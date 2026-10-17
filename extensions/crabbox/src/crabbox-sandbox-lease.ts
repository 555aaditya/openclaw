import { randomBytes } from "node:crypto";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";

export const CRABBOX_SANDBOX_LEASE_ID_PATTERN = /^cbx_[a-f0-9]{12}$/u;

/** The sandbox registry persists this generation before Crabbox provisioning starts. */
export function mintCrabboxSandboxLeaseId(): string {
  return `cbx_${randomBytes(6).toString("hex")}`;
}

/** An unavailable provider or a failed inspection does not prove a lease is gone. */
export function isMissingCrabboxSandboxLease(result: SpawnResult, identifier: string): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    result.termination !== "exit" ||
    result.code === null ||
    result.code === 0 ||
    !new RegExp(`(?:^|[^\\w-])${escapeRegExp(identifier)}(?=$|[^\\w-])`, "u").test(output) ||
    /\b(?:access\s+denied|auth|authentication|authorization|credentials?|forbidden|permission|token|unauthorized)\b/iu.test(
      output,
    )
  ) {
    return false;
  }
  if (/\bcoordinator\b/iu.test(output)) {
    return output
      .trim()
      .split(/[\r\n]+/u)
      .some((line) => {
        const response = line.match(
          /^(?:warning: could not inspect lease before release: )?coordinator (GET|POST) (?:https?:\/\/[^/\s]+)?\/v1\/leases\/([^/:?\s]+)(\/release)?(?:\?[^\s:]*)?:[ \t]*http (\d{3})\b([^\r\n]*)$/iu,
        );
        return (
          response?.[1] === "GET" &&
          response[2] === identifier &&
          !response[3] &&
          response[4] === "404"
        );
      });
  }
  return (
    (result.code === 4 &&
      (/\b(?:was\s+)?not found\b/iu.test(output) ||
        /\bno longer exists\b/iu.test(output) ||
        /\b(?:points to|is bound to) (?:a )?missing (?:instance|sandbox)\b/iu.test(output) ||
        /\bdisappeared before release\b/iu.test(output) ||
        /\bunknown blacksmith testbox(?:\s|:)/iu.test(output) ||
        /\bis not claimed by Crabbox\b/iu.test(output) ||
        /\bwandb sandbox "[^"\r\n]+" has no matching local ownership claim\b/iu.test(output) ||
        /\bunknown lease(?:\s|:)/iu.test(output))) ||
    (result.code === 5 && /\bcoder workspace "[^"\r\n]+" not found\b/iu.test(output))
  );
}
