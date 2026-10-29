import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hintGroups, autoCounts } from '../../extension/lib/hints.js';
import { sortTabOrder, pixelChange, focusChangeLevel } from '../../extension/lib/helpers.js';
import { summarizeScan, groupResults } from '../../extension/lib/scoring.js';

const node = (sel) => ({ target: [sel], html: `<x id="${sel}">`, failureSummary: '' });
const rule = (id, count, tags = ['wcag2a']) => ({
  id,
  count,
  tags,
  impact: 'moderate',
  help: `Help for ${id}`,
  helpUrl: `https://example.test/${id}`,
  nodes: Array.from({ length: count }, (_, i) => node(`#${id}${i}`)),
});
const empty = { count: 0, items: [] };
const lists = {
  clickables: { count: 2, items: [node('div'), node('span')] },
  headings: {
    count: 2,
    items: [
      { level: 1, text: 'Title', target: ['h1'] },
      { level: 3, text: 'Sub', target: ['h3'] },
    ],
  },
  links: { total: 9, count: 1, items: [node('a')] },
  duplicateLinks: { count: 2, items: [node('a1'), node('a2')] },
  images: { total: 3, ...empty },
  sameAlts: empty,
  liveRegions: empty,
  placeholders: { count: 1, items: [node('input')] },
  roles: { count: 2, items: [node('r1'), node('r2')] },
  skip: { skipLink: false, hasMain: false },
};
const scan = {
  violations: [
    rule('heading-order', 1, ['best-practice']),
    rule('p-as-heading', 2, ['wcag2a', 'experimental']),
    rule('label', 4),
    rule('image-redundant-alt', 1, ['best-practice']),
  ],
  incomplete: [rule('list', 1)],
};
const walk = {
  stops: 12,
  total: 12,
  capped: false,
  stopped: null,
  unreadableSheets: 1,
  pixelSkipped: null,
  noFocusConfirmed: { count: 1, items: [node('button')] },
  faintFocus: { count: 1, items: [node('a.faint')] },
  maybeNoFocus: empty,
  invisibleFocus: empty,
  coveredBySticky: { count: 3, items: [node('a1'), node('a2'), node('a3')] },
  orderJumps: empty,
  positiveTabindex: { count: 1, items: [node('a.first')] },
};
const check = (id, axe_rules = [], helpers = [], axe_possible = []) => ({ id, axe_rules, helpers, axe_possible });
const levels = (result) => result.groups.map((g) => `${g.level}:${g.title}`);

test('mapped axe failures are issues; needs review and experimental rules are possible problems', () => {
  const result = hintGroups(check('structure', ['heading-order', 'p-as-heading', 'list'], ['headings']), {
    scan,
    lists,
  });
  assert.deepEqual(levels(result), [
    'issue:Help for heading-order',
    'possible:Possible: Help for p-as-heading',
    'possible:Help for list (needs review)',
    'list:Heading outline (2)',
  ]);
  assert.equal(result.issues, 1);
  assert.equal(result.possible, 3); // 2 + 1, the outline is not counted
});

test('rules listed as axe_possible are possible problems even when axe fails them', () => {
  const result = hintGroups(check('alt-text-quality', [], [], ['image-redundant-alt']), { scan, lists });
  assert.deepEqual(levels(result), ['possible:Help for image-redundant-alt']);
});

test('before a scan, checks ask for one; checks with no automation say a person is needed', () => {
  assert.equal(hintGroups(check('structure', ['list'], ['headings']), {}).needsScan, true);
  const manual = hintGroups(check('reflow'), { scan, lists });
  assert.equal(manual.manualOnly, true);
  assert.equal(manual.issues + manual.possible, 0);
});

test('lists to review are shown but not counted', () => {
  const roles = hintGroups(check('custom-controls', [], ['roles']), { scan, lists });
  assert.equal(roles.issues + roles.possible, 0);
  assert.equal(roles.groups[0].items.length, 2);
  const live = hintGroups(check('status-messages', [], ['live-regions']), { scan, lists });
  assert.equal(live.groups[0].kind, 'note');
});

test('link duplicates, missing skip link and main landmark are possible problems', () => {
  const links = hintGroups(check('link-purpose', [], ['links', 'duplicate-links']), { scan, lists });
  assert.equal(links.possible, 3);
  const skip = hintGroups(check('skip-link', [], ['skip']), { scan, lists });
  assert.equal(skip.possible, 1);
  const withMain = hintGroups(check('skip-link', [], ['skip']), {
    scan,
    lists: { ...lists, skip: { skipLink: false, hasMain: true } },
  });
  assert.equal(withMain.possible, 0);
});

