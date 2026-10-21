import assert from 'node:assert/strict';
import test from 'node:test';
import { createRankings, renderHtml } from './generate_ranking.js';

const now = new Date('2026-10-21T07:00:00+09:00');

test('groups URLs by scheme and host while keeping HTTP and HTTPS separate', () => {
  const report = createRankings([
    { link: 'https://note.com/user/n/1', title: 'one', pub_date: '2026-09-10T00:00:00Z', fetched_at: '2026-09-11T00:00:00Z' },
    { link: 'https://note.com/another/n/2', title: 'two', pub_date: '2026-09-11T00:00:00Z', fetched_at: '2026-09-12T00:00:00Z' },
    { link: 'http://note.com/user/n/3', title: 'three', pub_date: '2026-09-12T00:00:00Z', fetched_at: '2026-09-13T00:00:00Z' }
  ], [], now);

  assert.deepEqual(report.allentry.monthly.rankings.map(group => [group.origin, group.count]), [
    ['https://note.com', 2],
    ['http://note.com', 1]
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
  assert.deepEqual(report.allentry.monthly.rankings.map(group => [group.origin, group.count]), [
    ['https://example.com', 2],
    ['https://old.example', 1],
    ['https://recent.example', 1]
  ]);
  assert.deepEqual(report.allentry.last30Days.rankings.map(group => [group.origin, group.count]), [
    ['https://example.com', 2],
    ['https://recent.example', 1]
  ]);
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
  assert.deepEqual(report.hotentry.monthly.rankings.map(group => [group.origin, group.count]), [
    ['https://hot.example', 1]
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
  const report = createRankings([], [], now);
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
});
