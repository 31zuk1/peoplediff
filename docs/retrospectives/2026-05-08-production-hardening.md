# 2026-05-08 Production Hardening Retrospective

## Context

PeopleDiffを研究室PoCから本番公開に近い状態へ引き上げるため、本文公開リスク以外のP0/P1要件を優先して実装した。

- rollback point: `1b68b96` (`Snapshot current PeopleDiff state before production hardening`)
- hardening commit: `b51977e` (`Harden production refresh and storage`)
- branch: `codex/production-hardening`
- pushed remote: `origin/codex/production-hardening`

## Goal

今日公開する前提で、最低限つぶすべき運用事故を減らす。

- 公開環境から誰でも重いrefreshを起動できないようにする。
- Vercel serverlessの揮発ファイルシステムに履歴を依存しない。
- cronで定期更新できる入口を用意する。
- refreshの多重実行を抑える。
- OpenAI使用量と概算コストをrun単位で追えるようにする。
- build時のTurbopack NFT警告を消す。

## What Changed

- `POST /api/refresh` を `PEOPLEDIFF_ADMIN_TOKEN` のBearer認証で保護した。
- 公開UIは本番デフォルトで読み取り専用にし、更新ボタンを隠すようにした。
- `lib/snapshot-store.ts` と `lib/local-snapshot-store.ts` を追加し、Vercel Blob / local file storeを切り替えられるようにした。
- `GET /api/cron/refresh` を追加し、`CRON_SECRET` と `PEOPLEDIFF_CRON_TARGETS` でVercel Cronから更新できるようにした。
- Blob上のlockファイルで、複数インスタンス間の同一refresh多重実行を抑制した。
- `lib/telemetry.ts` を追加し、run id、duration、warning数、OpenAI calls/tokens/cost、storage backendをsnapshotに保存するようにした。
- `@vercel/blob` を依存に追加した。
- `README.md` と `.env.example` に本番環境変数と運用手順を追記した。

## Verification Log

- `npm run build`
  - success
  - Turbopack NFT warningは解消
  - `punycode` deprecation warningのみ残存。依存由来で、今回のリリースブロッカーではない。
- production-like local server
  - `POST /api/refresh` without admin token: `401`
  - `GET /api/cron/refresh` without cron secret: `401`
  - `GET /api/refresh?targetLanguage=JP`: `200`
  - authorized `POST /api/refresh`: `200`, cache hit
  - public page did not render the refresh button when admin token was set
- git
  - branch pushed to GitHub
  - worktree clean after `b51977e`

## Agent Work Allocation

- Storage worker: Blob/local snapshot store, cache refactor, storage docs.
- Auth/cron worker: admin token, cron route, cron docs.
- Telemetry worker: OpenAI usage/cost metadata and structured refresh logs.
- Reviewer: production blockers, auth/storage/lock/budget/NFT/page-dynamic review.

Follow-up retrospective review agents were also started for:

- implementation risk review of the hardening commit
- release/documentation review

These follow-up reviews found several P1 issues that were fixed before public release.

## What Went Well

- 事前に `1b68b96` を切ったため、作業前状態へ戻れる安全点を確保できた。
- 既存の `readSnapshot` / `writeSnapshot` 呼び出しを保ったまま保存層を差し替えたので、UIやcompare pipelineへの波及を抑えられた。
- build後にNFT警告まで追い、`local-snapshot-store.ts` のパス処理を直して警告を消せた。
- 認証、公開GET、UI read-only、cache hitの最低限の本番相当確認を行えた。
- telemetryをsnapshotに入れたので、今後「重い」「高い」を感覚ではなくrun単位の数字で見られるようになった。

## Problems Found

### Fixed: local production without token could still allow refresh

初回実装では `!process.env.VERCEL && !process.env.PEOPLEDIFF_ADMIN_TOKEN` をローカル扱いにしていた。

これは `npm run dev` では便利だが、Vercel以外の本番環境や `npm run start` でトークン未設定の場合にもPOST refreshが開く余地があった。公開前の振り返りで見つかったため、development modeだけに限定するよう修正した。

Fix:

- `lib/auth.ts`: `isLocalDevelopmentWithoutAdminToken()` を追加し、`NODE_ENV !== "production"` を必須化。
- `app/page.tsx`: 更新ボタン表示条件も同じ関数に統一。
- `README.md`: dev bypassは `npm run dev` だけであることを追記。

### Fixed: refresh lock was too narrow

`b51977e` ではlock keyがrefresh signature由来だった。同じ `CN-target` の `latest*.json` / `index*.json` に書くrefreshでも、日付範囲や上限が違えば別lockになり、並行実行で最後に終わった方がlatest/indexを上書きする可能性があった。

