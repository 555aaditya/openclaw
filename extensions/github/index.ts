import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createGitHubReadTool } from "./src/read-tool.js";
import { createGitHubSearchTool } from "./src/search-tool.js";

export default definePluginEntry({
  id: "github",
  name: "GitHub",
  description: "Public GitHub link previews and document reader",
  register(api) {
    api.registerTool(
      { contextVersion: 2, create: (context) => createGitHubReadTool(api, context) },
      { name: "github_read", workspaceAccess: false },
    );
    api.registerTool(
      { contextVersion: 2, create: (context) => createGitHubSearchTool(api, context) },
      { name: "github_search", workspaceAccess: false },
    );
    const host = api.config.gateway?.github?.host?.trim().toLowerCase();
    if (host && host !== "github.com") {
      for (const [method, kind] of [
        ["github.sessionPreview", "preview"],
        ["github.sessionDetail", "detail"],
      ] as const) {
        api.registerGatewayMethod(
          method,
          async (options) => {
            const { handleSessionGitHubRequest } = await import("./src/handlers.js");
            await handleSessionGitHubRequest(kind, host, options);
          },
          { scope: "operator.read" },
        );
      }
    }
    // HTTP readers load only on their first request.
    // The shipped controlUi.githubPreview host adapter retains managed identity
    // selection and calls this plugin's public data API; it is not re-registered.
    for (const method of ["github.preview", "github.detail", "github.image"] as const) {
      api.registerGatewayMethod(
        method,
        async (options) => {
          const { githubHandlers } = await import("./src/handlers.js");
          await githubHandlers[method](options);
        },
        // Public GitHub data does not depend on the caller's user profile.
        // Gateway connect/role/operator.read checks still own admission.
        { scope: "operator.read", profileAccess: "independent" },
      );
    }
  },
});
