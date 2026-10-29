// The side panel: finds the current page, runs scans, and shows results,
// guided checks, and saved progress.

import { pageKey, pageLabel } from '../lib/pagekey.js';
import { scanTab, ScanProblem, explainProblem, problemForUrl, codeFromChromeError } from '../lib/scan.js';
import {
  CORE_CHECKS,
  coreStatuses,
  countGood,
  statusText,
  formatCount,
  groupResults,
  summarizeScan,
  compareScans,
  impactText,
  coreCheckForRule,
} from '../lib/scoring.js';
import {
  emptyPage,
  loadPage,
  saveManualStatus,
  saveScanSummary,
  saveAutoCounts,
  clearPage,
  clearAll,
} from '../lib/storage.js';
import { buildReport, targetText, targetPlace, describeElement, elementNoun } from '../lib/report.js';
import { showOnPage, clearHighlight } from '../lib/highlight.js';
import { collectLists, focusChecks } from '../lib/helpers.js';
import { hintGroups, autoCounts } from '../lib/hints.js';
import { t } from '../lib/i18n.js';

// The name lives only in _locales/en/messages.json.
const NAME = chrome.i18n.getMessage('extShortName') || 'Accessibility checker';

// For automated tests only: "panel.html?tabId=123" works on that tab instead
// of the active tab, because a test cannot click the toolbar icon.
const FIXED_TAB_ID = Number(new URLSearchParams(location.search).get('tabId')) || null;

const $ = (id) => document.getElementById(id);

/** How long a scan waits for a page that is still loading. */
const LOAD_WAIT_MS = 10000;
const LOAD_POLL_MS = 250;
/** The meter fill animation lasts 300ms; remove its class a little after. */
const METER_FILL_MS = 400;
/** Possible problems show this many at a time, so a noisy page stays readable. */
const POSSIBLE_PAGE_SIZE = 10;

const state = {
  windowId: null,
  tab: null, // the tab we are looking at: { id, url, status }
  key: null, // its page key (origin + pathname), or null
  page: emptyPage(), // what is saved for this page
  scan: null, // full results of the latest scan in this session
  scanKey: null, // page key that `scan` belongs to
  since: null, // { fixed, new } compared with the scan before
  scanning: false,
  highlightTabId: null,
  automatedCopy: [], // data/automated-core.json
  axeCopy: {}, // data/axe-rules.json, plain copy for every other axe rule
  titles: {}, // plain title for every axe rule, by rule id
  manualChecks: [], // data/manual-checks.json
  pendingConfirm: null,
  confirmOpener: null, // the button that opened the confirm box
  lists: null, // review lists from the last scan (same page as `scan`)
  walk: null, // results of the last keyboard focus check
  walkKey: null, // page key that `walk` belongs to
  walkState: null, // focus checks: 'running' | 'done' | 'failed' | null
  focusCancel: false, // set by the Cancel button while the focus checks run
};

// Start up

init().catch((error) => {
  console.error(error);
  showNotice('unknown', String(error && error.message));
});

async function init() {
  for (const node of document.querySelectorAll('[data-name]')) node.textContent = NAME;
  document.title = NAME;

  const [automated, manual, axeCopy] = await Promise.all([
    loadJson('../data/automated-core.json'),
    loadJson('../data/manual-checks.json'),
    loadJson('../data/axe-rules.json'),
  ]);
  state.automatedCopy = automated;
  state.manualChecks = manual;
  state.axeCopy = axeCopy;
  state.titles = Object.fromEntries(Object.entries(axeCopy).map(([id, entry]) => [id, entry.title]));
  for (const entry of automated) for (const id of entry.rules) state.titles[id] = entry.title;

  if (!FIXED_TAB_ID) state.windowId = (await chrome.windows.getCurrent()).id;

  renderGuidedChecks();
  wireEvents();
  await refreshPage();
}

async function loadJson(path) {
  // This reads a file packaged inside the extension. It is not a network request.
  const response = await fetch(path);
  return response.json();
}

function wireEvents() {
  $('scan-button').addEventListener('click', onScan);
  $('clear-highlight').addEventListener('click', onClearHighlight);
  $('other-toggle').addEventListener('click', toggleOtherIssues);
  $('copy-report').addEventListener('click', onCopyReport);
  $('clear-page').addEventListener('click', () =>
    askToConfirm('Clear the saved scan summary and guided check answers for this page?', onClearPage),
  );
  $('clear-all').addEventListener('click', () =>
    askToConfirm(`Clear everything ${NAME} has saved, for every page?`, onClearAll),
  );
  $('confirm-yes').addEventListener('click', () => {
    const action = state.pendingConfirm;
    closeConfirm();
    if (action) action();
  });
  $('focus-cancel').textContent = t('progressCancel');
  $('focus-cancel').addEventListener('click', () => {
    state.focusCancel = true;
    $('focus-cancel').setAttribute('aria-disabled', 'true');
  });
  $('confirm-no').addEventListener('click', () => {
    const opener = state.confirmOpener;
    closeConfirm();
    // The Cancel button is now hidden, so put focus back where the user was.
    if (opener) opener.focus();
  });

  // Follow the user as they switch tabs or the page changes.
  chrome.tabs.onActivated.addListener((info) => {
    if (!FIXED_TAB_ID && info.windowId === state.windowId) refreshPage();
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === 'loading') navigatedAt.set(tabId, Date.now());
    // A new page load takes the overlay with it, so forget it here too.
    if (change.status === 'loading' && tabId === state.highlightTabId) forgetHighlight();
    // A new hash or query on the same page (scroll spies, routers) keeps the
    // same saved key, so redrawing would only collapse items and drop focus.
    // No address means we may have lost access, so always refresh then.
    const samePage = tab.url && pageKey(tab.url) === state.key;
    if (state.tab && tabId === state.tab.id && (change.status || change.url) && !samePage) refreshPage();
  });
  // The background script writes this when the toolbar icon is clicked.
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.lastClick) refreshPage({ clearNotice: true });
  });

  // Best effort: remove the outline from the page when the panel closes.
  window.addEventListener('pagehide', () => {
    if (state.highlightTabId) clearHighlight(state.highlightTabId).catch(() => {});
  });
  // Escape anywhere in the panel removes the outline from the page.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.highlightTabId) {
      event.preventDefault();
      onClearHighlight();
    }
  });
}

