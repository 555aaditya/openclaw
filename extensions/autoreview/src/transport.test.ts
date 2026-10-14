import { describe, expect, it } from "vitest";
import { encodeFrame, PROTOCOL, ReviewPipe } from "./transport.js";

const signal = () => new AbortController().signal;
describe("review protocol bytes", () => {
  it("preserves split UTF-8 and coalesced frames in order", async () => {
    const pipe = new ReviewPipe();
    const bytes = Buffer.concat([
      encodeFrame({ kind: "capture", text: "🦊" }),
      encodeFrame({ kind: "result" }),
    ]);
    const pending = pipe.next(signal());
    for (const byte of bytes) pipe.push(Buffer.from([byte]));
    pipe.end();
    expect(await pending).toEqual({ protocol: PROTOCOL, kind: "capture", text: "🦊" });
    expect(await pipe.next(signal())).toEqual({ protocol: PROTOCOL, kind: "result" });
    expect(await pipe.next(signal())).toBeUndefined();
  });
  it.each([0, 4 * 1024 * 1024 + 1, 0xffffffff])(
    "rejects length %i before reading a body",
    async (size) => {
      const pipe = new ReviewPipe();
      const header = Buffer.alloc(4);
      header.writeUInt32BE(size);
      pipe.push(header);
      await expect(pipe.next(signal())).rejects.toThrow("byte limit");
    },
  );
  it("rejects malformed UTF-8, wrong protocol, and partial EOF", async () => {
    for (const bytes of [
      Buffer.from([0, 0, 0, 1, 0xff]),
      encodeFrame({ protocol: "wrong" }),
      Buffer.from([0, 0]),
    ]) {
      const pipe = new ReviewPipe();
      pipe.push(bytes);
      pipe.end();
      await expect(pipe.next(signal())).rejects.toThrow();
    }
  });
  it("aborts a pending read and refuses writes after EOF", async () => {
    const pipe = new ReviewPipe();
    const controller = new AbortController();
    const pending = pipe.next(controller.signal);
    controller.abort(new Error("expired"));
    await expect(pending).rejects.toThrow("expired");
    pipe.end();
    expect(() => pipe.push(Buffer.from("late"))).toThrow("EOF");
  });
  it("bounds buffered and encoded bytes", () => {
    expect(() => new ReviewPipe().push(Buffer.alloc(4 * 1024 * 1024 + 65541))).toThrow("budget");
    expect(() => encodeFrame({ text: "x".repeat(4 * 1024 * 1024) })).toThrow("byte limit");
  });
});
