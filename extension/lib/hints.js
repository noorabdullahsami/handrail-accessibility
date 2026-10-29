// Turns scan results and helper data into what each guided check shows.
// Pure functions, so they can be unit tested.
//
// Every finding has one of three levels:
//   issue     the tool is confident: shown as "Issues found (N)"
//   possible  a likely problem a person must confirm
//   list      evidence to look through (an outline, a list), not a problem
// Nothing here ever marks a check "Looks good". Only a person does that.

import { t } from './i18n.js';

/** Which focus check findings belong to which guided check, and at what level. */
export const FOCUS_WALK_FINDINGS = {
  'focus-visible': { issue: ['noFocusConfirmed', 'invisibleFocus'], possible: ['faintFocus', 'maybeNoFocus'] },
  'focus-order': { issue: [], possible: ['positiveTabindex', 'orderJumps'] },
  'focus-not-hidden': { issue: ['coveredBySticky'], possible: [] },
};

const WALK_TITLES = {
  noFocusConfirmed: 'groupNoFocusConfirmed',
  invisibleFocus: 'groupInvisibleFocus',
  faintFocus: 'groupFaintFocus',
  maybeNoFocus: 'groupMaybeNoFocus',
  positiveTabindex: 'groupPositiveTabindex',
  orderJumps: 'groupOrderJumps',
  coveredBySticky: 'groupCoveredBySticky',
};

/**
 * @param {object} check     a guided check from data/manual-checks.json
 * @param {object} sources
 * @param {object|null} sources.scan   full scan results (or null)
 * @param {object|null} sources.lists  result of collectLists() (or null)
 * @param {object|null} sources.walk   result of focusChecks() (or null)
 * @param {object} titles              plain titles for axe rules, by rule id
 * @returns {{ groups: object[], issues: number, possible: number, needsScan: boolean, needsWalk: boolean, manualOnly: boolean }}
 *
 * Each group: { title, level, kind: 'axe' | 'items' | 'outline' | 'note', count, items, helpUrl? }
 */
export function hintGroups(check, { scan = null, lists = null, walk = null } = {}, titles = {}) {
  const axeRules = check.axe_rules || [];
  const axePossible = check.axe_possible || [];
  const helpers = check.helpers || [];
  const groups = [];
  const usesWalk = helpers.includes('focus-walk');
  const usesLists = helpers.some((h) => h !== 'focus-walk');

  if (scan) {
    for (const ruleId of [...axeRules, ...axePossible]) {
      for (const [type, list] of [
        ['issue', scan.violations],
        ['review', scan.incomplete],
      ]) {
        const rule = (list || []).find((r) => r.id === ruleId);
        if (!rule) continue;
        const experimental = (rule.tags || []).includes('experimental');
        // Stable axe failures mapped to this check are automated results.
        // "Needs review", experimental rules, and rules listed as
        // axe_possible are likely problems for a person to confirm.
        const level = type === 'issue' && !experimental && axeRules.includes(ruleId) ? 'issue' : 'possible';
        let title = titles[rule.id] || rule.help;
        if (experimental) title = `Possible: ${title}`;
        if (type === 'review') title += ' (needs review)';
        groups.push({ title, level, kind: 'axe', count: rule.count, items: rule.nodes, helpUrl: rule.helpUrl });
      }
    }
  }

  if (lists) {
    for (const helper of helpers) groups.push(...listGroups(helper, lists));
  }

  if (walk && usesWalk) {
    const findings = FOCUS_WALK_FINDINGS[check.id] || { issue: [], possible: [] };
    for (const level of ['issue', 'possible']) {
      for (const key of findings[level]) {
        const finding = walk[key];
        if (finding && finding.count > 0)
          groups.push({ title: t(WALK_TITLES[key]), level, kind: 'items', count: finding.count, items: finding.items });
      }
    }
    groups.push(note(t('noteFocusStops', { stops: walk.stops, total: walk.total })));
    if (walk.capped) groups.push(note(t('noteFocusCapped', { total: walk.total, max: walk.stops })));
    if (walk.stopped === 'time') groups.push(note(t('noteFocusTime', { done: walk.stops, total: walk.total })));
    if (walk.stopped === 'cancelled')
      groups.push(note(t('noteFocusCancelled', { done: walk.stops, total: walk.total })));
    if (check.id === 'focus-visible' && walk.pixelSkipped) groups.push(note(t('notePixelSkipped')));
    if (walk.unreadableSheets > 0) groups.push(note(t('noteUnreadableSheets', { count: walk.unreadableSheets })));
  }

  const kept = groups.filter((g) => !(g.level !== 'list' && g.kind !== 'note' && g.count === 0));
  const sum = (level) => kept.filter((g) => g.level === level).reduce((total, g) => total + g.count, 0);
  return {
    groups: kept,
    issues: sum('issue'),
    possible: sum('possible'),
    needsScan: (axeRules.length > 0 || axePossible.length > 0 || usesLists) && !scan,
    needsWalk: usesWalk && !walk,
    manualOnly: axeRules.length === 0 && axePossible.length === 0 && helpers.length === 0,
  };
}

function note(title) {
  return { title, level: 'note', kind: 'note', count: 0, items: [] };
}

function listGroups(helper, lists) {
  const group = (title, data, level) => ({ title, level, kind: 'items', count: data.count, items: data.items });
  switch (helper) {
    case 'clickables':
      return [group('Looks clickable but cannot be reached with Tab', lists.clickables, 'possible')];
    case 'headings':
      return [
        lists.headings.count
          ? {
              title: `Heading outline (${lists.headings.count})`,
              level: 'list',
              kind: 'outline',
              count: 0,
              items: lists.headings.items,
            }
          : note('No headings found on this page.'),
      ];
    case 'links':
      return [
        group('Links with vague text', lists.links, 'possible'),
        note(`${lists.links.total} links on the page in total.`),
      ];
    case 'duplicate-links':
      return [group(t('groupDuplicateLinks'), lists.duplicateLinks, 'possible')];
    case 'images':
      return [
        group('Alt text that may not describe the image', lists.images, 'possible'),
        note(`${lists.images.total} images on the page have alt text.`),
      ];
    case 'same-alts':
      return [group(t('groupSameAlts'), lists.sameAlts, 'possible')];
    case 'placeholders':
      return [group('Fields named only by placeholder text', lists.placeholders, 'possible')];
    case 'skip':
      return lists.skip.skipLink || lists.skip.hasMain
        ? []
        : [{ title: t('groupNoSkip'), level: 'possible', kind: 'note', count: 1, items: [] }];
    case 'live-regions':
      return [
        lists.liveRegions.count
          ? group('Areas that announce updates (live regions)', lists.liveRegions, 'list')
          : note('No live regions found. If this page shows messages like "Saved", screen readers may not read them.'),
      ];
    case 'roles':
      return lists.roles.count ? [group('Custom controls to try with a screen reader', lists.roles, 'list')] : [];
    default:
      return [];
  }
}

/**
 * Issue and possible-problem counts per guided check that has any
 * automation, for storage, the Core 8 and the report: { checkId: { i, p } }.
 */
export function autoCounts(checks, sources, titles = {}) {
  const counts = {};
  for (const check of checks) {
    const result = hintGroups(check, sources, titles);
    // A focus check has no counts until the focus walk has run.
    if (!result.manualOnly && !result.needsScan && !result.needsWalk)
      counts[check.id] = { i: result.issues, p: result.possible };
  }
  return counts;
}
