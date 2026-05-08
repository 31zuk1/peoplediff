import type { SnapshotStore } from "./snapshot-store";

const LEGACY_CACHE_PATH = "/tmp/peoplediff-cache.json";
const FALLBACK_ARCHIVE_DIR = "/tmp/peoplediff-snapshots";

declare global {
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_WRITABLE_DIR__: string | undefined;
}

export function createLocalSnapshotStore(): SnapshotStore {
  return {
    backend: "file",
    async readJson<T>(name: string) {
      return readFirstJson<T>(archiveDirs().map((dir) => joinPath(dir, name)));
    },

    async writeJson(name: string, value: unknown) {
      const dir = await writableArchiveDir();
      if (!dir) throw new Error("No writable snapshot directory is available.");
      await writeJson(joinPath(dir, name), value);
    },

    async listNames() {
      const fileSets = await Promise.all(
        archiveDirs().map(async (dir) => {
          try {
            const fs = await import("node:fs/promises");
            return await fs.readdir(/*turbopackIgnore: true*/ dir);
          } catch {
            return [];
          }
        })
      );

      return [...new Set(fileSets.flat())];
    },

    async readLegacyJson<T>() {
      return readFirstJson<T>([LEGACY_CACHE_PATH]);
    }
  };
}

async function writableArchiveDir() {
  if (globalThis.__PEOPLEDIFF_WRITABLE_DIR__) return globalThis.__PEOPLEDIFF_WRITABLE_DIR__;

  for (const dir of archiveDirs()) {
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
      const testPath = joinPath(dir, ".write-test");
      await fs.writeFile(/*turbopackIgnore: true*/ testPath, "ok", "utf8");
      await fs.unlink(/*turbopackIgnore: true*/ testPath).catch(() => undefined);
      globalThis.__PEOPLEDIFF_WRITABLE_DIR__ = dir;
      return dir;
    } catch {
      // Try the next candidate. Vercel's project filesystem is read-only at runtime.
    }
  }

  return undefined;
}

function archiveDirs() {
  return [...new Set([primaryArchiveDir(), FALLBACK_ARCHIVE_DIR])];
}

function primaryArchiveDir() {
  const override = process.env.PEOPLEDIFF_DATA_DIR?.trim();
  if (override) return override;
  return `${process.cwd()}/data/snapshots`;
}

async function writeJson(filePath: string, value: unknown) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(/*turbopackIgnore: true*/ dirname(filePath), { recursive: true });
  await fs.writeFile(/*turbopackIgnore: true*/ filePath, JSON.stringify(value, null, 2), "utf8");
}

async function readFirstJson<T>(paths: string[]) {
  const fs = await import("node:fs/promises");

  for (const filePath of paths) {
    try {
      const raw = await fs.readFile(/*turbopackIgnore: true*/ filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      // Keep walking the fallback chain.
    }
  }

  return undefined;
}

function joinPath(dir: string, name: string) {
  const normalizedName = name.replace(/^\/+/, "");
  return dir.endsWith("/") ? `${dir}${normalizedName}` : `${dir}/${normalizedName}`;
}

function dirname(filePath: string) {
  const index = filePath.lastIndexOf("/");
  return index > 0 ? filePath.slice(0, index) : ".";
}
