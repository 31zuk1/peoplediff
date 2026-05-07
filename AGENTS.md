# AGENTS.md

This file is for coding agents working on PeopleDiff.

## Product Intent

PeopleDiff is not a news app and not a translation app.

It is a PoC interface for observing how People's Daily changes selection, wording, body detail, and framing between the Chinese edition and the Japanese edition.

Preserve this framing when changing the product:

- Show selective visibility: what exists only in Chinese or only in Japanese.
- Show topic connection: what is the same story across editions.
- Show narrative difference: what disappears, what is emphasized, and how political language changes.
- Keep the UI closer to OSINT / policy analysis than a generic news reader.

## Tech Stack

- Next.js App Router
- TypeScript
- TailwindCSS
- cheerio scraping
- OpenAI API
- File-based PoC archive in `data/snapshots`

Main entry points:

- `components/Dashboard.tsx`: primary dashboard UI
- `app/api/refresh/route.ts`: refresh/read API
- `lib/scraper.ts`: article collection and body extraction
- `lib/matcher.ts`: CN/JP article matching
- `lib/openai.ts`: OpenAI enrichment and comparison
- `lib/compare.ts`: refresh pipeline and stats
- `lib/cache.ts`: latest and daily snapshot storage
- `lib/types.ts`: shared data types

## Core Semantics

Do not change these labels casually.

- `MATCHED`: CN and JP both cover the same topic. It does not mean there is no difference.
- `CN ONLY`: an article appears only in the Chinese-side collection.
- `JP ONLY`: an article appears only in the Japanese-side collection.
- `BODY DIFF`: supplementary UI signal for differences in body detail, missing points, emphasized points, numbers, background, or specificity.
- `FRAMING`: supplementary UI signal for differences in tone, value judgment, political language, or external-facing explanation.

The top-level filter intentionally uses:

```text
ALL / CN / JP / MATCHED
```

Differences are shown inside `MATCHED` via badges and the comparison panel.

## Data and Persistence

Current storage is file-based:

```text
data/snapshots/latest.json
data/snapshots/YYYY-MM-DD.json
data/snapshots/index.json
```

These JSON files are ignored by git. Do not commit scraped snapshot data unless the user explicitly asks for a fixture.

`PEOPLEDIFF_DATA_DIR` can override the archive directory.

Important: Vercel serverless runtime writes are not durable. For real ongoing production history, replace `lib/cache.ts` with a durable storage adapter such as Vercel Blob, KV, Postgres, S3, or another database.

## OpenAI Behavior

`OPENAI_API_KEY` is optional. Without it, the app should still scrape and render heuristic summaries and matches.

When editing prompts in `lib/openai.ts`, keep this bias:

- It is better to surface an observable difference than to hide it.
- But do not invent differences when articles are substantively the same.
- If no meaningful difference is visible, the analysis should be allowed to say so.

The output should remain structured JSON suitable for the UI.

## Scraping Guidance

Scraping is intentionally pragmatic. People's Daily templates vary.

When changing `lib/scraper.ts`:

- Prefer tolerant extraction with multiple selectors.
- Keep deduplication.
- Preserve `urlDate`, `publishedDate`, and `dateMismatch`.
- Do not assume URL date and body date are always identical.
- Avoid brittle parsing that depends on one exact template.

## Matching Guidance

Matching is heuristic, not canonical NLP.

When changing `lib/matcher.ts`:

- Prefer conservative topic matching over broad accidental matches.
- Use translated title, raw title, aliases, keywords, and category hints together.
- Preserve the meaning that matched topic pairs should be displayed as `MATCHED`.
- Keep difference classification separate from match status.

## UI Guidance

The UI should feel like a media observation dashboard.

Prefer:

- compact, scannable layouts
- consistent control heights and column widths
- clear status labels and badges
- dark/light mode compatibility
- editor-like red `-` and green `+` rows for missing/emphasized points

Avoid:

- generic news site styling
- marketing-style hero sections
- hiding the core comparison below decorative content
- adding separate tabs that show the same data under different names

## Local Workflow

Use:

```bash
npm run dev
npm run build
```

Before finishing UI or type changes, run:

```bash
npm run build
```

If a local server is already running, do not start another one on the same port.

## Environment

Required for AI analysis:

```bash
OPENAI_API_KEY=...
```

Optional:

```bash
OPENAI_MODEL=gpt-4o-mini
PEOPLEDIFF_DATA_DIR=/absolute/path/to/snapshots
```

Never commit `.env`, `.env.local`, API keys, or generated snapshot JSON.

## Deployment Notes

This project is Vercel-compatible as a PoC because scraping and OpenAI calls run in a Node.js route handler.

For serious long-term operation, add:

- durable storage
- scheduled refresh
- rate/error monitoring
- retry/backoff for scraping
- a stronger article identity model

Keep those additions scoped. This project should stay fast to understand and easy to ship.
