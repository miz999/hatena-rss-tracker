import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMonthlyArchive,
  createMonthlyArchiveData,
  createRankings,
  getArchiveMonthKeys,
  renderHtml,
  renderMonthlyArchiveHtml
} from './generate_ranking.js';

const now = new Date('2026-10-21T07:00:00+09:00');

test('groups HTTP and HTTPS URLs under the same hostname', () => {
  const report = createRankings([
    { link: 'https://note.com/user/n/1', title: 'one', pub_date: '2026-09-10T00:00:00Z', fetched_at: '2026-09-11T00:00:00Z' },
    { link: 'https://note.com/another/n/2', title: 'two', pub_date: '2026-09-11T00:00:00Z', fetched_at: '2026-09-12T00:00:00Z' },
    { link: 'http://note.com/user/n/3', title: 'three', pub_date: '2026-09-12T00:00:00Z', fetched_at: '2026-09-13T00:00:00Z' }
  ], [], now);

  assert.deepEqual(report.allentry.monthly.rankings.map(group => [group.host, group.count]), [
    ['note.com', 3]
  ]);
});

test('uses the previous JST calendar month and an exact rolling 30-day window', () => {
  const report = createRankings([
    { link: 'https://example.com/month-start', title: 'month start', pub_date: '2026-08-31T15:00:00Z', fetched_at: '2026-09-01T00:00:00Z' },
    { link: 'https://example.com/month-end', title: 'month end', pub_date: '2026-09-30T14:59:59.999Z', fetched_at: '2026-10-01T00:00:00Z' },
    { link: 'https://example.com/next-month', title: 'next month', pub_date: '2026-09-30T15:00:00Z', fetched_at: '2026-10-01T00:01:00Z' },
    { link: 'https://recent.example/at-start', title: 'at start', pub_date: '2026-09-20T22:00:00.000Z', fetched_at: '2026-09-22T00:00:00Z' },
    { link: 'https://old.example/outside', title: 'outside', pub_date: '2026-09-20T21:59:59.999Z', fetched_at: '2026-09-22T00:00:00Z' }
  ], [], now);

  assert.equal(report.monthly.label, '2026年09月');
  assert.deepEqual(report.allentry.monthly.rankings.map(group => [group.host, group.count]), [
    ['example.com', 2],
    ['old.example', 1],
    ['recent.example', 1]
  ]);
  assert.deepEqual(report.allentry.last30Days.rankings.map(group => [group.host, group.count]), [
    ['example.com', 2],
    ['recent.example', 1]
  ]);
  assert.equal(report.allentry.monthly.entryCount, 4);
  assert.equal(report.allentry.last30Days.entryCount, 3);
});

test('uses Hotentry fetched_at rather than pub_date for period filtering', () => {
  const report = createRankings([
    { link: 'https://all.example/a', title: 'Allentry', pub_date: '2026-09-10T00:00:00Z', fetched_at: '2026-10-10T00:00:00Z' }
  ], [
    { link: 'https://hot.example/a', title: 'Hotentry', pub_date: null, fetched_at: '2026-09-10T00:00:00Z' },
    { link: 'https://hot.example/b', title: 'Outside monthly', pub_date: null, fetched_at: '2026-10-01T00:00:00Z' }
  ], now);

  assert.equal(report.hotentry.totals.uniqueUrls, 2);
  assert.equal(report.hotentry.totals.missingDate, 0);
  assert.deepEqual(report.hotentry.monthly.rankings.map(group => [group.host, group.count]), [
    ['hot.example', 1]
  ]);
  assert.equal(report.hotentry.monthly.rankings[0].articles[0].title, 'Hotentry');
  assert.equal(report.allentry.monthly.rankings[0].articles[0].title, 'Allentry');
});

test('keeps only the earliest record per URL and limits each ranking to 20 origins', () => {
  const allRows = Array.from({ length: 25 }, (_, index) => ({
    link: `https://site-${index}.example/article`,
    title: `Article ${index}`,
    pub_date: '2026-09-10T00:00:00Z',
    fetched_at: '2026-09-10T01:00:00Z'
  }));
  allRows.push({
    link: 'https://site-0.example/article',
    title: 'Duplicate',
    pub_date: '2026-09-10T00:00:00Z',
    fetched_at: '2026-09-11T01:00:00Z'
  });

  const report = createRankings(allRows, allRows, now);

  assert.equal(report.allentry.totals.uniqueUrls, 25);
  assert.equal(report.allentry.monthly.rankings.length, 20);
  assert.equal(report.hotentry.monthly.rankings.length, 20);
  assert.equal(report.hotentry.monthly.rankings[0].articles[0].title, 'Article 0');
});

