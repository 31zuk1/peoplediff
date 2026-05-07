import { promises as fs } from "node:fs";
import path from "node:path";
import type { Article, ArticlePair, RefreshResult } from "./types";
import { calculateStats, emptySnapshot } from "./compare";

const LEGACY_CACHE_PATH = path.join("/tmp", "peoplediff-cache.json");
const PRIMARY_ARCHIVE_DIR =
  process.env.PEOPLEDIFF_DATA_DIR || path.join(process.cwd(), "data", "snapshots");
const FALLBACK_ARCHIVE_DIR = path.join("/tmp", "peoplediff-snapshots");
const LATEST_FILE = "latest.json";
const INDEX_FILE = "index.json";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

declare global {
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_CACHE__: RefreshResult | undefined;
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_CACHE_BY_DATE__: Record<string, RefreshResult> | undefined;
  // eslint-disable-next-line no-var
  var __PEOPLEDIFF_WRITABLE_DIR__: string | undefined;
}

export async function readSnapshot(date?: string) {
  const normalizedDate = normalizeArchiveDate(date);
  if (normalizedDate) return readDatedSnapshot(normalizedDate);

  if (globalThis.__PEOPLEDIFF_CACHE__) {
    return withArchiveDates(globalThis.__PEOPLEDIFF_CACHE__);
  }

  const latest = await readFirstJson<RefreshResult>(
    archiveDirs().map((dir) => path.join(dir, LATEST_FILE))
  );
  if (latest) {
    globalThis.__PEOPLEDIFF_CACHE__ = stripArchiveMetadata(latest);
    return withArchiveDates(globalThis.__PEOPLEDIFF_CACHE__);
  }

  const latestDate = (await listArchiveDates())[0];
  if (latestDate) return readDatedSnapshot(latestDate);

  const legacy = await readFirstJson<RefreshResult>([LEGACY_CACHE_PATH]);
  if (legacy) {
    globalThis.__PEOPLEDIFF_CACHE__ = stripArchiveMetadata(legacy);
    return withArchiveDates(globalThis.__PEOPLEDIFF_CACHE__);
  }

  return withArchiveDates(emptySnapshot());
}

export async function writeSnapshot(snapshot: RefreshResult) {
  const cleanSnapshot = stripArchiveMetadata(snapshot);
  const writableDir = await writableArchiveDir();
  const dailySnapshots = splitSnapshotByDate(cleanSnapshot);

  globalThis.__PEOPLEDIFF_CACHE__ = cleanSnapshot;
  globalThis.__PEOPLEDIFF_CACHE_BY_DATE__ = {
    ...(globalThis.__PEOPLEDIFF_CACHE_BY_DATE__ ?? {}),
    ...Object.fromEntries(dailySnapshots)
  };

  if (writableDir) {
    await writeJson(path.join(writableDir, LATEST_FILE), cleanSnapshot);
    await Promise.all(
      [...dailySnapshots].map(([date, dailySnapshot]) =>
        writeJson(path.join(writableDir, `${date}.json`), dailySnapshot)
      )
    );
    await writeIndex(writableDir);
  }

  return withArchiveDates(cleanSnapshot);
}

async function readDatedSnapshot(date: string) {
  const cached = globalThis.__PEOPLEDIFF_CACHE_BY_DATE__?.[date];
  if (cached) return withArchiveDates(cached, date);

  const archived = await readFirstJson<RefreshResult>(
    archiveDirs().map((dir) => path.join(dir, `${date}.json`))
  );
  if (archived) {
    const cleanSnapshot = stripArchiveMetadata(archived);
    globalThis.__PEOPLEDIFF_CACHE_BY_DATE__ = {
      ...(globalThis.__PEOPLEDIFF_CACHE_BY_DATE__ ?? {}),
      [date]: cleanSnapshot
    };
    return withArchiveDates(cleanSnapshot, date);
  }

  const empty = {
    ...emptySnapshot(),
    dateScope: [date]
  };
  return withArchiveDates(empty, date);
}

