# hatena-rss-tracker (anond2ch) 設計仕様書

はてなブックマーク（および増田・匿名ダイアリー等）の RSS フィードを定期的に取得・蓄積し、SQLite データベースの更新とランキング等の静的コンテンツ生成を自動化するシステムです。

---

## 1. システム全体概要

外部 cron サービスからのイベントをトリガーとして GitHub Actions を起動し、クラウド上の仮想マシン（Runner）で RSS データを解析して SQLite に保存、差分を GitHub 側のリポジトリ（`main` ブランチ）へ自動コミット・Push します。GitHub Actions 自身の `schedule` は実行遅延があるため、定時実行には使用していません。


```text
[ 外部 cron サービス ]
         │ (repository_dispatch: trigger-fetch)
         ▼
[ GitHub Actions (Runner) ]
  ├── node scripts/fetch_rss.js ── HTTP GET ──▶ [ はてな RSS フィード ]
  │      └── RSS取得 ＆ SQLite DB 更新 (`data/*.db`)
  └── git commit & git push（変更がある場合） ──▶
[ GitHub Remote Repository (main) ]
  ├── data/ (SQLite DB群)
  └── docs/ (GitHub Pages等で公開する静的HTML)
  
```

---
## 2. データの管理と3つのツリー構造

本プロジェクトでは、ファイルの状態が以下の 3 箇所に分散して存在します。

| 環境 / ツリー | 役割・特徴 | データの永続性 |
| :--- | :--- | :--- |
| **1. ローカル環境** | 開発者の PC。コードの編集・手動検証を行う場所。 | ローカルディスクに保存 |
| **2. GitHub リモート** | 正本データ（`main` ブランチ）。DB や生成物の保管庫。 | 永続保存 |
| **3. Actions 実行環境** | ワークフロー起動毎に生成される使い捨ての仮想マシン。 | **ジョブ終了時に消滅** |

> **【重要】データの同期フロー**  
> Actions（3）は実行時に GitHub（2）の最新状態を `checkout` します。処理完了後に `git push` を行うことで、Actions 上で更新された SQLite DB を GitHub（2）へ反映します。開発者が手元で作業する際は、競合を避けるため `git pull` で最新の DB を取得してから更新を行います。

---

## 3. データベース（SQLite）仕様

Node.js 内蔵の `node:sqlite` (`DatabaseSync`) を使用し、年月別に分割された SQLite データベースファイルへ記事URLごとの初回取得データを記録します。

### ディレクトリ構成
* 保存先: `data/`
* ファイル命名規則:
  * ホットエントリー: `data/hotentry_{YYYY}.db`（年単位）
  * 新着エントリー: `data/allentry_{YYYY}{MM}.db`（月単位）

### テーブル定義

#### 1. `hot_entries` (人気エントリー)
```sql
CREATE TABLE IF NOT EXISTS hot_entries (
  link TEXT NOT NULL PRIMARY KEY,
  title TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
```

* `link` を主キーとして、記事URLごとに初回取得時のデータだけ保存します。
* `bookmark_count` と `category` は保存しません。
* 既存DBは記事URLごとの最古の取得データを残して重複行を削除し、新しいスキーマへ移行します。

#### 2. `all_entries` (新着エントリー)

```sql
CREATE TABLE IF NOT EXISTS all_entries (
  link TEXT NOT NULL PRIMARY KEY,
  title TEXT NOT NULL,
  pub_date TEXT,
  fetched_at TEXT NOT NULL
);
```

* `link` を主キーとし、全月のAllentry DBを照合して同じ記事は初回取得時のデータのみ保存します。以後の取得では重複としてスキップします。
* 既存の全月DBは記事URLごとの最古の取得データを残して重複行を削除し、新しいスキーマへ移行します。

## 4. データ取得ロジック (`scripts/fetch_rss.js`)

`rss-parser` を使用して RSS 1.0 (RDF) をパースします。はてな独自のタグを取得するためカスタムフィールドを設定しています。

### 主な設定と処理仕様

* **カスタムフィールドの取得:**
  * `dc:date` ➔ `dcDate`（更新日時）
* **保存方式:**
  * 初回取得時の現在時刻を ISO8601 文字列（`fetched_at`）として記録。
  * HotentryとAllentryの両方で記事URLを主キーとして初回データのみ保存します。
* **トランザクション制御:**
  * `db.exec('BEGIN TRANSACTION;')` 単位で挿入を行い、`stmt.run()` の戻り値から実際の新規追加件数をログ出力します。

## 5. GitHub Actions ワークフロー仕様 (`.github/workflows/fetch.yaml`)

### 構成設定

* **トリガー:**
  * **定時実行:** 外部 cron サービスが `repository_dispatch` イベント（`event_type: trigger-fetch`）を送信
  * **手動実行:** GitHub Actions の `workflow_dispatch`
  * Actions 内の `schedule` は無効化中。定時実行には外部 cron を使用します。
* **権限 (`permissions`):** `contents: write`（リポジトリへの自動 Push 権限）
* **実行ステップ:**
  1. **Checkout:** `actions/checkout@v5`
  2. **Node.js セットアップ:** `actions/setup-node@v5` (Node.js 22 LTS 以上指定)
  3. **依存関係インストール:** `npm ci`（`package.json` が存在する場合）
  4. **スクリプト実行:** `node scripts/fetch_rss.js`（ランキング生成処理は現在無効）
  5. **自動コミット & Push:** 変更差分がある場合のみ `github-actions[bot]` 名義でコミット

---

## 6. 運用・注意点

### 外部 cron からの起動

GitHub Actions の `schedule` は、混雑時や低アクティビティのリポジトリで実行が遅延・間引きされることがあります。そのため定時実行は `cron-job.org` などの外部サービスに設定し、GitHub の `repository_dispatch` API を呼び出します。

* **HTTP メソッド:** `POST`
* **URL:** `https://api.github.com/repos/{owner}/{repo}/dispatches`
* **ヘッダー:** `Accept: application/vnd.github+json`、`Authorization: Bearer <token>`、`X-GitHub-Api-Version: 2022-11-28`
* **JSON ボディ:** `{"event_type":"trigger-fetch"}`
* **認証:** fine-grained personal access token を使う場合は対象リポジトリを選択し、`Contents: Read and write` を付与してください。トークンは外部 cron サービスのシークレットとして登録してください。

トークンを README、ソースコード、コマンドへの直書き、Git の管理対象ファイルに記録しないでください。コミット履歴に残ると、ファイルから削除しただけでは漏えいを解消できません。誤って公開した場合は、トークンを直ちに revoke（失効）して新しいものを発行してください。

ローカルから動作確認する場合は、トークンを環境変数 `GITHUB_TOKEN` に設定したうえで、次のコマンドを実行します。下記は PowerShell 用です。コマンド中にトークンの値は記入しません。

```powershell
curl.exe -L -X POST "https://api.github.com/repos/miz999/hatena-rss-tracker/dispatches" -H "Accept: application/vnd.github+json" -H "Authorization: Bearer $env:GITHUB_TOKEN" -H "X-GitHub-Api-Version: 2022-11-28" -d '{"event_type":"trigger-fetch"}'
```

`event_type` はワークフローの `repository_dispatch.types` に指定された `trigger-fetch` と一致させます。GitHub 上から手動で実行する場合は、Actions タブで対象ワークフローを選択し、`Run workflow` を実行してください。外部サービスから `workflow_dispatch` を呼び出す設定ではありません。

### `.gitignore` と `data/` の扱い

* `data/` フォルダを Git 管理対象とする場合は、`.gitignore` に `data/` を含めないでください。（含めると `git add data/` ステップでエラーとなります）