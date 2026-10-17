import { expect, it } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import "../agents/test-helpers/fast-bash-tools.js";
import "../agents/test-helpers/fast-coding-tools.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";

it("refuses a cached owner portal catalog when grant checking retires admitted authority", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = { tools: { profile: "coding", allow: ["portal"] } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const authorityAbort = new AbortController();
    const admission = prepareAgentRunAdmission({
      cfg,
      operationalRunInstance: createOperationalRunInstanceRef("portal-controller"),
      facts: {
        runId: "portal-controller",
        agentId: "main",
        ingress: { kind: "system", boundary: "portal-readiness", state: "present" },
      },
      operatorAuthority: createAdmittedRunOperatorAuthority({
        profileId: "portal-controller",
        scopes: ["operator.write"],
        signal: authorityAbort.signal,
        assertCurrent: () => {},
      }),
    });
    const cache = new McpLoopbackToolCache();
    let retireDuringGrantCheck = false;
    try {
      const params: Parameters<McpLoopbackToolCache["resolve"]>[0] = {
        cfg,
        grantToken: "synthetic-owner-portal-grant",
        isGrantCurrent: () => {
          if (retireDuringGrantCheck) {
            authorityAbort.abort(new Error("Synthetic controller retirement"));
          }
          return true;
        },
        signal,
        admittedRunContext: await admission.admit("gateway"),
        context: {
          sessionKey: "agent:main:portal-readiness",
          sessionId: "portal-readiness",
          agentId: "main",
          senderIsOwner: true,
          toolsAllow: ["portal"],
        },
      };
      const primed = await cache.resolve(params);
      expect(primed.tools.map((tool) => tool.name)).toEqual(["portal"]);
      expect(await cache.resolve(params)).toBe(primed);
      retireDuringGrantCheck = true;
      await expect(cache.resolve(params)).rejects.toThrow(
        "admitted run operator authority is no longer active",
      );
    } finally {
      cache.clear();
      admission.close();
    }
  });
});
