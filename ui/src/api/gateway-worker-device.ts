type DeviceSeed = { deviceId: string; publicKey: string; privateKey: string };
type SignInput = { identity: DeviceSeed; payload: string };

let database: Promise<IDBDatabase> | undefined;
const keys = new Map<string, Promise<CryptoKey>>();

function deviceDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("openclaw-worker-prototype-device-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

async function loadSigningKey(identity: DeviceSeed): Promise<CryptoKey> {
  const db = await deviceDatabase();
  const stored = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const request = db.transaction("keys", "readonly").objectStore("keys").get(identity.deviceId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (stored) return stored;
  const binary = atob(identity.privateKey.replaceAll("-", "+").replaceAll("_", "/"));
  const seed = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // RFC 8410 PKCS#8 wraps the existing Ed25519 seed; pairing identity stays unchanged.
  const der = new Uint8Array(16 + seed.length);
  der.set([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  der.set(seed, 16);
  const key = await crypto.subtle.importKey("pkcs8", der, "Ed25519", false, ["sign"]);
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("keys", "readwrite");
    transaction.objectStore("keys").put(key, identity.deviceId);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  return key;
}

/** Flagged experiment seeds the existing identity once; signing and key custody stay here. */
export async function signGatewayWorkerDevice(value: unknown): Promise<string> {
  const { identity, payload } = value as SignInput;
  let key = keys.get(identity.deviceId);
  if (!key) {
    key = loadSigningKey(identity);
    keys.set(identity.deviceId, key);
  }
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", await key, new TextEncoder().encode(payload)),
  );
  return btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
