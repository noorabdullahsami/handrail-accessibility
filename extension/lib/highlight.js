// "Show on page": scroll to an element and draw an outline around it.
//
// The outline is an overlay laid over the page, inside a closed shadow root,
// so the page's own styles cannot reach it and we never restyle the element.
// Only one overlay exists at a time, and removing it leaves nothing behind.
//
// axe gives each element's location as a path:
//   ['button']                      in the page
//   [['shadow-card', 'img']]        through an open shadow root
//   ['iframe', 'button']            inside a frame
// Same-origin frames (including about:blank and srcdoc) are reached from the
// top page. Frames with another origin, and closed shadow roots, cannot be
// reached, and the result says so.

const HOST_ID = 'handrail-highlight';

/**
 * Returns { ok: true, matches, changed } or { ok: false, reason } where
 * reason is 'not-found' | 'hidden' | 'closed-shadow' | 'frame'. `label` is the
 * short number drawn next to the outline. `html` is the element's snippet
 * from the scan: if the element found now starts differently, `changed` is
 * true, because axe's selectors are often positional (":nth-child(12)") and
 * can point at a different element after the page changes.
 * Throws Chrome's error if we lost access.
 */
export async function showOnPage(tabId, target, label = '', html = '') {
  const openingTag = (/^<[^>]*>?/.exec(html) || [''])[0].replace(/…$/, '');
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: highlightInPage,
    args: [target, HOST_ID, String(label), openingTag],
  });
  return (frame && frame.result) || { ok: false, reason: 'not-found' };
}

export async function clearHighlight(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: removeHighlightInPage,
    args: [HOST_ID],
  });
}

// These two run inside the web page. They must be self-contained.

function highlightInPage(target, hostId, label, openingTag) {
  // Remove any earlier overlay and its listeners first.
  if (typeof window.__handrailCleanup === 'function') window.__handrailCleanup();
  const old = document.getElementById(hostId);
  if (old) old.remove();

  // Follow axe's path. Each step is one document (the page, then each frame);
  // a step that is a list goes through shadow roots inside that document.
  let doc = document;
  const frames = [];
  let element = null;
  let matches = 0;
  for (let i = 0; i < target.length; i++) {
    const path = Array.isArray(target[i]) ? target[i] : [target[i]];
    let root = doc;
    for (let j = 0; j < path.length; j++) {
      let found;
      try {
        found = root.querySelectorAll(path[j]);
      } catch {
        return { ok: false, reason: 'not-found' };
      }
      if (found.length === 0) return { ok: false, reason: 'not-found' };
      element = found[0];
      matches = found.length;
      if (j < path.length - 1) {
        // A closed shadow root reads as null, so we cannot look inside it.
        if (!element.shadowRoot) return { ok: false, reason: 'closed-shadow' };
        root = element.shadowRoot;
      }
    }
    if (i < target.length - 1) {
      let inner = null;
      try {
        inner = element.contentDocument;
      } catch {
        inner = null;
      }
      // Frames with another origin (or an opaque one) give us no document.
      if (!inner) return { ok: false, reason: 'frame' };
      frames.push(element);
      doc = inner;
    }
  }

  // Same check as the scan's snippet: whitespace collapsed, opening tag only.
  const now = element.outerHTML.replace(/\s+/g, ' ').trim();
  const changed = Boolean(openingTag) && !now.startsWith(openingTag);

  const rect = element.getBoundingClientRect();
  const invisible = element.checkVisibility && !element.checkVisibility({ checkVisibilityCSS: true });
  if (invisible || rect.width === 0 || rect.height === 0) return { ok: false, reason: 'hidden', matches };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // This also scrolls any scrollable boxes and frames around the element.
  element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });

  const host = document.createElement('div');
  host.id = hostId;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  // Brand rings: pale lime inside, deep green outside, so it shows on any page.
  const box = document.createElement('div');
  box.style.cssText =
    'position: fixed; box-sizing: border-box; pointer-events: none; border: 3px solid #e0ffc2; outline: 3px solid #064734;';
  const tag = document.createElement('div');
  tag.textContent = label;
  tag.hidden = !label;
  tag.style.cssText =
    'position: fixed; pointer-events: none; background: #064734; color: #e0ffc2; border-radius: 3px; padding: 2px 6px; font: 700 13px/1.2 system-ui, sans-serif; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);';
  shadow.append(box, tag);

  const place = () => {
    // Elements in frames: add up where each frame's content starts.
    let x = 0;
    let y = 0;
    for (const frame of frames) {
      const r = frame.getBoundingClientRect();
      const style = frame.ownerDocument.defaultView.getComputedStyle(frame);
      x += r.left + frame.clientLeft + parseFloat(style.paddingLeft);
      y += r.top + frame.clientTop + parseFloat(style.paddingTop);
    }
    const r = element.getBoundingClientRect();
    box.style.left = `${x + r.left - 4}px`;
    box.style.top = `${y + r.top - 4}px`;
    box.style.width = `${r.width + 8}px`;
    box.style.height = `${r.height + 8}px`;
    tag.style.left = `${Math.max(0, x + r.left - 7)}px`;
    tag.style.top = `${Math.max(0, y + r.top - 32)}px`;
  };
  place();
  document.documentElement.appendChild(host);

  // Keep the overlay on the element while the page or a frame scrolls.
  const windows = [window, ...frames.map((frame) => frame.contentWindow)];
  for (const win of windows) win.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place, { passive: true });
  window.__handrailCleanup = () => {
    for (const win of windows) {
      try {
        win.removeEventListener('scroll', place, { capture: true });
      } catch {
        // The frame is gone. Its listeners went with it.
      }
    }
    window.removeEventListener('resize', place);
    window.__handrailCleanup = null;
  };

  return { ok: true, matches, changed };
}

function removeHighlightInPage(hostId) {
  if (typeof window.__handrailCleanup === 'function') window.__handrailCleanup();
  const host = document.getElementById(hostId);
  if (host) host.remove();
}
