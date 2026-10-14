import { Session } from "node:inspector/promises";
import { isMainThread } from "node:worker_threads";

const IDLE_GC_DELAY_MS = 1_000;
const IDLE_GC_GROWTH_BYTES = 32 * 1024 * 1024;
let collectedMemory = { heapUsed: 0, external: 0 };
let session: Session | null | undefined;
let pending: NodeJS.Timeout | undefined;
let collecting = false;
let idle = false;
let generation = 0;

function hasIdleGarbageGrowth(): boolean {
  // These isolate-local counters avoid heap walks; external already includes ArrayBuffers.
  const memory = process.memoryUsage();
  return (
    memory.heapUsed > collectedMemory.heapUsed + IDLE_GC_GROWTH_BYTES ||
    memory.external > collectedMemory.external + IDLE_GC_GROWTH_BYTES
  );
}

async function collectWorkerIdleGarbage(): Promise<void> {
  pending = undefined;
  if (!hasIdleGarbageGrowth()) {
    return;
  }
  const collectingGeneration = generation;
  collecting = true;
  try {
    if (!session) {
      const connection = new Session();
      connection.connect();
      // Keep the local session until worker teardown. Disconnecting during GC
      // completion deadlocks V8 and tears down other profiler state.
      session = connection;
    }
    await session.post("HeapProfiler.collectGarbage");
    collecting = false;
    if (collectingGeneration === generation) {
      collectedMemory = process.memoryUsage();
    } else if (idle) {
      // A successor finished while GC was pending; its released heap needs a new sample.
      scheduleWorkerIdleGc();
    }
  } catch (error) {
    collecting = false;
    if (error instanceof Error && error.message.startsWith("Inspector error -32601:")) {
      session = null;
    } else {
      process.emitWarning(error instanceof Error ? error : String(error));
    }
  }
}

/** Only native worker owners call this after releasing their operation's payloads. */
export function scheduleWorkerIdleGc(): void {
  if (isMainThread || session === null) {
    return;
  }
  idle = true;
  if (pending || collecting) {
    return;
  }
  if (!hasIdleGarbageGrowth()) {
    return;
  }
  // A reply can immediately trigger another task; allow that burst to finish first.
  pending = setTimeout(() => {
    void collectWorkerIdleGarbage();
  }, IDLE_GC_DELAY_MS).unref();
}

/** A new operation takes precedence over collection of the preceding idle heap. */
export function cancelWorkerIdleGc(): void {
  generation++;
  idle = false;
  clearTimeout(pending);
  pending = undefined;
}
