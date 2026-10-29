import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_CHECKS,
  summarizeScan,
  coreStatuses,
  countGood,
  statusText,
  prioritize,
  groupResults,
  compareScans,
  isBestPractice,
} from '../../extension/lib/scoring.js';

const rule = (id, count, impact = 'serious', tags = ['wcag2a']) => ({
  id,
  count,
  impact,
  tags,
  help: id,
  helpUrl: `https://example.test/${id}`,
  nodes: Array.from({ length: Math.min(count, 3) }, (_, i) => ({
    target: [`#${id}-${i}`],
    html: '<x>',
    failureSummary: '',
  })),
});

test('keyboard and visible focus: tool issues, then "Needs a quick check" until a person says "Looks good"', () => {
  const byId = (statuses) => Object.fromEntries(statuses.map((c) => [c.id, c]));
  // Before the scan's checks have run: as before.
  assert.equal(byId(coreStatuses({}, {}, null)).keyboard.status, 'not-checked');
  // The tool found problems: "Issues found", even if a person said "Looks good".
  const found = byId(
    coreStatuses({}, { keyboard: 'looks-good' }, { keyboard: { i: 2, p: 0 }, 'focus-visible': { i: 0, p: 3 } }),
  );
  assert.equal(found.keyboard.status, 'issues');
  assert.equal(found.keyboard.issues, 2);
  assert.equal(found.keyboard.good, false);
  assert.equal(statusText('issues', found.keyboard.issues), 'Issues found (2)');
  // Nothing found: a quick check is still needed. Possible problems do not count as issues.
  assert.equal(found['focus-visible'].status, 'quick-check');
  assert.equal(statusText('quick-check'), 'Needs a quick check');
  assert.equal(found['focus-visible'].good, false);
  // Only a person makes it good.
  const marked = byId(coreStatuses({}, { 'focus-visible': 'looks-good' }, { 'focus-visible': { i: 0, p: 0 } }));
  assert.equal(marked['focus-visible'].status, 'looks-good');
  assert.equal(marked['focus-visible'].good, true);
  assert.equal(
    byId(coreStatuses({}, { 'focus-visible': 'has-problem' }, { 'focus-visible': { i: 0, p: 0 } }))['focus-visible']
      .status,
    'has-problem',
  );
});

test('counts in status words have a thousands separator', () => {
  assert.equal(statusText('issues', 1284), 'Issues found (1,284)');
  assert.equal(statusText('needs-review', 12), 'Needs review (12)');
  assert.equal(statusText('possible', 10000), 'Possible problems (10,000)');
});

test('there are exactly 8 core checks, 6 automated and 2 manual', () => {
  assert.equal(CORE_CHECKS.length, 8);
  assert.equal(CORE_CHECKS.filter((c) => c.kind === 'automated').length, 6);
  assert.deepEqual(
    CORE_CHECKS.filter((c) => c.kind === 'manual').map((c) => c.manualId),
    ['keyboard', 'focus-visible'],
  );
});

test('summarizeScan counts issues and review items per rule, skipping frame-tested', () => {
  const scan = {
    violations: [rule('color-contrast', 3), rule('label', 2)],
    incomplete: [rule('color-contrast', 1), rule('frame-tested', 2, null, ['best-practice'])],
  };
  assert.deepEqual(summarizeScan(scan), { 'color-contrast': { v: 3, i: 1 }, label: { v: 2, i: 0 } });
});

test('before any scan, automated checks are "Not scanned yet" and none count as good', () => {
  const statuses = coreStatuses(null, {});
  assert.equal(countGood(statuses), 0);
  assert.equal(statuses[0].status, 'not-scanned');
  assert.equal(statuses[6].status, 'not-checked');
});

test('a clean scan makes the 6 automated checks good; manual ones need marking', () => {
  assert.equal(countGood(coreStatuses({}, {})), 6);
  assert.equal(countGood(coreStatuses({}, { keyboard: 'looks-good' })), 7);
  assert.equal(countGood(coreStatuses({}, { keyboard: 'looks-good', 'focus-visible': 'looks-good' })), 8);
  assert.equal(countGood(coreStatuses({}, { keyboard: 'has-problem' })), 6);
});