// Which page are we on?

async function getTargetTab() {
  if (FIXED_TAB_ID) return chrome.tabs.get(FIXED_TAB_ID);
  const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
  return tab || null;
}

// When each tab last started loading a new page. Used to tell "you have not
// clicked the icon on this page yet" apart from "Chrome refuses this page".
const navigatedAt = new Map();

/**
 * Work out why a tab cannot be scanned, or return null if it can.
 * When we cannot see the address, ask Chrome directly with a harmless script
 * call. Its error message says why (for example "Cannot access a chrome://
 * URL"). We checked these cases in Chrome rather than guessing.
 */
async function detectProblem(tab) {
  if (tab.url) return problemForUrl(tab.url, { fileAccessAllowed: await fileAccessAllowed() });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => true });
    return null;
  } catch (error) {
    const code = codeFromChromeError(error.message);
    if (code !== 'no-access') return code;
    // The user clicked the icon on this page and Chrome still said no, so
    // this is a page Chrome never lets extensions read (like about:blank).
    const { lastClick } = await chrome.storage.session.get('lastClick');
    const clickedHere = lastClick && lastClick.tabId === tab.id && lastClick.at > (navigatedAt.get(tab.id) || 0);
    return clickedHere ? 'unsupported' : 'no-access';
  }
}

// Serialize refreshes so quick tab events cannot interleave.
let refreshChain = Promise.resolve();
function refreshPage(options) {
  refreshChain = refreshChain.then(() => doRefresh(options)).catch((error) => console.error(error));
  return refreshChain;
}

async function doRefresh({ clearNotice = false } = {}) {
  let tab = null;
  try {
    tab = await getTargetTab();
  } catch {
    tab = null;
  }
  state.tab = tab;

  // Chrome only shows us the address if we have access to the page.
  const url = tab && tab.url;
  const key = pageKey(url);
  const keyChanged = key !== state.key;
  state.key = key;

  if (key) {
    state.page = await loadPage(key);
  } else {
    state.page = emptyPage();
  }

  // The detailed results only belong to the page they came from.
  if (keyChanged && state.scanKey !== key) {
    state.since = null;
  }

  if (clearNotice || keyChanged) hideNotice();
  const problem = tab ? await detectProblem(tab) : 'no-tab';
  if (problem) showNotice(problem, '', { quiet: true });

  // Chrome only shows the address and title after the user clicks our icon on
  // this page (activeTab). Without that, we cannot know which page this is.
  let label = url ? pageLabel(url) || url : 'Not available on this page';
  if (!url && problem === 'no-access') label = `Unknown. Click the ${NAME} icon on this page to see it.`;
  $('page-label').textContent = label;
  $('page-title').textContent = url && tab.title && tab.title !== url ? tab.title : '';

  $('guided-save-note').hidden = Boolean(key);
  $('guided-list').classList.toggle('readonly', !key);
  renderAll();
}

