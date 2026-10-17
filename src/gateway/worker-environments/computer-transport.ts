import { randomUUID } from "node:crypto";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ComputerToolTransport } from "../../agents/tools/computer-tool.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { getActivePluginGatewayNodePolicyRegistry } from "../../plugins/runtime-state.js";
import type { WorkerComputerLaunchDescriptor } from "../../worker/launch-descriptor.js";
import { parseNodeWorkerComputerInput } from "../../worker/node-computer-protocol.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { applyPluginNodeInvokePolicy } from "../node-invoke-plugin-policy.js";
import { invokeNodeWithReadinessRetry } from "../node-invoke-readiness.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { publishNodePermissionMissing } from "../server-methods/nodes.permission-missing.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import { WorkerRunnerUnavailableError } from "./tunnel-contract.js";

const COMPUTER_COMMANDS = ["screen.snapshot", "computer.act"] as const;

type InvokeResult = Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>;

function payload(result: InvokeResult): unknown {
  if (!result.ok) {
    throw new Error(result.error?.message ?? "Session desktop command failed");
  }
  return result.payloadJSON ? JSON.parse(result.payloadJSON) : result.payload;
}

type WorkerComputerTransport = Omit<ComputerToolTransport, "invoke"> & {
  invoke(
    request: Parameters<ComputerToolTransport["invoke"]>[0],
    assertAuthorized?: () => void,
  ): Promise<unknown>;
};

export type PreparedWorkerComputer = {
  descriptor: WorkerComputerLaunchDescriptor;
  bind(
    operationalRunInstance: OperationalRunInstanceRef,
    workerSource?: { authority: AgentRunDelegatedAuthority; assertCurrent: () => void },
  ): WorkerComputerTransport;
  close(reason: string): Promise<void>;
};

export type WorkerEnvironmentComputerAuthority = {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  runId: string;
  assertCurrent(): void;
  turnClaim?: WorkerSessionTurnClaim;
};

type WorkerComputerOwnerOptions = {
  store: Pick<WorkerEnvironmentStore, "get">;
  resolveGatewayContext: GatewayContextResolver;
  getNodeTransport: () => NodeWorkerSupervisorTransport | undefined;
  warn: (message: string) => void;
};

