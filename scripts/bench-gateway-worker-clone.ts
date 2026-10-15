import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../ui/src/test-helpers/control-ui-team-scale-fixture.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string", default: ".artifacts/l56-clone.json" },
    runs: { type: "string", default: "7" },
  },
});
const fixture = createControlUiTeamScaleFixture({ now: 1_800_000_000_000 });
const lists = fixture.scenario.methodResponses!["sessions.list"] as {
  cases: Array<{ response: { sessions: Array<{ key: string; updatedAt: number }> } }>;
};
const initial = lists.cases.at(-1)!.response;
const frames = Array.from({ length: 60 }, (_, index) =>
  JSON.stringify({
    ...initial,
    sessions: initial.sessions.map((row, rowIndex) =>
      rowIndex === 0 ? { ...row, updatedAt: row.updatedAt + index } : row,
    ),
  }),
);
const server = createServer((_req, res) =>
  res.end("<!doctype html><title>Synthetic worker clone bench</title>"),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Benchmark did not bind");
const browser = await chromium.launch({
  headless: true,
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
});
try {
  const page = await browser.newPage();
  await page.addInitScript({ content: "globalThis.__name = (target) => target;" });
  await page.goto(`http://127.0.0.1:${address.port}`);
  const results = await page.evaluate(
    async ({ frames, runs }) => {
      const workerCode = `
      let frames; let mode; let index; let parseMs; let postMs; let bytes; let rows;
      function sendNext() {
        if (index === frames.length) { postMessage({done:true, parseMs, postMs, bytes}); return; }
        const raw = frames[index]; let value = raw;
        const start = performance.now();
        if (mode !== 'raw') value = JSON.parse(raw);
        parseMs += performance.now() - start;
        if (mode === 'rows') {
          const next = value.sessions; const upserts = [];
          for (const row of next) { const text = JSON.stringify(row); if (rows.get(row.key) !== text) upserts.push(row); rows.set(row.key,text); }
          value = { upserts, order: next.map(row=>row.key) };
        }
        bytes += typeof value === 'string' ? value.length : JSON.stringify(value).length;
        const at = performance.timeOrigin + performance.now();
        postMessage({index,value,at}); postMs += performance.timeOrigin + performance.now() - at;
        index++;
      }
      onmessage = event => {
        if (event.data.frames) { frames=event.data.frames; postMessage({ready:true}); }
        else if (event.data.mode) { mode=event.data.mode; index=0; parseMs=0; postMs=0; bytes=0; rows=new Map(); sendNext(); }
        else sendNext();
      };
    `;
      const worker = new Worker(
        URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" })),
      );
      await new Promise<void>((resolve) => {
        worker.onmessage = () => resolve();
        worker.postMessage({ frames });
      });
      const results: Array<Record<string, unknown>> = [];
      for (let run = -1; run < runs; run++)
        for (const mode of run % 2
          ? ["baseline", "raw", "parsed", "rows"]
          : ["rows", "parsed", "raw", "baseline"]) {
          let parseMs = 0;
          let applyMs = 0;
          let deliveryMs = 0;
          let checksum = 0;
          const materialized = new Map<string, { key: string; updatedAt: number }>();
          const wall = performance.now();
          const apply = (value: {
            sessions?: Array<{ key: string; updatedAt: number }>;
            upserts?: Array<{ key: string; updatedAt: number }>;
            order?: string[];
          }) => {
            const start = performance.now();
            if (value.upserts) for (const row of value.upserts) materialized.set(row.key, row);
            const rows = value.sessions ?? value.order!.map((key) => materialized.get(key)!);
            checksum += rows[0]!.updatedAt;
            applyMs += performance.now() - start;
          };
          let remote: Record<string, unknown> = {};
          if (mode === "baseline") {
            for (const frame of frames) {
              const start = performance.now();
              const value = JSON.parse(frame);
              parseMs += performance.now() - start;
              apply(value);
            }
          } else {
            remote = await new Promise((resolve) => {
              worker.onmessage = (event) => {
                if (event.data.done) {
                  resolve(event.data);
                  return;
                }
                deliveryMs += performance.timeOrigin + performance.now() - event.data.at;
                const start = performance.now();
                const value =
                  typeof event.data.value === "string"
                    ? JSON.parse(event.data.value)
                    : event.data.value;
                parseMs += performance.now() - start;
                apply(value);
                worker.postMessage({ ack: true });
              };
              worker.postMessage({ mode });
            });
          }
          if (run >= 0)
            results.push({
              run,
              mode,
              mainParseMs: parseMs,
              mainApplyMs: applyMs,
              deliveryMs,
              wallMs: performance.now() - wall,
              checksum,
              remote,
            });
        }
      worker.terminate();
      return results;
    },
    { frames, runs: Number(values.runs) },
  );
  await mkdir(new URL(".", `file://${process.cwd()}/${values.output}`).pathname, {
    recursive: true,
  });
  await writeFile(
    values.output,
    JSON.stringify(
      { frameBytes: Buffer.byteLength(frames[0]!), frames: frames.length, results },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      output: values.output,
      frameBytes: Buffer.byteLength(frames[0]!),
      samples: results.length,
    }),
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