async function fileAccessAllowed() {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

// Scanning

async function onScan() {
  if (state.scanning) return;
  hideNotice();
  await refreshPage();
  const tab = state.tab;
  if (!tab) return showNotice('no-tab');

  const problem = await detectProblem(tab);
  if (problem) return showNotice(problem);

  setScanning(true);
  try {
    if (!(await waitForLoad(tab.id))) {
      showNotice('loading');
      return;
    }
    if (state.highlightTabId) await onClearHighlight();

    const scan = await scanTab(tab.id);
    const key = pageKey(scan.url) || state.key;
    const summary = { at: scan.scannedAt, axeVersion: scan.axeVersion, rules: summarizeScan(scan) };

    let previous = null;
    if (key) {
      const saved = await saveScanSummary(key, summary);
      previous = saved.previous;
      state.page = saved.page;
    } else {
      state.page = { ...state.page, lastScan: summary };
    }
    state.scan = scan;
    state.scanKey = key;
    state.key = key;
    state.since = previous ? compareScans(previous.rules, summary.rules) : null;

    // Read-only lists for the guided checks. If this fails, the scan still counts.
    state.lists = null;
    try {
      state.lists = await collectLists(tab.id);
    } catch (error) {
      console.warn('Could not collect the review lists:', error);
    }

    state.walk = null;
    state.walkKey = key;
    state.walkState = 'running';
    renderAll();
    fillMeter();

    const good = countGood(currentStatuses());
    let message = `Scan complete: ${good} of ${CORE_CHECKS.length} core checks look good.`;
    if (state.since) message += ` Since last scan: ${state.since.fixed} fixed, ${state.since.new} new.`;
    announce(message);
    $('summary-heading').focus();

    await runFocusChecks(tab, key);
  } catch (error) {
    if (error instanceof ScanProblem) showNotice(error.code, error.technical);
    else showNotice('unknown', String(error && error.message));
  } finally {
    setScanning(false);
  }
}

/**
 * The automated part of the guided checks that moves focus: after axe, with
 * a progress line, a Cancel button, and the limits in helpers.js. Afterwards
 * only the summary and the guided checks are redrawn, so focus inside the
 * issue lists is kept.
 */
async function runFocusChecks(tab, key) {
  state.focusCancel = false;
  $('focus-cancel').setAttribute('aria-disabled', 'false');
  const progress = (done, total) => {
    $('focus-progress-text').textContent = t('progressFocus', { done, total });
    $('focus-progress').hidden = false;
  };
  announce(t('announceFocusStart'));
  try {
    state.walk = await focusChecks(tab.id, {
      windowId: tab.windowId,
      onProgress: progress,
      isCancelled: () => state.focusCancel,
    });
    state.walkState = 'done';
  } catch (error) {
    console.warn('The focus checks could not run:', error, error && error.technical);
    state.walkState = 'failed';
  } finally {
    $('focus-progress').hidden = true;
  }

  // Save the guided checks' counts with the scan, for the Core 8 and reports.
  const auto = autoCounts(state.manualChecks, hintSources(), state.titles);
  if (key) state.page = await saveAutoCounts(key, auto);
  if (state.key !== key) return; // the user moved to another page meanwhile
  renderSummary();
  renderHints();
  announce(t('announceFocusDone', { good: countGood(currentStatuses()), total: CORE_CHECKS.length }));
}

/** The one motion moment: after a scan, the meter's cells fill left to right. */
function fillMeter() {
  const meter = $('meter');
  meter.classList.remove('filling');
  void meter.offsetWidth; // restart the animation on a rescan
  meter.classList.add('filling');
  // Done after 300ms; later redraws (a status change, the focus checks
  // finishing) must not replay it.
  setTimeout(() => meter.classList.remove('filling'), METER_FILL_MS);
}

/** Guided checks' automated counts: from this session, or saved with the scan. */
function currentAuto() {
  if (state.scan && state.scanKey === state.key) return autoCounts(state.manualChecks, hintSources(), state.titles);
  return (state.page.lastScan && state.page.lastScan.auto) || null;
}

function currentStatuses() {
  return coreStatuses(currentRuleCounts(), state.page.manual, currentAuto());
}

function setScanning(on) {
  state.scanning = on;
  const button = $('scan-button');
  // aria-disabled instead of disabled, so keyboard focus stays on the button.
  button.setAttribute('aria-disabled', String(on));
  button.textContent = on ? 'Scanning…' : 'Scan this page';
  if (on) announce('Scanning the page. This can take a few seconds.');
}

async function waitForLoad(tabId) {
  for (let waited = 0; waited <= LOAD_WAIT_MS; waited += LOAD_POLL_MS) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'loading') return true;
    await new Promise((resolve) => setTimeout(resolve, LOAD_POLL_MS));
  }
  return false;
}

// Rendering

function renderAll() {
  renderHeader();
  updateReportButton();
  renderSummary();
  renderResults();
  updateGuidedStatuses();
  renderHints();
}

function renderHeader() {
  const last = state.page.lastScan;
  $('last-scanned').textContent = last ? `Last scanned: ${formatTime(last.at)}` : 'Not scanned yet';
}

function currentRuleCounts() {
  if (state.scan && state.scanKey === state.key) return summarizeScan(state.scan);
  return state.page.lastScan ? state.page.lastScan.rules : null;
}

function renderSummary() {
  const counts = currentRuleCounts();
  const statuses = currentStatuses();
  // The big number answers the panel's question. Never "0 of 8" before a
  // scan: that reads like a result.
  if (counts) {
    const number = el(
      'span',
      { class: 'headline-number' },
      t('meterNumber', { good: countGood(statuses), total: CORE_CHECKS.length }),
    );
    $('headline').replaceChildren(number, ' ', t('meterLookGood'));
  } else {
    $('headline').textContent = 'Not scanned yet';
  }
  $('meter').replaceChildren(...statuses.map((check, index) => meterCell(check, index)));
  $('meter').hidden = !counts;

  const since = $('since-last');
  since.hidden = !state.since || state.scanKey !== state.key;
  if (state.since) since.textContent = `Since last scan: ${state.since.fixed} fixed, ${state.since.new} new`;

  const hasDetails = state.scan && state.scanKey === state.key;
  const stale = $('stale-note');
  stale.hidden = Boolean(hasDetails) || !state.page.lastScan;
  stale.textContent = 'These results are from your last scan of this page. Scan again to see the details.';

  const list = $('core-list');
  list.replaceChildren(...statuses.map((check) => coreRow(check, hasDetails)));

  renderFrames(hasDetails ? groupResults(state.scan) : null);
}

