import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { expect, test, vi } from "vitest";
import { signGatewayWorkerDevice } from "./gateway-worker-device.ts";

test("worker imports the existing Ed25519 identity and produces a challenge-bound signature", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", webcrypto);
  try {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const identity = {
      deviceId: "synthetic-device",
      publicKey: "synthetic-public",
      privateKey: btoa(String.fromCharCode(...privateKey.slice(-32))),
    };
    const payload =
      "v2|synthetic-device|openclaw-control-ui|webchat|operator|operator.read|1800000000000||nonce";
    const signature = await signGatewayWorkerDevice({ identity, payload });
    const bytes = Uint8Array.from(
      atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        pair.publicKey,
        bytes,
        new TextEncoder().encode(payload),
      ),
    ).toBe(true);
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        pair.publicKey,
        bytes,
        new TextEncoder().encode(`${payload}-other`),
      ),
    ).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
