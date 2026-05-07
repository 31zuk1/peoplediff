# PeopleDiff

PeopleDiffは、中国語版「人民网」と日本語版「人民网日本語版」の新着記事を比較し、言語ごとに変化する国家メディアのナラティブを観測するPoCダッシュボードです。

これは翻訳ビューアではありません。記事が「翻訳されたか」だけでなく、「どの記事が対外向けに選ばれたか」「同じ話題でも本文・論点・政治表現がどう変わったか」を見るためのOSINT / policy intelligence UIです。

## Features

- 中国語版と日本語版の新着・日別記事スクレイピング
- cheerioによる本文、日時、カテゴリ、URL抽出
- OpenAI APIによる中国語タイトル翻訳、要約、本文差分分析
- タイトル類似、翻訳タイトル類似、キーワード類似による記事マッチング
- `MATCHED`、`CN ONLY`、`JP ONLY` のフィルタ
- `MATCHED`内での `BODY DIFF` / `FRAMING` 補助バッジ
- 消えている論点を赤い `-`、強調されている論点を緑の `+` で表示
- ダーク/ライトモード
- 日付別スナップショット保存と日付セレクタ

## Stack

- Next.js App Router
- TypeScript
- TailwindCSS
- cheerio
- OpenAI API
- Vercel想定のNode.js Route Handler

## Setup

```bash
npm install
cp .env.example .env.local
```

`.env.local` にOpenAI API keyを入れます。

```bash
OPENAI_API_KEY=sk-...
```

任意設定:

```bash
# Defaults to gpt-4o-mini
OPENAI_MODEL=gpt-4o-mini

# Defaults to ./data/snapshots
PEOPLEDIFF_DATA_DIR=/absolute/path/to/snapshots
```

起動:

```bash
npm run dev
```

ブラウザで `http://localhost:3000` を開き、`最新記事を更新` を押してください。

## Commands

```bash
npm run dev
npm run build
npm run start
```

## OpenAIなしの挙動

`OPENAI_API_KEY` がない場合でも、スクレイピング、本文抽出、簡易要約、ヒューリスティックなマッチングは動きます。

API keyがある場合は、以下が有効になります。

- 中国語タイトルの日本語翻訳
- 中国語本文の簡易要約
- 日中本文比較
- 消えている論点、強調されている論点、論調差分、政治表現差分のJSON生成

## UIの見方

上部フィルタ:

- `ALL`: 取得した全ペアを表示
- `CN`: 中国語版にのみ存在する記事
- `JP`: 日本語版にのみ存在する記事
- `MATCHED`: 中国語版と日本語版が同じ話題を扱っている記事

`MATCHED` の中で差分がある場合、カードに補助バッジが付きます。

- `BODY DIFF`: 本文量、論点、背景、数値、具体情報に差がある
- `FRAMING`: 論調、価値判断、政治表現、対外向け説明の仕方に差がある

比較パネルでは、赤い `-` が日本語版側で消えている/弱くなっている論点、緑の `+` が日本語版側で追加・強調されている論点です。

## Data Archives

更新時、取得結果は日付別に分割されます。

```text
data/snapshots/latest.json
data/snapshots/2026-05-07.json
data/snapshots/2026-05-06.json
data/snapshots/index.json
```

サイト上の日付セレクタは、保存済み日付のスナップショットを読み込みます。

APIでも日付指定できます。

```bash
curl "http://localhost:3000/api/refresh?date=2026-05-07"
```

注意: `data/snapshots/*.json` は `.gitignore` 対象です。履歴データはリポジトリにコミットしない前提です。

## API

### `GET /api/refresh`

最新スナップショットを返します。

### `GET /api/refresh?date=YYYY-MM-DD`

日付別スナップショットを返します。

### `POST /api/refresh`

両サイトを取得し、本文抽出、記事マッチング、OpenAI比較、キャッシュ更新、日付別保存を行います。

例:

```json
{
  "dates": ["2026-05-07", "2026-05-06"],
  "maxPages": 8,
  "maxArticles": 240
}
```

`dates` を省略した場合は、トップページ中心の小さなサンプル取得になります。

## Project Structure

```text
app/
  api/refresh/route.ts   API route for refresh/read
  page.tsx               Dashboard entry
components/
  Dashboard.tsx          Main UI
  StatusBadge.tsx        Status label component
lib/
  cache.ts               Latest + daily archive storage
  compare.ts             Refresh pipeline and stats
  matcher.ts             Article matching
  openai.ts              OpenAI enrichment and analysis
  scraper.ts             People's Daily scraping
  text.ts                Text normalization and similarity helpers
  types.ts               Shared types
data/snapshots/
  .gitkeep               Snapshot directory placeholder
```

## Deployment

Vercelにデプロイできます。

1. GitHubにpush
2. VercelでImport
3. Environment Variablesを設定
   - `OPENAI_API_KEY`
   - optional: `OPENAI_MODEL`
4. Deploy

重要: Vercel serverlessの実行時ファイルシステムは永続ではありません。このリポジトリの `data/snapshots` 保存は、ローカルや永続ディスクのあるサーバー向けのPoC保存層です。継続運用で履歴を確実に残す場合は、Vercel Blob、KV、Postgres、S3などに `lib/cache.ts` を差し替えてください。

## Current Limitations

- スクレイピングは人民网側のHTML変更に影響されます。
- マッチングは軽量ヒューリスティックです。完全なニュース同定ではありません。
- OpenAI比較は上位のマッチ済み記事を中心に実行します。
- 日付はURL日付と本文日付の両方を持ちます。ズレた場合は `dateMismatch` として保持します。
- ファイルベースの履歴保存はPoC向けです。

## Design Intent

PeopleDiffの目的は「翻訳の有無」を見ることではなく、言語ごとに変化する情報編集を直感的に観察することです。

見るべき問いは次の3つです。

- 中国語版にはあるが、日本語版にはない話題は何か
- 同じ話題でも、日本語版で消える/強調される論点は何か
- 対外向けに政治表現やフレーミングがどう変わるか
