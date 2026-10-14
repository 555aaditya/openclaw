import { AsyncLocalStorage } from "node:async_hooks";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { captureOperatorToolGatewayAuthority } from "../gateway/operator-invocation-authority.js";
import { readOperatorToolGatewayAuthority } from "../gateway/operator-tool-gateway-authority.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createLlmCompleteError } from "./runtime/runtime-llm-error.js";

/** Capture admitted requester and lifetime once; retained calls never adopt another ambient scope. */
export function captureBoundPluginInvocation(params: {
  agentId?: string;
  sessionKey?: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  requireInvocationOrigin?: boolean;
}) {
  const origin = captureOperatorToolGatewayAuthority();
  const caller = getGatewayToolCallerIdentity();
  const signals = [
    params.signal,
    getAsyncWorkSignal(),
    origin?.authority?.signal,
    readOperatorToolGatewayAuthority()?.signal,
    getPluginRuntimeGatewayRequestScope()?.signal,
    ...(caller?.approvalSignals ?? []),
  ].filter((signal): signal is AbortSignal => !!signal);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  // Restore the admitted producer's scope, never the ambient caller of a retained capability.
  const runInOrigin = AsyncLocalStorage.snapshot();
  const assertCurrent = () => {
    if (
      params.requireInvocationOrigin &&
      (!origin ||
        (caller && (caller.agentId !== params.agentId || caller.sessionKey !== params.sessionKey)))
    ) {
      throw createLlmCompleteError(
        "LLM_COMPLETION_NOT_AUTHORIZED",
        "Tool completion has no matching admitted invocation origin.",
      );
    }
    signal?.throwIfAborted();
    origin?.assertCurrent();
    params.assertCurrent();
  };
  return { assertCurrent, signal, runInOrigin };
}
