// Building the "Copy report" Markdown.
// Pure function with no Chrome APIs, so it can be unit tested in Node.

import {
  CORE_CHECKS,
  coreStatuses,
  countGood,
  statusText,
  groupResults,
  impactText,
  summarizeScan,
} from './scoring.js';
import { pageLabel, readable } from './pagekey.js';

export const CAVEAT = 'Automated checks only find some problems. A clean scan does not mean your page meets WCAG.';

/**
 * @param {object} input
 * @param {string} input.name           extension name
 * @param {Date}   input.date           when the report was made
 * @param {string} input.page           page label, without query or hash
 * @param {object|null} input.scan      full scan from this session, or null
 * @param {object|null} input.lastScan  stored summary (used if there is no full scan)
 * @param {object} input.manual         guided check statuses by id
 * @param {Array}  input.manualChecks   guided checks from data/manual-checks.json
 * @param {object} input.titles         plain titles for core rules, by rule id
 * @param {{fixed:number,new:number}|null} input.since  rescan comparison
 * @param {object|null} input.auto     guided checks' automated counts ({ id: { i, p } });
 *                                      defaults to the ones saved with lastScan
 */
export function buildReport({
  name,
  date,
  page,
  scan,
  lastScan,
  manual = {},
  manualChecks = [],
  titles = {},
  since = null,
  auto = null,
}) {
  const ruleCounts = scan ? summarizeScan(scan) : (lastScan && lastScan.rules) || null;
  const found = auto || (lastScan && lastScan.auto) || null;
  const axeVersion = (scan && scan.axeVersion) || (lastScan && lastScan.axeVersion) || '';
  const scannedAt = (scan && scan.scannedAt) || (lastScan && lastScan.at) || null;

  const lines = [`# Accessibility report: ${page}`, ''];
  lines.push(`- Date: ${formatDate(date)}`);
  lines.push(`- Page: ${page}`);
  lines.push(`- Last scan: ${scannedAt ? formatDate(new Date(scannedAt)) : 'Not scanned yet'}`);
  lines.push(`- Tool: ${name}${axeVersion ? `, using axe-core ${axeVersion}` : ''}`);
  if (since) lines.push(`- Since last scan: ${since.fixed} fixed, ${since.new} new`);
  lines.push('');

  pushCoreChecks(lines, coreStatuses(ruleCounts, manual, found), Boolean(ruleCounts));
  if (scan) pushIssues(lines, groupResults(scan, Infinity), titles);
  else if (lastScan) {
    lines.push('## Issues found', '', 'Details are not available. Scan the page again to include them.', '');
  }
  pushGuidedChecks(lines, manualChecks, manual, found);
  lines.push(`_${CAVEAT}_`, '');
  return lines.join('\n');
}

function pushCoreChecks(lines, statuses, scanned) {
  // Never "0 of 8" before a scan: that reads like a result.
  lines.push(
    scanned
      ? `## Core checks: ${countGood(statuses)} of ${CORE_CHECKS.length} look good`
      : '## Core checks: Not scanned yet',
  );
  lines.push('');
  for (const check of statuses) {
    const count = check.status === 'needs-review' ? check.review : check.issues;
    let text = statusText(check.status, count);
    if (check.status === 'issues' && check.review > 0) text += `, ${statusText('needs-review', check.review)}`;
    lines.push(`- ${check.name}: ${text}`);
  }
  lines.push('');
}

function pushIssues(lines, groups, titles) {
  lines.push('## Issues found');
  lines.push('');
  if (groups.fixNext.length === 0) {
    lines.push('The scan found no WCAG issues.');
    lines.push('');
  }
  groups.fixNext.forEach((rule, index) => pushRule(lines, rule, `${index + 1}.`, titles));

  if (groups.needsReview.length) {
    lines.push('## Needs review (the scan could not decide)');
    lines.push('');
    groups.needsReview.forEach((rule) => pushRule(lines, rule, '-', titles));
  }
  const bp = groups.bestPractice.issues;
  if (bp.length) {
    lines.push('## Best practices (not WCAG failures)');
    lines.push('');
    bp.forEach((rule) => pushRule(lines, rule, '-', titles));
  }
  if (groups.framesSkipped > 0) {
    lines.push(
      `Note: ${groups.framesSkipped} frame(s) on the page could not be scanned. Open each one on its own to scan it:`,
    );
    for (const frame of groups.skippedFrames)
      lines.push(`- ${pageLabel(frame.frameUrl) || 'A frame whose address could not be read'}`);
    lines.push('');
  }
}

function pushGuidedChecks(lines, manualChecks, manual, found) {
  lines.push('## Guided checks');
  lines.push('');
  const checked = manualChecks.filter((check) => manual[check.id] && manual[check.id] !== 'not-checked').length;
  lines.push(`${checked} of ${manualChecks.length} checked.`);
  lines.push('');
  for (const check of manualChecks) {
    let line = `- ${check.title} (WCAG ${check.wcag}, level ${check.level}): ${statusText(manual[check.id] || 'not-checked')}`;
    const counts = found && found[check.id];
    if (counts && counts.i) line += `. Scan: ${statusText('issues', counts.i)}`;
    if (counts && counts.p) line += `. Scan: ${statusText('possible', counts.p)}`;
    lines.push(line);
  }
  lines.push('');
}

