// End-to-end test of the real extension in Chrome for Testing.
//
// Usage: node test/e2e/run.mjs   (Windows only for now, see below)
//
// It loads the extension exactly as shipped (no extra permissions), serves
// test/fixtures on localhost, and opens the side panel with the real keyboard
// shortcut. Automation tools cannot click the toolbar icon, and synthetic key
// events do not reach Chrome's shortcut handler, so send-shortcut.ps1 presses
// Alt+Shift+K at the operating system level. That part is Windows only.
//
// Note: a Chrome window opens and takes focus while this runs. Do not type.

import puppeteer from 'puppeteer';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PAGES = path.join(ROOT, 'test', 'fixtures');
const PORT = 8123;
const BASE = `http://localhost:${PORT}`;
const AXE_SOURCE = readFileSync(path.join(ROOT, 'extension', 'vendor', 'axe.min.js'), 'utf8');
const SHOTS = path.join(ROOT, 'test', 'screenshots');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
}

const server = startServer(PORT);
// The same pages on the next port: a different origin, for frames from another site.
const otherServer = startServer(PORT + 1);
// Counts every request. Hostile snippets point here; it must get none.
const pings = [];
const pingServer = http
  .createServer((req, res) => {
    pings.push(req.url);
    res.end();
  })
  .listen(PORT + 3);
await waitForServer(BASE);
await waitForServer(`http://localhost:${PORT + 1}`);

const browser = await puppeteer.launch({
  headless: false,
  pipe: true,
  enableExtensions: [path.join(ROOT, 'extension')],
  defaultViewport: null,
});
let exitCode = 0;
try {
  await run();
} catch (error) {
  console.error(error);
  check('test run finished without crashing', false, String(error && error.message));
} finally {
  await browser.close();
  server.kill();
  otherServer.kill();
  pingServer.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) exitCode = 1;
  process.exit(exitCode);
}

