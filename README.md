# PeopleDiff

PeopleDiffは、中国語版「人民网」を基準に、人民網の日本語版・英語版・仏語版など対象言語版の新着記事を比較し、言語ごとに変化する国家メディアのナラティブを観測するPoCダッシュボードです。

これは翻訳ビューアではありません。記事が「翻訳されたか」だけでなく、「どの記事が対外向けに選ばれたか」「同じ話題でも本文・論点・政治表現がどう変わったか」を見るためのOSINT / policy intelligence UIです。

## Features

- 中国語版と対象言語版の新着・日別記事スクレイピング
- 中国語版を基準にした対象言語切替（英語、日本語、仏語、スペイン語、ロシア語、アラビア語、韓国語、ドイツ語、ポルトガル語、スワヒリ語、イタリア語、カザフ語、タイ語、マレー語、ギリシャ語、ベトナム語、ウルドゥー語、ヒンディー語など）
- cheerioによる本文、日時、カテゴリ、URL抽出
- OpenAI APIによる中国語/対象言語タイトルの日本語化、要約、本文差分分析
- タイトル類似、翻訳タイトル類似、キーワード類似による記事マッチング
- `MATCHED`、`CN ONLY`、対象言語のみ（JPの場合は`JP ONLY`）のフィルタ
- `MATCHED`内での `BODY DIFF` / `FRAMING` 補助バッジ
- 消えている論点を赤い `-`、強調されている論点を緑の `+` で表示
- ダーク/ライトモード
- ライブ更新の日付範囲指定、日付別スナップショット保存と日付セレクタ

## Language Coverage

PeopleDiffの基準言語は現時点では中国語版（CN）固定です。対象言語はUIから切り替えられ、まずは `CN -> target` の1:1比較として動きます。

人民網の外語チャンネルとして、2025年4月時点で英、法、俄、阿、西、日、韓、独、葡、スワヒリ、伊、カザフ（キリル）、タイ、マレー、ギリシャ、ベトナム、ウルドゥー、ヒンディーの18言語が確認できます。人民網サイトマップには、これとは別に蒙文、藏文、维文、哈文、朝鲜文、彝文、壮文などの民族語版も掲載されています。

保存ファイルは言語ペアごとに分離されます。既存互換のため `CN-JP` は従来通り `latest.json` / `YYYY-MM-DD.json` を使い、それ以外は `latest.CN-EN.json` / `YYYY-MM-DD.CN-EN.json` のような名前になります。

JSONでは `baseArticles` / `targetArticles` が正本です。`cnArticles` はCN互換、`jpArticles` はJP比較時の互換フィールドとして残しています。EN/FRなど非JPターゲットでは、片側掲載記事の保存ステータスは `TARGET ONLY` になります。

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

# Defaults to gpt-4.1-nano; used only to repair non-Japanese UI analysis text before snapshots are saved
OPENAI_REPAIR_MODEL=gpt-4.1-nano

# Defaults to ./data/snapshots
PEOPLEDIFF_DATA_DIR=/absolute/path/to/snapshots

# Defaults to local file storage unless BLOB_READ_WRITE_TOKEN is set
PEOPLEDIFF_STORAGE=blob

# Vercel Blob read-write token
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...

# Defaults to snapshots/
PEOPLEDIFF_BLOB_PREFIX=snapshots/

# Required for protected refresh endpoints
PEOPLEDIFF_ADMIN_TOKEN=change-me
CRON_SECRET=change-me-too

# Optional. Comma/space-separated cron target languages. Defaults to JP.
PEOPLEDIFF_CRON_TARGETS=JP,EN
```

起動:

```bash
npm run dev
```

ブラウザで `http://localhost:3000` を開き、`最新記事を更新` を押してください。

ライブ更新では日付範囲を指定できます。UIでは中国語版と対象言語版の両方を同じ期間で取得・表示します。

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
- 英語、仏語など対象言語タイトルの日本語翻訳
- 中国語本文の簡易要約
- 基準言語/対象言語の本文比較
- 消えている論点、強調されている論点、論調差分、政治表現差分のJSON生成

## UIの見方

上部フィルタ:

- `ALL`: 取得した全ペアを表示
- `CN`: 中国語版にのみ存在する記事
- `JP` / `EN` / `FR` など: 対象言語版にのみ存在する記事
- `MATCHED`: 中国語版と対象言語版が同じ話題を扱っている記事

`MATCHED` の中で差分がある場合、カードに補助バッジが付きます。

- `BODY DIFF`: 本文量、論点、背景、数値、具体情報に差がある
- `FRAMING`: 論調、価値判断、政治表現、対外向け説明の仕方に差がある

比較パネルでは、赤い `-` が対象言語版側で消えている/弱くなっている論点、緑の `+` が対象言語版側で追加・強調されている論点です。

## Data Archives

更新時、取得結果は日付別に分割されます。ローカルでは既定でファイル保存を使います。

```text
data/snapshots/latest.json
data/snapshots/2026-05-07.json
data/snapshots/2026-05-06.json
data/snapshots/index.json
```

サイト上の日付セレクタは、保存済み日付のスナップショットを読み込みます。