Fix:

- `app/api/refresh/route.ts`: process-local in-flight keyとBlob lock keyを `source-target` の出力単位に変更。
- `app/api/cron/refresh/route.ts`: cronも `CN-target` 単位でlockするように変更。
- 同一出力単位で別signatureが走っている場合は `409` を返す。

### Fixed: archive date listing could make latest unreadable

`withArchiveDates()` が毎回Blob listに依存していたため、`latest*.json` が読めていてもBlob list失敗で画面全体が500になる可能性があった。

Fix:

- `lib/cache.ts`: `index*.json` をread-sideでも優先して使う。
- indexがない/壊れている場合だけBlob listへfallbackする。
- list失敗時は空配列に落とし、latest snapshot自体は返せるようにした。

### Fixed: malformed lock blob recovery

既存lock blobが壊れていてJSONとして読めない場合、refreshが手動Blob掃除まで復旧しづらかった。

Fix:

- `lib/snapshot-store.ts`: unreadable/malformed lockは削除してlock作成を一度retryする。
- lock release処理を `lockHandle()` に分離した。

### Fixed: release docs were underspecified

READMEだけでは、初回seed、本番UI更新不可、Vercel Blob必須性、cron上限の調整、smoke testが読み取りづらかった。

Fix:

- `.env.example`: `PEOPLEDIFF_AI_CONCURRENCY` と `PEOPLEDIFF_SCRAPE_CONCURRENCY` を追加。
- `README.md`: 本番UIはread-only、初回seed必須、VercelではBlob必須、preview smoke test、cron上限調整を追記。

### Residual: real Vercel Blob write is not yet verified

SDK integrationとbuildは通ったが、本物の `BLOB_READ_WRITE_TOKEN` を使ったread/write/list/lock/releaseは未検証。

Release gate:

- Vercel環境変数を入れたpreview deploymentで、JPの小さな更新を1回実行する。
- Blobに `snapshots/latest.json`, daily snapshot, `index.json`, `.locks/` の作成/削除が期待通りか確認する。

### Residual: OpenAI price table is code-owned

telemetryはモデル別に概算コストを出すが、単価表は `lib/telemetry.ts` 内の固定値である。

今後モデルを変える場合は、価格表の更新をリリースチェックに含める。未知モデルは現状nano単価にフォールバックするため、過小/過大推定の可能性がある。

### Residual: refresh still runs synchronously inside route handler

今回の範囲では、POST/cronは同期的にscrape -> OpenAI -> writeまで実行する。Vercelの `maxDuration` 内に収まる想定だが、対象言語や日付範囲を増やすとtimeoutが残る。

Next step:

- job table / queue / background worker化
- refresh status endpoint
- partial write抑止の明示的なjob state管理

### Residual: budgets are capped but not per-run stopped

API入力の `maxPages`, `maxArticles`, `aiArticleLimit` は上限で丸めたが、OpenAI dollar budgetで途中停止する仕組みはまだない。

Next step:

- `PEOPLEDIFF_OPENAI_RUN_BUDGET_USD`
- budget exceeded時はanalysisを止め、scrape resultは保存するか失敗扱いにするかを設計する。

## Release Checklist

- Vercel env vars:
  - `OPENAI_API_KEY`
  - `PEOPLEDIFF_ADMIN_TOKEN`
  - `CRON_SECRET`
  - `BLOB_READ_WRITE_TOKEN`
  - `PEOPLEDIFF_STORAGE=blob`
  - optional: `PEOPLEDIFF_CRON_TARGETS=JP,EN`
  - optional: `OPENAI_MODEL=gpt-4.1-nano`
  - optional: `OPENAI_REPAIR_MODEL=gpt-4.1-nano`
- Preview deployment smoke test:
  - public page loads
  - refresh button is hidden in production
  - unauthenticated POST returns 401
  - cron without secret returns 401
  - authenticated small refresh succeeds
  - Blob latest/daily/index files are created
  - run metadata shows nonzero duration and storage `blob`
- After smoke test:
  - enable cron
  - run first scheduled update manually or wait for JST 01:05
  - inspect one CN/JP and one CN/EN snapshot

## PM Notes

今回の一番大きな判断は「本文公開リスクはいったん法務相談待ちにし、運用事故リスクを先につぶす」ことだった。これは研究PoCを今日出す目的には合っている。

ただし、公開後に研究者以外へURLが広がるなら、本文キャッシュ、robots/スクレイピング許容、引用範囲、アクセス制限は別途P0として戻すべき。
