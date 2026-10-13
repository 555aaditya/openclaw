import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { captureAgentRunLifecycleGeneration } from "./agent-event-execution-context.js";
import type { AgentEventPayload } from "./agent-events.types.js";

type PresentationEvent = Pick<AgentEventPayload, "stream" | "data">;
type PresentationBuffer = {
  lifecycleGeneration: string;
  session?: { sessionKey?: string; sessionId: string };
  capture: (event: PresentationEvent, publish: () => void) => boolean;
  isPending: () => boolean;
};
const buffers = resolveGlobalSingleton(
  Symbol.for("openclaw.agentRunPresentation"),
  () => new Map<string, PresentationBuffer>(),
);

/** Warm transport callbacks may emit outside the attempt's async execution scope. */
export function registerAgentRunPresentationBuffer(
  runId: string,
  capture: PresentationBuffer["capture"],
  isPending: () => boolean,
  session?: PresentationBuffer["session"],
): () => void {
  const previous = buffers.get(runId);
  const registration = {
    lifecycleGeneration: captureAgentRunLifecycleGeneration(runId),
    capture,
    isPending,
    session,
  };
  buffers.set(runId, registration);
  return () => {
    if (buffers.get(runId) === registration) {
      if (previous) {
        buffers.set(runId, previous);
      } else {
        buffers.delete(runId);
      }
    }
  };
}

function sessionPresentation(session: { sessionKey?: string; sessionId: string }) {
  return [...buffers.entries()].find(
    ([runId, buffer]) =>
      isAgentRunPresentationPending(runId) &&
      buffer.session?.sessionId === session.sessionId &&
      (!session.sessionKey || buffer.session.sessionKey === session.sessionKey),
  );
}

export function isAgentSessionPresentationPending(session: {
  sessionKey?: string;
  sessionId: string;
}): boolean {
  return sessionPresentation(session) !== undefined;
}

/** Sidebar previews share the same optional-turn decision as transcript messages. */
export function captureAgentSessionPresentation(
  session: { sessionKey?: string; sessionId: string },
  itemId: string,
  publish: () => void,
): boolean {
  const entry = sessionPresentation(session);
  return entry
    ? captureAgentRunPresentation(
        entry[0],
        { stream: "item", data: { kind: "answer_candidate", itemId } },
        publish,
      )
    : false;
}

export function isAgentRunPresentationPending(runId?: string): boolean {
  if (runId) {
    const entry = buffers.get(runId);
    return (
      entry !== undefined &&
      entry.lifecycleGeneration === captureAgentRunLifecycleGeneration(runId) &&
      entry.isPending()
    );
  }
  return [...buffers.keys()].some((id) => isAgentRunPresentationPending(id));
}

/** Share one attempt visibility decision across live events and committed transcript presentation. */
export function captureAgentRunPresentation(
  runId: string,
  event: PresentationEvent,
  publish: () => void,
): boolean {
  const presentation = buffers.get(runId);
  return presentation !== undefined &&
    presentation.lifecycleGeneration === captureAgentRunLifecycleGeneration(runId)
    ? presentation.capture(event, publish)
    : false;
}

export function clearAgentRunPresentationBuffers(): void {
  buffers.clear();
}
