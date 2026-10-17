export type StorageObjectInfo = { key: string; sizeBytes: number; modifiedAt?: number };

export type StorageBackend = {
  /** Non-secret human-readable target. */
  displayTarget: string;
  probe: (opts?: { signal?: AbortSignal }) => Promise<{ freeBytes?: number; totalBytes?: number }>;
  /** Never overwrite an existing key; sizeBytes is exact when provided. */
  putObject: (
    key: string,
    body: AsyncIterable<Uint8Array>,
    opts: { sizeBytes?: number; signal?: AbortSignal },
  ) => Promise<{ sizeBytes: number }>;
  getObject: (
    key: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<Uint8Array> | undefined>;
  statObject: (
    key: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<StorageObjectInfo | undefined>;
  listObjects: (
    prefix: string,
    opts?: { signal?: AbortSignal },
  ) => AsyncIterable<StorageObjectInfo>;
  deleteObject: (key: string, opts?: { signal?: AbortSignal }) => Promise<void>;
  close?: () => Promise<void>;
};
