import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isAdminOnlyNodeInvokeCommand,
  isBrowserProxyNodeInvokeCommand,
} from "../infra/node-commands.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { resolveReservedGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { operatorScopeSatisfied, roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  resolveSessionMethodScope,
  type SessionOperatorScope,
} from "../shared/session-method-scopes-base.js";
import { resolveDynamicSessionMutationRequiredScope } from "../shared/session-method-scopes.js";
import { isAgentSessionResetCommand } from "./agent-command-policy.js";
import {
  isCoreGatewayMethodClassified,
  isDynamicOperatorGatewayMethod,
  resolveCoreOperatorGatewayMethodScope,
} from "./methods/core-method-policy.js";
import { isForbiddenBrowserProxyMutation } from "./node-browser-proxy-policy.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  SESSION_WRITE_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
  isOperatorScope,
  type OperatorScope,
} from "./operator-scopes.js";

export {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  type OperatorScope,
};

/** Default scopes granted to CLI/operator clients when no narrower local policy is known. */
export const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  PAIRING_SCOPE,
  TALK_SECRETS_SCOPE,
];

function resolveScopedMethod(method: string): OperatorScope | undefined {
  // Node/dynamic sentinels are not operator scopes.
  const explicitScope = resolveCoreOperatorGatewayMethodScope(method);
  if (explicitScope) {
    return explicitScope;
  }
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (reservedScope) {
    return reservedScope;
  }
  const pluginDescriptor = getPluginRegistryForContext()?.gatewayMethodDescriptors?.find(
    (descriptor) => descriptor.name === method,
  );
  const pluginScope = pluginDescriptor?.scope;
  return pluginScope === "node" || pluginScope === "dynamic" ? undefined : pluginScope;
}

export function isApprovalMethod(method: string): boolean {
  return resolveScopedMethod(method) === APPROVALS_SCOPE;
}

function resolveDynamicLeastPrivilegeOperatorScopesForMethod(
  method: string,
  params: unknown,
): OperatorScope[] {
  // Dynamic methods derive authorization from params and live plugin registrations instead of
  // a single static method scope.
  const record = asOptionalRecord(params);
  if (method === "sessions.github.action") {
    return [record?.action === "refresh_base" ? SESSION_WRITE_SCOPE : WRITE_SCOPE];
  }
  if (method === "agent") {
    return isAgentSessionResetCommand(record?.message) ? [ADMIN_SCOPE] : [WRITE_SCOPE];
  }
  if (method === "node.invoke") {
    const command = record?.command;
    // Invalid persistent-profile mutations must reach the handler's precise fail-closed
    // rejection instead of being disguised as an admin-scope failure.
    if (
      isBrowserProxyNodeInvokeCommand(command) &&
      isForbiddenBrowserProxyMutation(record?.params)
    ) {
      return [WRITE_SCOPE];
    }
    return isAdminOnlyNodeInvokeCommand(command) ? [ADMIN_SCOPE] : [WRITE_SCOPE];
  }
  if (method === "talk.config") {
    return record?.includeSecrets === true ? [READ_SCOPE, TALK_SECRETS_SCOPE] : [READ_SCOPE];
  }
  if (method === "environments.list") {
    const runtimeId = record && "runtimeId" in record ? record.runtimeId : undefined;
    // Match the handler: every nonempty runtime ID needs command eligibility access.
    return typeof runtimeId === "string" && runtimeId ? [WRITE_SCOPE] : [READ_SCOPE];
  }
  if (method === "channels.pairing.approve") {
    return record?.bootstrapCommandOwner === true ? [PAIRING_SCOPE, ADMIN_SCOPE] : [PAIRING_SCOPE];
  }
  if (method === "fs.listDir") {
    const targetsNode = record && Object.hasOwn(record, "nodeId");
    return [targetsNode ? ADMIN_SCOPE : WRITE_SCOPE];
  }
  if (
    method === "sessions.patch" ||
    method === "sessions.patchMany" ||
    method === "sessions.create" ||
    method === "sessions.dispatch" ||
    method === "sessions.move"
  ) {
    return [resolveDynamicSessionMutationRequiredScope(method, params) ?? WRITE_SCOPE];
  }
  if (method === "sessions.delete") {
    return [resolveDynamicSessionMutationRequiredScope(method, params) ?? ADMIN_SCOPE];
  }
  return [WRITE_SCOPE];
}

