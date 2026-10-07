export type CollectionMode = "broad" | "jp-major";

export function collectionMode(value: unknown, fallback: CollectionMode = "broad"): CollectionMode {
  if (typeof value !== "string") return fallback;
  if (/^(broad|legacy|wide)$/i.test(value.trim())) return "broad";
  if (/^(jp-major|jp_major|anchored|jp-anchored|jp_anchor|jp-anchor)$/i.test(value.trim())) return "jp-major";
  return fallback;
}

export function defaultCollectionMode(): CollectionMode {
  // Keep existing production archives visible when deploying the optional JP mode.
  return collectionMode(process.env.PEOPLEDIFF_DEFAULT_MODE);
}
