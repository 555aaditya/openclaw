import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { StorageLocationConfig } from "../config/types.storage.js";
import { initStorageLocation, openStorageLocation, probeStorageLocation } from "./locations.js";
import type { StorageObjectInfo } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const markerKey = "openclaw-storage.json";
const replacementMarker = Buffer.from(
  JSON.stringify({
    version: 1,
    locationId: "11111111-1111-4111-8111-111111111111",
    createdAt: 0,
    encryption: "none",
  }),
);

async function* bytes(value: Uint8Array | string) {
  yield typeof value === "string" ? Buffer.from(value) : value;
}

async function collect(body: AsyncIterable<Uint8Array> | undefined): Promise<Buffer> {
  if (!body) {
    throw new Error("Expected an object stream");
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function list(body: AsyncIterable<StorageObjectInfo>): Promise<StorageObjectInfo[]> {
  const objects: StorageObjectInfo[] = [];
  for await (const object of body) {
    objects.push(object);
  }
  return objects.toSorted((left, right) => left.key.localeCompare(right.key));
}

function configFor(location: StorageLocationConfig): OpenClawConfig {
  return { storage: { locations: { archive: location } } };
}

function filesystemParams(
  directory: string,
  encryption: StorageLocationConfig["encryption"] = "none",
) {
  return {
    name: "archive",
    config: configFor({ provider: "filesystem", settings: { path: directory }, encryption }),
  };
}

describe("storage locations", () => {
  it("refuses runtime access to an uninitialized directory without creating anything", async () => {
    const directory = tempDirs.make("openclaw-storage-location-");
    const params = filesystemParams(directory);
    await expect(
      (async () => {
        const location = await openStorageLocation(params);
        try {
          await location.putObject("backup.bin", bytes("must not be written"), {});
        } finally {
          await location.close();
        }
      })(),
    ).rejects.toMatchObject({
      state: "unavailable",
      message: expect.stringContaining("openclaw storage init archive"),
    });
    await expect(probeStorageLocation(params)).resolves.toMatchObject({ state: "unavailable" });
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });

  it("requires an existing root during explicit initialization", async () => {
    const parent = tempDirs.make("openclaw-storage-location-");
    const directory = path.join(parent, "missing");
    await expect(initStorageLocation(filesystemParams(directory))).rejects.toMatchObject({
      name: "StorageLocationError",
      state: "unavailable",
      message:
        "Storage directory is unavailable. Reconnect the disk and check the configured path; storage init requires an existing directory.",
    });
    await expect(probeStorageLocation(filesystemParams(directory))).resolves.toMatchObject({
      state: "unavailable",
    });
    await expect(fs.readdir(parent)).resolves.toEqual([]);
  });

  it("initializes idempotently with the same key and reports a wrong passphrase", async () => {
    const directory = tempDirs.make("openclaw-storage-location-");
    const params = {
      ...filesystemParams(directory, {
        passphrase: { source: "env", provider: "default", id: "STORAGE_TEST_PASSPHRASE" },
      }),
      env: { STORAGE_TEST_PASSPHRASE: "example-storage-passphrase-not-real" },
    };
    const first = await initStorageLocation(params);
    const identity = first.describe();
    await first.close();
    const marker = await fs.readFile(path.join(directory, markerKey));
    const second = await initStorageLocation(params);
    try {
      expect(second.describe()).toEqual(identity);
      expect(identity.encrypted).toBe(true);
      await expect(second.probe()).resolves.toMatchObject({ state: "ok" });
    } finally {
      await second.close();
    }
    await expect(fs.readFile(path.join(directory, markerKey))).resolves.toEqual(marker);
    await expect(
      probeStorageLocation({
        ...params,
        env: { STORAGE_TEST_PASSPHRASE: "example-wrong-passphrase-not-real" },
      }),
    ).resolves.toMatchObject({ state: "wrong-key" });
  });

  it("keeps scoped streams plaintext while filesystem objects contain ciphertext and logical sizes", async () => {
    const directory = tempDirs.make("openclaw-storage-location-");
    const params = filesystemParams(directory, {
      passphrase: "example-storage-passphrase-not-real",
    });
    const location = await initStorageLocation(params);
    try {
      const scoped = location.scope("snapshots").scope("first");
      const payload = Buffer.alloc(1_048_577, 0x5a);
      await expect(
        scoped.putObject("data.bin", bytes(payload), { sizeBytes: payload.length }),
      ).resolves.toMatchObject({ sizeBytes: payload.length, storedBytes: expect.any(Number) });
      await scoped.putObject("empty.bin", bytes(Buffer.alloc(0)), { sizeBytes: 0 });
      await location.scope("snapshots/second").putObject("other.bin", bytes("other"), {});
      const stored = await fs.readFile(path.join(directory, "snapshots/first/data.bin"));
      expect(stored?.subarray(0, 8).toString()).toBe("OCSTOR1\n");
      expect(stored?.includes(payload)).toBe(false);
      expect(await collect(await scoped.getObject("data.bin"))).toEqual(payload);
      expect(await collect(await scoped.getObject("empty.bin"))).toEqual(Buffer.alloc(0));
      const dataStat = await fs.stat(path.join(directory, "snapshots/first/data.bin"));
      const emptyStat = await fs.stat(path.join(directory, "snapshots/first/empty.bin"));
      await expect(scoped.stat("data.bin")).resolves.toEqual({
        key: "data.bin",
        sizeBytes: payload.length,
        storedBytes: stored!.length,
        modifiedAt: dataStat.mtimeMs,
      });
      await expect(list(scoped.list())).resolves.toEqual([
        {
          key: "data.bin",
          sizeBytes: payload.length,
          storedBytes: stored!.length,
          modifiedAt: dataStat.mtimeMs,
        },
        {
          key: "empty.bin",
          sizeBytes: 0,
          storedBytes: emptyStat.size,
          modifiedAt: emptyStat.mtimeMs,
        },
      ]);
      expect((await list(location.list())).map((object) => object.key)).not.toContain(markerKey);
      await scoped.delete("data.bin");
      await expect(scoped.getObject("data.bin")).resolves.toBeUndefined();
      await expect(
        fs.stat(path.join(directory, "snapshots/second/other.bin")),
      ).resolves.toMatchObject({ size: expect.any(Number) });
    } finally {
      await location.close();
    }
  });

  it("revokes an existing handle when its marker is replaced", async () => {
    const directory = tempDirs.make("openclaw-storage-location-");
    const params = filesystemParams(directory);
    const location = await initStorageLocation(params);
    try {
      await fs.writeFile(path.join(directory, markerKey), replacementMarker);
      await expect(location.putObject("later.bin", bytes("blocked"), {})).rejects.toMatchObject({
        state: "unavailable",
      });
      await expect(location.probe()).resolves.toMatchObject({ state: "unavailable" });
      await expect(fs.readdir(directory)).resolves.toEqual([markerKey]);
    } finally {
      await location.close();
    }
  });

  it("refuses publication if identity changes while consuming the upload", async () => {
    const directory = tempDirs.make("openclaw-storage-location-");
    const params = filesystemParams(directory);
    const location = await initStorageLocation(params);
    try {
      async function* interrupted() {
        yield Buffer.from("first bytes");
        await fs.writeFile(path.join(directory, markerKey), replacementMarker);
        yield Buffer.from("last bytes");
      }
      await expect(location.putObject("later.bin", interrupted(), {})).rejects.toMatchObject({
        state: "unavailable",
      });
      await expect(fs.readdir(directory)).resolves.toEqual([markerKey]);
    } finally {
      await location.close();
    }
  });

  it("validates keys and namespaces before filesystem access", async () => {
    const directory = tempDirs.make("openclaw-storage-location-");
    const params = filesystemParams(directory);
    const location = await initStorageLocation(params);
    try {
      for (const key of [
        "",
        ".",
        "..",
        "a/../b",
        "/absolute",
        "back\\slash",
        "empty//segment",
        "trailing/",
        "a".repeat(513),
      ]) {
        await expect(location.putObject(key, bytes("blocked"), {})).rejects.toThrow();
        await expect(location.getObject(key)).rejects.toThrow();
        await expect(location.stat(key)).rejects.toThrow();
        await expect(location.delete(key)).rejects.toThrow();
        expect(() => location.scope(key)).toThrow();
      }
      await expect(list(location.list("invalid//prefix"))).rejects.toThrow();
      await expect(location.delete(markerKey)).rejects.toThrow("reserved");
      await expect(fs.readdir(directory)).resolves.toEqual([markerKey]);
    } finally {
      await location.close();
    }
  });
});