/** One row of the Core 8 list: name, status and a button that leads to the details. */
function coreRow(check, hasDetails) {
  const count = check.status === 'needs-review' ? check.review : check.issues;
  const nameBlock = el(
    'span',
    { class: 'core-name' },
    check.name,
    el('span', { class: 'core-kind' }, check.kind === 'manual' ? 'Check by hand' : 'Scan'),
  );
  const badges = el('span', { class: 'core-badges' }, statusBadge(check.status, count));
  if (check.status === 'issues' && check.review > 0) {
    badges.append(statusBadge('needs-review', check.review));
  }
  // The status and its button share the row's right side.
  const side = el('span', { class: 'core-side' }, badges);
  const item = el('li', {}, nameBlock, side);
  if (check.kind === 'automated' && hasDetails && (check.issues > 0 || check.review > 0)) {
    const label = check.issues > 0 ? 'Show issues' : 'Show items to review';
    side.append(
      el(
        'button',
        { type: 'button', class: 'button small', onclick: () => openIssueGroup(check) },
        label,
        el('span', { class: 'visually-hidden' }, `: ${check.name}`),
      ),
    );
  }
  if (check.kind === 'manual') {
    side.append(
      el(
        'button',
        { type: 'button', class: 'button small', onclick: () => openGuidedCheck(check.manualId) },
        'Go to check',
        el('span', { class: 'visually-hidden' }, `: ${check.name}`),
      ),
    );
  }
  return item;
}

/**
 * One cell of the Core 8 meter. Its shape says the state as well as its
 * colour: filled (looks good), solid edge with the count (issues), dashed
 * edge (needs review or a quick check), thin edge (not checked).
 */
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function meterCell(check, index) {
  const state =
    {
      'no-issues': 'good',
      'looks-good': 'good',
      issues: 'issues',
      'has-problem': 'issues',
      'needs-review': 'review',
      'quick-check': 'review',
    }[check.status] || 'unchecked';
  const count = check.status === 'needs-review' ? check.review : check.issues;
  // Four digits do not fit a cell at 320px: 1,284 shows as 1.3K. The exact
  // count is in the row under the meter and in the cell's tooltip.
  const shown =
    (state === 'issues' || state === 'review') && count ? (count >= 1000 ? COMPACT.format(count) : String(count)) : '';
  return el(
    'span',
    {
      class: 'meter-cell',
      'data-state': state,
      style: `--i: ${index}`,
      title: `${check.name}: ${statusText(check.status, count)}`,
    },
    shown,
  );
}

/** Frames axe could not get into, each with a link to scan it on its own. */
function renderFrames(groups) {
  const frames = $('frames-note');
  const skipped = groups ? groups.framesSkipped : 0;
  frames.hidden = skipped === 0;
  if (!skipped) return frames.replaceChildren();
  frames.replaceChildren(
    el(
      'p',
      {},
      `${skipped} frame${skipped === 1 ? '' : 's'} on this page could not be scanned. ` +
        'Frames from other sites are out of reach, because Chrome only gives access to the site you clicked the icon on.',
    ),
    el(
      'ul',
      {},
      ...groups.skippedFrames.map(({ frameUrl }) => {
        const address = pageLabel(frameUrl);
        if (!address) return el('li', {}, 'A frame whose address the page does not show.');
        const item = el('li', {}, el('code', {}, address));
        if (/^(https?|file):/.test(frameUrl)) {
          item.append(' ', externalLink(frameUrl, 'Open this frame on its own to scan it', `: ${address}`));
        }
        return item;
      }),
    ),
  );
}

function statusBadge(status, count) {
  const tone =
    {
      'no-issues': 'good',
      'looks-good': 'good',
      issues: 'bad',
      'has-problem': 'bad',
      'needs-review': 'review',
      possible: 'review',
      'quick-check': 'review',
    }[status] || 'neutral';
  return el('span', { class: `status status-${tone}` }, statusText(status, count));
}

function renderResults() {
  const hasDetails = state.scan && state.scanKey === state.key;
  for (const id of ['fix-section', 'other-section', 'bp-section', 'review-block']) $(id).hidden = true;
  if (!hasDetails) {
    $('fix-list').replaceChildren();
    $('other-list').replaceChildren();
    $('review-list').replaceChildren();
    $('bp-list').replaceChildren();
    return;
  }

  const groups = groupResults(state.scan);

  $('fix-section').hidden = false;
  $('fix-empty').hidden = groups.fixNext.length > 0;
  $('fix-list').replaceChildren(...groups.fixNext.map((rule) => el('li', {}, issueItem(rule, 'issue'))));

  $('other-section').hidden = groups.otherIssues.length === 0;
  $('other-list').replaceChildren(...groups.otherIssues.map((rule) => el('li', {}, issueItem(rule, 'issue'))));
  $('other-intro').textContent =
    `${groups.otherIssues.length} more issue${groups.otherIssues.length === 1 ? '' : 's'} found, in order of priority.`;
  setOtherExpanded(false);

  $('review-block').hidden = groups.needsReview.length === 0;
  $('review-list').replaceChildren(...groups.needsReview.map((rule) => el('li', {}, issueItem(rule, 'review'))));

  const bpRules = [
    ...groups.bestPractice.issues.map((rule) => ({ rule, kind: 'issue' })),
    ...groups.bestPractice.review.map((rule) => ({ rule, kind: 'review' })),
  ];
  $('bp-section').hidden = bpRules.length === 0;
  $('bp-list').replaceChildren(...bpRules.map(({ rule, kind }) => el('li', {}, issueItem(rule, kind))));
}

function toggleOtherIssues() {
  setOtherExpanded($('other-toggle').getAttribute('aria-expanded') !== 'true');
}

function setOtherExpanded(open) {
  const count = $('other-list').children.length;
  $('other-toggle').setAttribute('aria-expanded', String(open));
  $('other-toggle').textContent = open ? 'Hide other issues' : `Show all other issues (${count})`;
  $('other-list').hidden = !open;
}

