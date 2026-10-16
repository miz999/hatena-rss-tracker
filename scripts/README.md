# hatena-rss-tracker (anond2ch) 設計仕様書

はてなブックマーク（および増田・匿名ダイアリー等）の RSS フィードを定期的に取得・蓄積し、SQLite データベースの更新とランキング等の静的コンテンツ生成を自動化するシステムです。

---

## 1. システム全体概要

GitHub Actions の定時実行（cron）をトリガーとし、クラウド上の仮想マシン（Runner）で RSS データを解析して SQLite に保存、差分を GitHub 側のリポジトリ（`main` ブランチ）へ自動コミット・Push します。


```text
[ はてな RSS フィード ]
         │ (HTTP GET)
         ▼
[ GitHub Actions (Runner) ]
  ├── 1. node scripts/fetch_rss.js
  │      └── RSS取得 ＆ SQLite DB 更新 (`data/*.db`)
  ├── 2. node scripts/generate_ranking.js
  │      └── DBからランキング等のHTML生成
  └── 3. git commit & git push
         └── 変更を GitHub リポジトリへ保存
         │
         ▼
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

Node.js 内蔵の `node:sqlite` (`DatabaseSync`) を使用し、年月別に分割された SQLite データベースファイルへ時系列スナップショットを記録します。

### ディレクトリ構成
* 保存先: `data/`
* ファイル命名規則:
  * ホットエントリー: `data/hotentry_{YYYY}.db`（年単位）
  * 新着エントリー: `data/allentry_{YYYY}{MM}.db`（月単位）

### テーブル定義

#### 1. `hot_entries` (人気エントリー)
```sql
CREATE TABLE IF NOT EXISTS hot_entries (
  link TEXT NOT NULL,
  title TEXT NOT NULL,
  bookmark_count INTEGER NOT NULL,
  category TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (link, fetched_at)
);
```

#### 2. `all_entries` (新着エントリー)

```sql
CREATE TABLE IF NOT EXISTS all_entries (
  link TEXT NOT NULL,
  title TEXT NOT NULL,
  bookmark_count INTEGER NOT NULL,
  pub_date TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (link, fetched_at)
);
```

## 4. データ取得ロジック (`scripts/fetch_rss.js`)

`rss-parser` を使用して RSS 1.0 (RDF) をパースします。はてな独自のタグを取得するためカスタムフィールドを設定しています。

### 主な設定と処理仕様

* **カスタムフィールドの取得:**
  * `hatena:bookmarkcount` ➔ `bookmarkcount`（ブックマーク数）
  * `dc:date` ➔ `dcDate`（更新日時）
* **時系列ログの記録:**
  * 取得ごとに現在時刻の ISO8601 文字列（`isoNow`）を生成。
  * 複合主キー `(link, fetched_at)` により、同一 URL であっても取得実行ごとのスナップショット（ブックマーク数の推移）を保持。
* **トランザクション制御:**
  * `db.exec('BEGIN TRANSACTION;')` 単位で挿入を行い、`db.changes` の値から実際の新規追加・更新件数を正確にログ出力。

## 5. GitHub Actions ワークフロー仕様 (`.github/workflows/fetch.yaml`)

### 構成設定

* **トリガー:**
  * **定時実行:** `schedule`（`cron: '*/20 * * * *'` または任意の空き時間帯）
  * **手動実行:** `workflow_dispatch: {}`
* **権限 (`permissions`):** `contents: write`（リポジトリへの自動 Push 権限）
* **実行ステップ:**
  1. **Checkout:** `actions/checkout@v5`
  2. **Node.js セットアップ:** `actions/setup-node@v5` (Node.js 22 LTS 以上指定)
  3. **依存関係インストール:** `npm ci`（`package.json` が存在する場合）
  4. **スクリプト実行:** `node scripts/fetch_rss.js`
  5. **自動コミット & Push:** 変更差分がある場合のみ `github-actions[bot]` 名義でコミット

---

## 6. 運用・注意点

### GitHub Actions の Cron スケジュール特性

* 無料枠および低アクティビティリポジトリでは、20分おきの `schedule` 指定であっても実行遅延や間引き（1〜2時間程度の空き）が常態化します。
* 厳密な 20 分間隔のトリガーが必要な場合は、`cron-job.org` などの外部サービスから `workflow_dispatch` API を呼び出す構成を採用します。

### `.gitignore` と `data/` の扱い

* `data/` フォルダを Git 管理対象とする場合は、`.gitignore` に `data/` を含めないでください。（含めると `git add data/` ステップでエラーとなります）