/** Captures one environment's desktop under its placement or conversation attachment owner. */
export function createEnvironmentComputerTransportOwner(options: WorkerComputerOwnerOptions) {
  return async (
    source: WorkerEnvironmentComputerAuthority,
  ): Promise<PreparedWorkerComputer | undefined> => {
    source.assertCurrent();
    const environment = options.store.get(source.environmentId);
    if (!environment?.nodeDeviceId || !environment.sharedHost) {
      return undefined;
    }
    const context = options.resolveGatewayContext();
    const nodeTransport = options.getNodeTransport();
    if (!context || !nodeTransport) {
      throw new Error("Session desktop Gateway is unavailable");
    }
    const node = context.nodeRegistry.get(environment.nodeDeviceId);
    if (!node) {
      throw new WorkerRunnerUnavailableError();
    }
    const environmentIsCurrent = (current: WorkerEnvironmentRecord | undefined) => {
      const currentNode = context.nodeRegistry.get(node.nodeId);
      return (
        options.resolveGatewayContext() === context &&
        options.getNodeTransport() === nodeTransport &&
        current?.leaseId === environment.leaseId &&
        current?.ownerEpoch === environment.ownerEpoch &&
        current?.nodeDeviceId === node.nodeId &&
        currentNode?.connId === node.connId &&
        currentNode?.pairingGeneration === node.pairingGeneration &&
        currentNode.client.invalidated !== true
      );
    };
    const sourceIsCurrent = () => {
      try {
        source.assertCurrent();
      } catch {
        return false;
      }
      const currentEnvironment = options.store.get(environment.environmentId);
      return (
        environmentIsCurrent(currentEnvironment) &&
        currentEnvironment?.ownerEpoch === source.ownerEpoch &&
        ["ready", "idle", "attached"].includes(currentEnvironment.state) &&
        currentEnvironment.destroyRequestedAtMs === null
      );
    };
    const assertPlacement = () => {
      if (!sourceIsCurrent()) {
        throw new Error("Session desktop placement authority changed");
      }
    };
    assertPlacement();
    if (!COMPUTER_COMMANDS.every((command) => node.commands.includes(command))) {
      return undefined;
    }
    const computerUse = node.computerUse;
    if (!computerUse) {
      return undefined;
    }
    const registry = getActivePluginGatewayNodePolicyRegistry();
    const policyOwners = COMPUTER_COMMANDS.map((command) => {
      const entry = registry?.nodeInvokePolicies.find((item) =>
        item.policy.commands.includes(command),
      );
      const policy = entry?.policy;
      const plugin = registry?.plugins.find((item) => item.id === entry?.pluginId);
      return () =>
        registry?.nodeInvokePolicies.find((item) => item.policy.commands.includes(command)) ===
          entry &&
        entry?.policy === policy &&
        (!plugin ||
          (registry?.plugins.includes(plugin) && plugin.enabled && plugin.status === "loaded"));
    });
    const descriptor = { nodeId: node.nodeId, computerUse };
    const providerGeneration = computerUse.provider.generation;
    let closed = false;
    let closing: Promise<void> | undefined;
    const activeBindings = new Set<{ close(reason: string): Promise<unknown> }>();
    const resourceBindingIsCurrent = () =>
      environmentIsCurrent(options.store.get(environment.environmentId));
    const bindingIsCurrent = () =>
      getActivePluginGatewayNodePolicyRegistry() === registry &&
      policyOwners.every((isCurrent) => isCurrent()) &&
      context.nodeRegistry.get(node.nodeId)?.computerUse?.provider.generation ===
        providerGeneration;
    const commandIsAllowed = (command: (typeof COMPUTER_COMMANDS)[number]) => {
      const currentNode = context.nodeRegistry.get(node.nodeId);
      const declaredCommands = currentNode?.commands ?? [];
      return isNodeCommandAllowed({
        command,
        declaredCommands,
        allowlist: resolveNodeCommandAllowlist(context.getRuntimeConfig(), {
          ...currentNode,
          approvedCommands: declaredCommands,
        }),
      }).ok;
    };
    const parseRequest = (request: Parameters<ComputerToolTransport["invoke"]>[0]) => {
      if (request.nodeId !== node.nodeId) {
        throw new Error("Computer control is bound to this session's desktop");
      }
      const close =
        request.command === "computer.act" && request.commandParams.action === "__close_execution";
      const input = parseNodeWorkerComputerInput(
        JSON.stringify(
          close
            ? {
                operation: "close",
                executionId: request.commandParams.executionId,
                reason: request.commandParams.reason,
              }
            : {
                operation: request.command === "screen.snapshot" ? "snapshot" : "act",
                providerGeneration,
                params: request.commandParams,
              },
        ),
      );
      if (input.operation === "capabilities") {
        throw new Error("Session computer cannot request another capability check");
      }
      return input;
    };

    const send = async (
      input: ReturnType<typeof parseRequest>,
      params: {
        timeoutMs?: number;
        signal?: AbortSignal;
        idempotencyKey?: string;
        authorizeDispatch?: () => Promise<boolean>;
        isDispatchAuthorized: () => boolean;
        onDispatchReady?: (invokeId: string) => void;
      },
    ): Promise<InvokeResult> => {
      const isCurrent = () => resourceBindingIsCurrent() && params.isDispatchAuthorized();
      if (!resourceBindingIsCurrent()) {
        throw new Error("Session computer authority closed before dispatch");
      }
      const command = input.operation === "snapshot" ? "screen.snapshot" : "computer.act";
      const commandParams =
        input.operation === "close"
          ? { action: "__close_execution", executionId: input.executionId, reason: input.reason }
          : input.params;
      return await invokeNodeWithReadinessRetry(
        input.operation === "close"
          ? {
              invoke: (request) =>
                context.nodeRegistry.invokeLifecycle({
                  ...request,
                  isDispatchAuthorized: isCurrent,
                }),
            }
          : context.nodeRegistry,
        {
          nodeId: node.nodeId,
          expectedConnId: node.connId,
          expectedPairingGeneration: node.pairingGeneration,
          command,
          params: commandParams,
          sessionKey: source.sessionKey,
          ...params,
          isDispatchAuthorized: isCurrent,
        },
      );
    };

    return {
      descriptor,
      bind(operationalRunInstance, workerSource) {
        const worker = source.turnClaim?.owner.kind === "worker";
        workerSource?.assertCurrent();
        const runAuthority = getActiveAgentRunDelegatedAuthority(operationalRunInstance);
        const authority = worker ? workerSource?.authority : runAuthority;
        if (
          !runAuthority ||
          !authority ||
          !validateAgentRunDelegatedAuthority(authority) ||
          authority.operationalRunInstance.instanceId !== operationalRunInstance.instanceId ||
          authority.operationalRunInstance.runId !== operationalRunInstance.runId ||
          operationalRunInstance.runId !== source.runId
        ) {
          throw new Error("Session computer requires the exact admitted run");
        }
        const identity: AgentRuntimeIdentity = {
          kind: "agentRuntime",
          agentId: source.agentId,
          sessionKey: source.sessionKey,
          operationalRunInstance,
          delegatedAuthority:
            source.turnClaim?.owner.kind === "worker"
              ? { ...authority, kind: "worker", turnClaim: source.turnClaim }
              : { ...authority, kind: "local" },
        };
        const permissionError = (error: unknown, command: string) => {
          const permission = publishNodePermissionMissing({
            error,
            nodeId: node.nodeId,
            nodeName: node.displayName,
            command,
            agentRuntimeIdentity: identity,
            context,
          });
          return permission
            ? new GatewayClientRequestError({
                code: "UNAVAILABLE",
                message: permission.message,
                details: { permissionMissing: permission.permissionMissing },
              })
            : undefined;
        };
        // Tool construction can also build a schema-only projection. Only an actual
        // operation opens a binding; independent projections never retire the active tool.
        let execution: { logicalId: string; physicalId: string } | undefined;
        let bindingClosing: Promise<unknown> | undefined;
        const inFlight = new Set<Promise<unknown>>();
        const lifetime = new AbortController();
        const assertCurrent = () => {
          if (
            closed ||
            lifetime.signal.aborted ||
            !bindingIsCurrent() ||
            !validateAgentRunDelegatedAuthority(authority)
          ) {
            throw new Error("Session computer run authority closed");
          }
          workerSource?.assertCurrent();
          assertPlacement();
        };
        assertCurrent();
        const execute = async (
          input: Exclude<ReturnType<typeof parseRequest>, { operation: "close" }>,
          request: Pick<
            Parameters<ComputerToolTransport["invoke"]>[0],
            "timeoutMs" | "signal" | "idempotencyKey"
          >,
          assertAuthorized: (() => void) | undefined,
        ) => {
          // RPC tool grants can close independently of the run or placement.
          // Carry their exact authority through policy work and the final dispatch.
          const assertInvocationCurrent = () => {
            assertCurrent();
            assertAuthorized?.();
            request.signal?.throwIfAborted();
          };
          const command = input.operation === "snapshot" ? "screen.snapshot" : "computer.act";
          const commandParams = input.params;
          const isCurrent = () => {
            try {
              assertInvocationCurrent();
              return true;
            } catch {
              return false;
            }
          };
          const signal = AbortSignal.any([
            lifetime.signal,
            ...(request.signal ? [request.signal] : []),
          ]);
          assertInvocationCurrent();
          const dispatch = async (
            params: Parameters<typeof send>[1] & { params: unknown },
          ): Promise<InvokeResult> => {
            const actual = parseNodeWorkerComputerInput(
              JSON.stringify({ ...input, params: params.params }),
            );
            if (
              actual.operation === "capabilities" ||
              actual.operation === "close" ||
              actual.params.executionId !== execution?.physicalId
            ) {
              throw new Error("Computer policy cannot replace the session execution owner");
            }
            return await send(actual, {
              timeoutMs: params.timeoutMs,
              signal: params.signal,
              idempotencyKey: params.idempotencyKey,
              ...(params.authorizeDispatch ? { authorizeDispatch: params.authorizeDispatch } : {}),
              isDispatchAuthorized: () => isCurrent() && params.isDispatchAuthorized(),
              onDispatchReady: params.onDispatchReady,
            });
          };
          const result = await applyPluginNodeInvokePolicy({
            context,
            client: null,
            agentRuntimeIdentity: identity,
            nodeSession: node,
            command,
            params: commandParams,
            sessionKey: source.sessionKey,
            timeoutMs: request.timeoutMs,
            idempotencyKey: request.idempotencyKey,
            signal,
            isInvocationCurrent: isCurrent,
            isApprovalAuthorityActive: isCurrent,
            privateTransport: {
              isCurrent,
              invoke: dispatch,
            },
          });
          assertInvocationCurrent();
          if (result) {
            if (!result.ok) {
              throw (
                permissionError(asOptionalObjectRecord(result.details)?.nodeError, command) ??
                new Error(result.message ?? "Session computer action denied")
              );
            }
            return result.payloadJSON ? JSON.parse(result.payloadJSON) : result.payload;
          }
          if (!commandIsAllowed(command)) {
            throw new Error("Session computer command has no active policy or permission");
          }
          const raw = await dispatch({
            params: commandParams,
            timeoutMs: request.timeoutMs,
            signal,
            idempotencyKey: request.idempotencyKey,
            isDispatchAuthorized: () => isCurrent() && commandIsAllowed(command),
          });
          assertInvocationCurrent();
          if (!raw.ok) {
            throw (
              permissionError(raw.error, command) ??
              new Error(raw.error?.message ?? "Session desktop command failed")
            );
          }
          return payload(raw);
        };
        const binding = {
          close(reason: string): Promise<unknown> {
            if (bindingClosing) {
              return bindingClosing;
            }
            lifetime.abort();
            bindingClosing = (async () => {
              await Promise.allSettled(inFlight);
              if (!execution || !resourceBindingIsCurrent()) {
                activeBindings.delete(binding);
                return { ok: true };
              }
              // Releasing an owned native execution survives input-policy revocation.
              // Only this fixed physical close crosses the lease/connection guard;
              // no plugin handler, caller override, approval, or input is revived.
              const result = await send(
                {
                  operation: "close",
                  executionId: execution.physicalId,
                  reason: reason.slice(0, 64),
                },
                { isDispatchAuthorized: resourceBindingIsCurrent },
              );
              if (!resourceBindingIsCurrent()) {
                throw new Error("Session computer cleanup owner changed");
              }
              const output = payload(result);
              activeBindings.delete(binding);
              return output;
            })();
            return bindingClosing;
          },
        };
        return {
          computerUse,
          async resolveNode(query, signal) {
            signal?.throwIfAborted();
            assertCurrent();
            if (query !== undefined && query !== node.nodeId) {
              throw new Error("Computer control is bound to this session's desktop");
            }
            return descriptor;
          },
          async invoke(request, assertAuthorized) {
            const input = parseRequest(request);
            const logicalId =
              input.operation === "close" ? input.executionId : input.params.executionId;
            if (execution && logicalId !== execution.logicalId) {
              throw new Error("Session computer execution owner changed");
            }
            if (input.operation === "close") {
              return binding.close(input.reason);
            }
            assertCurrent();
            request.signal?.throwIfAborted();
            assertAuthorized?.();
            // Remote execution IDs are correlation only. The Gateway alone mints
            // the native owner, so a copied UUID cannot join or close another binding.
            execution ??= { logicalId, physicalId: randomUUID() };
            activeBindings.add(binding);
            input.params.executionId = execution.physicalId;
            const operation = execute(input, request, assertAuthorized);
            inFlight.add(operation);
            void operation.finally(() => inFlight.delete(operation)).catch(() => {});
            return operation;
          },
        };
      },
      close(reason) {
        if (closing) {
          return closing;
        }
        closed = true;
        closing = (async () => {
          const results = await Promise.allSettled(
            [...activeBindings].map((binding) => binding.close(reason)),
          );
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length) {
            throw new AggregateError(
              failures.map((failure) => failure.reason),
              "Session computer cleanup failed",
            );
          }
        })();
        return closing;
      },
    };
  };
}

