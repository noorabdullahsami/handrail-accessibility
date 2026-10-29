// Helpers for working with page addresses (URLs).
// Pure functions with no Chrome APIs, so they can be unit tested in Node.

/**
 * The key we save progress under: origin + pathname.
 * The query string (?a=b) and hash (#section) are ignored on purpose, so
 * "page.html?utm=x" and "page.html#top" share the same saved progress.
 * Returns null for pages we cannot scan, because there is nothing to save.
 */
export function pageKey(url) {
  const parsed = safeParse(url);
  if (!parsed) return null;
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return parsed.origin + parsed.pathname;
  }
  if (parsed.protocol === 'file:') {
    // file: URLs have origin "null", so build the key by hand.
    return 'file://' + parsed.pathname;
  }
  return null;
}

/**
 * A short, readable label for a page, for the panel header and the report.
 * "https://example.com/about/?q=1#top" becomes "example.com/about/".
 * Query strings and hashes are always dropped: they can hold tokens and
 * personal data. Files show only the file name, because the folder path can
 * show the user's name (C:/Users/<name>/...) to anyone who sees a report.
 */
export function pageLabel(url) {
  const parsed = safeParse(url);
  if (!parsed) return '';
  if (parsed.protocol === 'file:') return readable(parsed.pathname.split('/').pop()) || 'Local file';
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    // URL paths come percent-encoded; show the words the user typed.
    return parsed.host + readable(parsed.pathname);
  }
  return parsed.protocol + '//' + parsed.host + readable(parsed.pathname);
}

/**
 * Sort a page address into the kinds of page we treat differently.
 *   web       normal http or https page (including localhost)
 *   file      a file opened from the computer (file://)
 *   chrome    Chrome's own pages (chrome://, the New Tab page, and similar)
 *   extension a page that belongs to an extension
 *   webstore  the Chrome Web Store, which Chrome never lets extensions touch
 *   other     anything else we cannot scan (about:, data:, view-source:, ...)
 *   unknown   we were not allowed to see the address
 */
export function classifyUrl(url) {
  if (!url) return 'unknown';
  const parsed = safeParse(url);
  if (!parsed) return 'other';

  switch (parsed.protocol) {
    case 'http:':
    case 'https:':
      if (isWebStore(parsed)) return 'webstore';
      return 'web';
    case 'file:':
      return 'file';
    case 'chrome:':
    case 'chrome-untrusted:':
    case 'chrome-search:':
    case 'devtools:':
    case 'edge:':
    case 'brave:':
      return 'chrome';
    case 'chrome-extension:':
      return 'extension';
    default:
      return 'other';
  }
}

function isWebStore(parsed) {
  if (parsed.hostname === 'chromewebstore.google.com') return true;
  return parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore');
}

/** Decode %E3%82%B3 and the like for display; leave a malformed path as it is. */
export function readable(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function safeParse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
