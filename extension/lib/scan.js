// Running axe-core on the user's page, and explaining in plain words when we
// cannot.
//
// How a scan works:
//   1. Inject vendor/axe.min.js into the page (and into any frames Chrome
//      lets us reach) with chrome.scripting.executeScript.
//   2. Run axe.run() in the top frame with a second executeScript call.
//      axe collects results from the frames itself.
//   3. Send back only small, plain data (no DOM nodes), trimmed to size.
// We inject on demand instead of using a declared content script. A content
// script that is missing from an open tab causes the confusing "Receiving end
// does not exist" error that other checkers show.

/* global axe -- defined in the page by the injected vendor/axe.min.js */

import { classifyUrl } from './pagekey.js';

export const SCAN_TIMEOUT_MS = 30000;

// WCAG 2.0, 2.1 and 2.2 at levels A and AA, plus axe's best practices.
// Best practices are shown separately in the panel, never as WCAG failures.
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

// Experimental axe rules we also run. Their results only appear as "possible"
// hints inside the guided checks, never in the issue lists or the Core 8.
export const EXPERIMENTAL_RULES = ['p-as-heading'];

// How many affected elements we keep per rule. The full count is still kept.
export const MAX_NODES_PER_RULE = 50;
export const SNIPPET_LENGTH = 200;

/** Thrown when a scan cannot run. `code` matches a key in explainProblem(). */
export class ScanProblem extends Error {
  constructor(code, technical = '') {
    super(code);
    this.code = code;
    this.technical = technical;
  }
}

/**
 * Scan a tab. Resolves with the trimmed results, or rejects with ScanProblem.
 */
export async function scanTab(tabId, { timeoutMs = SCAN_TIMEOUT_MS } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ScanProblem('timeout')), timeoutMs);
  });
  try {
    return await Promise.race([runScan(tabId), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runScan(tabId) {
  try {
    // Inject axe into every frame we are allowed into. Frames from
    // other sites are skipped by Chrome; axe reports them as "not tested".
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['vendor/axe.min.js'],
    });
    // By default axe only talks to frames with exactly the same origin, so it
    // skipped frames with an opaque origin (data:, sandboxed srcdoc, and every
    // file:// frame). Chrome only injects axe into frames our activeTab access
    // covers: the page's own origin and frames the page made itself. Frames
    // from other sites never get axe, so they cannot send it results. Tested
    // in Chrome with test/fixtures/frames.html.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: allowFrameOrigins,
    });

    // Run it in the top frame.
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: runAxeInPage,
      args: [
        { tags: AXE_TAGS, extraRules: EXPERIMENTAL_RULES, maxNodes: MAX_NODES_PER_RULE, snippetLength: SNIPPET_LENGTH },
      ],
    });

    const result = frame && frame.result;
    if (!result) throw new ScanProblem('unknown', 'The scan returned no result.');
    if (result.error) throw new ScanProblem('unknown', result.error);
    return result;
  } catch (error) {
    if (error instanceof ScanProblem) throw error;
    throw new ScanProblem(codeFromChromeError(error.message), error.message);
  }
}

/**
 * Runs inside the web page, not in the extension. Chrome copies this
 * function's source into the page, so it must not use anything from outside
 * itself. It returns plain data only.
 */
