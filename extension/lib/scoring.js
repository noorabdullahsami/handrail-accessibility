// Turning raw scan results and manual statuses into the Core 8 summary,
// the "Fix these next" order, and the "Since last scan" comparison.
// Pure functions with no Chrome APIs, so they can be unit tested in Node.

import { t } from './i18n.js';

/**
 * The Core 8. Six are checked by axe rules, two are guided manual checks.
 * `name` is the short label used in the summary and the report.
 */
export const CORE_CHECKS = [
  { id: 'color-contrast', name: 'Text contrast', kind: 'automated', rules: ['color-contrast'] },
  { id: 'image-alt', name: 'Image descriptions', kind: 'automated', rules: ['image-alt'] },
  { id: 'label', name: 'Form labels', kind: 'automated', rules: ['label'] },
  { id: 'link-name', name: 'Link names', kind: 'automated', rules: ['link-name'] },
  { id: 'button-name', name: 'Button names', kind: 'automated', rules: ['button-name'] },
  { id: 'page-language', name: 'Page language', kind: 'automated', rules: ['html-has-lang', 'html-lang-valid'] },
  { id: 'keyboard', name: 'Keyboard access', kind: 'manual', manualId: 'keyboard' },
  { id: 'focus-visible', name: 'Visible focus', kind: 'manual', manualId: 'focus-visible' },
];

/** Every axe rule that belongs to a Core 8 check. */
export const CORE_RULE_IDS = new Set(CORE_CHECKS.flatMap((check) => check.rules || []));

export const MANUAL_STATUSES = ['not-checked', 'looks-good', 'has-problem'];

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];

/** The rule axe uses to report frames it could not get into. */
export const FRAME_RULE_ID = 'frame-tested';

/**
 * Shrink a full scan to the small summary we store:
 * { ruleId: { v: violationCount, i: needsReviewCount } }.
 * Only rules with at least one result are included.
 */
export function summarizeScan(scan) {
  const counts = {};
  for (const rule of (scan.violations || []).filter(isStable)) {
    counts[rule.id] = counts[rule.id] || { v: 0, i: 0 };
    counts[rule.id].v += rule.count;
  }
  for (const rule of (scan.incomplete || []).filter(isStable)) {
    if (rule.id === FRAME_RULE_ID) continue;
    counts[rule.id] = counts[rule.id] || { v: 0, i: 0 };
    counts[rule.id].i += rule.count;
  }
  return counts;
}

/**
 * Work out the status of each Core 8 check.
 * `ruleCounts` is the output of summarizeScan(), or null if not scanned.
 * `manual` maps manual check ids to 'not-checked' | 'looks-good' | 'has-problem'.
 * `auto` is the automated counts per guided check ({ id: { i, p } }), or
 * null before the scan's checks have run.
 *
 * Status codes:
 *   automated: 'not-scanned' | 'no-issues' | 'issues' | 'needs-review'
 *   manual:    'not-checked' | 'looks-good' | 'has-problem', and after a
 *              scan: 'issues' (the tool found some) or 'quick-check'
 * A check is "good" if it has no issues and nothing to review, or if a
 * person marked it "Looks good" and the tool found no issues. The tool
 * never marks anything "Looks good" itself.
 */
export function coreStatuses(ruleCounts, manual = {}, auto = null) {
  return CORE_CHECKS.map((check) => {
    if (check.kind === 'manual') {
      const marked = MANUAL_STATUSES.includes(manual[check.manualId]) ? manual[check.manualId] : 'not-checked';
      const found = auto && auto[check.manualId];
      let status = marked;
      if (found && found.i > 0) status = 'issues';
      else if (found && marked === 'not-checked') status = 'quick-check';
      const issues = found ? found.i : 0;
      return { ...check, status, issues, review: 0, good: status === 'looks-good' };
    }
    if (!ruleCounts) {
      return { ...check, status: 'not-scanned', issues: 0, review: 0, good: false };
    }
    let issues = 0;
    let review = 0;
    for (const ruleId of check.rules) {
      issues += (ruleCounts[ruleId] && ruleCounts[ruleId].v) || 0;
      review += (ruleCounts[ruleId] && ruleCounts[ruleId].i) || 0;
    }
    let status = 'no-issues';
    if (issues > 0) status = 'issues';
    else if (review > 0) status = 'needs-review';
    return { ...check, status, issues, review, good: status === 'no-issues' };
  });
}

/** How many of the Core 8 look good. */
export function countGood(statuses) {
  return statuses.filter((s) => s.good).length;
}

