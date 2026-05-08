import { BlobNotFoundError, del, get, list, put } from "@vercel/blob";

const DEFAULT_BLOB_PREFIX = "snapshots/";

export type SnapshotStore = {
  backend: "blob" | "file";
  readJson<T>(name: string): Promise<T | undefined>;
  writeJson(name: string, value: unknown): Promise<void>;
  listNames(): Promise<string[]>;
  readLegacyJson?<T>(): Promise<T | undefined>;
  acquireLock?(name: string, ttlMs: number): Promise<SnapshotLock | undefined>;
};

export type SnapshotLock = {
  name: string;
  release(): Promise<void>;
};

export function createSnapshotStore(): SnapshotStore {
  return shouldUseBlobStore() ? createBlobSnapshotStore() : createLocalSnapshotStoreProxy();
}

export function snapshotStorageBackend() {
  return shouldUseBlobStore() ? "blob" : "file";
}

export function usesDurableSnapshotStore() {
  return shouldUseBlobStore();
}

export async function acquireSnapshotLock(
  name: string,
  ttlMs: number
): Promise<SnapshotLock | undefined> {
  if (!shouldUseBlobStore()) {
    return {
      name,
      async release() {
        // Local file mode relies on the process-local in-flight guard.
      }
    };
  }

  return createBlobSnapshotStore().acquireLock?.(name, ttlMs);
}

function shouldUseBlobStore() {
  const storage = process.env.PEOPLEDIFF_STORAGE?.trim().toLowerCase();
  if (storage === "blob") return true;
  if (storage === "file" || storage === "fs") return false;
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

function createBlobSnapshotStore(): SnapshotStore {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    throw new Error("PEOPLEDIFF_STORAGE=blob requires BLOB_READ_WRITE_TOKEN.");
  }

  const prefix = normalizeBlobPrefix(process.env.PEOPLEDIFF_BLOB_PREFIX);

  return {
    backend: "blob",
    async readJson<T>(name: string) {
      const blob = await get(blobPath(prefix, name), {
        access: "private",
        token,
        useCache: false
      }).catch((error: unknown) => {
        if (isBlobMissing(error)) return null;
        throw error;
      });

      if (!blob || blob.statusCode !== 200 || !blob.stream) return undefined;
      const raw = await new Response(blob.stream).text();
      return JSON.parse(raw) as T;
    },

    async writeJson(name: string, value: unknown) {
      await put(blobPath(prefix, name), JSON.stringify(value, null, 2), {
        access: "private",
        allowOverwrite: true,
        contentType: "application/json; charset=utf-8",
        token
      });
    },

    async listNames() {
      const names = new Set<string>();
      let cursor: string | undefined;

      do {
        const result = await list({
          cursor,
          limit: 1000,
          prefix,
          token
        });

        result.blobs.forEach((blob) => {
          if (blob.pathname.startsWith(prefix)) {
            names.add(blob.pathname.slice(prefix.length));
          }
        });
        cursor = result.cursor;
      } while (cursor);

      return [...names];
    },

    async acquireLock(name: string, ttlMs: number) {
      const lockName = `.locks/${safeLockName(name)}.json`;
      const pathname = blobPath(prefix, lockName);
      const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      const payload = { owner, expiresAt };
      const createLock = async () => {
        await put(pathname, JSON.stringify(payload), {
          access: "private",
          allowOverwrite: false,
          contentType: "application/json; charset=utf-8",
          token
        });
      };

      try {
        await createLock();
      } catch (error) {
        const existing = await readLockJson(pathname, token);
        if (!existing) throw error;
        if (new Date(existing.expiresAt).getTime() > Date.now()) return undefined;
        await del(pathname, { token }).catch(() => undefined);
        try {
          await createLock();
        } catch {
          return undefined;
        }
      }

      return {
        name,
        async release() {
          const current = await readLockJson(pathname, token).catch(() => undefined);
          if (current?.owner !== owner) return;
          await del(pathname, { token }).catch(() => undefined);
        }
      };
    }
  };
}

function createLocalSnapshotStoreProxy(): SnapshotStore {
  return {
    backend: "file",
    async readJson<T>(name: string) {
      return (await createLocalStore()).readJson<T>(name);
    },

    async writeJson(name: string, value: unknown) {
      await (await createLocalStore()).writeJson(name, value);
    },

    async listNames() {
      return (await createLocalStore()).listNames();
    },

    async readLegacyJson<T>() {
      return (await createLocalStore()).readLegacyJson?.<T>();
    }
  };
}

async function createLocalStore() {
  const { createLocalSnapshotStore } = await import("./local-snapshot-store");
  return createLocalSnapshotStore();
}

function normalizeBlobPrefix(input: string | undefined) {
  const value = input?.trim() || DEFAULT_BLOB_PREFIX;
  return value.endsWith("/") ? value : `${value}/`;
}

function blobPath(prefix: string, name: string) {
  return `${prefix}${name.replace(/^\/+/, "")}`;
}

function safeLockName(input: string) {
  return input.replace(/[^a-z0-9._-]/gi, "_").slice(0, 120) || "refresh";
}

async function readLockJson(pathname: string, token: string) {
  const blob = await get(pathname, {
    access: "private",
    token,
    useCache: false
  }).catch((error: unknown) => {
    if (isBlobMissing(error)) return null;
    throw error;
  });
  if (!blob || blob.statusCode !== 200 || !blob.stream) return undefined;
  try {
    return JSON.parse(await new Response(blob.stream).text()) as {
      owner: string;
      expiresAt: string;
    };
  } catch {
    return undefined;
  }
}

function isBlobMissing(error: unknown) {
  return error instanceof BlobNotFoundError;
}