async function withArchiveDates(snapshot: RefreshResult, activeDate?: string): Promise<RefreshResult> {
  return {
    ...snapshot,
    activeDate,
    archiveDates: await listArchiveDates()
  };
}

function splitSnapshotByDate(snapshot: RefreshResult) {
  const dates = collectSnapshotDates(snapshot);
  const dailySnapshots = new Map<string, RefreshResult>();

  for (const date of dates) {
    const pairs = snapshot.pairs.filter((pair) => pairTouchesDate(pair, date));
    const cnArticles = collectArticlesForDate(snapshot.cnArticles, pairs, "cn", date);
    const jpArticles = collectArticlesForDate(snapshot.jpArticles, pairs, "jp", date);

    dailySnapshots.set(date, {
      ...snapshot,
      activeDate: undefined,
      archiveDates: undefined,
      dateScope: [date],
      cnArticles,
      jpArticles,
      pairs,
      stats: calculateStats(pairs, cnArticles.length, jpArticles.length)
    });
  }

  return dailySnapshots;
}

function collectSnapshotDates(snapshot: RefreshResult) {
  const values = new Set<string>();

  snapshot.dateScope?.forEach((date) => {
    const normalized = normalizeArchiveDate(date);
    if (normalized) values.add(normalized);
  });

  [...snapshot.cnArticles, ...snapshot.jpArticles].forEach((article) => {
    const normalized = normalizeArchiveDate(articleDate(article));
    if (normalized) values.add(normalized);
  });

  return [...values].sort((a, b) => b.localeCompare(a));
}

function collectArticlesForDate(
  articles: Article[],
  pairs: ArticlePair[],
  side: "cn" | "jp",
  date: string
) {
  const byId = new Map<string, Article>();

  articles.forEach((article) => {
    if (articleDate(article) === date) byId.set(article.id, article);
  });

  pairs.forEach((pair) => {
    const article = pair[side];
    if (article) byId.set(article.id, article);
  });

  return [...byId.values()];
}

function pairTouchesDate(pair: ArticlePair, date: string) {
  return articleDate(pair.cn) === date || articleDate(pair.jp) === date;
}

function articleDate(article?: Article) {
  return article?.urlDate || article?.publishedDate;
}

async function listArchiveDates() {
  const files = await Promise.all(
    archiveDirs().map(async (dir) => {
      try {
        return await fs.readdir(dir);
      } catch {
        return [];
      }
    })
  );

  return [...new Set(files.flat().map((file) => file.replace(/\.json$/, "")).filter(isDate))]
    .sort((a, b) => b.localeCompare(a));
}

async function writableArchiveDir() {
  if (globalThis.__PEOPLEDIFF_WRITABLE_DIR__) return globalThis.__PEOPLEDIFF_WRITABLE_DIR__;

  for (const dir of archiveDirs()) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const testPath = path.join(dir, ".write-test");
      await fs.writeFile(testPath, "ok", "utf8");
      await fs.unlink(testPath).catch(() => undefined);
      globalThis.__PEOPLEDIFF_WRITABLE_DIR__ = dir;
      return dir;
    } catch {
      // Try the next candidate. Vercel's project filesystem is read-only at runtime.
    }
  }

  return undefined;
}

function archiveDirs() {
  return [...new Set([PRIMARY_ARCHIVE_DIR, FALLBACK_ARCHIVE_DIR])];
}

async function writeIndex(dir: string) {
  const dates = await listArchiveDates();
  await writeJson(path.join(dir, INDEX_FILE), {
    updatedAt: new Date().toISOString(),
    dates
  });
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function readFirstJson<T>(paths: string[]) {
  for (const filePath of paths) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      // Keep walking the fallback chain.
    }
  }
  return undefined;
}

function stripArchiveMetadata(snapshot: RefreshResult): RefreshResult {
  const { activeDate: _activeDate, archiveDates: _archiveDates, ...rest } = snapshot;
  return rest;
}

function normalizeArchiveDate(input?: string) {
  const match = input?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return undefined;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function isDate(input: string) {
  return DATE_PATTERN.test(input);
}