test('focus findings go to the right checks at the right level, and need the walk first', () => {
  assert.equal(hintGroups(check('focus-visible', [], ['focus-walk']), { scan, lists }).needsWalk, true);
  const visible = hintGroups(check('focus-visible', [], ['focus-walk']), { scan, lists, walk });
  assert.equal(visible.issues, 1); // confirmed on screen
  assert.equal(visible.possible, 1); // faint
  assert.ok(visible.groups.some((g) => g.kind === 'note' && /1/.test(g.title) && /another site/.test(g.title)));
  const hidden = hintGroups(check('focus-not-hidden', [], ['focus-walk']), { scan, lists, walk });
  assert.equal(hidden.issues, 3);
  const order = hintGroups(check('focus-order', [], ['focus-walk']), { scan, lists, walk });
  assert.deepEqual([order.issues, order.possible], [0, 1]);
});

test('stopped focus checks say why', () => {
  const titles = (w) =>
    hintGroups(check('focus-visible', [], ['focus-walk']), { scan, lists, walk: { ...walk, ...w } })
      .groups.map((g) => g.title)
      .join(' | ');
  assert.match(titles({ stopped: 'time', stops: 80, total: 300 }), /20 second limit, after 80 of 300/);
  assert.match(titles({ stopped: 'cancelled', stops: 5, total: 9 }), /cancelled after 5 of 9/);
  assert.match(
    titles({ capped: true, stops: 500, total: 812 }),
    /812 places you can Tab to\. The focus checks stopped at the first 500/,
  );
  assert.match(titles({ pixelSkipped: 'no' }), /on-screen check/);
});

test('autoCounts only counts checks whose automation has run', () => {
  const checks = [
    check('keyboard', [], ['clickables']),
    check('reflow'),
    check('labels-instructions', ['label'], ['placeholders']),
    check('focus-visible', [], ['focus-walk']),
  ];
  assert.deepEqual(autoCounts(checks, { scan, lists }), {
    keyboard: { i: 0, p: 2 },
    'labels-instructions': { i: 4, p: 1 },
  });
  assert.deepEqual(autoCounts(checks, { scan, lists, walk })['focus-visible'], { i: 1, p: 1 });
});

test('experimental rules never reach the issue lists, Core 8 counts, or rescan comparison', () => {
  assert.equal('p-as-heading' in summarizeScan(scan), false);
  const groups = groupResults(scan);
  const ids = [...groups.fixNext, ...groups.otherIssues, ...groups.needsReview, ...groups.bestPractice.issues].map(
    (r) => r.id,
  );
  assert.equal(ids.includes('p-as-heading'), false);
});

test('sortTabOrder: positive tabindex first (low to high), then page order', () => {
  const order = sortTabOrder([
    { index: 0, tabIndex: 0 },
    { index: 1, tabIndex: 3 },
    { index: 2, tabIndex: 0 },
    { index: 3, tabIndex: 1 },
    { index: 4, tabIndex: 3 },
    { index: 5, tabIndex: -1 },
  ]);
  assert.deepEqual(
    order.map((i) => i.index),
    [3, 1, 4, 0, 2],
  );
});

test('pixel comparison: no change, a faint change, and a visible focus ring', () => {
  const box = (pixels) => Uint8ClampedArray.from(pixels.flatMap(([r, g, b]) => [r, g, b, 255]));
  const white = Array(400).fill([255, 255, 255]);
  const same = pixelChange(box(white), box(white));
  assert.deepEqual(same, { changed: 0, total: 400, maxDiff: 0 });
  assert.equal(focusChangeLevel(same), 'none');
  // A slightly darker background: changed, but very low contrast.
  assert.equal(focusChangeLevel(pixelChange(box(white), box(Array(400).fill([240, 240, 240])))), 'faint');
  // One dark pixel out of 400: too small to see.
  assert.equal(focusChangeLevel({ changed: 1, total: 400, maxDiff: 200 }), 'faint');
  // A dark ring around the edge (76 of 400 pixels).
  const ring = white.map((p, i) => (i < 20 || i >= 380 || i % 20 === 0 || i % 20 === 19 ? [0, 0, 255] : p));
  assert.equal(focusChangeLevel(pixelChange(box(white), box(ring))), 'visible');
  // Small changes from compression noise (8 or less) do not count.
  assert.equal(pixelChange(box(white), box(Array(400).fill([250, 251, 247]))).changed, 0);
});
