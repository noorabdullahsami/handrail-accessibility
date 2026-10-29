// Checks the shape and wording rules of the data files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const load = (path) => JSON.parse(readFileSync(new URL(`../../extension/${path}`, import.meta.url), 'utf8'));
const manual = load('data/manual-checks.json');
const automated = load('data/automated-core.json');
const BANNED = /—|\bpass(es|ed)?\b|compliant|makes your site accessible|seamless|robust|powerful/i;

test('23 guided checks with all required fields, A or AA only', () => {
  assert.equal(manual.length, 23);
  const fields = [
    'id',
    'wcag',
    'level',
    'core',
    'new_in_2_2',
    'title',
    'why',
    'how_to_check',
    'pass_looks_like',
    'common_fixes',
    'url',
  ];
  for (const check of manual) {
    for (const field of fields) assert.ok(field in check, `${check.id} missing ${field}`);
    assert.ok(['A', 'AA'].includes(check.level), check.id);
    assert.match(check.url, /^https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/[a-z-]+\.html$/);
  }
  assert.equal(new Set(manual.map((c) => c.id)).size, 23);
  assert.deepEqual(
    manual.filter((c) => c.core).map((c) => c.id),
    ['keyboard', 'focus-visible'],
  );
});

test('guided check helpers and axe rules are valid', () => {
  const axe = createRequire(import.meta.url)('axe-core');
  const ruleIds = new Set(axe.getRules().map((r) => r.ruleId));
  const helpers = [
    'clickables',
    'focus-walk',
    'headings',
    'links',
    'duplicate-links',
    'images',
    'same-alts',
    'placeholders',
    'live-regions',
    'roles',
    'skip',
  ];
  for (const check of manual) {
    assert.ok(Array.isArray(check.axe_rules) && Array.isArray(check.helpers), check.id);
    for (const id of [...check.axe_rules, ...(check.axe_possible || [])])
      assert.ok(ruleIds.has(id), `${check.id}: unknown axe rule ${id}`);
    for (const h of check.helpers) assert.ok(helpers.includes(h), `${check.id}: unknown helper ${h}`);
  }
});

test('6 automated core entries covering the Core 8 axe rules, all unreviewed', () => {
  assert.equal(automated.length, 6);
  assert.deepEqual(automated.flatMap((e) => e.rules).sort(), [
    'button-name',
    'color-contrast',
    'html-has-lang',
    'html-lang-valid',
    'image-alt',
    'label',
    'link-name',
  ]);
  for (const entry of automated) {
    assert.equal(entry.reviewed, false);
    for (const field of ['title', 'why', 'how_to_fix', 'url']) assert.ok(entry[field], `${entry.id} ${field}`);
  }
});

test('every axe rule the scan can return has plain copy in data/axe-rules.json', async () => {
  const axe = createRequire(import.meta.url)('axe-core');
  const { AXE_TAGS, EXPERIMENTAL_RULES } = await import('../../extension/lib/scan.js');
  const ruleIds = [...axe.getRules(AXE_TAGS).map((r) => r.ruleId), ...EXPERIMENTAL_RULES];
  const copy = load('data/axe-rules.json');
  const missing = ruleIds.filter((id) => !copy[id]);
  assert.deepEqual(missing, [], `No entry in data/axe-rules.json for: ${missing.join(', ')}`);
  for (const [id, entry] of Object.entries(copy)) {
    for (const field of ['title', 'why', 'how_to_fix']) assert.ok(entry[field], `${id} ${field}`);
    assert.ok(entry.wcag === null || /^\d\.\d\.\d{1,2}(, \d\.\d\.\d{1,2})*$/.test(entry.wcag), `${id} wcag`);
    assert.equal(entry.reviewed, false, id);
  }
  // The Core 8 rules use the same titles in both files.
  for (const entry of automated) for (const id of entry.rules) assert.equal(copy[id].title, entry.title, id);
});

test('user-facing copy avoids banned words and em dashes', () => {
  const rules = Object.entries(load('data/axe-rules.json')).map(([id, entry]) => ({ id, ...entry }));
  for (const entry of [...manual, ...automated, ...rules]) {
    const text = JSON.stringify(entry);
    assert.doesNotMatch(text, BANNED, entry.id);
  }
});

test('the extension name lives in one place', () => {
  const messages = load('_locales/en/messages.json');
  assert.ok(messages.extName.message.length <= 45);
  assert.ok(messages.extDescription.message.length <= 132);
  const manifest = load('manifest.json');
  assert.equal(manifest.name, '__MSG_extName__');
  const sources = ['panel/panel.html', 'panel/panel.js', 'background.js', 'manifest.json'].map((p) =>
    readFileSync(new URL(`../../extension/${p}`, import.meta.url), 'utf8'),
  );
  assert.ok(messages.extShortName.message.length <= 12);
  assert.equal(manifest.short_name, '__MSG_extShortName__');
  for (const source of sources) {
    assert.ok(!source.includes(messages.extName.message));
    assert.ok(!source.includes(messages.extShortName.message));
  }
});

test('every guided check with automation says what the scan checked and what a person still checks', () => {
  const messages = load('_locales/en/messages.json');
  const withAutomation = [
    'keyboard',
    'focus-visible',
    'focus-not-hidden',
    'focus-order',
    'skip-link',
    'link-purpose',
    'alt-text-quality',
    'target-size',
    'structure',
    'custom-controls',
    'labels-instructions',
    'use-of-color',
  ];
  for (const id of withAutomation) {
    const check = manual.find((c) => c.id === id);
    assert.ok(
      check.axe_rules.length || (check.axe_possible || []).length || check.helpers.length,
      `${id} has no automation`,
    );
    for (const part of ['checked', 'still'])
      assert.ok(messages[`auto_${part}_${id.replace(/-/g, '_')}`], `${id} ${part}`);
  }
});

test('every t("key") in the code exists in messages.json, with plain wording', async () => {
  const { readdirSync } = await import('node:fs');
  const messages = load('_locales/en/messages.json');
  const files = ['panel', 'lib'].flatMap((dir) =>
    readdirSync(new URL(`../../extension/${dir}`, import.meta.url))
      .filter((f) => f.endsWith('.js'))
      .map((f) => `${dir}/${f}`),
  );
  const used = files.flatMap((file) =>
    [
      ...readFileSync(new URL(`../../extension/${file}`, import.meta.url), 'utf8').matchAll(/\bt\('([A-Za-z0-9_]+)'/g),
    ].map((m) => m[1]),
  );
  assert.ok(used.length > 20);
  for (const key of used) assert.ok(messages[key], `missing message: ${key}`);
  for (const [key, entry] of Object.entries(messages)) assert.doesNotMatch(entry.message, BANNED, key);
});

test('manifest asks only for the four allowed permissions', () => {
  const manifest = load('manifest.json');
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'sidePanel', 'storage']);
  for (const key of ['host_permissions', 'content_scripts', 'optional_permissions', 'optional_host_permissions']) {
    assert.ok(!(key in manifest), key);
  }
});