function pushRule(lines, rule, bullet, titles) {
  const title = titles[rule.id] || rule.help;
  const impact = impactText(rule.impact);
  lines.push(
    `${bullet} **${title}** (rule \`${rule.id}\`, ${rule.count} element${rule.count === 1 ? '' : 's'}${impact ? `, impact ${impact.toLowerCase()}` : ''})`,
  );
  for (const node of rule.nodes.slice(0, 5)) {
    lines.push(`    - \`${targetText(node.target).replace(/`/g, "'")}\``);
  }
  if (rule.count > 5) lines.push(`    - and ${rule.count - 5} more`);
  lines.push(`    - More: ${rule.helpUrl}`);
  lines.push('');
}

/**
 * axe gives each element's location as a list of CSS selectors. One selector
 * means the element is in the page itself. More than one means it is inside
 * a frame or a shadow root (a hidden part of a web component).
 */
export function targetText(target) {
  return (target || []).map((part) => (Array.isArray(part) ? part.join(' >>> ') : part)).join(' >> ');
}

/**
 * Where an element is, in words, for elements inside frames or web
 * components, where axe's selector ("shadow-card >>> img") is hard to read.
 * Empty for elements in the page itself.
 */
export function targetPlace(target) {
  if (!Array.isArray(target) || target.length === 0) return '';
  const last = target[target.length - 1];
  const places = [];
  if (Array.isArray(last) && last.length > 1) {
    const host = String(last[last.length - 2]);
    places.push(`inside the ${(/^[a-z][\w-]*/i.exec(host) || [host])[0]} component`);
  }
  if (target.length > 1) places.push('inside a frame on this page');
  return places.join(', ');
}

/**
 * A plain description of an element, from facts read out of its HTML
 * snippet: { tag, type, role, name, src }. `name` is its text or label.
 *   "Button with no text", "Image: logo.png", 'Link: "Read the report"'
 */
export function describeElement({ tag = '', type = '', role = '', name = '', src = '' } = {}) {
  const noun = elementNoun({ tag, type, role });
  const text = String(name).replace(/\s+/g, ' ').trim();
  const quoted = `"${text.length > 60 ? `${text.slice(0, 59)}…` : text}"`;
  if (noun === 'Page') return 'The whole page (the <html> element)';
  if (noun === 'Image' && !text) {
    const file = fileName(src);
    return file ? `Image: ${file}` : 'Image with no description';
  }
  return text ? `${noun}: ${quoted}` : `${noun} with no text`;
}

const ROLE_NOUNS = {
  button: 'Button',
  link: 'Link',
  img: 'Image',
  image: 'Image',
  checkbox: 'Checkbox',
  radio: 'Radio button',
  switch: 'Switch',
  tab: 'Tab',
  menuitem: 'Menu item',
  textbox: 'Text field',
  searchbox: 'Search field',
  combobox: 'Dropdown',
  slider: 'Slider',
  heading: 'Heading',
  dialog: 'Dialog',
};

const TAG_NOUNS = {
  a: 'Link',
  button: 'Button',
  img: 'Image',
  svg: 'Image',
  area: 'Image map area',
  select: 'Dropdown',
  textarea: 'Text box',
  label: 'Label',
  iframe: 'Frame',
  video: 'Video',
  audio: 'Audio player',
  table: 'Table',
  th: 'Table header',
  td: 'Table cell',
  ul: 'List',
  ol: 'List',
  dl: 'List',
  li: 'List item',
  summary: 'Expand button',
  nav: 'Navigation',
  p: 'Paragraph',
  html: 'Page',
};

const INPUT_NOUNS = {
  button: 'Button',
  submit: 'Button',
  reset: 'Button',
  image: 'Image button',
  checkbox: 'Checkbox',
  radio: 'Radio button',
  range: 'Slider',
};

/** The kind of element, as a word: "Button", "Image", "<div> element". */
export function elementNoun({ tag = '', type = '', role = '' } = {}) {
  const t = tag.toLowerCase();
  const r = role.toLowerCase().trim().split(/\s+/)[0];
  if (ROLE_NOUNS[r]) return ROLE_NOUNS[r];
  if (t === 'input') return INPUT_NOUNS[type.toLowerCase()] || 'Text field';
  if (/^h[1-6]$/.test(t)) return 'Heading';
  if (TAG_NOUNS[t]) return TAG_NOUNS[t];
  return t ? `<${t}> element` : 'Element';
}

function fileName(src) {
  if (!src || /^data:/i.test(src)) return '';
  const path = String(src).split(/[?#]/)[0];
  return readable(path.split('/').filter(Boolean).pop() || '');
}

function formatDate(date) {
  // YYYY-MM-DD HH:MM in the user's time zone.
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
