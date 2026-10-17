import { describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

const { moveDestinationMocks } = getWorkerPlacementStartupMocks();
const workspace = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("./worker-environments/workspace-sync-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-environments/workspace-sync-preflight.js")>()),
  preflightWorkerWorkspace: workspace.preflight,
}));

import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import {
  createRuntime,
  setupSessionFixture,
} from "./server-worker-placement-provision-cancellation.test-support.js";
import { REQUEST as FIXTURE_REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import * as support from "./worker-environments/service.test-support.js";

const REQUEST = {
  ...FIXTURE_REQUEST,
  profileId: "development",
  executionMode: "remote-exec" as const,
};

describe("dispatch admission before provider allocation", () => {
  support.setupWorkerEnvironmentServiceSuite();
  setupSessionFixture(REQUEST);

  it.each([
    { identity: REQUEST.sessionKey, inherited: false },
    { identity: REQUEST.sessionId, inherited: false },
    { identity: "legacy-session-alias", inherited: false },
    { identity: REQUEST.sessionKey, inherited: true },
  ])("preserves active $identity work (inherited: $inherited)", async ({ identity, inherited }) => {
    const targetReader = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
      "./session-utils-store-worker.js",
    );
    moveDestinationMocks.prepareGatewaySessionTarget.mockImplementation((params) =>
      targetReader.resolveGatewaySessionStoreTargetInWorker({
        ...params,
        onSelected: (target) => {
          target.storeKeys.push("legacy-session-alias");
          params.onSelected?.(target);
        },
      }),
    );
    workspace.preflight.mockReset().mockResolvedValue(undefined);
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const environments = support.createService(support.createProvider());
    const allocate = vi
      .spyOn(environments, "createWithRequest")
      .mockRejectedValue(new Error("fixture: barrier complete"));
    const start = vi.spyOn(placements, "startDispatch");
    const runtime = await createRuntime(placements, environments);
    const interrupted = vi.fn();
    const admission = await beginSessionWorkAdmission({
      scope: `${support.testState.root}/sessions.sqlite`,
      identities: [identity],
      assertAllowed: () => {},
      onInterrupt: () => {
        interrupted();
        admission.release();
      },
    });
    const dispatch = () => runtime.dispatchService.dispatch(REQUEST);
    try {
      if (inherited) {
        await expect(admission.run(dispatch)).rejects.toThrow("fixture: barrier complete");
        expect(start).toHaveBeenCalledOnce();
      } else {
        await expect(dispatch()).rejects.toThrow("is busy with active work");
        expect(workspace.preflight).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(await placements.getAsync(REQUEST.sessionId)).toBeUndefined();
      }
      expect(interrupted).not.toHaveBeenCalled();
      expect(admission.isActive()).toBe(true);
      expect(allocate).toHaveBeenCalledTimes(inherited ? 1 : 0);
    } finally {
      admission.release();
    }
    if (!inherited) {
      await expect(dispatch()).rejects.toThrow("fixture: barrier complete");
      expect(start).toHaveBeenCalledOnce();
      expect(allocate).toHaveBeenCalledOnce();
    }
  });
});