async function runAxeInPage(options) {
  if (typeof axe === 'undefined') return { error: 'axe-core did not load on this page.' };

  // Remove our own "Show on page" outline first so it is not scanned.
  if (typeof window.__handrailCleanup === 'function') window.__handrailCleanup();
  const highlight = document.getElementById('handrail-highlight');
  if (highlight) highlight.remove();

  const trim = (text, max) => {
    const clean = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
  };
  // The address of a frame axe could not get into, so the panel can link to it.
  const frameUrl = (target) => {
    try {
      let doc = document;
      for (const part of target.slice(0, -1)) doc = doc.querySelector(part).contentDocument;
      return doc.querySelector(target[target.length - 1]).src || '';
    } catch {
      return ''; // the frame is gone or its parent is from another site
    }
  };
  const pack = (rule) => ({
    id: rule.id,
    impact: rule.impact || null,
    tags: rule.tags,
    help: rule.help,
    description: rule.description,
    helpUrl: rule.helpUrl,
    count: rule.nodes.length,
    nodes: rule.nodes.slice(0, options.maxNodes).map((node) => ({
      target: node.target,
      html: trim(node.html, options.snippetLength),
      failureSummary: node.failureSummary || '',
      impact: node.impact || null,
      ...(rule.id === 'frame-tested' ? { frameUrl: frameUrl(node.target) } : {}),
    })),
  });

  try {
    const results = await axe.run(document, {
      runOnly: { type: 'tag', values: options.tags },
      // Adds these rules on top of the tags above.
      rules: Object.fromEntries(options.extraRules.map((id) => [id, { enabled: true }])),
      // We only need details for problems. This keeps the scan faster.
      resultTypes: ['violations', 'incomplete'],
      // Give up on a frame after 5 seconds, so one slow frame
      // cannot stall the whole scan.
      frameWaitTime: 5000,
    });
    return {
      axeVersion: axe.version,
      url: location.href,
      scannedAt: new Date().toISOString(),
      violations: results.violations.map(pack),
      incomplete: results.incomplete.map(pack),
    };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}

/** Runs in every frame, right after axe is injected. */
function allowFrameOrigins() {
  if (typeof axe !== 'undefined') axe.configure({ allowedOrigins: ['<unsafe_all_origins>'] });
}

/**
 * Chrome reports blocked pages with English error strings. Turn the ones we
 * know into a code. Checked against Chrome's messages; anything we do not
 * recognize becomes "unknown" and the raw text is shown as technical details.
 */
export function codeFromChromeError(message = '') {
  const text = String(message);
  if (/Cannot access a chrome:\/\/ URL/i.test(text)) return 'chrome';
  if (/chrome-extension:\/\/ URL of different extension/i.test(text)) return 'extension';
  if (/extensions gallery cannot be scripted/i.test(text)) return 'webstore';
  if (/Cannot access contents of url "file:/i.test(text)) return 'file-access';
  if (/is showing error page/i.test(text)) return 'error-page';
  if (/No tab with id/i.test(text)) return 'no-tab';
  if (/Cannot access contents of (the page|url)|must request permission/i.test(text)) return 'no-access';
  if (/Axe is already running/i.test(text)) return 'busy';
  return 'unknown';
}

/**
 * Before scanning, rule out pages we already know we cannot scan, using the
 * address. Returns a problem code, or null if it is worth trying.
 * `fileAccessAllowed` is the result of chrome.extension.isAllowedFileSchemeAccess().
 */
export function problemForUrl(url, { fileAccessAllowed = true } = {}) {
  switch (classifyUrl(url)) {
    case 'web':
      return null;
    case 'file':
      return fileAccessAllowed ? null : 'file-access';
    case 'chrome':
      return 'chrome';
    case 'extension':
      return 'extension';
    case 'webstore':
      return 'webstore';
    case 'unknown':
      // We cannot see the address, which means Chrome has not given us
      // access to this page (or took it back after the user navigated).
      return 'no-access';
    default:
      return 'unsupported';
  }
}

/**
 * Plain-language text for each problem. `extensionName` comes from messages.json.
 * Every message says what happened and what to do next.
 */
export function explainProblem(code, extensionName = '') {
  const name = extensionName || 'this extension';
  const icon = extensionName ? `the ${extensionName} icon` : 'the extension icon';
  const messages = {
    'no-access': {
      title: `Click ${icon} on this page to scan it.`,
      detail:
        `Chrome only lets ${name} read a page after you click its icon (or press its shortcut) on that page. ` +
        'That permission ends when the tab goes to a different site.',
    },
    chrome: {
      title: 'Chrome does not let extensions scan its own pages.',
      detail:
        'Pages like Settings, New Tab, and other chrome:// pages are off limits. Open your site, or any web page, and try again.',
    },
    extension: {
      title: 'This page belongs to an extension.',
      detail: 'Chrome does not let one extension read the pages of another. Open a web page and try again.',
    },
    webstore: {
      title: 'Chrome does not let extensions run on the Chrome Web Store.',
      detail: 'Open a different page and try again.',
    },
    'file-access': {
      title: 'To scan files from your computer, turn on file access.',
      detail:
        `Go to chrome://extensions, find ${name}, select Details, and turn on "Allow access to file URLs". ` +
        `Then reload this page and click ${icon} again. ` +
        'Or serve the folder with a local server (for example, python -m http.server) and open it on localhost.',
    },
    'error-page': {
      title: 'This tab is showing an error page.',
      detail: 'The page did not load, so there is nothing to scan. Load the page, then scan again.',
    },
    'no-tab': {
      title: 'That tab is no longer open.',
      detail: `Go to the page you want to check and click ${icon}.`,
    },
    loading: {
      title: 'This page is still loading.',
      detail: 'Wait until it has finished loading, then select "Scan this page" again.',
    },
    timeout: {
      title: `The scan took longer than ${SCAN_TIMEOUT_MS / 1000} seconds, so it was stopped.`,
      detail: 'Very large or busy pages can do this. Wait until the page is idle and try again.',
    },
    busy: {
      title: 'A scan is already running on this page.',
      detail: 'Wait a few seconds and try again.',
    },
    unsupported: {
      title: 'This kind of page cannot be scanned.',
      detail: `${name} can scan web pages (http and https, including localhost) and files from your computer. Open one of those and try again.`,
    },
    unknown: {
      title: 'The scan did not work.',
      detail: `Reload the page, click ${icon}, and try again. The technical details below may help if it keeps happening.`,
    },
  };
  return messages[code] || messages.unknown;
}
