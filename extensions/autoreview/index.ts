import path from "node:path";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { helperProvenance } from "./src/helper-provenance.js";
import { pinInstalledHelper } from "./src/helper.js";
import { reviewCandidate, type ReviewInput } from "./src/review.js";

const configSchema = {
  type: "object",
  properties: { helperPath: { type: "string", minLength: 1 } },
  required: ["helperPath"],
  additionalProperties: false,
};

function readInput(value: unknown): ReviewInput {
  const input = asOptionalObjectRecord(value);
  if (
    !input ||
    Object.keys(input).some((key) => !["base", "datasets", "maxPriority"].includes(key)) ||
    (input.base !== undefined &&
      (typeof input.base !== "string" || !/^[a-f0-9]{40}$/.test(input.base))) ||
    (input.maxPriority !== undefined &&
      !["P0", "P1", "P2", "P3"].includes(String(input.maxPriority))) ||
    (input.datasets !== undefined &&
      (!Array.isArray(input.datasets) ||
        input.datasets.length > 64 ||
        input.datasets.some(
          (item) =>
            typeof item !== "string" ||
            !item ||
            item.length > 2048 ||
            path.isAbsolute(item) ||
            item.split(/[\\/]/).includes(".."),
        )))
  ) {
    throw new Error(
      "AutoReview accepts only a full base commit, up to 64 repository-relative evidence paths, and priority P0–P3.",
    );
  }
  return input as ReviewInput;
}

export default definePluginEntry({
  id: "autoreview",
  name: "AutoReview",
  description:
    "Independent structured review through the current agent's configured isolated runtime.",
  configSchema: { jsonSchema: configSchema },
  register(api) {
    const config = asOptionalObjectRecord(api.pluginConfig);
    let helper: ReturnType<typeof pinInstalledHelper>;
    try {
      if (typeof config?.helperPath !== "string") throw new Error("missing installation");
      helper = pinInstalledHelper(config.helperPath);
    } catch {
      api.logger.warn(
        `AutoReview unavailable. Configure the shared helper at canonical revision ${helperProvenance.revision} and Python 3.10+, then reload the plugin. See /tools/autoreview.`,
      );
      return;
    }
    const lifetime = new AbortController();
    const active = new Set<Promise<unknown>>();
    const dispose = async () => {
      lifetime.abort();
      await Promise.allSettled([...active]);
    };
    api.lifecycle.registerRuntimeLifecycle({
      id: "autoreview",
      dispose,
      cleanup: async ({ reason, sessionKey, runId }) => {
        if (
          sessionKey === undefined &&
          runId === undefined &&
          ["disable", "restart"].includes(reason)
        )
          await dispose();
      },
    });
    api.registerTool(
      {
        contextVersion: 2,
        create(ctx): AnyAgentTool | null {
          if (
            !ctx.sandboxProgram?.immutableSystemImage ||
            !ctx.workspaceDir ||
            !ctx.agentId ||
            !ctx.sessionKey ||
            lifetime.signal.aborted
          )
            return null;
          return {
            name: "autoreview",
            label: "Review current candidate",
            description:
              "Use this canonical native review entry point directly before any guest review-CLI preflight. Run independent structured review of this session's full Git candidate: HEAD (or an explicit base commit), staged changes, working changes, and untracked files. Uses this agent's configured reviewer in an isolated runtime with no external or repository capabilities. Supply repository-relative datasets for relevant unchanged callers, tests, and dependency context; missing context must be reported as incomplete. Default priority is P0; use P1–P3 only when requested. Returns immutable capture hashes, reviewer identity, validated findings and status. Only scoped-clean is clean for that target and priority; filtered, incomplete, unavailable, or changed-source outcomes do not satisfy a clean-review gate. Does not commit or publish.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                base: {
                  type: "string",
                  pattern: "^[a-f0-9]{40}$",
                  description: "Optional full base commit for the complete dirty candidate.",
                },
                datasets: {
                  type: "array",
                  maxItems: 64,
                  items: { type: "string", maxLength: 2048 },
                  description: "Repository-relative evidence files; no symlink escapes.",
                },
                maxPriority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
              },
            },
            async execute(_id, params, callerSignal) {
              const signal = AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(600_000),
                ...(callerSignal ? [callerSignal] : []),
              ]);
              const operation = reviewCandidate(helper, ctx, readInput(params), signal);
              active.add(operation);
              try {
                const result = await operation;
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  details: result,
                };
              } catch (error) {
                const code = asOptionalObjectRecord(error)?.code;
                const reason =
                  error instanceof Error && error.message.startsWith("AutoReview ")
                    ? error.message
                    : typeof code === "string" && /^LLM_[A-Z_]+$/.test(code)
                      ? `${code}: the configured reviewer could not complete an admitted isolated review.`
                      : "AutoReview stopped before a complete validated result. Check the configured reviewer, shared helper version, invocation lifetime, and source drift; no clean review was produced.";
                const result = { status: "reviewer_unavailable", reason };
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  details: result,
                  isError: true,
                };
              } finally {
                active.delete(operation);
              }
            },
          };
        },
      },
      { name: "autoreview", optional: true, workspaceAccess: false },
    );
  },
});