APIでも日付指定できます。

```bash
curl "http://localhost:3000/api/refresh?date=2026-05-07&targetLanguage=EN"
```

注意: `data/snapshots/*.json` は `.gitignore` 対象です。履歴データはリポジトリにコミットしない前提です。

本番で `PEOPLEDIFF_STORAGE=blob` を指定するか `BLOB_READ_WRITE_TOKEN` が存在する場合、同じスナップショット名をVercel Blobに保存します。既定のBlobパスは `snapshots/latest.json`、`snapshots/YYYY-MM-DD.json`、`snapshots/index.json` です。`CN-JP` 以外はファイル保存と同じく `latest.CN-EN.json`、`YYYY-MM-DD.CN-EN.json`、`index.CN-EN.json` のように言語ペア付きで保存されます。

## API

### `GET /api/refresh`

最新スナップショットを返します。

### `GET /api/refresh?date=YYYY-MM-DD`

日付別スナップショットを返します。

`sourceLanguage` は現時点ではCN固定です。`targetLanguage=EN`、`FR`、`JP` のように対象言語を指定できます。

### `POST /api/refresh`

`PEOPLEDIFF_ADMIN_TOKEN` で保護された管理者向け更新APIです。両サイトを取得し、本文抽出、記事マッチング、OpenAI比較、キャッシュ更新、日付別保存を行います。トークンは `Authorization: Bearer <token>` で送ります。

無認証または不正なトークンのPOSTは、スクレイピングやOpenAI処理を開始する前に `401` を返します。公開画面や外部利用は `GET /api/refresh` の読み取りに限定し、重い更新処理はこのPOSTまたはcronに寄せます。

例:

```bash
curl -X POST "http://localhost:3000/api/refresh" \
  -H "Authorization: Bearer $PEOPLEDIFF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetLanguage":"EN","dates":["2026-05-07","2026-05-06"]}'
```

リクエスト本文:

```json
{
  "targetLanguage": "EN",
  "dateFrom": "2026-05-06",
  "dateTo": "2026-05-07",
  "maxPages": 8,
  "maxArticles": 240,
  "aiArticleLimit": 32
}
```

`dates` に `["2026-05-07", "2026-05-06"]` のような配列を渡すこともできます。UIと同じ挙動にする場合は、`sourceDates` と `targetDates` に同じ配列を渡します。

`dates` / `dateFrom` / `dateTo` を省略した場合は、トップページ中心の小さなサンプル取得になります。

### `GET /api/cron/refresh`

Vercel Cron向けの更新APIです。`CRON_SECRET` を `Authorization: Bearer <secret>` で受け取り、`PEOPLEDIFF_CRON_TARGETS` に指定した対象言語を、JST基準の今日/昨日で更新します。

```bash
curl "http://localhost:3000/api/cron/refresh" \
  -H "Authorization: Bearer $CRON_SECRET"
```

cronの既定スケジュールは `vercel.json` の `5 16 * * *` です。これはUTC指定なので、日本時間では毎日01:05に実行されます。

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
  snapshot-store.ts      Snapshot storage selector and Vercel Blob store
  local-snapshot-store.ts Local file snapshot store
  compare.ts             Refresh pipeline and stats
  languages.ts           People's Daily language registry
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
   - optional: `OPENAI_REPAIR_MODEL`
   - `PEOPLEDIFF_ADMIN_TOKEN`
   - `CRON_SECRET`
   - optional: `PEOPLEDIFF_CRON_TARGETS`
   - optional: `PEOPLEDIFF_STORAGE=blob`
   - optional: `BLOB_READ_WRITE_TOKEN`
4. Deploy

重要: Vercel serverlessの実行時ファイルシステムは永続ではありません。本番で履歴を残す場合は、Vercel Blob storeを作成し、`BLOB_READ_WRITE_TOKEN` を環境変数に設定してください。`PEOPLEDIFF_STORAGE=blob` を併用すると、トークン未設定時に明示的に失敗します。Blobを使わないローカル/永続ディスク環境では、従来通り `data/snapshots` または `PEOPLEDIFF_DATA_DIR` に保存されます。

## Current Limitations

- スクレイピングは人民网側のHTML変更に影響されます。
- マッチングは軽量ヒューリスティックです。完全なニュース同定ではありません。
- OpenAI比較は上位のマッチ済み記事を中心に実行します。
- OpenAI翻訳は既定では取得記事の先頭範囲に上限を設けます。必要に応じて `aiArticleLimit` または `PEOPLEDIFF_AI_ARTICLE_LIMIT` で調整できます。
- 日付はURL日付と本文日付の両方を持ちます。ズレた場合は `dateMismatch` として保持します。
- ファイルベースの履歴保存はPoC向けです。

## Design Intent

PeopleDiffの目的は「翻訳の有無」を見ることではなく、言語ごとに変化する情報編集を直感的に観察することです。

見るべき問いは次の3つです。

- 中国語版にはあるが、対象言語版にはない話題は何か
- 同じ話題でも、対象言語版で消える/強調される論点は何か
- 対外向けに政治表現やフレーミングがどう変わるか
