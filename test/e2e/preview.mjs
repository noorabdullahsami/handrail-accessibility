// Checks the preview page (test/preview.html): every mock state renders the
// real panel without errors, says the right thing, and has no sideways
// scrolling at 320px. Also takes screenshots for design work.
//
// Usage: node test/e2e/preview.mjs
//        node test/e2e/preview.mjs --shots <folder> [--states typical,zero]
//          [--width 320|360|420]
//          saves <state>-<light|dark>-<width>.png instead of testing

import puppeteer from 'puppeteer';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8130;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const AXE_SOURCE = readFileSync(path.join(ROOT, 'extension', 'vendor', 'axe.min.js'), 'utf8');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

const EXPECT = {
  empty: { headline: 'Not scanned yet' },
  scanning: { button: 'Scanning…' },
  typical: { headline: '1 of 8 core checks look good' },
  zero: { headline: '6 of 8 core checks look good' },
  many: { headline: '0 of 8 core checks look good' },
  long: { headline: '4 of 8 core checks look good' },
  error: { notice: 'Chrome does not let extensions scan its own pages.' },
  worst: {
    headline: '2 of 8 core checks look good',
    meter: '1.3K',
    status: 'Issues found (1,284)',
    address: 'shop.example.com/ja/コレクション/秋冬-2026/リネンシャツ-ウォッシュドインディゴ',
  },
};

const results = [];
function check(name, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
}

const server = startServer();
await sleep(1200);
const browser = await puppeteer.launch({ headless: true });
try {
  const shots = arg('--shots');
  if (shots)
    await screenshots(
      path.resolve(ROOT, shots),
      (arg('--states') || 'typical').split(','),
      Number(arg('--width')) || 360,
    );
  else await run();
} catch (error) {
  console.error(error);
  check('preview test finished without crashing', false, String(error && error.message));
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((ok) => !ok).length;
if (results.length) console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

async function open(state, { width = 360, theme = 'light' } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewport({ width, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await page.goto(`${BASE}/test/preview/panel.html?state=${state}`);
  await sleep(state === 'empty' || state === 'error' ? 600 : 1500);
  return { page, errors };
}

async function run() {
  const text = (page, selector) =>
    page.$eval(selector, (n) => n.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  for (const [state, want] of Object.entries(EXPECT)) {
    const { page, errors } = await open(state, { width: 320 });
    if (want.headline)
      check(`${state}: headline`, (await text(page, '#headline')) === want.headline, await text(page, '#headline'));
    if (want.button)
      check(
        `${state}: scan button says it is scanning`,
        (await text(page, '#scan-button')) === want.button,
        await text(page, '#scan-button'),
      );
    if (want.notice)
      check(
        `${state}: says why it cannot scan`,
        (await text(page, '#notice-title')) === want.notice,
        await text(page, '#notice-title'),
      );
    if (want.meter)
      check(
        `${state}: a four-digit count fits its meter cell as ${want.meter}`,
        (await text(page, '.meter-cell')) === want.meter,
        await text(page, '.meter-cell'),
      );
    if (want.status)
      check(
        `${state}: the row gives the exact count with a separator`,
        (await text(page, '#core-list .status')) === want.status,
        await text(page, '#core-list .status'),
      );
    if (want.address)
      check(
        `${state}: the address is shown as words, not percent codes`,
        (await text(page, '#page-label')) === want.address,
        await text(page, '#page-label'),
      );
    await page.evaluate(() => {
      for (const d of document.querySelectorAll('details')) d.open = true;
    });
    for (const size of ['100%', '200%']) {
      const over = await overflowing(page, size);
      check(
        `${state}: no sideways scrolling at 320px, text ${size}, everything open`,
        over.length === 0,
        over.join(' | '),
      );
    }
    check(`${state}: no errors`, errors.length === 0, errors.join(' ; '));
    await page.close();
  }
  // axe on every state, both themes, with every section open: zero violations.
  for (const state of Object.keys(EXPECT)) {
    for (const theme of ['light', 'dark']) {
      const { page } = await open(state, { theme });
      await page.evaluate(() => {
        for (const d of document.querySelectorAll('details')) d.open = true;
      });
      const found = await axeViolations(page);
      check(`axe: ${state}, ${theme}: no violations`, found.length === 0, found.join(' | '));
      await page.close();
    }
  }

  // The one motion moment: the meter fills once after a scan, in 300ms.
  for (const motion of ['no-preference', 'reduce']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 360, height: 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: motion }]);
    await page.goto(`${BASE}/test/preview/panel.html?state=typical`);
    // Wait for the scan's meter: the class goes on as the cells fill.
    await page.waitForFunction(() => document.getElementById('meter').classList.contains('filling'), {
      timeout: 5000,
      polling: 'mutation',
    });
    const during = await page.evaluate(() => ({
      running: document.getAnimations().filter((a) => a.animationName === 'meter-fill').length,
      longest: Math.max(0, ...document.getAnimations().map((a) => a.effect.getComputedTiming().endTime)),
      others: document.getAnimations().filter((a) => a.animationName !== 'meter-fill').length,
    }));
    await sleep(600);
    const after = await page.evaluate(() => ({
      filling: document.getElementById('meter').classList.contains('filling'),
      hidden: [...document.querySelectorAll('.meter-cell')].filter((c) => getComputedStyle(c).opacity !== '1').length,
    }));
    if (motion === 'reduce')
      check(
        'reduced motion: the meter does not animate, and every cell shows',
        during.running === 0 && after.hidden === 0,
        JSON.stringify({ during, after }),
      );
    else
      check(
        'the meter fills left to right in 300ms, and nothing else animates',
        during.running === 8 &&
          Math.round(during.longest) === 300 &&
          during.others === 0 &&
          !after.filling &&
          after.hidden === 0,
        JSON.stringify({ during, after }),
      );
    await page.close();
  }

  // The bundled typeface really loads (both weights), with no fallback.
  const { page: fontPage } = await open('typical');
  const fonts = await fontPage.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((f) => f.family.replace(/["']/g, '') === 'TeX Gyre Heros' && f.status === 'loaded')
      .map((f) => f.weight)
      .sort();
  });
  check('TeX Gyre Heros is loaded at weights 400 and 700', fonts.join(',') === '400,700', fonts.join(','));
  await fontPage.close();

  // The outer page with its toggles also loads.
  const outer = await browser.newPage();
  const outerErrors = [];
  outer.on('pageerror', (e) => outerErrors.push(e.message));
  await outer.goto(`${BASE}/test/preview.html?state=zero&theme=dark&width=420`);
  await sleep(1500);
  const frame = await outer.$eval('#panel', (f) => ({
    width: f.style.width,
    scheme: f.style.colorScheme,
    src: f.getAttribute('src'),
  }));
  check(
    'preview page applies state, theme and width from the address',
    frame.width === '420px' && frame.scheme === 'dark' && frame.src.includes('state=zero'),
    JSON.stringify(frame),
  );
  check('preview page: no errors', outerErrors.length === 0, outerErrors.join(' ; '));
  const outerFound = await axeViolations(outer);
  check('axe: the preview page itself has no violations', outerFound.length === 0, outerFound.join(' | '));
}

/** axe with the panel's own standard: WCAG 2.0-2.2 A and AA, plus best practices. */
async function axeViolations(page) {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    });
    return result.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')}`);
  });
}

