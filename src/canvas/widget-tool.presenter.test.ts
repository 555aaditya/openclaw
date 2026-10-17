import { access } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { createBoardPutCaller } from "./widget-tool.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => resetPluginRuntimeStateForTest());
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
});

describe("show_widget current-channel presentation", () => {});

describe("show_widget capability outcomes", () => {
  it.each(["pending", "rejected", "granted"] as const)(
    "reports the owner's %s capability outcome",
    async (grantState) => {
      const { mock, callGateway } = createBoardPutCaller();
      const original = mock.getMockImplementation()!;
      mock.mockImplementation(async (...args) => {
        const snapshot = await original(...args);
        snapshot.widgets[0]!.grantState = grantState;
        return snapshot;
      });
      const tool = createShowWidgetTool({
        agentSessionKey: "agent:main:approval",
        inlineHostEnabled: false,
        callGateway,
      });
      const result = await tool.execute("pin", {
        title: "Runs",
        widget_code: "<p>runs</p>",
        pin: true,
        capabilities: { tools: ["github.actions.runs:owner/repo"] },
      });
      const text = result.content.find((item) => item.type === "text")?.text;
      if (!text) {
        throw new Error("expected widget tool text result");
      }
      const payload = JSON.parse(text);
      expect(payload).toMatchObject({ boardWidgetName: "runs", capabilityState: grantState });
      expect(payload.text).toContain(grantState);
      if (grantState !== "granted") {
        expect(payload.text).toMatch(/approve|review/i);
      }
    },
  );
});

describe("scheduled show_widget", () => {
  it("keeps scheduled widget authoring pinned-only without an inline client", async () => {
    const { mock: callGatewayMock, callGateway } = createBoardPutCaller();
    const stateDir = tempDirs.make("openclaw-scheduled-widget-");
    const tool = createShowWidgetTool({
      stateDir,
      sessionId: "scheduled-board-only",
      agentSessionKey: "agent:main:dashboard:scheduled",
      inlineClientAvailable: false,
      pinnedOnly: true,
      callGateway,
    });
    const schema = tool.parameters as {
      properties?: {
        pin?: { const?: boolean };
        presentation?: { properties?: { target?: unknown } };
      };
      required?: string[];
    };

    expect(tool.requiredClientCaps).toBeUndefined();
    expect(schema.required).toContain("pin");
    expect(schema.properties?.pin?.const).toBe(true);
    expect(schema.properties?.presentation?.properties).not.toHaveProperty("target");
    expect(tool.description).toContain("This surface is pinned-only");

    await expect(
      tool.execute("scheduled-unpinned", {
        title: "Scheduled status",
        widget_code: "<main>ready</main>",
      }),
    ).rejects.toThrow("pin=true is required for this pinned-only widget surface");
    await expect(
      tool.execute("scheduled-target", {
        title: "Scheduled status",
        widget_code: "<main>ready</main>",
        pin: true,
        presentation: { target: "assistant_message" },
      }),
    ).rejects.toThrow("presentation.target is unavailable for this pinned-only widget surface");

    const result = await tool.execute("scheduled-pinned", {
      title: "Scheduled status",
      widget_code: "<button onclick=\"this.textContent='updated'\">Update</button>",
      name: "scheduled-status",
      pin: true,
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    expect(JSON.parse(text ?? "null")).toEqual({
      status: "pinned",
      boardWidgetName: "scheduled-status",
      capabilityState: "none",
      text: "Widget pinned to dashboard tab main as scheduled-status. Open this dashboard tab in Control UI to view it.",
    });
    expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith(
      "board.widget.put",
      expect.objectContaining({
        sessionKey: "agent:main:dashboard:scheduled",
        name: "scheduled-status",
        content: {
          kind: "html",
          html: "<button onclick=\"this.textContent='updated'\">Update</button>",
        },
      }),
    );
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });
});

describe("show_widget script syntax gate", () => {});
