// End-to-end test of the guided-check hints and the keyboard focus check.
//
// Usage: node test/e2e/hints.mjs   (any OS, no keystrokes needed)
//
// Unlike run.mjs, this does not press the real shortcut. It uses a test-only
// copy of the extension in test/.build/ that also has host access to
// localhost, so the panel can scan without a click. That copy is never
// shipped. The click/shortcut permission flow is tested by run.mjs.
//
// The panel opens in its own window next to the page. That matches the real
// side panel: the page is visible but does not have keyboard focus.

import puppeteer from 'puppeteer';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUILD = path.join(ROOT, 'test', '.build', 'ext');
const PORT = 8124;
const BASE = `http://localhost:${PORT}`;
const AXE_SOURCE = readFileSync(path.join(ROOT, 'extension', 'vendor', 'axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
}

makeTestBuild();
const server = startServer();
await waitForServer();
const browser = await puppeteer.launch({
  headless: Boolean(process.env.CI), // GitHub Actions sets CI; locally a window opens
  pipe: true,
  enableExtensions: [BUILD],
  defaultViewport: null,
});
try {
  await run();
} catch (error) {
  console.error(error);
  check('test run finished without crashing', false, String(error && error.message));
} finally {
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function run() {
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
  const [page] = await browser.pages();
  await page.goto(`${BASE}/keyboard.html`);
  await sleep(500);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost/*' }))[0].id);
  await sw.evaluate(
    (id) =>
      chrome.windows.create({
        url: chrome.runtime.getURL(`panel/panel.html?tabId=${id}`),
        type: 'popup',
        width: 420,
        height: 900,
      }),
    tabId,
  );
  const panel = await (await browser.waitForTarget((t) => t.url().includes('/panel/panel.html'))).asPage();
  const errors = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  panel.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await sleep(800);

  // Before a scan: checks say what they need.
  check(
    'before a scan, an automated check asks for a scan',
    (await hintText(panel, 'structure')).includes('Scan the page to run these checks.'),
  );
  check(
    'a check with no help says it needs a person',
    (await hintText(panel, 'reflow')).includes("A scan can't help with this one"),
  );

  // The focus checks run with the scan and must put the page back as it was.
  await page.evaluate(() => {
    window.scrollTo(0, 300);
    document.getElementById('normal').focus();
  });
  const progressSeen = panel
    .waitForFunction(
      () =>
        !document.getElementById('focus-progress').hidden &&
        /^Checking focus: \d+ of \d+$/.test(document.getElementById('focus-progress-text').textContent),
      { timeout: 20000 },
    )
    .then(
      () => true,
      () => false,
    );
  await panel.click('#scan-button');
  check('a progress line shows while the focus checks run', await progressSeen);
  check('a Cancel button is there while they run', (await text(panel, '#focus-cancel')) === 'Cancel');
  await waitForScan(panel);

  // Counts documented at the top of keyboard.html.
  const counts = await autoCountsOf(panel);
  const expect = {
    keyboard: '1/2',
    structure: '1/1',
    'link-purpose': '0/2',
    'alt-text-quality': '0/2',
    'labels-instructions': '0/1',
    'focus-order': '0/2',
    'focus-visible': '2/0',
    'focus-not-hidden': '1/0',
  };
  for (const [id, want] of Object.entries(expect))
    check(`keyboard.html: ${id} issues/possible = ${want}`, counts[id] === want, counts[id]);
  check(
    'lists are shown but not counted (live regions, custom controls)',
    counts['status-messages'] === '0/0' && counts['custom-controls'] === '0/0',
    `${counts['status-messages']} ${counts['custom-controls']}`,
  );
  check(
    'a check that only lists things does not claim "Nothing found by automated checks"',
    !(await hintText(panel, 'status-messages')).includes('Nothing found by automated checks'),
  );
  check('live region listed', (await hintText(panel, 'status-messages')).includes('Areas that announce updates'));
  check('heading outline listed', (await hintText(panel, 'structure')).includes('Heading outline (3)'));
  check('experimental rule is a possible problem', (await hintText(panel, 'structure')).includes('Possible: '));
  const inIssueLists = await panel.$$eval('#fix-list a, #other-list a, #bp-list a, #review-list a', (as) =>
    as.some((a) => a.href.includes('p-as-heading')),
  );
  check('experimental rule stays out of the issue lists', !inIssueLists);
  check(
    "Core 8: keyboard access shows the tool's issues",
    (await coreRow(panel, 'Keyboard access')) === 'Issues found (1)',
    await coreRow(panel, 'Keyboard access'),
  );
  check(
    "Core 8: visible focus shows the tool's issues",
    (await coreRow(panel, 'Visible focus')) === 'Issues found (2)',
    await coreRow(panel, 'Visible focus'),
  );
  check(
    'each automated check says what it checked and what is left',
    /What the scan checked: .+Still check: /.test(await hintText(panel, 'focus-order')),
  );
  check(
    'keyboard check states the Tab key limit',
    (await hintText(panel, 'keyboard')).includes('A script cannot press the Tab key for real'),
  );
  const flagged = await panel.$$eval('[data-hints-for="focus-visible"] .node-selector', (n) =>
    n.map((x) => x.textContent),
  );
  check(
    'the right elements are flagged (Save button, off-screen link)',
    flagged.some((s) => s.includes('Button: "Save"')) && flagged.some((s) => s.includes('Link')),
    flagged.join(' | '),
  );
  check('a skip link that appears on focus is not flagged', !flagged.some((s) => /skip/i.test(s)));

  const after = await page.evaluate(() => ({
    y: window.scrollY,
    active: document.activeElement.id,
    htmlStyle: document.documentElement.getAttribute('style'),
    leftovers: document.querySelectorAll('[data-handrail-focus]').length,
    styles: document.querySelectorAll('style').length,
  }));
  check('page scroll position put back', after.y === 300, String(after.y));
  check('page focus put back', after.active === 'normal', after.active);
  check(
    'nothing left on the page',
    after.htmlStyle === null && after.leftovers === 0 && after.styles === 1,
    JSON.stringify(after),
  );
  check(
    'result announced',
    /^Focus checks done\. Core checks: \d of 8 look good\.$/.test(await text(panel, '#announcer')),
    await text(panel, '#announcer'),
  );

  // Show on page works for a finding.
  await panel.evaluate(() => {
    for (const d of document.querySelectorAll('#check-keyboard details')) d.open = true;
    document.getElementById('check-keyboard').open = true;
  });
  await panel.click('[data-hints-for="keyboard"] button.small');
  await sleep(600);
  check('show on page works from a finding', (await page.$$eval('#handrail-highlight', (n) => n.length)) === 1);
  await panel.click('#clear-highlight');

  // The report lists automated and possible counts for the guided checks.
  await panel.evaluate(() => {
    window.__copied = '';
    navigator.clipboard.writeText = async (value) => {
      window.__copied = value;
    };
  });
  await panel.click('#copy-report');
  await sleep(300);
  const report = await panel.evaluate(() => window.__copied);
  check(
    'report gives the guided checks their scan results',
    /Tab order follows the page in a sensible order.*Not checked\. Scan: Possible problems \(2\)/.test(report) &&
      /- Visible focus: Issues found \(2\)/.test(report),
  );

  // A page with 600 places to Tab to: the checks stop at 500 and say so,
  // and Cancel stops them early and says how far they got.
  await page.goto(`${BASE}/many.html`);
  await sleep(500);
  await panel.click('#scan-button');
  await waitForScan(panel);
  check(
    'more than 500 places: the focus checks stop at 500 and say so',
    (await hintText(panel, 'focus-visible')).includes(
      'This page has 600 places you can Tab to. The focus checks stopped at the first 500.',
    ),
  );
  await panel.click('#scan-button');
  await panel.waitForFunction(() => !document.getElementById('focus-progress').hidden, { timeout: 20000 });
  await panel.click('#focus-cancel');
  await waitForScan(panel);
  check(
    'Cancel stops the focus checks and says how far they got',
    /cancelled after \d+ of \d+ places/.test(await hintText(panel, 'focus-visible')),
    await hintText(panel, 'focus-visible'),
  );
  check(
    'page is put back after a cancel too',
    (await page.evaluate(() => document.querySelectorAll('[data-handrail-focus]').length)) === 0,
  );

  // Accuracy: every automated check against a problem page and a clean page.
  // Problem pages: exact counts (documented at the top of each page).
  // Clean pages: zero issues and zero possible problems on every guided check with automation.
  const TIER_A = [
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
  const FIXTURES = {
    keyboard: { keyboard: '1/3' },
    'focus-visible': { 'focus-visible': '2/1' },
    'focus-not-hidden': { 'focus-not-hidden': '1/0' },
    'focus-order': { 'focus-order': '0/3' },
    'skip-link': { 'skip-link': '0/4' },
    'link-purpose': { 'link-purpose': '0/4' },
    'alt-text': { 'alt-text-quality': '0/7' },
    labels: { 'labels-instructions': '2/1' },
    'axe-mapped': { 'target-size': '2/0', structure: '1/0', 'custom-controls': '1/0', 'use-of-color': '1/0' },
  };
  for (const [name, wants] of Object.entries(FIXTURES)) {
    await page.goto(`${BASE}/auto/${name}-problem.html`);
    await sleep(500);
    await panel.click('#scan-button');
    await waitForScan(panel);
    const got = await autoCountsOf(panel);
    for (const [id, want] of Object.entries(wants))
      check(`auto/${name}-problem: ${id} = ${want}`, got[id] === want, got[id]);

    await page.goto(`${BASE}/auto/${name}-clean.html`);
    await sleep(500);
    await panel.click('#scan-button');
    await waitForScan(panel);
    const clean = await autoCountsOf(panel);
    const noisy = TIER_A.filter((id) => clean[id] !== '0/0').map((id) => `${id} ${clean[id]}`);
    check(`auto/${name}-clean: no findings on any guided check with automation`, noisy.length === 0, noisy.join(', '));
  }

  // The panel itself, with every hint group open.
  await panel.evaluate(() => {
    for (const d of document.querySelectorAll('details')) d.open = true;
  });
  await audit(panel, 'panel with all hints open, light');
  await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await audit(panel, 'panel with all hints open, dark');
  await panel.setViewport({ width: 320, height: 800 });
  await panel.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await sleep(200);
  const wide = await panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('320px and 200% text with hints open: no sideways scrolling', wide <= 0, `${wide}px too wide`);
  check('no errors in the panel', errors.length === 0, errors.join(' ; '));
}

function makeTestBuild() {
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  cpSync(path.join(ROOT, 'extension'), BUILD, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(BUILD, 'manifest.json'), 'utf8'));
  // Test only, never shipped: localhost access instead of a click, and
  // <all_urls>, which captureVisibleTab needs without a click (activeTab).
  manifest.host_permissions = ['http://localhost/*', '<all_urls>'];
  writeFileSync(path.join(BUILD, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function startServer() {
  for (const python of ['python3', 'python']) {
    if (spawnSync(python, ['--version']).status === 0) {
      return spawn(python, ['-m', 'http.server', String(PORT), '--directory', path.join(ROOT, 'test', 'fixtures')], {
        stdio: 'ignore',
      });
    }
  }
  throw new Error('Python is needed to serve the test pages.');
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/keyboard.html`)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error('Test server did not start.');
}

async function text(page, selector) {
  return page.$eval(selector, (n) => n.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
}

async function hintText(panel, checkId) {
  return text(panel, `[data-hints-for="${checkId}"]`);
}

async function waitForScan(panel) {
  await sleep(200);
  await panel.waitForFunction(() => document.getElementById('scan-button').getAttribute('aria-disabled') !== 'true', {
    timeout: 60000,
  });
  await sleep(300);
}

/** "issues/possible" per guided check, from the counts behind the badges. */
async function autoCountsOf(panel) {
  return panel.$$eval('#guided-list details.item', (items) =>
    Object.fromEntries(
      items
        .filter((d) => d.dataset.autoIssues !== '' && d.dataset.autoIssues !== undefined)
        .map((d) => [d.id.replace('check-', ''), `${d.dataset.autoIssues}/${d.dataset.autoPossible}`]),
    ),
  );
}

async function coreRow(panel, name) {
  return panel.$$eval(
    '#core-list li',
    (items, name) => {
      const row = items.find((li) => li.querySelector('.core-name').firstChild.textContent.trim() === name);
      return row ? [...row.querySelectorAll('.status')].map((s) => s.textContent.trim()).join(' ') : '';
    },
    name,
  );
}

async function audit(page, label) {
  await page.evaluate(AXE_SOURCE);
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    });
    return result.violations.map(
      (v) =>
        `${v.id} (${v.nodes.length}): ${v.nodes
          .slice(0, 2)
          .map((n) => n.target.join(' '))
          .join(', ')}`,
    );
  });
  check(`self-audit: axe finds nothing in ${label}`, violations.length === 0, violations.join(' ; '));
}