/** Elements that stick out past the panel's right edge, deepest first. */
async function overflowing(page, size) {
  return page.evaluate((size) => {
    document.documentElement.style.fontSize = size;
    const edge = document.documentElement.clientWidth;
    const out = [...document.querySelectorAll('body *')].filter(
      (n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > edge + 1,
    );
    return out
      .filter((n) => !out.some((o) => o !== n && n.contains(o)))
      .slice(0, 5)
      .map(
        (n) =>
          `${n.tagName.toLowerCase()}.${n.className || ''} +${Math.round(n.getBoundingClientRect().right - edge)}px "${n.textContent.trim().slice(0, 24)}"`,
      );
  }, size);
}

async function screenshots(folder, states, width) {
  mkdirSync(folder, { recursive: true });
  for (const state of states) {
    for (const theme of ['light', 'dark']) {
      const { page } = await open(state, { width, theme });
      // The first screen, with the first issue opened to show an open row.
      await page.evaluate(() => {
        const first = document.querySelector('#fix-list details');
        if (first) first.open = true;
      });
      const file = path.join(folder, `${state}-${theme}-${width}.png`);
      await page.screenshot({ path: file });
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (wide > 0) console.log(`  too wide by ${wide}px`);
      console.log(file);
      await page.close();
    }
  }
}

function startServer() {
  for (const python of ['python3', 'python']) {
    if (spawnSync(python, ['--version']).status === 0)
      return spawn(python, ['-m', 'http.server', String(PORT), '--directory', ROOT], { stdio: 'ignore' });
  }
  throw new Error('Python is needed to serve the preview.');
}