/** Plain copy for a rule: data/automated-core.json for the Core 8, else data/axe-rules.json. */
function copyForRule(ruleId) {
  return state.automatedCopy.find((entry) => entry.rules.includes(ruleId)) || state.axeCopy[ruleId] || null;
}

/** One expandable issue. `kind` is 'issue' or 'review'. */
function issueItem(rule, kind) {
  const copy = copyForRule(rule.id);
  const core = coreCheckForRule(rule.id);
  const title = copy ? copy.title : rule.help;
  const status = kind === 'review' ? 'needs-review' : 'issues';

  const meta = el('span', { class: 'item-meta' }, statusBadge(status, rule.count));
  const impact = impactText(rule.impact);
  if (impact && kind === 'issue') meta.append(el('span', { class: 'tag' }, `Impact: ${impact}`));
  if (core) meta.append(el('span', { class: 'tag' }, 'Core check'));

  const body = el('div', { class: 'item-body' });
  if (kind === 'review') {
    body.append(
      para(
        'Why you need to look',
        'The scan found something it could not judge on its own. Check each element below and decide if it is a problem.',
      ),
    );
  }
  if (copy) {
    body.append(para('Why it matters', copy.why), para('How to fix', copy.how_to_fix));
  } else {
    body.append(para('What this checks', rule.description));
    body.append(
      para('How to fix', 'Each element below lists what the scan found. The rule details link has examples.'),
    );
  }

  body.append(el('h4', {}, `Elements affected (${formatCount(rule.count)})`));
  if (rule.count > rule.nodes.length) {
    body.append(el('p', { class: 'muted' }, `Showing the first ${rule.nodes.length} of ${formatCount(rule.count)}.`));
  }
  body.append(...nodeList(rule.nodes));

  const links = el('p', {});
  if (copy && copy.url) {
    links.append(externalLink(copy.url, `What WCAG ${copy.wcag} asks for, explained by W3C`), el('br'));
  }
  links.append(externalLink(rule.helpUrl, `Rule details and examples for "${rule.id}" (axe-core rule page)`));
  body.append(links);

  return el(
    'details',
    // A core check row finds its group by this id (see openIssueGroup).
    { class: 'item', id: `${kind}-${rule.id}` },
    el('summary', {}, el('h3', {}, title), meta),
    body,
  );
}

/**
 * The affected elements of one group. Each row describes its element in
 * words and can show it on the page, copy its selector or HTML, and step to
 * the previous or next element in the group.
 */
function nodeList(nodes, limit = Infinity) {
  const rows = [];
  nodes.forEach((node, index) => rows.push(nodeRow(node, index, rows, nodes.length)));
  const list = el('ol', { class: 'nodes' }, ...rows.map((row) => row.li));
  if (rows.length <= limit) return [list];
  rows.slice(limit).forEach((row) => (row.li.hidden = true));
  const more = el('button', { type: 'button', class: 'button small' }, t('showAll', { count: rows.length }));
  rows.reveal = () => {
    rows.forEach((row) => (row.li.hidden = false));
    more.remove();
  };
  more.addEventListener('click', () => {
    rows.reveal();
    rows[limit].showButton.focus();
  });
  return [list, more];
}

function nodeRow(node, index, rows, total) {
  const facts = factsFromHtml(node.html);
  const description = [describeElement(facts), targetPlace(node.target)].filter(Boolean).join(', ');
  const position = `${index + 1} of ${total}`;
  // Every button says which element it acts on, like "Show on page: button 2 of 5".
  const which = `${elementNoun(facts).toLowerCase()} ${position}`;
  const button = (text, onclick, extra = {}) =>
    el(
      'button',
      { type: 'button', class: 'button small', onclick, ...extra },
      text,
      el('span', { class: 'visually-hidden' }, `: ${which}`),
    );

  const result = el('p', { class: 'highlight-result' });
  const snippet = el(
    'details',
    { class: 'snippet' },
    el('summary', {}, 'HTML', el('span', { class: 'visually-hidden' }, ` of ${which}`)),
    el('pre', {}, el('code', {}, node.html)),
  );
  const row = { show: () => onShowOnPage(node, description, index + 1, result, snippet) };
  const step = async (delta) => {
    const other = rows[index + delta];
    if (other.li.hidden) rows.reveal();
    await other.show();
    // Keep focus on the same kind of button, so Enter keeps stepping.
    const same = delta > 0 ? other.next : other.prev;
    (same.disabled ? other.showButton : same).focus();
  };
  row.showButton = button('Show on page', row.show);
  row.prev = button('Previous', () => step(-1), { disabled: index === 0 });
  row.next = button('Next', () => step(1), { disabled: index === total - 1 });

  row.li = el(
    'li',
    {},
    el('p', { class: 'node-selector' }, el('span', { class: 'term' }, `Element ${position}: `), description),
    snippet,
    node.failureSummary
      ? el('p', { class: 'node-summary' }, el('span', { class: 'term' }, 'What the scan found: '), node.failureSummary)
      : null,
    el(
      'div',
      { class: 'node-actions' },
      row.showButton,
      button('Copy selector', () => copyText(targetText(node.target), 'Selector', result)),
      button('Copy HTML', () => copyText(node.html, 'HTML', result)),
    ),
    total > 1 ? el('div', { class: 'node-actions' }, row.prev, row.next) : null,
    result,
  );
  return row;
}

