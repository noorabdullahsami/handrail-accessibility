// Every WCAG reference must match extension/data/wcag22.json: the number must
// exist in WCAG 2.2, and the level, name and Understanding URL must match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const load = (path) => JSON.parse(read(path));
const { criteria } = load('extension/data/wcag22.json');
const byNum = new Map(criteria.map((sc) => [sc.num, sc]));

function assertCriterion(num, where) {
  assert.notEqual(num, '4.1.1', `${where}: 4.1.1 Parsing was removed in WCAG 2.2`);
  assert.ok(byNum.has(num), `${where}: ${num} is not a WCAG 2.2 success criterion`);
  return byNum.get(num);
}

test('wcag22.json has every WCAG 2.2 success criterion and not 4.1.1', () => {
  assert.equal(criteria.length, 86);
  assert.ok(!byNum.has('4.1.1'));
  for (const sc of criteria) {
    assert.match(sc.num, /^[1-4]\.\d+\.\d+$/);
    assert.ok(['A', 'AA', 'AAA'].includes(sc.level), sc.num);
    assert.equal(sc.url, `https://www.w3.org/WAI/WCAG22/Understanding/${sc.url.split('/').pop()}`);
  }
});

test('guided checks and core checks use the right number, level and Understanding URL', () => {
  const entries = [...load('extension/data/manual-checks.json'), ...load('extension/data/automated-core.json')];
  for (const entry of entries) {
    // Some cite two criteria, like "2.4.4, 4.1.2". The first sets the level and URL.
    const [sc] = entry.wcag.split(',').map((num) => assertCriterion(num.trim(), entry.id));
    assert.equal(entry.level, sc.level, `${entry.id}: level`);
    assert.equal(entry.url, sc.url, `${entry.id}: url`);
  }
});

test('axe rule copy names only WCAG 2.2 criteria', () => {
  for (const [id, entry] of Object.entries(load('extension/data/axe-rules.json'))) {
    if (entry.wcag === null) continue;
    for (const num of entry.wcag.split(',')) assertCriterion(num.trim(), id);
  }
});

// Criterion numbers in prose: principles 1 to 4, guidelines 1 to 5.
const NUMBER = /(?<![\d.])([1-4]\.[1-5]\.\d{1,2})(?![\d.])/g;

const textFiles = [
  'README.md',
  'CONTRIBUTING.md',
  'PRIVACY.md',
  ...readdirSync(new URL('../../docs', import.meta.url))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
  'extension/_locales/en/messages.json',
  'extension/panel/panel.html',
  'extension/panel/panel.js',
  'extension/panel/privacy.html',
  'extension/lib/report.js',
];

test('criterion numbers in the docs and the panel are all in WCAG 2.2', () => {
  for (const file of textFiles) {
    for (const [, num] of read(file).matchAll(NUMBER)) assertCriterion(num, file);
  }
});

test('table rows that name a criterion use its official name and level', () => {
  for (const file of textFiles.filter((f) => f.endsWith('.md'))) {
    for (const line of read(file).split('\n')) {
      if (!line.startsWith('|')) continue;
      for (const [, num] of line.matchAll(NUMBER)) {
        const sc = assertCriterion(num, file);
        assert.ok(line.includes(sc.name), `${file}: ${num} should be named "${sc.name}"`);
        assert.match(line, new RegExp(`\\|\\s*${sc.level}\\s*\\|`), `${file}: ${num} should be level ${sc.level}`);
      }
    }
  }
});