function findMissingOperatorScope(
  requiredScopes: readonly OperatorScope[],
  scopes: readonly string[],
): OperatorScope | undefined {
  return requiredScopes.find((scope) => !operatorScopeSatisfied(scope, scopes));
}

export function resolveLeastPrivilegeOperatorScopesForMethod(
  method: string,
  params?: unknown,
): OperatorScope[] {
  if (isDynamicOperatorGatewayMethod(method)) {
    return resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params);
  }
  const requiredScope = resolveScopedMethod(method);
  if (requiredScope) {
    return [requiredScope];
  }
  // Default-deny for unclassified methods.
  return [];
}

/** Projects requested scopes through the original grant and this call's exact scope policy. */
export function projectOperatorScopesForMethod(params: {
  method: string;
  requestParams: unknown;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
  requiredScope?: OperatorScope;
  sessionScope?: SessionOperatorScope;
}): string[] {
  const requiredScopes = params.requiredScope
    ? [params.requiredScope]
    : resolveLeastPrivilegeOperatorScopesForMethod(params.method, params.requestParams);
  const sessionScope =
    params.sessionScope ?? resolveSessionMethodScope(params.method, params.requestParams);
  return params.requestedScopes.flatMap((requestedScope) => {
    if (
      roleScopesAllow({
        role: "operator",
        requestedScopes: [requestedScope],
        allowedScopes: params.allowedScopes,
      })
    ) {
      return [requestedScope];
    }
    // Only the method's required scope may use its narrow alternative. Unrelated
    // requested permissions and params-sensitive admin calls cannot borrow it.
    if (!isOperatorScope(requestedScope) || !requiredScopes.includes(requestedScope)) {
      return [];
    }
    const authorization = authorizeOperatorScopesForRequiredScope(
      requestedScope,
      params.allowedScopes,
      sessionScope,
      params.method,
    );
    return authorization.allowed && authorization.sessionScope ? [authorization.sessionScope] : [];
  });
}

export function authorizeOperatorScopesForMethod(
  method: string,
  scopes: readonly string[],
  params?: unknown,
):
  | { allowed: true; sessionScope?: SessionOperatorScope }
  | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  if (isDynamicOperatorGatewayMethod(method)) {
    const missingScope = findMissingOperatorScope(
      resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params),
      scopes,
    );
    return missingScope
      ? authorizeOperatorScopesForRequiredScope(
          missingScope,
          scopes,
          resolveSessionMethodScope(method, params),
          method,
        )
      : { allowed: true };
  }
  const requiredScope = resolveScopedMethod(method) ?? ADMIN_SCOPE;
  return authorizeOperatorScopesForRequiredScope(
    requiredScope,
    scopes,
    resolveSessionMethodScope(method, params),
    method,
  );
}

export function authorizeOperatorScopesForRequiredScope(
  requiredScope: OperatorScope,
  scopes: readonly string[],
  sessionScope?: SessionOperatorScope,
  method?: string,
):
  | { allowed: true; sessionScope?: SessionOperatorScope }
  | { allowed: false; missingScope: OperatorScope } {
  if (operatorScopeSatisfied(requiredScope, scopes)) {
    return { allowed: true };
  }
  if (
    ((requiredScope === READ_SCOPE && sessionScope === "operator.sessions.read") ||
      ((requiredScope === WRITE_SCOPE ||
        (requiredScope === QUESTIONS_SCOPE && method?.startsWith("question."))) &&
        sessionScope === "operator.sessions.write")) &&
    operatorScopeSatisfied(sessionScope, scopes)
  ) {
    return { allowed: true, sessionScope };
  }
  return { allowed: false, missingScope: requiredScope };
}

export function isGatewayMethodClassified(method: string): boolean {
  return isCoreGatewayMethodClassified(method) || resolveScopedMethod(method) !== undefined;
}