/**
 * Facts about an element, read from its HTML snippet: { tag, type, role,
 * name, src }. DOMParser builds a detached document that never runs scripts
 * or loads images. The page's inline handlers (onclick="...") are removed
 * first: they never run, but Chrome still reports each one as a policy
 * error in the panel's console (tested), and the description needs none.
 */
function factsFromHtml(html = '') {
  const tag = (/^<([a-z][\w-]*)/i.exec(html) || [])[1] || '';
  const safe = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  const body = new DOMParser().parseFromString(safe, 'text/html').body;
  const node = body.firstElementChild;
  // Table parts like <td> are dropped outside a table; keep their text.
  if (!node) return { tag, name: body.textContent };
  const attr = (name) => node.getAttribute(name) || '';
  const inputButton = node.localName === 'input' && ['button', 'submit', 'reset'].includes(attr('type'));
  const name =
    attr('aria-label') ||
    attr('alt') ||
    (inputButton ? attr('value') : '') ||
    node.textContent ||
    attr('title') ||
    attr('placeholder');
  return { tag, type: attr('type'), role: attr('role'), name, src: attr('src') };
}

function para(label, text) {
  return el('p', {}, el('span', { class: 'term' }, `${label}: `), text);
}

/** `hiddenExtra` is read by screen readers only, to tell same-text links apart. */
function externalLink(href, text, hiddenExtra = '') {
  return el(
    'a',
    { href, target: '_blank', rel: 'noopener noreferrer' },
    text,
    el('span', { class: 'visually-hidden' }, `${hiddenExtra} (opens in a new tab)`),
  );
}

// Guided manual checks

function renderGuidedChecks() {
  // Core checks first, then the rest in file order.
  const checks = [...state.manualChecks].sort((a, b) => Number(b.core) - Number(a.core));
  $('guided-list').replaceChildren(...checks.map((check) => el('li', {}, guidedItem(check))));
}

function guidedItem(check) {
  const meta = el(
    'span',
    { class: 'item-meta' },
    el('span', { class: 'status status-neutral', 'data-status-for': check.id }, 'Not checked'),
  );
  if (check.core) meta.append(el('span', { class: 'tag' }, 'Core check'));
  if (check.new_in_2_2) meta.append(el('span', { class: 'tag' }, 'New in WCAG 2.2'));
  meta.append(el('span', { class: 'tag' }, `WCAG ${check.wcag}, level ${check.level}`));
  meta.append(el('span', { 'data-scan-for': check.id }));

  // "What the scan noticed": filled in by renderHints().
  const hints = el(
    'div',
    { class: 'hints' },
    el('h4', {}, 'What the scan noticed'),
    el('div', { 'data-hints-for': check.id }),
  );

  const name = `status-${check.id}`;
  const radios = [
    ['not-checked', 'Not checked'],
    ['looks-good', 'Looks good'],
    ['has-problem', 'Has a problem'],
  ].map(([value, label]) =>
    el(
      'label',
      { class: 'radio' },
      el('input', { type: 'radio', name, value, onchange: () => onManualStatus(check.id, value) }),
      label,
    ),
  );

  return el(
    'details',
    { class: 'item', id: `check-${check.id}` },
    el('summary', {}, el('h3', {}, check.title), meta),
    el(
      'div',
      { class: 'item-body' },
      para('Why it matters', check.why),
      el('h4', {}, 'How to check'),
      el('ol', {}, ...check.how_to_check.map((step) => el('li', {}, step))),
      para('What good looks like', check.pass_looks_like),
      para('Common fixes', check.common_fixes),
      el('p', {}, externalLink(check.url, `What WCAG ${check.wcag} asks for, explained by W3C`)),
      hints,
      el('fieldset', { class: 'check-status' }, el('legend', {}, 'Your result for this check'), ...radios),
    ),
  );
}

/** The evidence each helper can collect for the current page. */
function hintSources() {
  const hasDetails = state.scan && state.scanKey === state.key;
  return {
    scan: hasDetails ? state.scan : null,
    lists: hasDetails ? state.lists : null,
    walk: state.walk && state.walkKey === state.key ? state.walk : null,
  };
}

function renderHints() {
  const sources = hintSources();
  const saved = state.page.lastScan && state.page.lastScan.auto;
  for (const check of state.manualChecks) {
    const box = document.querySelector(`[data-hints-for="${check.id}"]`);
    if (!box) continue;
    const result = hintGroups(check, sources, state.titles);

    // Automated counts next to the person's status: from this scan, or the
    // saved summary after a reload. The tool never marks a check "Looks good".
    const ready = sources.scan && !result.needsWalk;
    const counts = ready ? { i: result.issues, p: result.possible } : saved && saved[check.id];
    const badges = [];
    if (counts && counts.i) badges.push(scanBadge('issues', counts.i));
    if (counts && counts.p) badges.push(scanBadge('possible', counts.p));
    document.querySelector(`[data-scan-for="${check.id}"]`).replaceChildren(...badges);
    // For tests and debugging: the counts behind the badges.
    const item = $(`check-${check.id}`);
    item.dataset.autoIssues = counts ? counts.i : '';
    item.dataset.autoPossible = counts ? counts.p : '';

    box.replaceChildren(
      ...guidedSummary(check, result, sources),
      ...result.groups.map((group) => hintGroupView(group)),
    );
  }
}

