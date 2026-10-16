import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { projectCodexCatalogNativeThread } from "../session-catalog-native-projection.js";
import { MAX_CURSOR_LENGTH, readControlCursor } from "../session-catalog-parsing.js";
import type { CodexCatalogNativePage } from "../session-catalog-types.js";

type Span = { start: number; end: number };
const THREAD_FIELDS = new Set([
  "id",
  "sessionId",
  "projectId",
  "ephemeral",
  "name",
  "cwd",
  "modelProvider",
  "cliVersion",
  "path",
  "originator",
  "createdAt",
  "updatedAt",
  "recencyAt",
  "source",
  "gitInfo",
]);

/** Recover small singleton metadata and the real cursor; skip unused payload as bytes.
 * The app-server serializer owns JSON validity inside discarded fields.
 */
export function readOversizedCodexCatalogPage(
  line: Buffer,
  id: number,
): CodexCatalogNativePage | undefined {
  try {
    const whitespace = (position: number) => {
      let at = position;
      while (line[at] === 32 || line[at] === 9 || line[at] === 13 || line[at] === 10) {
        at++;
      }
      return at;
    };
    const stringEnd = (position: number) => {
      let at = position;
      for (;;) {
        at = line.indexOf(34, at + 1);
        if (at < 0) {
          throw new Error("Unterminated catalog string");
        }
        let slash = at - 1;
        while (line[slash] === 92) {
          slash--;
        }
        if ((at - slash) % 2 === 1) {
          return at + 1;
        }
      }
    };
    const valueEnd = (start: number) => {
      if (line[start] === 34) {
        return stringEnd(start);
      }
      if (line[start] !== 123 && line[start] !== 91) {
        let end = start;
        while (end < line.length && ![32, 9, 13, 10, 44, 125, 93].includes(line[end]!)) {
          end++;
        }
        if (end === start) {
          throw new Error("Missing catalog value");
        }
        return end;
      }
      const closing: number[] = [];
      for (let at = start; at < line.length; at++) {
        const byte = line[at];
        if (byte === 34) {
          at = stringEnd(at) - 1;
        } else if (byte === 123 || byte === 91) {
          if (closing.length === 64) {
            throw new Error("Catalog nesting exceeds limit");
          }
          closing.push(byte === 123 ? 125 : 93);
        } else if (byte === 125 || byte === 93) {
          if (closing.pop() !== byte) {
            throw new Error("Unbalanced catalog value");
          }
          if (!closing.length) {
            return at + 1;
          }
        }
      }
      throw new Error("Incomplete catalog value");
    };
    const decode = ({ start, end }: Span, maxBytes = 8192) => {
      if (end - start > maxBytes) {
        throw new Error("Oversized catalog metadata");
      }
      return JSON.parse(line.toString("utf8", start, end)) as unknown;
    };
    const fields = (span: Span, wanted: ReadonlySet<string>) => {
      if (line[span.start] !== 123) {
        throw new Error("Invalid catalog object");
      }
      const result = new Map<string, Span>();
      let at = whitespace(span.start + 1);
      while (line[at] !== 125) {
        if (line[at] !== 34) {
          throw new Error("Invalid catalog key");
        }
        const end = stringEnd(at);
        const key = end - at <= 128 ? decode({ start: at, end }) : undefined;
        at = whitespace(end);
        if (line[at] !== 58) {
          throw new Error("Missing catalog separator");
        }
        const start = whitespace(at + 1);
        at = valueEnd(start);
        if (typeof key === "string" && wanted.has(key)) {
          result.set(key, { start, end: at });
        }
        at = whitespace(at);
        if (line[at] === 125) {
          break;
        }
        if (line[at] !== 44) {
          throw new Error("Missing catalog field separator");
        }
        at = whitespace(at + 1);
        if (line[at] === 125) {
          throw new Error("Invalid catalog trailing comma");
        }
      }
      if (at + 1 !== span.end) {
        throw new Error("Invalid catalog object boundary");
      }
      return result;
    };
    const start = whitespace(0);
    const end = valueEnd(start);
    if (whitespace(end) !== line.length) {
      return undefined;
    }
    const envelope = fields({ start, end }, new Set(["id", "result", "error"]));
    if (envelope.has("error") || decode(envelope.get("id")!) !== id) {
      return undefined;
    }
    const response = fields(
      envelope.get("result")!,
      new Set(["data", "nextCursor", "backwardsCursor"]),
    );
    if (!response.has("nextCursor")) {
      return undefined;
    }
    const data = response.get("data")!;
    if (line[data.start] !== 91) {
      return undefined;
    }
    const threadStart = whitespace(data.start + 1);
    const threadEnd = valueEnd(threadStart);
    if (whitespace(threadEnd) !== data.end - 1) {
      return undefined;
    }
    const native: Record<string, unknown> = {};
    for (const [key, span] of fields({ start: threadStart, end: threadEnd }, THREAD_FIELDS)) {
      // Optional oversized metadata is omitted; identity and cursors remain mandatory/bounded.
      if (span.end - span.start <= 8192) {
        native[key] = decode(span);
      }
    }
    const thread = projectCodexCatalogNativeThread(native, sanitizeTerminalText);
    const page: CodexCatalogNativePage = {
      data: [{ ...thread, catalogError: "oversized-thread" }],
    };
    for (const key of ["nextCursor", "backwardsCursor"] as const) {
      const span = response.get(key);
      if (span) {
        page[key] = readControlCursor(decode(span, MAX_CURSOR_LENGTH * 6 + 2), key) ?? null;
      }
    }
    return page;
  } catch {
    // Without a trustworthy identity and continuation, retain the ordinary failed-source path.
    return undefined;
  }
}