/** Placement admission retains its exact turn claim; attachments use the same transport owner. */
export function createWorkerComputerTransportOwner(
  options: WorkerComputerOwnerOptions & {
    placements: Pick<WorkerSessionPlacementStore, "get" | "getAsync" | "validateTurnClaim">;
  },
) {
  const create = createEnvironmentComputerTransportOwner(options);
  return async (claim: WorkerSessionTurnClaim): Promise<PreparedWorkerComputer | undefined> => {
    const placement = await options.placements.getAsync(claim.sessionId);
    if (placement?.state !== "active" || !options.placements.validateTurnClaim(claim)) {
      throw new Error("Session desktop placement is no longer active");
    }
    return create({
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      sessionId: claim.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      runId: claim.runId,
      turnClaim: claim,
      assertCurrent() {
        const current = options.placements.get(claim.sessionId);
        const environment = options.store.get(placement.environmentId);
        if (
          !options.placements.validateTurnClaim(claim) ||
          current?.state !== "active" ||
          current.generation !== claim.placementGeneration ||
          current.sessionKey !== placement.sessionKey ||
          current.agentId !== placement.agentId ||
          current.environmentId !== placement.environmentId ||
          current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
          environment?.state !== "attached" ||
          environment.attachedSessionIds.length !== 1 ||
          environment.attachedSessionIds[0] !== claim.sessionId
        ) {
          throw new Error("Session desktop placement authority changed");
        }
      },
    });
  };
}