/** One or two lines: what the scan checked, what it found, what a person still has to confirm. */
function guidedSummary(check, result, sources) {
  if (result.manualOnly) return [el('p', { class: 'muted' }, "A scan can't help with this one. It needs a person.")];
  const key = check.id.replace(/-/g, '_');
  const automated = t(`auto_checked_${key}`) !== `auto_checked_${key}`;
  if (result.needsScan) return [el('p', { class: 'muted' }, t('autoNeedsScan'))];
  // Checks that only list things to look at make no claim about what was found.
  if (!automated) return [];
  const still = t(`auto_still_${key}`);
  const parts = [el('p', {}, el('span', { class: 'term' }, t('autoCheckedLabel')), ' ', t(`auto_checked_${key}`))];
  if (result.needsWalk)
    parts.push(el('p', { class: 'muted' }, t(state.walkState === 'failed' ? 'autoFocusFailed' : 'autoFocusRunning')));
  else if (result.issues + result.possible === 0) parts.push(el('p', {}, t('autoNothing', { still })));
  else parts.push(el('p', {}, t('autoStill', { still })));
  if (check.id === 'keyboard' && sources.scan) parts.push(el('p', { class: 'muted' }, t('autoKeyboardLimit')));
  return parts;
}

function scanBadge(status, count) {
  const badge = statusBadge(status, count);
  badge.textContent = `Scan: ${badge.textContent}`;
  return badge;
}

function hintGroupView(group) {
  if (group.kind === 'note') {
    const line = el('p', { class: group.level === 'possible' ? '' : 'muted' }, group.title);
    if (group.level === 'possible') line.prepend(el('span', { class: 'tag' }, t('levelPossible')), ' ');
    return line;
  }

  const counted = group.level === 'issue' || group.level === 'possible';
  const summary = el('summary', {}, counted ? `${group.title} (${group.count})` : group.title);
  if (group.level === 'issue') summary.append(' ', statusBadge('issues', group.count));
  if (group.level === 'possible') summary.append(' ', el('span', { class: 'tag' }, t('levelPossible')));
  const body = el('div', { class: 'hint-body' });
  if (group.kind === 'outline') {
    body.append(
      el(
        'ol',
        { class: 'outline' },
        ...group.items.map((h) =>
          el(
            'li',
            { class: `level-${Math.min(h.level, 6)}` },
            el('span', { class: 'term' }, `H${h.level} `),
            h.text || '(empty heading)',
          ),
        ),
      ),
    );
  } else {
    if (group.count > group.items.length)
      body.append(
        el('p', { class: 'muted' }, `Showing the first ${group.items.length} of ${formatCount(group.count)}.`),
      );
    body.append(...nodeList(group.items, group.level === 'possible' ? POSSIBLE_PAGE_SIZE : Infinity));
    if (group.helpUrl)
      body.append(el('p', {}, externalLink(group.helpUrl, 'Rule details and examples (axe-core rule page)')));
  }
  return el('details', { class: 'hint-group' }, summary, body);
}

function updateGuidedStatuses() {
  const manual = state.page.manual;
  let checked = 0;
  for (const check of state.manualChecks) {
    const status = manual[check.id] || 'not-checked';
    if (status !== 'not-checked') checked += 1;
    const badge = document.querySelector(`[data-status-for="${check.id}"]`);
    if (badge) {
      const fresh = statusBadge(status);
      badge.className = fresh.className;
      badge.textContent = fresh.textContent;
    }
    for (const input of document.querySelectorAll(`input[name="status-${check.id}"]`)) {
      input.checked = input.value === status;
      input.disabled = !state.key;
    }
  }
  $('guided-progress').textContent = `${checked} of ${state.manualChecks.length} guided checks done`;
}

async function onManualStatus(checkId, status) {
  if (!state.key) return;
  state.page = await saveManualStatus(state.key, checkId, status);
  renderSummary();
  updateGuidedStatuses();
}

/** From a core check row to its issue group: open it and move focus there. */
function openIssueGroup(check) {
  const kind = check.issues > 0 ? 'issue' : 'review';
  const item = check.rules.map((id) => $(`${kind}-${id}`)).find(Boolean);
  if (!item) return;
  if ($('other-list').contains(item)) setOtherExpanded(true);
  item.open = true;
  item.querySelector('summary').focus();
  item.scrollIntoView({ block: 'start' });
}

function openGuidedCheck(checkId) {
  const details = $(`check-${checkId}`);
  details.open = true;
  details.querySelector('summary').focus();
  details.scrollIntoView({ block: 'start' });
}

// Show on page

const HIGHLIGHT_PROBLEMS = {
  'not-found': "This element isn't on the page anymore. Rescan to update.",
  hidden: "This element is hidden on the page, so it can't be highlighted. Its HTML is shown above.",
  'closed-shadow':
    "This element is inside a closed web component, which extensions can't look inside. Use Copy selector to find it in your browser's developer tools.",
  // Frames from other sites are never scanned, so this is a frame the page
  // made itself with its own sealed origin (a data: address or a sandbox).
  frame:
    "This element is inside a sealed frame (a sandboxed or data: frame), which can't be reached from here. Use Copy selector to find it in your browser's developer tools.",
};