async function run() {
  const [page] = await browser.pages();
  await page.goto(`${BASE}/broken.html`);
  await page.bringToFront();
  await sleep(1000);

  // Open from the shortcut, activeTab is granted
  const sent = pressShortcut('Broken test page');
  check('shortcut was sent to the test window', sent === 'SENT', sent);
  const panelTarget = await browser
    .waitForTarget((t) => t.url().includes('/panel/panel.html'), { timeout: 8000 })
    .catch(() => null);
  check('side panel opens from the keyboard shortcut', panelTarget);
  if (!panelTarget) return;
  const panel = await panelTarget.asPage();
  // new URL().origin is "null" for chrome-extension: URLs, so cut the string instead.
  const extensionOrigin = panelTarget.url().split('/panel/')[0];
  // Let the panel use the clipboard as if it had focus, so copies can be checked.
  await browser
    .defaultBrowserContext()
    .overridePermissions(extensionOrigin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  await (await panel.createCDPSession()).send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(800);
  check(
    'panel can see the page address (activeTab granted)',
    (await text(panel, '#page-label')) === `localhost:${PORT}/broken.html`,
    await text(panel, '#page-label'),
  );
  check('panel header shows the name from messages.json', (await text(panel, 'h1')) === 'Handrail');
  check(
    'panel shows the page title when it has access',
    (await text(panel, '#page-title')) === 'Broken test page',
    await text(panel, '#page-title'),
  );

  // Before any scan: no "0 of 8", and no report to copy yet
  check(
    'before a scan the summary says Not scanned yet',
    (await text(panel, '#headline')) === 'Not scanned yet',
    await text(panel, '#headline'),
  );
  check(
    'before a scan Copy report is off, with a visible reason',
    (await panel.$eval('#copy-report', (n) => n.getAttribute('aria-disabled'))) === 'true' &&
      !(await panel.$eval('#report-note', (n) => n.hidden)) &&
      (await text(panel, '#report-note')).startsWith('Scan this page first'),
  );
  await panel.click('#copy-report');
  await sleep(300);
  check(
    'pressing Copy report before a scan says why instead of copying',
    (await text(panel, '#announcer')).startsWith('Scan this page first') &&
      (await panel.$eval('#report-fallback', (n) => n.hidden)),
    await text(panel, '#announcer'),
  );

  // Scan broken.html
  await scan(panel);
  const core = await coreMap(panel);
  check(
    'broken: text contrast 3 issues + 1 needs review',
    core['Text contrast'] === 'Issues found (3) Needs review (1)',
    core['Text contrast'],
  );
  check(
    'broken: image descriptions 3 issues (incl. shadow DOM)',
    core['Image descriptions'] === 'Issues found (3)',
    core['Image descriptions'],
  );
  check('broken: form labels 2 issues', core['Form labels'] === 'Issues found (2)', core['Form labels']);
  check('broken: link names 2 issues', core['Link names'] === 'Issues found (2)', core['Link names']);
  check(
    'broken: button names 3 issues (incl. same-origin frame)',
    core['Button names'] === 'Issues found (3)',
    core['Button names'],
  );
  check('broken: page language 1 issue', core['Page language'] === 'Issues found (1)', core['Page language']);
  // After the scan's own keyboard checks. The two icon-only links have no
  // size, so Chrome leaves them out of the Tab order (the real Tab key skips
  // them too); they are reported as links with no name instead. Nothing is
  // marked good by the tool: both checks still need a person.
  check(
    'broken: keyboard access needs a quick check (the tool found no keyboard issues)',
    core['Keyboard access'] === 'Needs a quick check',
    core['Keyboard access'],
  );
  check(
    'broken: visible focus needs a quick check (the tool found no focus issues)',
    core['Visible focus'] === 'Needs a quick check',
    core['Visible focus'],
  );
  const focusHints = await text(panel, '[data-hints-for="focus-visible"]');
  check(
    'the on-screen focus check runs with activeTab alone (no extra permission)',
    /The focus checks visited \d+ of \d+/.test(focusHints) && !focusHints.includes('on-screen check'),
    focusHints.slice(0, 160),
  );
  const narrowestName = await panel.$$eval('#core-list .core-name', (n) =>
    Math.min(...n.map((x) => x.getBoundingClientRect().width)),
  );
  check('core check names are never squeezed narrow', narrowestName >= 100, `${Math.round(narrowestName)}px`);
  check('broken: headline 0 of 8 after the scan', (await text(panel, '#headline')) === '0 of 8 core checks look good');
  check(
    'broken: cross-origin frame reported',
    (await text(panel, '#frames-note')).startsWith('1 frame on this page could not be scanned'),
  );
  const frameLinks = await panel.$$eval('#frames-note a', (n) => n.map((a) => a.href));
  check(
    'broken: the frame is listed by address with a link to scan it on its own',
    (await text(panel, '#frames-note li code')) === `127.0.0.1:${PORT}/frame-other.html` &&
      frameLinks[0] === `http://127.0.0.1:${PORT}/frame-other.html`,
    JSON.stringify(frameLinks),
  );
  check(
    'after a scan Copy report is on and the reason is gone',
    (await panel.$eval('#copy-report', (n) => n.getAttribute('aria-disabled'))) === 'false' &&
      (await panel.$eval('#report-note', (n) => n.hidden)),
  );
  const shadowText = await panel.$$eval('.node-selector', (n) => n.map((x) => x.textContent));
  check(
    'shadow DOM element is described in words, not as "a >>> b"',
    shadowText.some((t) => t.includes('Image with no description, inside the shadow-card component')) &&
      !shadowText.some((t) => t.includes('>>>')),
    shadowText.filter((t) => /shadow/.test(t)).join(' | '),
  );
  const copiedRow = await copyFromRow(panel, 'inside the shadow-card component');
  check(
    'Copy selector puts the exact selector on the clipboard',
    copiedRow.selector === 'shadow-card >>> img' && copiedRow.selectorNote === 'Selector copied.',
    JSON.stringify(copiedRow),
  );
  check(
    'Copy HTML puts the exact snippet on the clipboard',
    copiedRow.html === copiedRow.shownHtml &&
      copiedRow.html.startsWith('<img') &&
      copiedRow.htmlNote === 'HTML copied.',
    JSON.stringify(copiedRow),
  );
  check(
    'every element has a Copy selector button',
    await panel.$$eval('.nodes > li', (n) =>
      n.every((li) => [...li.querySelectorAll('button')].some((b) => b.textContent.startsWith('Copy selector'))),
    ),
  );
  const targetIssue = await panel.$$eval('details.item', (items) => {
    const item = items.find((d) => d.querySelector('a[href*="/target-size"]'));
    return item ? item.querySelector('summary .status').textContent.trim() : '';
  });
  const targetGuided = await text(panel, '[data-scan-for="target-size"]');
  check(
    'the target size guided check shows the same automated finding as the issue list',
    /^Issues found \(\d+\)$/.test(targetIssue) && targetGuided === `Scan: ${targetIssue}`,
    `${targetGuided} vs ${targetIssue}`,
  );
  const rawTitles = await panel.$$eval('details.item summary h3', (n) =>
    n.map((x) => x.textContent).filter((t) => /\b(must|should)\b/.test(t)),
  );
  check('every issue has a plain title, none in axe wording', rawTitles.length === 0, rawTitles.join(' | '));
  const fixTitles = await panel.$$eval('#fix-list > li summary h3', (n) => n.map((x) => x.textContent));
  check(
    'fix these next has 5 items, Core 8 first',
    fixTitles.length === 5 && fixTitles[0] === 'Buttons have names that screen readers can read',
    fixTitles.join(' | '),
  );
  const otherCount = await panel.$$eval('#other-list > li', (n) => n.length);
  check(
    'other issues listed behind "show all"',
    otherCount >= 1 && (await panel.$eval('#other-list', (n) => n.hidden)),
    `${otherCount} other`,
  );
  const allRuleIds = await panel.$$eval('a[href*="dequeuniversity.com/rules/axe"]', (n) =>
    n.map((a) => a.href.split('/').pop().split('?')[0]),
  );
  check(
    'WCAG 2.2 target-size rule ran and flagged the 12px button',
    allRuleIds.includes('target-size'),
    allRuleIds.filter((id) => id.startsWith('target')).join(','),
  );
  check(
    'best practices section shown and collapsed',
    !(await panel.$eval('#bp-section', (n) => n.hidden)) && !(await panel.$eval('#bp-details', (n) => n.open)),
  );
  check(
    'focus moved to the summary heading after the scan',
    (await panel.evaluate(() => document.activeElement.id)) === 'summary-heading',
  );
  check(
    'live region announced the result once the focus checks finished',
    (await text(panel, '#announcer')) === 'Focus checks done. Core checks: 0 of 8 look good.',
    await text(panel, '#announcer'),
  );

  // A core check row leads to its issue group
  await panel.evaluate(() =>
    [...document.querySelectorAll('#core-list button')]
      .find((b) => b.textContent === 'Show issues: Image descriptions')
      .click(),
  );
  await sleep(300);
  const landed = await panel.evaluate(() => ({
    open: document.getElementById('issue-image-alt').open,
    focus: document.activeElement === document.querySelector('#issue-image-alt > summary'),
  }));
  check(
    'core check row "Show issues" opens its issue group and moves focus there',
    landed.open && landed.focus,
    JSON.stringify(landed),
  );

  // Self-audit of the panel with everything open
  await openEverything(panel);
  await auditPanel(panel, 'panel, light theme, all sections open');
  await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await auditPanel(panel, 'panel, dark theme, all sections open');
  await panel.emulateMediaFeatures([]);
  await targetSizes(panel);
  await keyboardWalk(panel);

  // Show on page
  // Every element in every issue group can be shown, including the one in the
  // shadow DOM and the one in the same-origin frame.
  const ISSUE_ROWS = '#fix-list .nodes > li, #other-list .nodes > li, #review-list .nodes > li, #bp-list .nodes > li';
  const rowCount = await panel.$$eval(ISSUE_ROWS, (rows) => rows.length);
  const notShown = [];
  for (let i = 0; i < rowCount; i++) {
    const outcome = await showRow(panel, ISSUE_ROWS, i);
    if (!outcome.text.startsWith('Highlighted on page')) notShown.push(`${outcome.what} -> ${outcome.text}`);
  }
  check(
    'every element in every issue group can be shown on the page',
    rowCount > 20 && notShown.length === 0,
    `${rowCount} elements. ${notShown.slice(0, 3).join(' | ')}`,
  );
  const shadowShown = await showRow(panel, ISSUE_ROWS, 'inside the shadow-card component');
  check('the image inside shadow-card is highlighted', shadowShown.text === 'Highlighted on page.', shadowShown.text);
  check(
    'the highlight is one overlay in a closed shadow root, hidden from screen readers, ignoring the mouse',
    await page.$$eval(
      '#handrail-highlight',
      (n) =>
        n.length === 1 &&
        n[0].shadowRoot === null &&
        n[0].getAttribute('aria-hidden') === 'true' &&
        n[0].style.pointerEvents === 'none',
    ),
  );
  check(
    'the highlight was announced with a description',
    (await text(panel, '#announcer')) ===
      'Highlighted on page: Image with no description, inside the shadow-card component',
    await text(panel, '#announcer'),
  );
  const frameShown = await showRow(panel, ISSUE_ROWS, 'inside a frame on this page');
  check(
    'the button inside the same-origin frame is highlighted',
    frameShown.text === 'Highlighted on page.',
    frameShown.text,
  );
  check('still only one overlay on the page', (await page.$$eval('#handrail-highlight', (n) => n.length)) === 1);

  // Previous and Next step through one group (button names: 3 elements).
  const stepping = await panel.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const rows = [...document.querySelectorAll('#issue-button-name .nodes > li')];
    const button = (row, word) => [...row.querySelectorAll('button')].find((b) => b.textContent.startsWith(word));
    const shown = (row) => row.querySelector('.highlight-result').textContent.startsWith('Highlighted');
    const steps = {};
    steps.names = button(rows[1], 'Show on page').textContent;
    steps.ends = button(rows[0], 'Previous').disabled && button(rows[2], 'Next').disabled;
    button(rows[0], 'Next').click();
    await wait(800);
    steps.next1 = shown(rows[1]) && document.activeElement === button(rows[1], 'Next');
    button(rows[1], 'Next').click();
    await wait(800);
    steps.next2 = shown(rows[2]) && document.activeElement === button(rows[2], 'Show on page');
    button(rows[2], 'Previous').click();
    await wait(800);
    steps.prev = shown(rows[1]) && document.activeElement === button(rows[1], 'Previous');
    steps.oneResult = document.querySelectorAll('.highlight-result:not(:empty)').length === 1;
    return steps;
  });
  check(
    'Next and Previous step through the group and keep focus on the stepping button',
    stepping.ends && stepping.next1 && stepping.next2 && stepping.prev && stepping.oneResult,
    JSON.stringify(stepping),
  );
  check('each button says which element it acts on', stepping.names === 'Show on page: button 2 of 3', stepping.names);

  await panel.keyboard.press('Escape');
  await sleep(400);
  check(
    'Escape in the panel removes the highlight and leaves nothing behind',
    (await page.$$eval('#handrail-highlight', (n) => n.length)) === 0 &&
      (await panel.$eval('#clear-highlight', (n) => n.hidden)),
  );

  // Several elements match the selector: highlight the first and say how many.
  await page.evaluate(() => {
    for (const id of ['email', 'age']) document.body.append(document.getElementById(id).cloneNode());
  });
  const several = await showRow(panel, ISSUE_ROWS, 'Text field with no text', true);
  check(
    'when several elements match, the first is shown and the count is given',
    several.text === 'Highlighted on page. 2 elements match its selector, so this is the first one.',
    several.text,
  );
  await panel.click('#clear-highlight');
  await sleep(300);
  check('remove highlight leaves nothing behind', (await page.$$eval('#handrail-highlight', (n) => n.length)) === 0);

  // Hidden, then gone (as when a single-page app re-renders).
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('body > button:not(.tiny)')) b.style.display = 'none';
  });
  const hidden = await showRow(panel, ISSUE_ROWS, 'Button with no text', true);
  check(
    'a hidden element says it cannot be highlighted and shows its HTML',
    hidden.text.startsWith("This element is hidden on the page, so it can't be highlighted") && hidden.snippetOpen,
    JSON.stringify(hidden),
  );
  // axe's selector is positional, so after a re-render it can point at a
  // different element. The panel still shows it, but says so.
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('body > button:not(.tiny)')) b.remove();
  });
  const moved = await showRow(panel, ISSUE_ROWS, 'Button with no text', true);
  check(
    'when the selector now points at a different element, the panel says so',
    moved.text.endsWith('The page changed since the scan, so this may be a different element. Rescan to update.'),
    moved.text,
  );
  await page.evaluate(() => document.querySelector('.tiny').remove());
  const gone = await showRow(panel, ISSUE_ROWS, 'Button with no text', true);
  check(
    'a removed element says it is gone and to rescan',
    gone.text === "This element isn't on the page anymore. Rescan to update.",
    gone.text,
  );

  // A page load takes the highlight away, and the panel notices.
  await showRow(panel, ISSUE_ROWS, 'Image with no description, inside the shadow-card component');
  await page.reload();
  await sleep(1500);
  check(
    'navigating clears the highlight in the panel too',
    (await panel.$eval('#clear-highlight', (n) => n.hidden)) &&
      (await page.$$eval('#handrail-highlight', (n) => n.length)) === 0,
  );

  // Pages that rewrite their own address (scroll spies, hash routers) must not
  // reset the panel or drop keyboard focus.
  await panel.evaluate(() => {
    document.querySelector('#fix-list details').open = true;
    document.querySelector('#fix-list button.small').focus();
  });
  await page.evaluate(() => history.replaceState(null, '', '#section-2'));
  await sleep(800);
  const kept = await panel.evaluate(() => {
    const button = document.querySelector('#fix-list button.small');
    return {
      open: button.closest('details').open,
      focused: document.activeElement === button,
      active: document.activeElement.tagName,
    };
  });
  check('page changing its own hash keeps panel focus and open items', kept.open && kept.focused, JSON.stringify(kept));
  await page.evaluate(() => history.replaceState(null, '', location.pathname));
  await sleep(500);

  // Guided checks, persistence, rescan
  await panel.evaluate(() => {
    document.getElementById('check-keyboard').open = true;
  });
  await panel.click('#check-keyboard input[value="looks-good"]');
  await sleep(300);
  check(
    'marking a core manual check updates the headline',
    (await text(panel, '#headline')) === '1 of 8 core checks look good',
    await text(panel, '#headline'),
  );
  await panel.reload();
  await sleep(1200);
  check(
    'manual status survives closing and reopening the panel',
    await panel.$eval('#check-keyboard input[value="looks-good"]', (n) => n.checked),
  );
  check(
    'last scan summary survives too',
    (await text(panel, '#stale-note')).startsWith('These results are from your last scan'),
  );
  const coreAfterReload = await coreMap(panel);
  check(
    'stored Core 8 summary shown after reopening',
    coreAfterReload['Form labels'] === 'Issues found (2)',
    coreAfterReload['Form labels'],
  );

  // Fix one image and break one more button, then rescan.
  await page.evaluate(() => {
    document.querySelector('body > img').alt = 'Fixed';
    const b = document.createElement('button');
    document.body.append(b);
  });
  await scan(panel);
  check(
    'rescan shows "Since last scan: 1 fixed, 1 new"',
    (await text(panel, '#since-last')) === 'Since last scan: 1 fixed, 1 new',
    await text(panel, '#since-last'),
  );

  // Copy report
  // First the real path: it either copies, or shows the text box fallback.
  await panel.click('#copy-report');
  await sleep(500);
  const copied = /Report copied/.test(await text(panel, '#announcer'));
  const fellBack = !(await panel.$eval('#report-fallback', (n) => n.hidden));
  check(
    'copy report copies, or shows a text box to copy from',
    copied || fellBack,
    copied ? 'copied' : 'fallback shown',
  );
  // Then capture the text by wrapping the clipboard call, to check what is in it.
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
    'report has page, axe version, core summary, caveat',
    /localhost:8123\/broken.html/.test(report) &&
      /axe-core 4\./.test(report) &&
      /## Core checks: 1 of 8 look good/.test(report) &&
      /A clean scan does not mean your page meets WCAG/.test(report),
  );
  check(
    'report lists manual statuses',
    /Everything works with just a keyboard \(WCAG 2\.1\.1, level A\): Looks good/.test(report),
  );

  // SPA route change (same origin keeps access)
  await page.goto(`${BASE}/spa.html`);
  await sleep(1000);
  await scan(panel);
  check(
    'spa home: no image issues',
    (await coreMap(panel))['Image descriptions'] === 'Nothing found by automated checks',
  );
  await page.click('[data-route="spa-about"]');
  await sleep(800);
  check(
    'spa route change: panel follows the new path',
    (await text(panel, '#page-label')) === `localhost:${PORT}/spa-about`,
    await text(panel, '#page-label'),
  );
  check('spa route change: old details are hidden', await panel.$eval('#fix-section', (n) => n.hidden));
  await scan(panel);
  check(
    'spa about: image issue found after rescan',
    (await coreMap(panel))['Image descriptions'] === 'Issues found (1)',
    (await coreMap(panel))['Image descriptions'],
  );

  // Frames: same-origin, srcdoc, about:blank, data: and sandboxed frames scan
  await page.goto(`${BASE}/frames.html`);
  await sleep(1500);
  await scan(panel);
  check(
    'frames: a nameless button found in each of the 5 reachable frames',
    (await coreMap(panel))['Button names'] === 'Issues found (5)',
    (await coreMap(panel))['Button names'],
  );
  const frameCodes = await panel.$$eval('#frames-note li code', (n) => n.map((x) => x.textContent));
  check(
    'frames: frames from another host and another port are listed as not scanned',
    (await text(panel, '#frames-note')).startsWith('2 frames on this page could not be scanned') &&
      frameCodes.includes(`127.0.0.1:${PORT}/frame-other.html`) &&
      frameCodes.includes(`localhost:${PORT + 1}/frame-other.html`),
    frameCodes.join(', '),
  );
  const frameLinkNames = await panel.$$eval('#frames-note a', (n) => n.map((a) => `${a.href} = ${a.textContent}`));
  check(
    'frames: the other-port frame has its own link to open it on its own',
    frameLinkNames.includes(
      `http://localhost:${PORT + 1}/frame-other.html = Open this frame on its own to scan it: localhost:${PORT + 1}/frame-other.html (opens in a new tab)`,
    ),
    frameLinkNames.join(' | '),
  );
  const frameDescriptions = await panel.$$eval('.node-selector', (n) =>
    n.map((x) => x.textContent).filter((t) => t.includes('inside a frame')),
  );
  check(
    'frames: elements in frames are described in words',
    frameDescriptions.length >= 5,
    String(frameDescriptions.length),
  );
  // Same-origin, srcdoc and about:blank frames can be outlined. data: and
  // sandboxed frames were scanned but have no document the panel can reach.
  const frameRows = '#issue-button-name .nodes > li';
  const frameResults = [];
  for (let i = 0; i < 5; i++) frameResults.push((await showRow(panel, frameRows, i)).text);
  const sealedMessage =
    "This element is inside a sealed frame (a sandboxed or data: frame), which can't be reached from here. Use Copy selector to find it in your browser's developer tools.";
  check(
    'frames: 3 frame elements are outlined, 2 in sealed frames get the plain message',
    frameResults.filter((t) => t === 'Highlighted on page.').length === 3 &&
      frameResults.filter((t) => t === sealedMessage).length === 2,
    frameResults.join(' | '),
  );
  await panel.keyboard.press('Escape');

  // Shadow DOM: closed roots
  await page.goto(`${BASE}/shadow.html`);
  await sleep(1200);
  await scan(panel);
  check(
    'shadow: a closed shadow root hides its image from the scan (1 issue, not 2)',
    (await coreMap(panel))['Image descriptions'] === 'Issues found (1)',
    (await coreMap(panel))['Image descriptions'],
  );
  check(
    'shadow: the open one is outlined',
    (await showRow(panel, '.nodes > li', 'inside the swap-card component')).text === 'Highlighted on page.',
  );
  // A re-render gives the same component a closed root.
  await page.evaluate(() => {
    document.querySelector('swap-card').outerHTML = '<swap-card data-mode="closed"></swap-card>';
  });
  const closed = await showRow(panel, '.nodes > li', 'inside the swap-card component');
  check(
    'shadow: an element behind a closed shadow root gets the plain message',
    closed.text ===
      "This element is inside a closed web component, which extensions can't look inside. Use Copy selector to find it in your browser's developer tools.",
    closed.text,
  );

  // Highlight position: transform and zoom, light and dark
  mkdirSync(SHOTS, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  for (const theme of ['light', 'dark']) {
    await page.goto(`${BASE}/position.html${theme === 'dark' ? '?dark' : ''}`);
    await sleep(1000);
    await scan(panel);
    for (const [index, id] of [
      [0, 'scaled'],
      [1, 'zoomed'],
    ]) {
      const shown = await showRow(panel, '#issue-button-name .nodes > li', index);
      await sleep(400);
      const element = await page.$eval(`#${id}-button`, (n) => n.getBoundingClientRect().toJSON());
      const outline = await overlayRect(page);
      // The outline is drawn 4px outside the element on every side.
      const off = outline
        ? Math.max(
            ...['left', 'top'].map((k) => Math.abs(outline[k] - (element[k] - 4))),
            ...['right', 'bottom'].map((k) => Math.abs(outline[k] - (element[k] + 4))),
          )
        : Infinity;
      await page.screenshot({ path: path.join(SHOTS, `position-${theme}-${id}.png`) });
      check(
        `position, ${theme} page: the outline sits on the button inside "${id}" (within 1px)`,
        shown.text === 'Highlighted on page.' && off <= 1,
        `${off.toFixed(2)}px off. element ${JSON.stringify(element)} outline ${JSON.stringify(outline)}`,
      );
    }
  }
  await page.emulateMediaFeatures([]);
  await panel.keyboard.press('Escape');

  // Hostile snippets: shown as text only, no requests
  await page.goto(`${BASE}/hostile.html`);
  await sleep(1000);
  await scan(panel);
  await openEverything(panel);
  await sleep(1500);
  const hostile = await panel.evaluate(() => ({
    live: document.querySelectorAll(
      '.nodes img, .nodes svg, .nodes style, .nodes script, .nodes a[href^="javascript:"]',
    ).length,
    pwned: window.__pwned || null,
    headerShown: getComputedStyle(document.querySelector('.app-header')).display !== 'none',
    asText: [...document.querySelectorAll('.nodes pre code')]
      .map((c) => c.textContent)
      .filter((t) => /onerror=|onload=|javascript:|<style>/.test(t)).length,
  }));
  check(
    'hostile snippets show only as text: nothing renders, runs or restyles the panel',
    hostile.live === 0 && !hostile.pwned && hostile.headerShown && hostile.asText >= 4,
    JSON.stringify(hostile),
  );
  check('hostile snippets make zero requests to the test server', pings.length === 0, pings.join(', '));

  // Clear data
  await panel.click('#clear-page');
  await panel.click('#confirm-no');
  check(
    'cancel puts focus back on the button that opened the question',
    (await panel.evaluate(() => document.activeElement.id)) === 'clear-page',
    await panel.evaluate(() => document.activeElement.id || document.activeElement.tagName),
  );
  await panel.click('#clear-page');
  check('clear asks for confirmation first', !(await panel.$eval('#confirm-box', (n) => n.hidden)));
  await auditPanel(panel, 'panel with the confirm box open');
  await panel.click('#confirm-yes');
  await sleep(500);
  check("clear this page's data resets the page", (await text(panel, '#last-scanned')) === 'Not scanned yet');
  await panel.click('#clear-all');
  await panel.click('#confirm-yes');
  await sleep(500);
  const leftover = await panel.evaluate(() => chrome.storage.local.get(null));
  check('clear all data empties storage', Object.keys(leftover).length === 0, JSON.stringify(leftover));

  // Grant lost after going to another site
  await page.goto(`http://127.0.0.1:${PORT}/good.html`);
  await sleep(1000);
  check(
    'navigated to another site: panel says to click the icon',
    (await text(panel, '#notice-title')) === 'Click the Handrail icon on this page to scan it.',
    await text(panel, '#notice-title'),
  );
  check(
    'without access the page line says so and what to do',
    (await text(panel, '#page-label')) === 'Unknown. Click the Handrail icon on this page to see it.' &&
      (await text(panel, '#page-title')) === '',
    await text(panel, '#page-label'),
  );
  check(
    'without access Copy report stays off',
    (await panel.$eval('#copy-report', (n) => n.getAttribute('aria-disabled'))) === 'true',
  );
  await panel.click('#scan-button');
  await sleep(500);
  check(
    'scan without access shows the same message (no silent failure)',
    !(await panel.$eval('#notice', (n) => n.hidden)) &&
      (await text(panel, '#notice-title')) === 'Click the Handrail icon on this page to scan it.',
  );
  await auditPanel(panel, 'panel with a notice showing');
  await sleep(500);
  pressShortcut('Good test page');
  await sleep(1500);
  check(
    'pressing the shortcut again restores access',
    (await text(panel, '#page-label')) === `127.0.0.1:${PORT}/good.html` &&
      (await panel.$eval('#notice', (n) => n.hidden)),
  );
  await scan(panel);
  check(
    'good.html: 6 of 8 (all automated checks clean)',
    (await text(panel, '#headline')) === '6 of 8 core checks look good',
    await text(panel, '#headline'),
  );
  check('good.html: no fix list items', (await panel.$$eval('#fix-list > li', (n) => n.length)) === 0);

  // Pages that cannot be scanned
  await page.goto('chrome://version');
  await sleep(800);
  pressShortcut('About Version');
  await sleep(1500);
  await panel.click('#scan-button');
  await sleep(500);
  check(
    'chrome:// page gets a specific message',
    (await text(panel, '#notice-title')) === 'Chrome does not let extensions scan its own pages.',
    await text(panel, '#notice-title'),
  );

  await page.goto('about:blank');
  await sleep(800);
  pressShortcut('about:blank');
  await sleep(1500);
  await panel.click('#scan-button');
  await sleep(500);
  check(
    'about:blank says the page cannot be scanned',
    (await text(panel, '#notice-title')) === 'This kind of page cannot be scanned.',
    await text(panel, '#notice-title'),
  );

  // Nothing listens on this port, so Chrome shows its error page.
  await page.goto(`http://localhost:${PORT + 9}/`).catch(() => {});
  await sleep(1000);
  pressShortcut(`localhost`);
  await sleep(1500);
  await panel.click('#scan-button');
  await sleep(800);
  check(
    'error page gets a specific message',
    (await text(panel, '#notice-title')) === 'This tab is showing an error page.',
    await text(panel, '#notice-title'),
  );

  // The privacy page linked from the footer must be accessible too.
  const privacy = await browser.newPage();
  await privacy.goto(`${extensionOrigin}/panel/privacy.html`);
  await sleep(300);
  check('privacy page shows the name', (await text(privacy, 'h1')) === 'Privacy: Handrail', await text(privacy, 'h1'));
  await auditPanel(privacy, 'privacy page');
  await privacy.close();
  await page.bringToFront();

  const fileUrl = pathToFileURL(path.join(PAGES, 'good.html')).href;
  await page.goto(fileUrl);
  await sleep(800);
  pressShortcut('Good test page');
  await sleep(1500);
  // Puppeteer turns on "Allow access to file URLs" for extensions it loads,
  // so here the file should scan. The "not allowed" message is covered by unit
  // tests and by the manual QA script.
  const fileAccess = await panel.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
  if (fileAccess) {
    await scan(panel);
    check(
      'file:// page scans when file access is on',
      (await text(panel, '#headline')) === '6 of 8 core checks look good',
      await text(panel, '#headline'),
    );
    check(
      'file:// page shows only the file name, no folders',
      (await text(panel, '#page-label')) === 'good.html',
      await text(panel, '#page-label'),
    );
  } else {
    await panel.click('#scan-button');
    await sleep(500);
    check(
      'file:// page explains how to allow file access',
      (await text(panel, '#notice-title')) === 'To scan files from your computer, turn on file access.',
      await text(panel, '#notice-title'),
    );
  }

  // Reflow and text size, in a narrow tab (uses the ?tabId test hook)
  await page.goto(`${BASE}/broken.html`);
  await sleep(800);
  pressShortcut('Broken test page');
  await sleep(1500);
  const tabId = (await panel.evaluate(() => chrome.storage.session.get('lastClick'))).lastClick.tabId;
  const narrow = await browser.newPage();
  await narrow.setViewport({ width: 320, height: 800 });
  await narrow.goto(`${extensionOrigin}/panel/panel.html?tabId=${tabId}`);
  await sleep(800);
  await scan(narrow);
  await openEverything(narrow);
  check('320px wide: no horizontal scrolling', await noSideScroll(narrow), await widthInfo(narrow));
  await narrow.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await sleep(300);
  check('320px wide at 200% text: no horizontal scrolling', await noSideScroll(narrow), await widthInfo(narrow));
  await auditPanel(narrow, 'panel at 320px and 200% text');
  await narrow.close();
}

