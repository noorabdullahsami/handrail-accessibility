// Saving progress per page in chrome.storage.local.
//
// Each page is stored under "page:" + its key (origin + pathname). The value
// is small on purpose. We never store page content, only:
//   {
//     v: 1,
//     manual: { "keyboard": "looks-good", ... },       // guided check statuses
//     lastScan: {                                     // or null
//       at: "2026-10-25T12:00:00.000Z",
//       axeVersion: "4.14.0",
//       rules: { "color-contrast": { v: 3, i: 1 }, ... } // v = issues, i = needs review
//       auto: { "keyboard": { i: 2, p: 1 }, ... }  // guided checks: i = issues, p = possible problems
//     }
//   }
//
// The functions take an optional `area` so tests can pass a fake in place of
// chrome.storage.local.

import { MANUAL_STATUSES } from './scoring.js';

export const STORAGE_VERSION = 1;
const PREFIX = 'page:';

export function storageKey(pageKey) {
  return PREFIX + pageKey;
}

export function emptyPage() {
  return { v: STORAGE_VERSION, manual: {}, lastScan: null };
}

/**
 * Clean up whatever was read from storage, so the rest of the code can trust
 * the shape. Unknown fields and bad values are dropped.
 */
export function normalizePage(raw) {
  const page = emptyPage();
  if (!raw || typeof raw !== 'object') return page;

  if (raw.manual && typeof raw.manual === 'object') {
    for (const [id, status] of Object.entries(raw.manual)) {
      if (MANUAL_STATUSES.includes(status) && status !== 'not-checked') page.manual[id] = status;
    }
  }

  const scan = raw.lastScan;
  if (scan && typeof scan === 'object' && typeof scan.at === 'string' && scan.rules && typeof scan.rules === 'object') {
    const rules = {};
    for (const [ruleId, counts] of Object.entries(scan.rules)) {
      const v = Number(counts && counts.v) || 0;
      const i = Number(counts && counts.i) || 0;
      if (v > 0 || i > 0) rules[ruleId] = { v, i };
    }
    page.lastScan = { at: scan.at, axeVersion: String(scan.axeVersion || ''), rules };
    if (scan.auto && typeof scan.auto === 'object') {
      page.lastScan.auto = {};
      for (const [checkId, counts] of Object.entries(scan.auto)) {
        page.lastScan.auto[checkId] = { i: Number(counts && counts.i) || 0, p: Number(counts && counts.p) || 0 };
      }
    }
  }
  return page;
}

function defaultArea() {
  return globalThis.chrome.storage.local;
}

export async function loadPage(pageKey, area = defaultArea()) {
  const key = storageKey(pageKey);
  const stored = await area.get(key);
  return normalizePage(stored[key]);
}

async function savePage(pageKey, page, area) {
  await area.set({ [storageKey(pageKey)]: normalizePage(page) });
}

/** Save one guided check status. 'not-checked' removes the entry. */
export async function saveManualStatus(pageKey, checkId, status, area = defaultArea()) {
  const page = await loadPage(pageKey, area);
  if (status === 'not-checked') delete page.manual[checkId];
  else page.manual[checkId] = status;
  await savePage(pageKey, page, area);
  return page;
}

/**
 * Save the summary of a new scan. Returns the previous summary (or null) so
 * the caller can show "Since last scan".
 */
export async function saveScanSummary(pageKey, summary, area = defaultArea()) {
  const page = await loadPage(pageKey, area);
  const previous = page.lastScan;
  page.lastScan = summary;
  await savePage(pageKey, page, area);
  return { previous, page: normalizePage(page) };
}

/** Save the guided checks' automated counts onto the last scan summary. */
export async function saveAutoCounts(pageKey, auto, area = defaultArea()) {
  const page = await loadPage(pageKey, area);
  if (!page.lastScan) return page;
  page.lastScan.auto = auto;
  await savePage(pageKey, page, area);
  return normalizePage(page);
}

export async function clearPage(pageKey, area = defaultArea()) {
  await area.remove(storageKey(pageKey));
}

export async function clearAll(area = defaultArea()) {
  await area.clear();
}
