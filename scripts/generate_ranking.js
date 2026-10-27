import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(repositoryRoot, 'data');
const outputDir = path.join(repositoryRoot, 'site');

function getCalendarMonthWindow(year, month) {
  const start = Date.UTC(year, month, 1) - JST_OFFSET_MS;
  const end = Date.UTC(year, month + 1, 1) - JST_OFFSET_MS;

  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    label: `${new Date(start + JST_OFFSET_MS).getUTCFullYear()}年${String(new Date(start + JST_OFFSET_MS).getUTCMonth() + 1).padStart(2, '0')}月`
  };
}

function getMonthlyWindow(now) {
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  return getCalendarMonthWindow(jstNow.getUTCFullYear(), jstNow.getUTCMonth() - 1);
}

function getRollingWindow(now) {
  return {
    start: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    end: now.toISOString()
  };
}

function rankByHost(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.host) ?? { host: entry.host, count: 0, articles: [] };
    group.count++;
    group.articles.push(entry);
    groups.set(entry.host, group);
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      articles: group.articles.sort((a, b) => b.date.localeCompare(a.date) || a.link.localeCompare(b.link))
    }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
    .slice(0, 20);
}

function createDatasetRankings(rows, dateField, now, monthlyWindow = getMonthlyWindow(now)) {
  const uniqueEntries = new Map();
  for (const row of rows) {
    const previous = uniqueEntries.get(row.link);
    if (!previous || row.fetched_at < previous.fetched_at) {
      uniqueEntries.set(row.link, row);
    }
  }

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
      host: url.hostname
    });
  }

  const monthlyEntries = entries.filter(entry => {
    const dateMs = Date.parse(entry.date);
    return dateMs >= monthlyStart && dateMs < monthlyEnd;
  });
  const last30DaysEntries = entries.filter(entry => {
    const dateMs = Date.parse(entry.date);
    return dateMs >= rollingStart && dateMs <= now.getTime();
  });

  return {
    monthly: {
      label: monthlyWindow.label,
      start: monthlyWindow.start,
      endExclusive: monthlyWindow.end,
      entryCount: monthlyEntries.length,
      rankings: rankByHost(monthlyEntries)
    },
    last30Days: {
      start: rollingWindow.start,
      endInclusive: rollingWindow.end,
      entryCount: last30DaysEntries.length,
      rankings: rankByHost(last30DaysEntries)
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
    aggregation: 'hostname (scheme and port ignored)',
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

export function getArchiveMonthKeys(allRows, hotRows, now = new Date()) {
  const fetchDates = [...allRows, ...hotRows]
    .map(row => Date.parse(row.fetched_at))
    .filter(Number.isFinite);
  if (fetchDates.length === 0) {
    return [];
  }

  const earliest = new Date(fetchDates.reduce((minimum, date) => Math.min(minimum, date), Infinity) + JST_OFFSET_MS);
  const currentJst = new Date(now.getTime() + JST_OFFSET_MS);
  const monthKeys = [];
  let year = earliest.getUTCFullYear();
  let month = earliest.getUTCMonth();

  while (year < currentJst.getUTCFullYear() ||
    (year === currentJst.getUTCFullYear() && month < currentJst.getUTCMonth())) {
    monthKeys.push(`${year}${String(month + 1).padStart(2, '0')}`);
    month++;
    if (month === 12) {
      year++;
      month = 0;
    }
  }

  return monthKeys;
}

export function createMonthlyArchive(allRows, hotRows, monthKey, now = new Date()) {
  if (!/^\d{6}$/.test(monthKey) ||
    Number(monthKey.slice(0, 4)) < 100 ||
    Number(monthKey.slice(4, 6)) < 1 ||
    Number(monthKey.slice(4, 6)) > 12) {
    throw new Error(`Invalid archive month "${monthKey}"`);
  }

  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(4, 6)) - 1;
  const monthlyWindow = getCalendarMonthWindow(year, month);
  if (Date.parse(monthlyWindow.end) > now.getTime()) {
    throw new Error(`Archive month "${monthKey}" is not complete`);
  }

  return {
    generatedAt: now.toISOString(),
    aggregation: 'hostname (scheme and port ignored)',
    monthly: {
      label: monthlyWindow.label,
      start: monthlyWindow.start,
      endExclusive: monthlyWindow.end
    },
    allentry: createDatasetRankings(allRows, 'pub_date', now, monthlyWindow),
    hotentry: createDatasetRankings(hotRows, 'fetched_at', now, monthlyWindow)
  };
}

export function createMonthlyArchiveData(report) {
  const monthDate = new Date(Date.parse(report.monthly.start) + JST_OFFSET_MS);
  const monthKey = `${monthDate.getUTCFullYear()}${String(monthDate.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    generatedAt: report.generatedAt,
    aggregation: report.aggregation,
    monthly: report.monthly,
    allentry: {
      dateBasis: 'pub_date',
      ...report.allentry.monthly
    },
    hotentry: {
      dateBasis: 'fetched_at',
      ...report.hotentry.monthly
    }
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
        <th scope="row"><code>${escapeHtml(group.host)}</code></th>
        <td>${group.count}</td>
        <td><details><summary>記事一覧</summary><ol>${articles}</ol></details></td>
      </tr>`;
  }).join('');

  return `<div class="table-scroll"><table>
    <thead><tr><th>順位</th><th>URLグループ</th><th>記事数</th><th>${escapeHtml(dateLabel)}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderArchiveNavigation(monthKeys) {
  if (monthKeys.length === 0) {
    return '';
  }
  const links = [...monthKeys].reverse()
    .map(monthKey => `<li><a href="${monthKey}.html">${monthKey.slice(0, 4)}年${monthKey.slice(4)}月</a></li>`)
    .join('');
  return `<nav aria-label="月別アーカイブ"><h2>月別アーカイブ</h2><ul>${links}</ul></nav>`;
}

export function renderHtml(report, archiveMonths = []) {
  const monthlyEnd = new Date(Date.parse(report.monthly.endExclusive) - 1).toISOString();
  const last30Start = formatJst(report.last30Days.start);
  const last30End = formatJst(report.last30Days.endInclusive);
  const datasets = [
    { key: 'allentry', label: 'Allentry', dateLabel: '公開日時（pub_date）', dateBasis: 'pub_date' },
    { key: 'hotentry', label: 'Hotentry', dateLabel: '初回取得日時（fetched_at）', dateBasis: 'fetched_at' }
  ];
  const sections = [
    { dataset: datasets[0], period: 'last30Days', heading: 'Allentry 直近30日ランキング', range: `${last30Start} 〜 ${last30End} JST` },
    { dataset: datasets[1], period: 'last30Days', heading: 'Hotentry 直近30日ランキング', range: `${last30Start} 〜 ${last30End} JST` },
    { dataset: datasets[0], period: 'monthly', heading: `前月ランキング — Allentry — ${report.monthly.label}`, range: `${formatJst(report.monthly.start)} 〜 ${formatJst(monthlyEnd)} JST` },
    { dataset: datasets[1], period: 'monthly', heading: `前月ランキング — Hotentry — ${report.monthly.label}`, range: `${formatJst(report.monthly.start)} 〜 ${formatJst(monthlyEnd)} JST` }
  ].map(({ dataset, period, heading, range }) => {
    const rankings = report[dataset.key];
    return `
    <section>
      <h2>${escapeHtml(heading)}</h2>
      <p class="meta">期間基準: ${dataset.dateBasis} ／ 期間内エントリー総数: ${rankings[period].entryCount}件</p>
      <p class="meta">${escapeHtml(range)}</p>
      ${renderRankingTable(rankings[period].rankings, '対象記事はありません。', dataset.dateLabel)}
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
    <p>集計単位: hostname（http/https・ポート・パスは区別せず集約）</p>
    <p class="meta">更新: ${escapeHtml(formatJst(report.generatedAt))} JST ／ 上位20グループを表示</p>
  </header>
  <main>
    ${sections}
    ${renderArchiveNavigation(archiveMonths)}
  </main>
