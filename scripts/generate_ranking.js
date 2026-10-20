import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(repositoryRoot, 'data');
const outputDir = path.join(repositoryRoot, 'site');

function getMonthlyWindow(now) {
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const start = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() - 1, 1) - JST_OFFSET_MS;
  const end = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), 1) - JST_OFFSET_MS;

  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    label: `${new Date(start + JST_OFFSET_MS).getUTCFullYear()}年${String(new Date(start + JST_OFFSET_MS).getUTCMonth() + 1).padStart(2, '0')}月`
  };
}

function getRollingWindow(now) {
  return {
    start: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    end: now.toISOString()
  };
}

function rankByOrigin(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.origin) ?? { origin: entry.origin, count: 0, articles: [] };
    group.count++;
    group.articles.push(entry);
    groups.set(entry.origin, group);
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      articles: group.articles.sort((a, b) => b.date.localeCompare(a.date) || a.link.localeCompare(b.link))
    }))
    .sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin))
    .slice(0, 20);
}

function createDatasetRankings(rows, dateField, now) {
  const uniqueEntries = new Map();
  for (const row of rows) {
    const previous = uniqueEntries.get(row.link);
    if (!previous || row.fetched_at < previous.fetched_at) {
      uniqueEntries.set(row.link, row);
    }
  }

  const monthlyWindow = getMonthlyWindow(now);
  const rollingWindow = getRollingWindow(now);
  const monthlyStart = Date.parse(monthlyWindow.start);
  const monthlyEnd = Date.parse(monthlyWindow.end);
  const rollingStart = Date.parse(rollingWindow.start);
  let missingDateCount = 0;
  let invalidDateCount = 0;
  const entries = [];

  for (const row of uniqueEntries.values()) {
    const dateValue = row[dateField];
    if (!dateValue) {
      missingDateCount++;
      continue;
    }

    const dateMs = Date.parse(dateValue);
    if (!Number.isFinite(dateMs)) {
      invalidDateCount++;
      continue;
    }

    let url;
    try {
      url = new URL(row.link);
    } catch (error) {
      throw new Error(`Invalid article URL "${row.link}"`, { cause: error });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Unsupported article URL protocol in "${row.link}"`);
    }

    entries.push({
      link: row.link,
      title: row.title,
      date: new Date(dateMs).toISOString(),
      fetchedAt: row.fetched_at,
      origin: url.origin
    });
  }

  return {
    monthly: {
      label: monthlyWindow.label,
      start: monthlyWindow.start,
      endExclusive: monthlyWindow.end,
      rankings: rankByOrigin(entries.filter(entry => {
        const dateMs = Date.parse(entry.date);
        return dateMs >= monthlyStart && dateMs < monthlyEnd;
      }))
    },
    last30Days: {
      start: rollingWindow.start,
      endInclusive: rollingWindow.end,
      rankings: rankByOrigin(entries.filter(entry => {
        const dateMs = Date.parse(entry.date);
        return dateMs >= rollingStart && dateMs <= now.getTime();
      }))
    },
    totals: {
      uniqueUrls: uniqueEntries.size,
      missingDate: missingDateCount,
      invalidDate: invalidDateCount
    }
  };
}

export function createRankings(allRows, hotRows, now = new Date()) {
  const monthlyWindow = getMonthlyWindow(now);
  const rollingWindow = getRollingWindow(now);
  return {
    generatedAt: now.toISOString(),
    aggregation: 'origin (scheme + host + optional port)',
    monthly: {
      label: monthlyWindow.label,
      start: monthlyWindow.start,
      endExclusive: monthlyWindow.end
    },
    last30Days: {
      start: rollingWindow.start,
      endInclusive: rollingWindow.end
    },
    allentry: createDatasetRankings(allRows, 'pub_date', now),
    hotentry: createDatasetRankings(hotRows, 'fetched_at', now)
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function formatJst(isoDate) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(isoDate));
}

function renderRankingTable(rankings, emptyMessage, dateLabel) {
  if (rankings.length === 0) {
    return `<p>${emptyMessage}</p>`;
  }

  const rows = rankings.map((group, index) => {
    const articles = group.articles.map(article => `
      <li>
        <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title)}</a>
        <time datetime="${escapeHtml(article.date)}">${escapeHtml(formatJst(article.date))}</time>
      </li>`).join('');

    return `
      <tr>
        <td>${index + 1}</td>
        <th scope="row"><a href="${escapeHtml(group.origin)}" target="_blank" rel="noopener noreferrer">${escapeHtml(group.origin)}</a></th>
        <td>${group.count}</td>
        <td><details><summary>記事一覧</summary><ol>${articles}</ol></details></td>
      </tr>`;
  }).join('');

  return `<div class="table-scroll"><table>
    <thead><tr><th>順位</th><th>URLグループ</th><th>記事数</th><th>${escapeHtml(dateLabel)}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export function renderHtml(report) {
  const monthlyEnd = new Date(Date.parse(report.monthly.endExclusive) - 1).toISOString();
  const last30Start = formatJst(report.last30Days.start);
  const last30End = formatJst(report.last30Days.endInclusive);
  const datasets = [
    { key: 'allentry', label: 'Allentry', dateLabel: '公開日時（pub_date）', dateBasis: 'pub_date' },
    { key: 'hotentry', label: 'Hotentry', dateLabel: '初回取得日時（fetched_at）', dateBasis: 'fetched_at' }
  ];
  const sections = datasets.map(dataset => {
    const rankings = report[dataset.key];
    return `
    <section>
      <h2>${dataset.label}</h2>
      <p class="meta">期間基準: ${dataset.dateBasis} ／ 公開日時なし: ${rankings.totals.missingDate}件 ／ 不正な日時: ${rankings.totals.invalidDate}件</p>
      <h3>前月ランキング — ${escapeHtml(report.monthly.label)}</h3>
      <p class="meta">${escapeHtml(formatJst(report.monthly.start))} 〜 ${escapeHtml(formatJst(monthlyEnd))} JST</p>
      ${renderRankingTable(rankings.monthly.rankings, '対象記事はありません。', dataset.dateLabel)}
      <h3>直近30日ランキング</h3>
      <p class="meta">${escapeHtml(last30Start)} 〜 ${escapeHtml(last30End)} JST</p>
      ${renderRankingTable(rankings.last30Days.rankings, '対象記事はありません。', dataset.dateLabel)}
    </section>`;
  }).join('');
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>はてなブックマーク URLランキング</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 1100px; margin: 0 auto; padding: 1.5rem; line-height: 1.6; }
    h1 { line-height: 1.3; }
    section { margin: 2rem 0 3rem; }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: .65rem; border-bottom: 1px solid #8886; text-align: left; vertical-align: top; }
    td:first-child, td:nth-child(3) { white-space: nowrap; }
    details ol { padding-left: 1.5rem; min-width: 20rem; }
    details li { margin: .5rem 0; }
    time { display: block; font-size: .85rem; opacity: .75; }
    .meta { opacity: .75; font-size: .9rem; }
  </style>
</head>
<body>
  <header>
    <h1>はてなブックマーク URLランキング</h1>
    <p>集計単位: scheme + host（http/httpsは別。パスは集約）</p>
    <p class="meta">更新: ${escapeHtml(formatJst(report.generatedAt))} JST ／ 上位20グループを表示</p>
  </header>
  <main>
    ${sections}
  </main>
</body>
</html>
`;
}

function loadTable(directory, files, tableName) {
  const rows = [];
  for (const file of files) {
    const db = new DatabaseSync(path.join(directory, file), { readOnly: true });
    try {
      rows.push(...db.prepare(`
        SELECT link, title, ${tableName === 'all_entries' ? 'pub_date' : 'NULL AS pub_date'}, fetched_at
        FROM ${tableName}
        ORDER BY fetched_at
      `).all());
    } finally {
      db.close();
    }
  }
  return rows;
}

export function loadEntries(directory = dataDir) {
  const files = fs.readdirSync(directory);
  const allentryFiles = files.filter(file => /^allentry_\d{6}\.db$/.test(file)).sort();
  const hotentryFiles = files.filter(file => /^hotentry_\d{4}\.db$/.test(file)).sort();
  if (allentryFiles.length === 0) {
    throw new Error(`No Allentry databases found in ${directory}`);
  }
  if (hotentryFiles.length === 0) {
    throw new Error(`No Hotentry databases found in ${directory}`);
  }

  return {
    allEntries: loadTable(directory, allentryFiles, 'all_entries'),
    hotEntries: loadTable(directory, hotentryFiles, 'hot_entries')
  };
}

function main() {
  const now = new Date();
  const { allEntries, hotEntries } = loadEntries();
  const report = createRankings(allEntries, hotEntries, now);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'data.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'index.html'), renderHtml(report));
  fs.writeFileSync(path.join(outputDir, '.nojekyll'), '');
  console.log(`Generated rankings for ${report.monthly.label} and the last 30 days.`);
  console.log(`Allentry URLs: ${report.allentry.totals.uniqueUrls}; Hotentry URLs: ${report.hotentry.totals.uniqueUrls}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error('Failed to generate rankings:', error);
    process.exitCode = 1;
  }
}
