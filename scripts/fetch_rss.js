import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import RssParser from 'rss-parser';

// customFields を指定して hatena 固有タグと dc:date をパースできるようにする
const parser = new RssParser({
  customFields: {
    item: [
      ['dc:date', 'dcDate']
    ]
  }
});

// 1. 日付から保存先ファイル名を動的に決定
const now = new Date();
const isoNow = now.toISOString();
const year = now.getFullYear();
const month = String(now.getMonth() + 1).padStart(2, '0');

const dataDir = path.resolve('data');
const hotentryDbPath = path.join(dataDir, `hotentry_${year}.db`);
const allentryDbPath = path.join(dataDir, `allentry_${year}${month}.db`);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 2. DB 初期化
function initHotentryDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS hot_entries (
      link TEXT NOT NULL PRIMARY KEY,
      title TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);

  const columns = db.prepare('PRAGMA table_info(hot_entries)').all();
  const linkColumn = columns.find(column => column.name === 'link');
  if (linkColumn.pk === 1 && !columns.some(column => ['bookmark_count', 'category'].includes(column.name))) {
    return db;
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      CREATE TABLE hot_entries_migration (
        link TEXT NOT NULL PRIMARY KEY,
        title TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      INSERT INTO hot_entries_migration (link, title, fetched_at)
      SELECT link, title, fetched_at
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY link ORDER BY fetched_at, rowid) AS row_number
        FROM hot_entries
      )
      WHERE row_number = 1;

      DROP TABLE hot_entries;
      ALTER TABLE hot_entries_migration RENAME TO hot_entries;
    `);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }

  return db;
}

function initAllentryDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS all_entries (
      link TEXT NOT NULL PRIMARY KEY,
      title TEXT NOT NULL,
      pub_date TEXT,
      fetched_at TEXT NOT NULL
    );
  `);

  const columns = db.prepare('PRAGMA table_info(all_entries)').all();
  const linkColumn = columns.find(column => column.name === 'link');
  if (linkColumn.pk === 1 && !columns.some(column => column.name === 'bookmark_count')) {
    return db;
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      CREATE TABLE all_entries_migration (
        link TEXT NOT NULL PRIMARY KEY,
        title TEXT NOT NULL,
        pub_date TEXT,
        fetched_at TEXT NOT NULL
      );

      INSERT INTO all_entries_migration (link, title, pub_date, fetched_at)
      SELECT link, title, pub_date, fetched_at
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY link ORDER BY fetched_at, rowid) AS row_number
        FROM all_entries
      )
      WHERE row_number = 1;

      DROP TABLE all_entries;
      ALTER TABLE all_entries_migration RENAME TO all_entries;
    `);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }

  return db;
}

function initEntryDbs(dataDir, currentDbPath, filePattern, tableName, initDb) {
  const currentPath = path.resolve(currentDbPath);
  const dbPaths = fs.readdirSync(dataDir)
    .filter(file => filePattern.test(file))
    .map(file => path.resolve(dataDir, file));
  if (!dbPaths.includes(currentPath)) {
    dbPaths.push(currentPath);
  }
  dbPaths.sort();

  const links = new Set();
  let currentDb;

  for (const dbPath of dbPaths) {
    const db = initDb(dbPath);
    try {
      const rows = db.prepare(`SELECT link FROM ${tableName} ORDER BY fetched_at, rowid`).all();
      const deleteDuplicate = db.prepare(`DELETE FROM ${tableName} WHERE link = ?`);

      db.exec('BEGIN IMMEDIATE;');
      for (const { link } of rows) {
        if (links.has(link)) {
          deleteDuplicate.run(link);
        } else {
          links.add(link);
        }
      }
      db.exec('COMMIT;');

      if (dbPath === currentPath) {
        currentDb = db;
      } else {
        db.close();
      }
    } catch (error) {
      db.close();
      throw error;
    }
  }

  return { db: currentDb, links };
}

// 4. Hotentry 保存処理
async function processHotentry(db, existingLinks) {
  const feedUrl = 'https://b.hatena.ne.jp/hotentry.rss';
  const feed = await parser.parseURL(feedUrl);
  
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO hot_entries (link, title, fetched_at)
    VALUES (?, ?, ?)
  `);

  let newCount = 0;
  const newTitles = [];

  for (const item of feed.items) {
    const link = item.link;
    const title = item.title;

    if (existingLinks.has(link)) {
      continue;
    }

    // Changes 計測用に実行
    db.exec('BEGIN TRANSACTION;');
    const { changes } = stmt.run(link, title, isoNow);
    db.exec('COMMIT;');

    existingLinks.add(link);
    if (changes > 0) {
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

// 5. Allentry 保存処理
async function processAllentry(db, existingLinks) {
  const feedUrl = 'https://b.hatena.ne.jp/entrylist.rss';
  const feed = await parser.parseURL(feedUrl);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO all_entries (link, title, pub_date, fetched_at)
    VALUES (?, ?, ?, ?)
  `);

  let newCount = 0;
  const newTitles = [];

  for (const item of feed.items) {
    const link = item.link;
    const title = item.title;
    // RSS 1.0 の dc:date を優先取得、なければ pubDate
    const pubDate = item.dcDate || item.pubDate || null;

    if (existingLinks.has(link)) {
      continue;
    }

    db.exec('BEGIN TRANSACTION;');
    const { changes } = stmt.run(link, title, pubDate, isoNow);
    db.exec('COMMIT;');

    existingLinks.add(link);
    if (changes > 0) {
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

// 6. メイン実行処理
async function main() {
  console.log(`========================================`);
  console.log(`⏰ Cron Run: ${isoNow}`);
  console.log(`========================================`);

  let hotDb;
  let allDb;

  try {
    const initializedHotentry = initEntryDbs(
      dataDir,
      hotentryDbPath,
      /^hotentry_\d{4}\.db$/,
      'hot_entries',
      initHotentryDb
    );
    hotDb = initializedHotentry.db;
    const existingHotentryLinks = initializedHotentry.links;

    const initializedAllentry = initEntryDbs(
      dataDir,
      allentryDbPath,
      /^allentry_\d{6}\.db$/,
      'all_entries',
      initAllentryDb
    );
    allDb = initializedAllentry.db;
    const existingAllentryLinks = initializedAllentry.links;

    const hotSummary = await processHotentry(hotDb, existingHotentryLinks);
    console.log(`[Hotentry]  取得: ${hotSummary.total}件 | 新規: ${hotSummary.newCount}件 | 重複スキップ: ${hotSummary.skipped}件`);
    if (hotSummary.newTitles.length > 0) {
      hotSummary.newTitles.forEach(t => console.log(`  🔥 ${t}`));
    }

    const allSummary = await processAllentry(allDb, existingAllentryLinks);
    console.log(`[Allentry]  取得: ${allSummary.total}件 | 新規: ${allSummary.newCount}件 | 重複スキップ: ${allSummary.skipped}件`);
    if (allSummary.newTitles.length > 0) {
      allSummary.newTitles.forEach(t => console.log(`  ✨ ${t}`));
    }

  } catch (error) {
    console.error('❌ Error fetching RSS:', error);
    process.exitCode = 1;
  } finally {
    hotDb?.close();
    allDb?.close();
    console.log(`========================================\n`);
  }
}

main();