</body>
</html>
`;
}

export function renderMonthlyArchiveHtml(report) {
  const monthEnd = new Date(Date.parse(report.monthly.endExclusive) - 1).toISOString();
  const monthDate = new Date(Date.parse(report.monthly.start) + JST_OFFSET_MS);
  const monthKey = `${monthDate.getUTCFullYear()}${String(monthDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const datasets = [
    { key: 'allentry', label: 'Allentry', dateLabel: '公開日時（pub_date）', dateBasis: 'pub_date' },
    { key: 'hotentry', label: 'Hotentry', dateLabel: '初回取得日時（fetched_at）', dateBasis: 'fetched_at' }
  ];
  const sections = datasets.map(dataset => {
    const rankings = report[dataset.key].monthly;
    return `
    <section>
      <h2>${dataset.label}</h2>
      <p class="meta">期間基準: ${dataset.dateBasis} ／ 期間内エントリー総数: ${rankings.entryCount}件</p>
      ${renderRankingTable(rankings.rankings, '対象記事はありません。', dataset.dateLabel)}
    </section>`;
  }).join('');

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(report.monthly.label)} はてなブックマーク URLランキング</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 1100px; margin: 0 auto; padding: 1.5rem; line-height: 1.6; }
    section { margin: 2rem 0 3rem; }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: .65rem; border-bottom: 1px solid #8886; text-align: left; vertical-align: top; }
    td:first-child, td:nth-child(3) { white-space: nowrap; }
    details ol { padding-left: 1.5rem; min-width: 20rem; }
    details li { margin: .5rem 0; }
    time, .meta { display: block; font-size: .9rem; opacity: .75; }
  </style>
</head>
<body>
  <header>
    <p><a href="index.html">最新ランキングへ戻る</a></p>
    <h1>${escapeHtml(report.monthly.label)} はてなブックマーク URLランキング</h1>
    <p class="meta">${escapeHtml(formatJst(report.monthly.start))} 〜 ${escapeHtml(formatJst(monthEnd))} JST ／ hostname単位の上位20グループ</p>
    <p><a href="${monthKey}.json">この月のランキングJSON</a></p>
  </header>
  <main>${sections}</main>
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
  const archiveMonths = getArchiveMonthKeys(allEntries, hotEntries, now);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'data.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'index.html'), renderHtml(report, archiveMonths));
  for (const monthKey of archiveMonths) {
    const archive = createMonthlyArchive(allEntries, hotEntries, monthKey, now);
    const archiveData = createMonthlyArchiveData(archive);
    fs.writeFileSync(path.join(outputDir, `${monthKey}.json`), `${JSON.stringify(archiveData, null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, `${monthKey}.html`), renderMonthlyArchiveHtml(archive));
  }
  fs.writeFileSync(path.join(outputDir, '.nojekyll'), '');
  console.log(`Generated rankings for ${report.monthly.label}, the last 30 days, and ${archiveMonths.length} monthly archives.`);
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