test('"Needs review" items stop a check from counting as good', () => {
  const statuses = coreStatuses({ 'color-contrast': { v: 0, i: 2 } }, {});
  const contrast = statuses.find((s) => s.id === 'color-contrast');
  assert.equal(contrast.status, 'needs-review');
  assert.equal(contrast.review, 2);
  assert.equal(contrast.good, false);
  assert.equal(countGood(statuses), 5);
});

test('page language combines two axe rules', () => {
  const lang = coreStatuses({ 'html-has-lang': { v: 1, i: 0 }, 'html-lang-valid': { v: 0, i: 0 } }, {}).find(
    (s) => s.id === 'page-language',
  );
  assert.equal(lang.status, 'issues');
  assert.equal(lang.issues, 1);
});

test('a typical first scan: 4 of 8 look good', () => {
  const counts = { 'color-contrast': { v: 5, i: 0 }, 'image-alt': { v: 2, i: 0 }, label: { v: 1, i: 0 } };
  assert.equal(countGood(coreStatuses(counts, { keyboard: 'looks-good' })), 4);
});

test('status words never say pass, compliant, or accessible', () => {
  const words = ['no-issues', 'issues', 'needs-review', 'not-scanned', 'looks-good', 'has-problem', 'not-checked'].map(
    (s) => statusText(s, 2),
  );
  assert.deepEqual(words, [
    'Nothing found by automated checks',
    'Issues found (2)',
    'Needs review (2)',
    'Not scanned yet',
    'Looks good',
    'Has a problem',
    'Not checked',
  ]);
  for (const word of words) assert.doesNotMatch(word, /pass|complian|accessible/i);
});

test('prioritize: Core 8 first, then impact, then count', () => {
  const ordered = prioritize([
    rule('region', 9, 'moderate'),
    rule('aria-roles', 1, 'critical'),
    rule('link-name', 1, 'serious'),
    rule('image-alt', 2, 'critical'),
    rule('button-name', 5, 'critical'),
    rule('list', 4, 'serious'),
    rule('listitem', 7, 'serious'),
  ]);
  assert.deepEqual(
    ordered.map((r) => r.id),
    ['button-name', 'image-alt', 'link-name', 'aria-roles', 'listitem', 'list', 'region'],
  );
});

test('groupResults: up to 5 in "Fix these next", rest in other issues, best practices apart', () => {
  const scan = {
    violations: [
      rule('a1', 1),
      rule('a2', 2),
      rule('a3', 3),
      rule('a4', 4),
      rule('a5', 5),
      rule('a6', 6),
      rule('a7', 7),
      rule('region', 3, 'moderate', ['cat.keyboard', 'best-practice']),
    ],
    incomplete: [
      rule('color-contrast', 1),
      rule('frame-tested', 2, 'critical', ['cat.structure', 'best-practice', 'review-item']),
    ],
  };
  const groups = groupResults(scan);
  assert.deepEqual(
    groups.fixNext.map((r) => r.id),
    ['a7', 'a6', 'a5', 'a4', 'a3'],
  );
  assert.deepEqual(
    groups.otherIssues.map((r) => r.id),
    ['a2', 'a1'],
  );
  assert.deepEqual(
    groups.bestPractice.issues.map((r) => r.id),
    ['region'],
  );
  assert.deepEqual(groups.bestPractice.review, []);
  assert.deepEqual(
    groups.needsReview.map((r) => r.id),
    ['color-contrast'],
  );
  assert.equal(groups.framesSkipped, 2);
});

test('isBestPractice is false for anything with a WCAG tag', () => {
  assert.equal(isBestPractice({ tags: ['best-practice'] }), true);
  assert.equal(isBestPractice({ tags: ['wcag2a', 'best-practice'] }), false);
  assert.equal(isBestPractice({ tags: ['wcag22aa'] }), false);
});

test('compareScans counts fixed and new elements', () => {
  const before = { 'color-contrast': { v: 5, i: 0 }, label: { v: 2, i: 0 }, 'image-alt': { v: 1, i: 3 } };
  const after = { 'color-contrast': { v: 2, i: 0 }, 'link-name': { v: 1, i: 0 }, 'image-alt': { v: 1, i: 0 } };
  assert.deepEqual(compareScans(before, after), { fixed: 5, new: 1 });
  assert.deepEqual(compareScans(after, after), { fixed: 0, new: 0 });
  assert.deepEqual(compareScans(null, after), { fixed: 0, new: 4 });
});
