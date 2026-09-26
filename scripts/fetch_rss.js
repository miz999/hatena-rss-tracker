import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import RssParser from 'rss-parser';

const parser = new RssParser();

// 1. 日付から保存先ファイル名を動的に決定
const now = new Date();
const isoNow = now.toISOString();
const year = now.getFullYear();
const month = String(now.getMonth() + 1).padStart(2, '0');

const dataDir = path.resolve('data');
const hotentryDbPath = path.join(dataDir, `hotentry_${year}.db`);
const allentryDbPath = path.join(dataDir, `allentry_${year}${month}.db`);

// data ディレクトリが存在しない場合は自動作成
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 2. DB 初期化（ファイル・テーブルがなければ自動生成）
function initHotentryDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS hot_entries (
      link TEXT NOT NULL,
      title TEXT NOT NULL,
      bookmark_count INTEGER NOT NULL,
      category TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (link, fetched_at)
    );
  `);
  return db;
}

function initAllentryDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS all_entries (
      link TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      bookmark_count INTEGER NOT NULL,
      pub_date TEXT,
      fetched_at TEXT NOT NULL
    );
  `);
  return db;
}

// 3. はてブ特有のブックマーク数を抽出するヘルパー（例: <hatena:bookmarkcount>）
function extractBookmarkCount(item) {
  if (item.bookmarkcount !== undefined) {
    return parseInt(item.bookmarkcount, 10);
  }
  return 0;
}

// 4. Hotentry 保存処理 & サマリ取得
async function processHotentry(db) {
  const feedUrl = 'https://b.hatena.ne.jp/hotentry.rss';
  const feed = await parser.parseURL(feedUrl);
  
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO hot_entries (link, title, bookmark_count, category, fetched_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  let newCount = 0;
  const newTitles = [];

  for (const item of feed.items) {
    const link = item.link;
    const title = item.title;
    const count = extractBookmarkCount(item);
    const category = item.categories ? item.categories[0] : null;

    stmt.run(link, title, count, category, isoNow);

    if (db.changes > 0) {
      newCount++;
      newTitles.push(title);
    }
  }

  return {
    total: feed.items.length,
    newCount,
    skipped: feed.items.length - newCount,
    newTitles
  };
}

// 5. Allentry 保存処理 & サマリ取得
async function processAllentry(db) {
  const feedUrl = 'https://b.hatena.ne.jp/entrylist.rss';
  const feed = await parser.parseURL(feedUrl);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO all_entries (link, title, bookmark_count, pub_date, fetched_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  let newCount = 0;
  const newTitles = [];

  for (const item of feed.items) {
    const link = item.link;
    const title = item.title;
    const count = extractBookmarkCount(item);
    const pubDate = item.pubDate || null;

    stmt.run(link, title, count, pubDate, isoNow);

    if (db.changes > 0) {
      newCount++;
      newTitles.push(title);
    }
  }

  return {
    total: feed.items.length,
    newCount,
    skipped: feed.items.length - newCount,
    newTitles
  };
}

// 6. メイン実行処理 ＆ サマリログ出力
async function main() {
  console.log(`========================================`);
  console.log(`⏰ Cron Run: ${isoNow}`);
  console.log(`========================================`);

  const hotDb = initHotentryDb(hotentryDbPath);
  const allDb = initAllentryDb(allentryDbPath);

  try {
    const hotSummary = await processHotentry(hotDb);
    console.log(`[Hotentry]  取得: ${hotSummary.total}件 | 新規: ${hotSummary.newCount}件 | 重複スキップ: ${hotSummary.skipped}件`);
    if (hotSummary.newTitles.length > 0) {
      hotSummary.newTitles.forEach(t => console.log(`  🔥 ${t}`));
    }

    const allSummary = await processAllentry(allDb);
    console.log(`[Allentry]  取得: ${allSummary.total}件 | 新規: ${allSummary.newCount}件 | 重複スキップ: ${allSummary.skipped}件`);
    if (allSummary.newTitles.length > 0) {
      allSummary.newTitles.forEach(t => console.log(`  ✨ ${t}`));
    }

  } catch (error) {
    console.error('❌ Error fetching RSS:', error);
    process.exitCode = 1;
  } finally {
    hotDb.close();
    allDb.close();
    console.log(`========================================\n`);
  }
}

main();