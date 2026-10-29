// Takes screenshots (1280x800) of the real running extension on the fixture pages.
// Windows only: it presses the real keyboard shortcut and captures the real
// Chrome window, side panel included.
//
// Usage: node scripts/screenshots.mjs   (needs Python 3 to serve test/fixtures)
// Do not touch the mouse or keyboard while it runs. Files go to docs/images/.

import puppeteer from 'puppeteer';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(ROOT, 'docs', 'images');
const BASE = 'http://localhost:8000';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const captured = [];
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);
if (!python) throw new Error('Python is needed to serve the test pages.');
const server = spawn(python, ['-m', 'http.server', '8000', '--directory', path.join(ROOT, 'test', 'fixtures')], {
  stdio: 'ignore',
});
await sleep(1500); // give the server a moment to start
const browser = await puppeteer.launch({
  headless: false,
  pipe: true,
  enableExtensions: [path.join(ROOT, 'extension')],
  defaultViewport: null,
});
try {
  const [page] = await browser.pages();
  // Make the window a size that scales cleanly to 1280x800.
  const session = await page.createCDPSession();
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' },
  });

  await page.goto(`${BASE}/broken.html`);
  await sleep(1200);
  ps('test/e2e/send-shortcut.ps1', 'Broken test page');
  const target = await browser.waitForTarget((t) => t.url().includes('/panel/panel.html'), { timeout: 8000 });
  const panel = await target.asPage();
  await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await sleep(800);

  // 1. Summary after a scan.
  await panel.click('#scan-button');
  await panel.waitForFunction(() => document.getElementById('scan-button').getAttribute('aria-disabled') !== 'true', {
    timeout: 40000,
  });
  await sleep(500);
  await capture(panel, 1, () => document.getElementById('summary-heading').scrollIntoView());

  // 2. An issue opened, with the element outlined on the page.
  await panel.evaluate(() => {
    const item = [...document.querySelectorAll('#fix-list details')].find((d) =>
      d.textContent.includes('Text stands out'),
    );
    item.open = true;
    item.querySelector('button.small').click();
  });
  await sleep(1200);
  await capture(panel, 2, () => {
    const item = [...document.querySelectorAll('#fix-list details')].find((d) => d.open);
    item.scrollIntoView();
  });

  // 3. A guided check, in dark mode.
  await panel.click('#clear-highlight');
  await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await panel.evaluate(() => {
    const item = document.getElementById('check-focus-not-hidden');
    item.open = true;
    item.querySelector('input[value="has-problem"]').click();
    item.scrollIntoView();
  });
  await sleep(500);
  await capture(panel, 3);

  // 4. A rescan after fixing things: "Since last scan".
  await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluate(() => {
    document.documentElement.lang = 'en';
    for (const img of document.querySelectorAll('body > img')) img.alt = 'Logo';
  });
  await panel.click('#scan-button');
  await panel.waitForFunction(() => document.getElementById('scan-button').getAttribute('aria-disabled') !== 'true', {
    timeout: 40000,
  });
  await sleep(500);
  await capture(panel, 4, () => window.scrollTo(0, 0));

  // Resize last: opening a tab for it would move the side panel to that tab.
  for (const n of captured) {
    const raw = path.join(OUT, `raw-${n}.png`);
    await resize(raw, path.join(OUT, `screenshot-${n}.png`));
    unlinkSync(raw);
  }
} finally {
  await browser.close();
  server.kill();
}

async function capture(panel, n, scroll) {
  if (scroll) await panel.evaluate(scroll);
  await sleep(400);
  const raw = path.join(OUT, `raw-${n}.png`);
  const result = ps('scripts/capture-window.ps1', 'Broken test page', raw);
  console.log(`screenshot ${n}: ${result}`);
  captured.push(n);
}

/** Scale the capture to exactly 1280x800 using a throwaway page. */
async function resize(input, output) {
  const data = readFileSync(input).toString('base64');
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1280, height: 800 });
  await tab.setContent(
    `<body style="margin:0"><img src="data:image/png;base64,${data}" style="width:1280px;height:800px;display:block"></body>`,
  );
  await tab.screenshot({ path: output });
  await tab.close();
}

function ps(script, ...args) {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, script), ...args],
    {
      encoding: 'utf8',
    },
  );
  return (result.stdout || '').trim();
}
