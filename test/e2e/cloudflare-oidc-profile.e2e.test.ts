import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  accessOrigin,
  accessRequest,
  githubCfg,
  identityResponse,
  oidcIdentity,
} from "../../src/gateway/github-user-identity.oidc.test-support.js";
import { resolveAuthenticatedHttpUserProfile } from "../../src/gateway/http-auth-user-profile.js";
import { GatewayOperatorAccessDeniedError } from "../../src/gateway/operator-access-policy.js";
import { resetPluginRuntimeStateForTest } from "../../src/plugins/runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";
import { resolveUserProfileGitHubAttribution } from "../../src/state/user-profile-github-identity.js";
import { getUserProfileListItem } from "../../src/state/user-profile-list-item.test-support.js";
import { prepareUserProfileCatalog } from "../../src/state/user-profile-list.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

afterEach(async () => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

it.each([false, true])(
  "preserves optional OIDC enrichment and denies retired policy roles (policy=%s)",
  async (requiresRetiredPolicy) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const email = "ada@example.test";
      const cfg: OpenClawConfig = {
        gateway: {
          ...githubCfg.gateway,
          ...(requiresRetiredPolicy
            ? {
                roles: {
                  default: "guest",
                  definitions: {
                    guest: {
                      ...githubCfg.gateway!.roles!.definitions.guest!,
                      accessPolicyPlugin: "visitor-access",
                    },
                  },
                },
              }
            : {}),
        },
      };
      const transport = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url) =>
          url === `${accessOrigin}/cdn-cgi/access/get-identity`
            ? identityResponse(oidcIdentity("01", "custom"))
            : identityResponse({}, 503),
        );
      const request = accessRequest(email, cfg);
      const catalog = await prepareUserProfileCatalog();
      try {
        if (requiresRetiredPolicy) {
          await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toBeInstanceOf(
            GatewayOperatorAccessDeniedError,
          );
        } else {
          const admitted = await resolveAuthenticatedHttpUserProfile(request);
          const profileId = admitted.authenticatedUserProfile!.profileId;
          expect(getUserProfileListItem(profileId)).toMatchObject({
            emails: [email],
            githubIdentity: null,
          });
          expect(
            (await resolveUserProfileGitHubAttribution([profileId])).get(profileId),
          ).toBeNull();
        }
        expect(transport).toHaveBeenCalledOnce();
      } finally {
        catalog.release();
        request.req.destroy();
      }
    });
  },
);