// Helpers

function startServer(port) {
  for (const python of ['python3', 'python']) {
    const probe = spawnSync(python, ['--version']);
    if (probe.status === 0) {
      return spawn(python, ['-m', 'http.server', String(port), '--directory', PAGES], { stdio: 'ignore' });
    }
  }
  throw new Error('Python is needed to serve the test pages.');
}

async function waitForServer(base) {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`${base}/good.html`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error('Test server did not start.');
}

function pressShortcut(titlePart) {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(ROOT, 'test', 'e2e', 'send-shortcut.ps1'),
      titlePart,
    ],
    { encoding: 'utf8' },
  );
  return (result.stdout || '').trim().split('\n')[0].trim();
}

async function text(page, selector) {
  return page.$eval(selector, (n) => n.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
}

async function scan(panel) {
  await panel.click('#scan-button');
  await sleep(200);
  await panel.waitForFunction(() => document.getElementById('scan-button').getAttribute('aria-disabled') !== 'true', {
    timeout: 40000,
  });
  await sleep(200);
}

/**
 * Press "Show on page" on one element row and wait for its result. `which` is
 * the row's index, or text its description must contain (`exact` to match the
 * description exactly).
 */
async function showRow(panel, rowsSelector, which, exact = false) {
  return panel.evaluate(
    async (selector, which, exact) => {
      const rows = [...document.querySelectorAll(selector)];
      const describe = (row) => row.querySelector('.node-selector').textContent.replace(/^Element \d+ of \d+: /, '');
      const row =
        typeof which === 'number'
          ? rows[which]
          : rows.find((r) => (exact ? describe(r) === which : describe(r).includes(which)));
      if (!row) return { text: `no row for ${which}`, what: '' };
      const result = row.querySelector('.highlight-result');
      result.textContent = '';
      [...row.querySelectorAll('button')].find((b) => b.textContent.startsWith('Show on page')).click();
      for (let t = 0; t < 60 && !result.textContent; t++) await new Promise((resolve) => setTimeout(resolve, 50));
      return { text: result.textContent, what: describe(row), snippetOpen: row.querySelector('details.snippet').open };
    },
    rowsSelector,
    which,
    exact,
  );
}

/** Press Copy selector and Copy HTML on one row and read back the clipboard. */
async function copyFromRow(panel, describes) {
  return panel.evaluate(async (describes) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const row = [...document.querySelectorAll('.nodes > li')].find((r) =>
      r.querySelector('.node-selector').textContent.includes(describes),
    );
    const button = (word) => [...row.querySelectorAll('button')].find((b) => b.textContent.startsWith(word));
    const note = row.querySelector('.highlight-result');
    const out = { shownHtml: row.querySelector('pre code').textContent };
    button('Copy selector').click();
    await wait(400);
    out.selectorNote = note.textContent;
    out.selector = await navigator.clipboard.readText();
    button('Copy HTML').click();
    await wait(400);
    out.htmlNote = note.textContent;
    out.html = await navigator.clipboard.readText();
    return out;
  }, describes);
}

