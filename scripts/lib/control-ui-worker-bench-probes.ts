/** Measurement only; records counts and timing, never transcript contents. */
export function installWorkerBenchProbes() {
  const longTasks: Array<{ start: number; duration: number }> = [];
  const startups: Array<{ kind: string; at: number; readyMs?: number }> = [];
  let firstTranscriptRowMs: number | undefined;
  const workerErrors: string[] = [];
  const rows = new MutationObserver(() => {
    if (document.querySelector(".chat-bubble[data-message-id]")) {
      firstTranscriptRowMs = performance.now();
      rows.disconnect();
    }
  });
  rows.observe(document, { childList: true, subtree: true });
  for (const kind of ["Worker", "SharedWorker"] as const) {
    const Original = window[kind];
    if (!Original) continue;
    Reflect.set(
      window,
      kind,
      new Proxy(Original, {
        construct(target, args) {
          const worker = Reflect.construct(target, args);
          if (String(args[0]).includes("gateway-worker-")) {
            const sample = {
              kind,
              at: performance.now(),
              readyMs: undefined as number | undefined,
            };
            startups.push(sample);
            worker.addEventListener("error", (event: ErrorEvent) =>
              workerErrors.push(event.message),
            );
            const port = kind === "SharedWorker" ? worker.port : worker;
            port.addEventListener(
              "message",
              () => {
                sample.readyMs = performance.now() - sample.at;
              },
              { once: true },
            );
          }
          return worker;
        },
      }),
    );
  }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longTasks.push({ start: entry.startTime, duration: entry.duration });
  });
  observer.observe({ type: "longtask", buffered: true });
  Reflect.set(window, "__coldLoad", {
    read() {
      return {
        at: performance.now(),
        firstTranscriptRowMs,
        fcpMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
        firstHelloMs: Reflect.get(window, "__gatewayFirstDataAt"),
        firstListMs: Reflect.get(window, "__gatewayFirstListAt"),
        startups,
        workerErrors,
        longTasks,
        rpcCensus: Reflect.get(window, "__wsLog"),
        socket: Reflect.get(window, "__gatewaySocketMetrics"),
        bridge: Reflect.get(window, "__gatewayWorkerMetrics"),
        loaf: Reflect.get(window, "__perf")?.loaf ?? [],
        mutations: Reflect.get(window, "__perf")?.mutTotal ?? 0,
        mutationsByRegion: Object.fromEntries(Reflect.get(window, "__perf")?.mut ?? []),
      };
    },
  });
}
