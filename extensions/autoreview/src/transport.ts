import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const PROTOCOL = "autoreview-native-v1";
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;

/** Byte callbacks feed a bounded queue; EOF or abort never substitutes for a terminal frame. */
export class ReviewPipe {
  private buffered = Buffer.alloc(0);
  private received = 0;
  private ended = false;
  private wake?: () => void;

  push(chunk: Uint8Array) {
    this.received += chunk.byteLength;
    if (
      this.ended ||
      this.received > MAX_TOTAL ||
      this.buffered.length + chunk.byteLength > MAX_FRAME + 65540
    ) {
      throw new Error("AutoReview helper exceeded the transport byte budget or wrote after EOF.");
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  private async read(
    size: number,
    signal: AbortSignal,
    allowEof = false,
  ): Promise<Buffer | undefined> {
    while (this.buffered.length < size) {
      signal.throwIfAborted();
      if (this.ended) {
        if (allowEof && this.buffered.length === 0) return undefined;
        throw new Error("AutoReview helper closed a partial frame.");
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          this.wake = undefined;
          resolve();
        };
        this.wake = done;
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
    signal.throwIfAborted();
    const value = this.buffered.subarray(0, size);
    this.buffered = this.buffered.subarray(size);
    return value;
  }

  async next(signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    const header = await this.read(4, signal, true);
    if (!header) return undefined;
    const size = header.readUInt32BE();
    if (size === 0 || size > MAX_FRAME)
      throw new Error("AutoReview helper frame exceeds its byte limit.");
    const payload = await this.read(size, signal);
    const value = asOptionalObjectRecord(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)),
    );
    if (!value || value.protocol !== PROTOCOL)
      throw new Error("AutoReview helper protocol mismatch.");
    return value;
  }
}

export function encodeFrame(value: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify({ protocol: PROTOCOL, ...value }));
  if (body.length > MAX_FRAME) throw new Error("AutoReview response exceeds its byte limit.");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