/** Counts with a thousands separator: 1,284. The panel's text is English. */
export function formatCount(count) {
  return Number(count).toLocaleString('en');
}

/** The words shown for each status. Never "pass", "compliant" or "accessible". */
export function statusText(status, count = 0) {
  switch (status) {
    case 'no-issues':
      return 'Nothing found by automated checks';
    case 'issues':
      return `Issues found (${formatCount(count)})`;
    case 'needs-review':
      return `Needs review (${formatCount(count)})`;
    case 'not-scanned':
      return 'Not scanned yet';
    case 'looks-good':
      return 'Looks good';
    case 'has-problem':
      return 'Has a problem';
    case 'quick-check':
      return t('statusQuickCheck');
    case 'possible':
      return t('statusPossible', { count: formatCount(count) });
    default:
      return 'Not checked';
  }
}

/**
 * False for axe's experimental rules. We run one (p-as-heading) only as a
 * "possible" hint in the guided checks, so it never counts as an issue.
 */
function isStable(rule) {
  return !(rule.tags || []).includes('experimental');
}

/** True for axe rules that are best practices, not WCAG failures. */
export function isBestPractice(rule) {
  const tags = rule.tags || [];
  return !tags.some((tag) => /^wcag\d/.test(tag)) && tags.includes('best-practice');
}

/** Which Core 8 check (if any) a rule belongs to. */
export function coreCheckForRule(ruleId) {
  return CORE_CHECKS.find((check) => (check.rules || []).includes(ruleId)) || null;
}

/**
 * Order WCAG issues for "Fix these next":
 * Core 8 first, then by impact (critical, serious, moderate, minor),
 * then by how many elements are affected (most first).
 */
export function prioritize(rules) {
  const impactRank = (impact) => {
    const index = IMPACT_ORDER.indexOf(impact);
    return index === -1 ? IMPACT_ORDER.length : index;
  };
  return [...rules].sort((a, b) => {
    const coreA = CORE_RULE_IDS.has(a.id) ? 0 : 1;
    const coreB = CORE_RULE_IDS.has(b.id) ? 0 : 1;
    if (coreA !== coreB) return coreA - coreB;
    const impact = impactRank(a.impact) - impactRank(b.impact);
    if (impact !== 0) return impact;
    if (b.count !== a.count) return b.count - a.count;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Split a scan into the groups the panel shows.
 *   fixNext       up to `limit` WCAG issues, highest priority first
 *   otherIssues   the rest of the WCAG issues, same order
 *   needsReview   WCAG rules axe could not decide on
 *   bestPractice  best-practice issues and items to review
 *   framesSkipped how many frames axe could not get into
 *   skippedFrames those frames, each with `frameUrl` when the page shows it
 */
export function groupResults(scan, limit = 5) {
  const violations = (scan.violations || []).filter(isStable);
  const incomplete = (scan.incomplete || []).filter(isStable);
  const ordered = prioritize(violations.filter((rule) => !isBestPractice(rule)));
  const frameRule = incomplete.find((rule) => rule.id === FRAME_RULE_ID);
  return {
    fixNext: ordered.slice(0, limit),
    otherIssues: ordered.slice(limit),
    needsReview: prioritize(incomplete.filter((rule) => !isBestPractice(rule))),
    bestPractice: {
      issues: prioritize(violations.filter(isBestPractice)),
      review: prioritize(incomplete.filter((rule) => isBestPractice(rule) && rule.id !== FRAME_RULE_ID)),
    },
    framesSkipped: frameRule ? frameRule.count : 0,
    skippedFrames: frameRule ? frameRule.nodes : [],
  };
}

/**
 * Compare two summaries from summarizeScan() for the same page.
 * Counts affected elements: if a rule went from 5 to 2, that is 3 fixed.
 * Only issues are compared, not "needs review" items.
 */
export function compareScans(previous, current) {
  let fixed = 0;
  let added = 0;
  const ruleIds = new Set([...Object.keys(previous || {}), ...Object.keys(current || {})]);
  for (const ruleId of ruleIds) {
    const before = (previous && previous[ruleId] && previous[ruleId].v) || 0;
    const after = (current && current[ruleId] && current[ruleId].v) || 0;
    if (after < before) fixed += before - after;
    if (after > before) added += after - before;
  }
  return { fixed, new: added };
}

/** Plain words for axe's impact levels. */
export function impactText(impact) {
  const words = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' };
  return words[impact] || '';
}
