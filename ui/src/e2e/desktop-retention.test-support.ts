import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";

export const RETAINED_DESKTOP_SESSION_KEY = "agent:main:retained-desktop-slot";

export const retainedDesktopEnvironment = {
  id: "node:desktop-node",
  type: "node",
  status: "available",
  desktop: true,
};

export function retainedDesktopScenario(
  base: ControlUiMockGatewayScenario,
): ControlUiMockGatewayScenario {
  return {
    ...base,
    sessionKey: RETAINED_DESKTOP_SESSION_KEY,
    methodResponses: {
      ...base.methodResponses,
      "sessions.list": {
        count: 1,
        defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
        path: "",
        sessions: [
          {
            key: RETAINED_DESKTOP_SESSION_KEY,
            sessionId: RETAINED_DESKTOP_SESSION_KEY,
            kind: "direct",
            label: "Retained desktop",
            placement: {
              state: "active",
              environmentId: "device-worker-retained",
              runner: { kind: "device", deviceId: "desktop-node", status: "available" },
            },
            updatedAt: Date.now(),
          },
        ],
        ts: Date.now(),
      },
      "environments.list": {
        environments: [retainedDesktopEnvironment],
      },
      "environments.status": retainedDesktopEnvironment,
      "desktop.observe": {
        cases: [false, true].map((control) => ({
          match: { control },
          response: {
            transport: "rfb",
            wsPath: "/desktop/observe?token=retained",
            expiresAtMs: 60_000,
            control,
          },
        })),
      },
    },
  };
}
