/* @vitest-environment jsdom */

import type { ClawsDraftsReadResult, ClawsDraftsReviewResult } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createContext,
  createRuntimeConfigStub,
} from "../skill-workshop/skill-workshop-page.test-support.ts";
import { ClawDraftPage } from "./draft-page.tsx";
import { ClawDraftPageState } from "./draft-state.ts";

const target = { agentId: "research", draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087" };
const initial = { content: '{"name":"release-notes"}', revision: "a".repeat(64) };
const reviewed: ClawsDraftsReviewResult = {
  revision: initial.revision,
  reviewToken: "b".repeat(64),
  publisher: "alice",
  name: "@alice/release-notes",
  version: "0.1.0",
  files: [{ path: "CLAW.md", content: "Write release notes from an approved change list." }],
  scope: {
    input: "Approved changes",
    job: "Draft release notes",
    output: "Markdown",
    authority: "Read only",
  },
};

function draftContext(request: ReturnType<typeof vi.fn>) {
  return createContext(request, {
    methods: [
      "sessions.create",
      "claws.drafts.create",
      "claws.drafts.read",
      "claws.drafts.save",
      "claws.drafts.review",
      "claws.drafts.publish",
    ],
    runtimeConfig: createRuntimeConfigStub({
      sourceConfig: { gateway: { controlUi: { experimental: { claws: true } } } },
    }),
  });
}

describe("Claw draft review", () => {
  it("requires review after edits, displays the personal publisher, and reports pending publication accurately", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "claws.drafts.read") {
        return initial;
      }
      if (method === "claws.drafts.review") {
        return reviewed;
      }
      if (method === "claws.drafts.publish") {
        return {
          name: reviewed.name,
          version: reviewed.version,
          url: "https://clawhub.ai/alice/release-notes",
          publicationStatus: "pending",
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const context = draftContext(request);
    const page = mountSolid(() => <ClawDraftPage target={target} />, {
      wrapper: createSolidApplicationContextProvider(context).wrapper,
    });
    await waitForSolid(() =>
      expect(page.getByRole("textbox")).toHaveProperty("value", initial.content),
    );
    expect(page.queryByRole("button", { name: "Publish to ClawHub" })).toBeNull();
    page.getByRole("button", { name: "Review package" }).click();
    await waitForSolid(() => expect(page.getByText("Personal publisher: @alice")).toBeTruthy());
    expect(page.getByText(reviewed.files[0]!.content)).toBeTruthy();
    const editor = page.getByRole("textbox");
    Object.assign(editor, { value: '{"name":"edited"}' });
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSolid(() =>
      expect(page.queryByRole("button", { name: "Publish to ClawHub" })).toBeNull(),
    );
    expect(page.getByRole("button", { name: "Review package" })).toHaveProperty("disabled", true);
    Object.assign(editor, { value: initial.content });
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSolid(() =>
      expect(page.getByRole("button", { name: "Review package" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    page.getByRole("button", { name: "Review package" }).click();
    await waitForSolid(() =>
      expect(page.getByRole("button", { name: "Publish to ClawHub" })).toBeTruthy(),
    );
    page.getByRole("button", { name: "Publish to ClawHub" }).click();
    await waitForSolid(() =>
      expect(page.getByText("Submitted for security scanning")).toBeTruthy(),
    );
    expect(page.queryByText("Claw published")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.drafts.publish")).toHaveLength(
      1,
    );
  });

  it("starts one ordinary generation session with a review link and keeps its accepted run after navigation", async () => {
    const request = vi.fn(async () => ({
      draftId: target.draftId,
      path: "/private/draft.json",
      prompt: "Write the private draft.",
    }));
    const context = draftContext(request);
    const creation = createDeferredCore<SessionCreateOutcome | null>();
    context.sessions.createResult = vi.fn(() => creation.promise);
    const page = mountSolid(
      () => (
        <ClawDraftPage
          target={{ agentId: target.agentId, sourceSessionKey: "agent:research:source" }}
        />
      ),
      {
        wrapper: createSolidApplicationContextProvider(context).wrapper,
      },
    );
    await waitForSolid(() =>
      expect(page.getByRole("button", { name: "Generate private draft" })).toBeTruthy(),
    );
    const generate = page.getByRole("button", { name: "Generate private draft" });
    generate.click();
    generate.click();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
    expect(context.sessions.createResult).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "research",
        parentSessionKey: "agent:research:source",
        fork: true,
        forkFrom: "last-completed",
        message: expect.stringContaining(`/agents/claws?draft=${target.draftId}&agent=research`),
      }),
      { reconciliation: "background" },
    );
    page.unmount();
    creation.resolve({
      key: "agent:research:generated",
      initialRun: { status: "started", runId: "draft-run" },
    });
    await vi.waitFor(() =>
      expect(context.chatSubmissions.retain).toHaveBeenCalledWith(
        expect.objectContaining({ pendingRunId: "draft-run" }),
      ),
    );
    expect(context.navigate).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it("discards an old draft response after the selected draft changes", async () => {
    const first = createDeferredCore<ClawsDraftsReadResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ content: "new draft", revision: "c".repeat(64) });
    const state = new ClawDraftPageState(draftContext(request));
    state.sync(target);
    state.sync({ ...target, draftId: "a38c9f34-e1a3-4d5d-8c30-06cd456896d3" });
    await vi.waitFor(() => expect(state.content).toBe("new draft"));
    first.resolve(initial);
    await first.promise;
    expect(state.content).toBe("new draft");
    state.dispose();
  });
});