test('escapes RSS titles before rendering HTML', () => {
  const report = createRankings([
    { link: 'https://example.com/a', title: '<script>alert(1)</script>', pub_date: '2026-09-10T00:00:00Z', fetched_at: '2026-09-10T01:00:00Z' }
  ], [], now);

  const html = renderHtml(report);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renders ranking sections in the requested order', () => {
  const report = createRankings([
    { link: 'https://example.com/a', title: 'Article', pub_date: '2026-09-10T00:00:00Z', fetched_at: '2026-09-10T01:00:00Z' },
    { link: 'https://example.com/no-date', title: 'No date', pub_date: null, fetched_at: '2026-09-10T01:00:00Z' }
  ], [], now);
  const html = renderHtml(report);
  const headings = [
    'Allentry 直近30日ランキング',
    'Hotentry 直近30日ランキング',
    '前月ランキング — Allentry — 2026年09月',
    '前月ランキング — Hotentry — 2026年09月'
  ];
  const positions = headings.map(heading => html.indexOf(heading));

  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(html.includes('期間内エントリー総数: 1件'));
  assert.ok(!html.includes('日時なし'));
  assert.ok(!html.includes('不正な日時'));
});

test('creates archive pages only for completed months and links them from the index', () => {
  const allRows = [
    { link: 'https://all.example/september', title: 'September article', pub_date: '2026-09-10T00:00:00Z', fetched_at: '2026-09-10T01:00:00Z' },
    { link: 'https://all.example/october', title: 'October article', pub_date: '2026-10-10T00:00:00Z', fetched_at: '2026-10-10T01:00:00Z' }
  ];
  const hotRows = [
    { link: 'https://hot.example/september', title: 'September hot', pub_date: null, fetched_at: '2026-09-10T01:00:00Z' },
    { link: 'https://hot.example/october', title: 'October hot', pub_date: null, fetched_at: '2026-10-10T01:00:00Z' }
  ];
  const archiveMonths = getArchiveMonthKeys(allRows, hotRows, now);
  const archive = createMonthlyArchive(allRows, hotRows, '202609', now);
  const archiveData = createMonthlyArchiveData(archive);
  const archiveHtml = renderMonthlyArchiveHtml(archive);
  const indexHtml = renderHtml(createRankings(allRows, hotRows, now), archiveMonths);

  assert.deepEqual(archiveMonths, ['202609']);
  assert.equal(archive.allentry.monthly.entryCount, 1);
  assert.equal(archive.hotentry.monthly.entryCount, 1);
  assert.ok(archiveHtml.includes('September article'));
  assert.ok(archiveHtml.includes('September hot'));
  assert.ok(!archiveHtml.includes('October article'));
  assert.ok(archiveHtml.includes('href="202609.json"'));
  assert.ok(indexHtml.includes('href="202609.html"'));
  assert.equal(archiveData.monthly.label, '2026年09月');
  assert.equal(archiveData.allentry.dateBasis, 'pub_date');
  assert.equal(archiveData.hotentry.dateBasis, 'fetched_at');
  assert.equal(archiveData.allentry.entryCount, 1);
  assert.equal(archiveData.hotentry.entryCount, 1);
  assert.equal(archiveData.allentry.rankings[0].articles[0].link, 'https://all.example/september');
  assert.equal(archiveData.hotentry.rankings[0].articles[0].link, 'https://hot.example/september');
  assert.ok(!Object.hasOwn(archiveData.allentry, 'last30Days'));
  assert.ok(!Object.hasOwn(archiveData.allentry, 'totals'));
  assert.throws(() => createMonthlyArchive(allRows, hotRows, '202613', now), /Invalid archive month/);
  assert.throws(() => createMonthlyArchive(allRows, hotRows, '202610', now), /is not complete/);
});

test('limits both monthly archive datasets to their top 20 hostname groups', () => {
  const allRows = Array.from({ length: 22 }, (_, index) => ({
    link: `https://all-${index}.example/article`,
    title: `Allentry ${index}`,
    pub_date: '2026-09-10T00:00:00Z',
    fetched_at: '2026-09-10T01:00:00Z'
  }));
  const hotRows = Array.from({ length: 22 }, (_, index) => ({
    link: `https://hot-${index}.example/article`,
    title: `Hotentry ${index}`,
    pub_date: null,
    fetched_at: '2026-09-10T01:00:00Z'
  }));
  const archive = createMonthlyArchive(allRows, hotRows, '202609', now);
  const archiveData = createMonthlyArchiveData(archive);

  assert.equal(archiveData.allentry.entryCount, 22);
  assert.equal(archiveData.hotentry.entryCount, 22);
  assert.equal(archiveData.allentry.rankings.length, 20);
  assert.equal(archiveData.hotentry.rankings.length, 20);
});