async function onShowOnPage(node, description, number, resultNode, snippet) {
  const tab = state.tab;
  if (!tab) return;
  for (const other of document.querySelectorAll('.highlight-result')) other.textContent = '';
  for (const row of document.querySelectorAll('.is-highlighted')) row.classList.remove('is-highlighted');
  let text;
  try {
    const result = await showOnPage(tab.id, node.target, number, node.html);
    if (result.ok) {
      state.highlightTabId = tab.id;
      resultNode.closest('li').classList.add('is-highlighted');
      $('clear-highlight').hidden = false;
      text = 'Highlighted on page.';
      if (result.matches > 1) text += ` ${result.matches} elements match its selector, so this is the first one.`;
      if (result.changed)
        text += ' The page changed since the scan, so this may be a different element. Rescan to update.';
      announce(`Highlighted on page: ${description}`);
    } else {
      // Showing a new element always removes the old outline first.
      forgetHighlight();
      text = HIGHLIGHT_PROBLEMS[result.reason] || HIGHLIGHT_PROBLEMS['not-found'];
      if (result.reason === 'hidden') snippet.open = true;
      announce(text);
    }
  } catch (error) {
    text = explainProblem(codeFromChromeError(error.message), NAME).title;
    announce(text);
  }
  resultNode.textContent = text;
}

/** Copy text for the user. If the clipboard is blocked, show the text instead. */
async function copyText(text, what, resultNode) {
  try {
    await navigator.clipboard.writeText(text);
    resultNode.textContent = `${what} copied.`;
  } catch {
    resultNode.replaceChildren(`Copying did not work. ${what}: `, el('code', {}, text));
  }
}

/** The panel's side of removing the outline. The page side is clearHighlight(). */
function forgetHighlight() {
  state.highlightTabId = null;
  for (const row of document.querySelectorAll('.is-highlighted')) row.classList.remove('is-highlighted');
  $('clear-highlight').hidden = true;
  for (const node of document.querySelectorAll('.highlight-result')) node.textContent = '';
}

async function onClearHighlight() {
  const tabId = state.highlightTabId;
  forgetHighlight();
  if (tabId) {
    try {
      await clearHighlight(tabId);
    } catch {
      // The tab may be gone or moved on. Nothing is left to clean up then.
    }
  }
  announce('Highlight removed.');
}

// Report and saved data

/** Copy report needs a scan of this page; until then it says why it is off. */
function updateReportButton() {
  const ready = Boolean(state.key && state.page.lastScan);
  const button = $('copy-report');
  button.setAttribute('aria-disabled', String(!ready));
  // Only describe the button with the reason while the reason is showing.
  if (ready) button.removeAttribute('aria-describedby');
  else button.setAttribute('aria-describedby', 'report-note');
  $('report-note').hidden = ready;
}

async function onCopyReport() {
  if (!state.key || !state.page.lastScan) {
    announce($('report-note').textContent);
    return;
  }
  const hasDetails = state.scan && state.scanKey === state.key;
  const report = buildReport({
    name: NAME,
    date: new Date(),
    page: state.tab && state.tab.url ? pageLabel(state.tab.url) : 'Unknown page',
    scan: hasDetails ? state.scan : null,
    lastScan: state.page.lastScan,
    manual: state.page.manual,
    manualChecks: state.manualChecks,
    titles: state.titles,
    since: hasDetails ? state.since : null,
    auto: currentAuto(),
  });

  $('report-fallback').hidden = true;
  try {
    await navigator.clipboard.writeText(report);
    announce('Report copied as Markdown.');
  } catch {
    $('report-text').value = report;
    $('report-fallback').hidden = false;
    $('report-text').focus();
    $('report-text').select();
    announce('Copying did not work. The report is in the text box. Press Control C to copy it.');
  }
}

function askToConfirm(text, action) {
  state.pendingConfirm = action;
  state.confirmOpener = document.activeElement;
  $('confirm-text').textContent = text;
  $('confirm-box').hidden = false;
  $('confirm-box').focus();
}

function closeConfirm() {
  state.pendingConfirm = null;
  $('confirm-box').hidden = true;
}

async function onClearPage() {
  if (state.key) await clearPage(state.key);
  forgetSession();
  await refreshPage();
  announce("This page's saved data was cleared.");
  $('clear-page').focus();
}

async function onClearAll() {
  await clearAll();
  forgetSession();
  await refreshPage();
  announce('All saved data was cleared.');
  $('clear-all').focus();
}

function forgetSession() {
  state.scan = null;
  state.scanKey = null;
  state.since = null;
  state.lists = null;
  state.walk = null;
  state.walkKey = null;
  state.walkState = null;
}

// Notices and announcements

/**
 * Show a plain-language problem message. `quiet` shows it without moving
 * focus, for messages that appear on their own (like when switching tabs).
 */
function showNotice(code, technical = '', { quiet = false } = {}) {
  const { title, detail } = explainProblem(code, NAME);
  const notice = $('notice');
  const info = code === 'no-access' || code === 'loading';
  notice.classList.toggle('info', info);
  // The border color shows the kind; this word says it too.
  $('notice-kind').textContent = info ? 'Note' : 'Problem';
  $('notice-title').textContent = title;
  $('notice-detail').textContent = detail;
  $('notice-technical').hidden = !technical;
  $('notice-technical-text').textContent = technical;
  notice.hidden = false;
  if (!quiet) {
    announce(`${title} ${detail}`);
    notice.focus();
  }
}

function hideNotice() {
  $('notice').hidden = true;
}

function announce(message) {
  const region = $('announcer');
  // Clear first so the same message is read again if it repeats.
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}

// Small helpers

/** Create an element. Text is always added as text, never as HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
    else if (value !== null && value !== undefined && value !== false)
      node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function formatTime(iso) {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
