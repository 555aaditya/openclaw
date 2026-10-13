import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { finalizeRuntimePromptImages } from "../media/runtime-prompt-image-provenance.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginHookBeforeMessageWriteEvent } from "../plugins/types.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { readTranscriptMessages } from "../sessions/user-turn-transcript.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";

registerAgentSessionLoopTestLifecycle();
afterEach(resetGlobalHookRunner);

describe("pre-admitted channel photos", () => {
  it.each([
    { vision: false, writeHook: false },
    { vision: true, writeHook: false },
    { vision: true, writeHook: true },
  ])(
    "preserves the accepted photo turn with a stale runtime snapshot (vision=$vision, hook=$writeHook)",
    async ({ vision, writeHook }) => {
      await withOpenClawTestState({ label: "channel-photo-admission" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId: "channel-photo",
          sessionKey: "agent:main:channel-photo",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        // Channel ingress persists separately from the runtime's already-open view.
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        const { session } = await createTestSession({
          sessionManager: manager,
          model: { ...testModel, input: vision ? ["text", "image"] : ["text"] },
        });
        try {
          const caption = "What should he write next?";
          const hook = vi.fn(({ message }: PluginHookBeforeMessageWriteEvent) =>
            message.role === "user" && typeof message.content === "string"
              ? { message: { ...message, content: `[approved] ${message.content}` } }
              : undefined,
          );
          if (writeHook) {
            const registry = createEmptyPluginRegistry();
            registry.typedHooks.push({
              pluginId: "photo-admission-fixture",
              hookName: "before_message_write",
              source: "test",
              handler: hook,
            });
            initializeGlobalHookRunner(registry);
          }
          const imagePath = path.join(state.workspaceDir, "input-photo.png");
          const imageBuffer = createSolidPngBuffer(2, 2, { r: 12, g: 34, b: 56 });
          await fs.writeFile(imagePath, imageBuffer);
          const recorder = createUserTurnTranscriptRecorder({
            input: {
              text: caption,
              timestamp: 1,
              idempotencyKey: "channel-user:v1:photo",
              media: [
                {
                  path: imagePath,
                  url: "media://inbound/input-photo.png",
                  contentType: "image/png",
                  kind: "image",
                  workspaceDir: state.workspaceDir,
                },
              ],
              mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
            },
            target: { ...target, sessionEntry: undefined },
            beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
          });
          await recorder.persistApproved();
          const accepted = await readTranscriptMessages(target);
          expect(accepted).toHaveLength(1);
          guardSessionManager(manager, {
            preparedUserTurnMessage: await recorder.resolveMessage(),
            preparedUserTurnTranscriptRecorder: recorder,
          });
          const image = {
            type: "image" as const,
            data: imageBuffer.toString("base64"),
            mimeType: "image/png",
          };
          streamMocks.streamSimple.mockImplementation((model) =>
            createAssistantResultStream(
              createAssistant(model, [{ type: "text", text: "Photo answered" }]),
            ),
          );
          await session.prompt(caption, {
            images: vision ? finalizeRuntimePromptImages([{ image, factIndex: 0 }]).images : [],
            persistedUserIdempotencyKey: "channel-user:v1:photo",
            expandPromptTemplates: false,
          });
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
          const users = streamMocks.streamSimple.mock.calls[0]![1].messages.filter(
            (message) => message.role === "user",
          );
          expect(users).toHaveLength(1);
          if (vision) {
            expect(users[0]?.content).toContainEqual(image);
          }
          expect(session.getLastAssistantText()).toBe("Photo answered");
          const persisted = await readTranscriptMessages(target);
          expect(persisted.filter((message) => message.role === "user")).toEqual(accepted);
          expect(recorder.getPersistedMessage?.()).toEqual(accepted[0]);
          if (writeHook) {
            expect(hook.mock.calls.filter(([event]) => event.message.role === "user")).toHaveLength(
              1,
            );
            expect(accepted[0]?.content).toBe(`[approved] ${caption}`);
          }
        } finally {
          session.dispose();
        }
      });
    },
  );
});