/**
 * Where the highlight's outline box is, read through Chrome's DevTools
 * protocol (the only way into its closed shadow root). Viewport CSS pixels.
 */
async function overlayRect(page) {
  const cdp = await page.createCDPSession();
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = (node) =>
      (node.attributes || []).includes('handrail-highlight')
        ? node
        : [...(node.children || []), ...(node.shadowRoots || [])].map(find).find(Boolean);
    const host = find(root);
    if (!host) return null;
    const box = host.shadowRoots[0].children[0];
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: box.nodeId });
    const [left, top, , , right, bottom] = model.border;
    return { left, top, right, bottom };
  } finally {
    await cdp.detach();
  }
}

async function coreMap(panel) {
  return panel.$$eval('#core-list li', (items) =>
    Object.fromEntries(
      items.map((li) => [
        li.querySelector('.core-name').firstChild.textContent.trim(),
        [...li.querySelectorAll('.status')].map((s) => s.textContent.trim()).join(' '),
      ]),
    ),
  );
}

async function openEverything(panel) {
  await panel.evaluate(() => {
    for (const d of document.querySelectorAll('details')) d.open = true;
    const toggle = document.getElementById('other-toggle');
    if (toggle.getAttribute('aria-expanded') !== 'true' && !document.getElementById('other-section').hidden)
      toggle.click();
  });
}

