import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  storageKey,
  emptyPage,
  normalizePage,
  loadPage,
  saveManualStatus,
  saveScanSummary,
  saveAutoCounts,
  clearPage,
  clearAll,
} from '../../extension/lib/storage.js';

/** A stand-in for chrome.storage.local, kept in memory. */
function fakeArea() {
  const data = {};
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(key) {
      delete data[key];
    },
    async clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
  };
}

const KEY = 'http://localhost:8000/broken.html';

test('storage keys are prefixed', () => {
  assert.equal(storageKey(KEY), 'page:' + KEY);
});

test('normalizePage drops bad data and keeps the documented shape', () => {
  assert.deepEqual(normalizePage(undefined), emptyPage());
  assert.deepEqual(normalizePage('junk'), emptyPage());
  const page = normalizePage({
    v: 1,
    extra: 'dropped',
    manual: { keyboard: 'looks-good', 'focus-visible': 'banana', reflow: 'not-checked' },
    lastScan: {
      at: '2026-10-25T10:00:00.000Z',
      axeVersion: '4.14.0',
      rules: { label: { v: 2, i: 0 }, empty: { v: 0, i: 0 } },
      html: '<big>',
    },
  });
  assert.deepEqual(page, {
    v: 1,
    manual: { keyboard: 'looks-good' },
    lastScan: { at: '2026-10-25T10:00:00.000Z', axeVersion: '4.14.0', rules: { label: { v: 2, i: 0 } } },
  });
});

test('manual statuses are saved per page and "not-checked" removes them', async () => {
  const area = fakeArea();
  await saveManualStatus(KEY, 'keyboard', 'has-problem', area);
  assert.deepEqual((await loadPage(KEY, area)).manual, { keyboard: 'has-problem' });
  await saveManualStatus(KEY, 'keyboard', 'not-checked', area);
  assert.deepEqual((await loadPage(KEY, area)).manual, {});
  assert.deepEqual(await loadPage('http://localhost:8000/other.html', area), emptyPage());
});

test('guided check counts are saved with the scan, cleaned, and kept on reload', async () => {
  const area = fakeArea();
  await saveScanSummary(KEY, { at: '2026-10-25T10:00:00.000Z', axeVersion: '4.14.0', rules: {} }, area);
  await saveAutoCounts(KEY, { keyboard: { i: 2, p: 1 }, 'focus-visible': { i: '0', p: null } }, area);
  const page = await loadPage(KEY, area);
  assert.deepEqual(page.lastScan.auto, { keyboard: { i: 2, p: 1 }, 'focus-visible': { i: 0, p: 0 } });
  // Nothing to attach to before a scan.
  const empty = fakeArea();
  assert.equal((await saveAutoCounts(KEY, { keyboard: { i: 1, p: 0 } }, empty)).lastScan, null);
});

test('saveScanSummary returns the previous summary for the rescan comparison', async () => {
  const area = fakeArea();
  const first = { at: '2026-10-25T10:00:00.000Z', axeVersion: '4.14.0', rules: { label: { v: 2, i: 0 } } };
  const second = { at: '2026-10-25T11:00:00.000Z', axeVersion: '4.14.0', rules: {} };
  assert.equal((await saveScanSummary(KEY, first, area)).previous, null);
  const result = await saveScanSummary(KEY, second, area);
  assert.deepEqual(result.previous, first);
  assert.deepEqual(result.page.lastScan, second);
});

test('stored data is small: no page content is kept', async () => {
  const area = fakeArea();
  await saveScanSummary(
    KEY,
    { at: '2026-10-25T10:00:00.000Z', axeVersion: '4.14.0', rules: { label: { v: 2, i: 0 } } },
    area,
  );
  const stored = JSON.stringify(area.data);
  assert.ok(stored.length < 300, stored);
  assert.doesNotMatch(stored, /</);
});

test('clearPage removes one page, clearAll removes everything', async () => {
  const area = fakeArea();
  await saveManualStatus(KEY, 'keyboard', 'looks-good', area);
  await saveManualStatus('https://a.test/', 'keyboard', 'looks-good', area);
  await clearPage(KEY, area);
  assert.deepEqual(Object.keys(area.data), ['page:https://a.test/']);
  await clearAll(area);
  assert.deepEqual(area.data, {});
});
