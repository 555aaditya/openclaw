import type { Slot, Task } from "./worker-task-pool.types.js";

/** Admit worker construction after queue pressure; failed bootstrap waits for rotation. */
export function createWorkerTaskPoolBootstrap<Input, Output>(
  slots: ReadonlySet<Slot<Input, Output>>,
  queue: Task<Input, Output>[],
  reject: (task: Task<Input, Output>, error: Error) => void,
  runInContext: <T>(operation: () => T) => T,
  scaleUpDelayMs = 0,
) {
  if (!Number.isSafeInteger(scaleUpDelayMs) || scaleUpDelayMs < 0) {
    throw new RangeError("scaleUpDelayMs must be a nonnegative safe integer");
  }
  let failure: Error | undefined;
  let scaleUpTimer: NodeJS.Timeout | undefined;
  const admissionError = () =>
    failure &&
    ![...slots].some((slot) => slot.ready === true && !slot.retiring && !slot.retirementFailed)
      ? failure
      : undefined;
  const rejectQueued = () => {
    const error = admissionError();
    if (!error) {
      return;
    }
    // Detach the whole cohort before callbacks can reenter admission or dispatch.
    const queued = queue.splice(0);
    for (const task of queued) {
      reject(task, error);
    }
  };
  return {
    clearScaleUp: () => clearTimeout(scaleUpTimer),
    deferScaleUp(dispatch: () => void): boolean {
      if (!slots.size || scaleUpDelayMs === 0) {
        return false;
      }
      // Short overlapping reads reuse a warm isolate instead of warming another heap.
      const remaining = scaleUpDelayMs - (performance.now() - queue[0]!.enqueuedAt);
      if (remaining <= 0) {
        return false;
      }
      scaleUpTimer = runInContext(() => setTimeout(dispatch, remaining));
      scaleUpTimer.unref();
      return true;
    },
    error: () => failure,
    get admissionError() {
      return admissionError();
    },
    fail(error: Error) {
      failure ??= error;
      rejectQueued();
    },
    rejectQueued,
    reset: () => {
      failure = undefined;
    },
  };
}