async function auditPanel(panel, label) {
  await panel.evaluate(AXE_SOURCE);
  const violations = await panel.evaluate(async () => {
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

async function targetSizes(panel) {
  const small = await panel.evaluate(() =>
    [...document.querySelectorAll('button, summary, a, input, label.radio')]
      .filter((n) => n.offsetParent !== null && !n.closest('p'))
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      .filter(({ n, r }) => {
        // Links inside sentences are exempt; radios are measured by their label row.
        if (n.tagName === 'INPUT' && n.type === 'radio') return false;
        return r.width < 24 || r.height < 24;
      })
      .map(
        ({ n, r }) =>
          `${n.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${n.textContent.trim().slice(0, 20)}"`,
      ),
  );
  check('targets are at least 24x24 CSS px', small.length === 0, small.slice(0, 5).join(' ; '));
}

async function keyboardWalk(panel) {
  await panel.evaluate(() => document.getElementById('scan-button').focus());
  const seen = [];
  let allVisible = true;
  for (let i = 0; i < 12; i++) {
    await panel.keyboard.press('Tab');
    const info = await panel.evaluate(() => {
      const el = document.activeElement;
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        outline: parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none',
      };
    });
    seen.push(info.tag);
    if (!info.outline) allVisible = false;
  }
  check('Tab moves through panel controls', new Set(seen).size > 1 && !seen.includes('body'), seen.join(','));
  check('every focused control shows a focus outline', allVisible);
}

async function noSideScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

async function widthInfo(page) {
  return page.evaluate(
    () => `scrollWidth ${document.documentElement.scrollWidth}, clientWidth ${document.documentElement.clientWidth}`,
  );
}
