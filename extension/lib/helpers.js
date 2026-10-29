// Helpers for the guided checks: they collect evidence from the page so the
// user can check faster. They never decide that a check is fine. The user does.
//
// Two kinds:
//   collectLists(tabId)  Read-only lists (headings, links, images, ...).
//                        Runs after every scan. Changes nothing on the page.
//   focusChecks(...)     Moves keyboard focus through the page in Tab order and
//                        looks at each stop. It scrolls the page and can set off
//                        the page's own focus effects. Runs after the scan, in
//                        small steps, with a time and size limit and a Cancel.
//                        Focus and scroll position are put back afterwards.
//
// A script cannot press the real Tab key: browsers ignore made-up key presses
// for moving focus, and real ones need the "debugger" permission. So the
// walk works out the Tab order itself and calls element.focus().
// The Tab order covers the page, open shadow roots, and same-origin frames.

import { ScanProblem, codeFromChromeError } from './scan.js';

export const MAX_ITEMS = 50;
/** The most places the focus checks visit. */
export const MAX_TAB_STOPS = 500;
/** The focus checks stop after this long, and say so. */
export const FOCUS_BUDGET_MS = 20000;
/**
 * The most elements checked on screen with before and after screenshots.
 * Each takes two screenshots, and Chrome allows only 2 per second
 * (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND), so this keeps it near 5 seconds.
 */
export const MAX_PIXEL_CHECKS = 10;
const CAPTURE_GAP_MS = 520;
const STEP_SIZE = 25;
/** A colour channel that moves less than this is screenshot noise, not a change. */
const PIXEL_NOISE = 8;
/** Below this largest channel change, a focus style is too faint to see well. */
const FAINT_MAX_DIFF = 48;
/** Below this share of changed pixels, a focus style is too small to notice. */
const FAINT_SHARE = 0.005;

/** Read-only review lists. Resolves with plain data. */
export async function collectLists(tabId) {
  return runInPage(tabId, [{ mode: 'lists', max: MAX_ITEMS }]);
}

/**
 * The focus checks. `onProgress(done, total)` is called as it goes, and
 * `isCancelled()` is asked between steps. `windowId` is needed for the
 * screenshots; without it (or if Chrome refuses), the on-screen check is
 * skipped and the results say so.
 * Resolves with { stops, total, capped, stopped, unreadableSheets,
 *   noFocusConfirmed, faintFocus, maybeNoFocus, invisibleFocus,
 *   coveredBySticky, orderJumps, positiveTabindex, pixelChecked, pixelSkipped }.
 */
export async function focusChecks(tabId, { windowId = null, onProgress = () => {}, isCancelled = () => false } = {}) {
  const started = Date.now();
  const overBudget = () => Date.now() - started > FOCUS_BUDGET_MS;

  // List what can get focus. Sort into Tab order here, where it can be unit tested.
  const candidates = await runInPage(tabId, [{ mode: 'focusables' }]);
  const order = sortTabOrder(candidates);
  const capped = order.length > MAX_TAB_STOPS;
  const visit = order.slice(0, MAX_TAB_STOPS);

  let stopped = null; // 'cancelled' | 'time' | null
  let done = 0;
  let pixelSkipped = null;
  const pixel = [];
  let result;
  await runInPage(tabId, [{ mode: 'walk-start', order: visit.map((c) => c.index) }]);
  try {
    // Walk the Tab order a few stops at a time.
    onProgress(0, visit.length);
    while (done < visit.length) {
      if (isCancelled()) stopped = 'cancelled';
      else if (overBudget()) stopped = 'time';
      if (stopped) break;
      done = (await runInPage(tabId, [{ mode: 'walk-step', count: STEP_SIZE }])).done;
      onProgress(done, visit.length);
    }

    // Elements whose styles did not change get a before and after
    // screenshot, compared here in memory and then thrown away.
    const toCheck = stopped ? 0 : Math.min(MAX_PIXEL_CHECKS, (await runInPage(tabId, [{ mode: 'pixel-count' }])).count);
    for (let k = 0; k < toCheck; k++) {
      if (isCancelled()) stopped = 'cancelled';
      else if (overBudget()) stopped = 'time';
      if (stopped) break;
      try {
        pixel.push(await pixelCheck(tabId, windowId, k));
      } catch (error) {
        // Chrome said no (for example, the window is not showing this tab).
        pixelSkipped = String((error && error.message) || error);
        break;
      }
    }
  } finally {
    // Always put focus, scroll position and styles back.
    result = await runInPage(tabId, [{ mode: 'walk-end', pixel, max: MAX_ITEMS }]);
  }
  return { ...result, total: order.length, capped, stopped, pixelChecked: pixel.length, pixelSkipped };
}

let lastCapture = 0;
async function capture(windowId) {
  const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCapture = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

/** One element: screenshot without focus, then with focus, and compare its box. */
async function pixelCheck(tabId, windowId, k) {
  if (windowId === null) throw new Error('No window to take screenshots in.');
  const box = await runInPage(tabId, [{ mode: 'pixel-prep', k }]);
  if (!box.inView) return { k, level: 'skipped' };
  const before = await capture(windowId);
  await runInPage(tabId, [{ mode: 'pixel-flag', k }]);
  const after = await capture(windowId);
  const [a, b] = await Promise.all([regionPixels(before, box), regionPixels(after, box)]);
  return { k, level: focusChangeLevel(pixelChange(a, b)) };
}

/** The pixels inside `box` (CSS px, plus 4px around it) from a screenshot data URL. */
async function regionPixels(dataUrl, box) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bitmap.width / box.viewportWidth;
  const x = Math.max(0, Math.floor((box.left - 4) * scale));
  const y = Math.max(0, Math.floor((box.top - 4) * scale));
  const w = Math.max(1, Math.min(bitmap.width - x, Math.ceil((box.width + 8) * scale)));
  const h = Math.max(1, Math.min(bitmap.height - y, Math.ceil((box.height + 8) * scale)));
  const canvas = new OffscreenCanvas(w, h);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
  bitmap.close();
  return context.getImageData(0, 0, w, h).data;
}

/**
 * How much two same-size RGBA pixel arrays differ.
 * Returns { changed, total, maxDiff }: pixels where any color channel moved by
 * more than 8 (out of 255), and the biggest change seen.
 */
export function pixelChange(a, b) {
  let changed = 0;
  let maxDiff = 0;
  const total = Math.min(a.length, b.length) / 4;
  for (let i = 0; i < total * 4; i += 4) {
    const diff = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (diff > PIXEL_NOISE) changed += 1;
    if (diff > maxDiff) maxDiff = diff;
  }
  return { changed, total, maxDiff };
}

/**
 * 'none'    nothing on screen changed: an automated issue
 * 'faint'   a tiny or very low-contrast change: a possible problem
 * 'visible' a real change: not a problem
 */
export function focusChangeLevel({ changed, total, maxDiff }) {
  if (changed === 0) return 'none';
  if (maxDiff < FAINT_MAX_DIFF || changed / total < FAINT_SHARE) return 'faint';
  return 'visible';
}

/**
 * Sequential Tab order, as browsers do it: elements with a positive tabindex
 * first (lowest number first, ties in page order), then everything with
 * tabindex 0 or a natural tab stop, in page order. tabindex -1 is skipped.
 * @param {{index:number, tabIndex:number}[]} items  index = position in the page
 */
export function sortTabOrder(items) {
  const positive = items.filter((i) => i.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex || a.index - b.index);
  const natural = items.filter((i) => i.tabIndex === 0).sort((a, b) => a.index - b.index);
  return [...positive, ...natural];
}

async function runInPage(tabId, args) {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: pageHelperInPage,
      args,
    });
    const result = frame && frame.result;
    if (!result) throw new ScanProblem('unknown', 'The helper returned no result.');
    if (result.error) throw new ScanProblem('unknown', result.error);
    return result.data;
  } catch (error) {
    if (error instanceof ScanProblem) throw error;
    throw new ScanProblem(codeFromChromeError(error.message), error.message);
  }
}

/**
 * Runs inside the web page. Chrome copies this function's source into the
 * page, so everything it uses must be defined inside it. State between calls
 * (the focus walk) is kept in window.__handrailWalk, which lives in the
 * extension's private copy of `window`, not the page's.
 */
async function pageHelperInPage(options) {
  const SNIPPET = 200;
  const FOCUSABLE =
    'a[href], area[href], button, input:not([type="hidden"]), select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]';
  const NATIVE_INTERACTIVE =
    'a[href], area[href], button, input, select, textarea, summary, label, option, iframe, audio[controls], video[controls]';
  const WIDGET_ROLES = [
    'button',
    'checkbox',
    'combobox',
    'dialog',
    'grid',
    'link',
    'listbox',
    'menu',
    'menubar',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'scrollbar',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'tablist',
    'tabpanel',
    'textbox',
    'tree',
    'treeitem',
  ];
  // Roles that must be reachable with Tab on their own. Items inside lists,
  // menus and tab lists (option, menuitem, tab) often move focus with arrow
  // keys instead, so they are left out to avoid false alarms.
  const STANDALONE_ROLES = [
    'button',
    'link',
    'checkbox',
    'switch',
    'slider',
    'spinbutton',
    'textbox',
    'searchbox',
    'combobox',
  ];
  const GENERIC_LINKS = [
    'click here',
    'here',
    'read more',
    'more',
    'learn more',
    'click',
    'link',
    'this link',
    'details',
    'more info',
  ];
  const VAGUE_ALT = ['image', 'img', 'photo', 'picture', 'pic', 'graphic', 'icon', 'banner', 'placeholder', 'untitled'];
  const ATTR = 'data-handrail-focus';
  const FLAG = `[${ATTR}]`;

  const viewOf = (el) => el.ownerDocument.defaultView;
  // Where an element's document starts on screen (frames add up).
  function frameOffset(el) {
    let x = 0;
    let y = 0;
    for (let win = viewOf(el); win && win.frameElement; win = win.frameElement.ownerDocument.defaultView) {
      const frame = win.frameElement;
      const r = frame.getBoundingClientRect();
      const s = viewOf(frame).getComputedStyle(frame);
      x += r.left + frame.clientLeft + parseFloat(s.paddingLeft);
      y += r.top + frame.clientTop + parseFloat(s.paddingTop);
    }
    return { x, y };
  }
  function screenRect(el) {
    const r = el.getBoundingClientRect();
    const o = frameOffset(el);
    return {
      left: r.left + o.x,
      top: r.top + o.y,
      right: r.right + o.x,
      bottom: r.bottom + o.y,
      width: r.width,
      height: r.height,
    };
  }
  // Every element in Tab-order terms: the page, then inside open shadow
  // roots and same-origin frames at the place they appear. Also collects
  // those roots, so focus styles can be copied into each one.
  function composed(roots) {
    const out = [];
    const visit = (root) => {
      // Documents (9) and shadow roots (11) hold style sheets; elements do not.
      if (root.nodeType !== 1) roots.add(root);
      for (const child of root.children) {
        out.push(child);
        if (child.shadowRoot) visit(child.shadowRoot);
        if (child.localName === 'iframe' || child.localName === 'frame') {
          let inner = null;
          try {
            inner = child.contentDocument;
          } catch {
            inner = null; // frames from other sites throw instead of returning null
          }
          if (inner && inner.documentElement) visit(inner);
        }
        visit(child);
      }
    };
    visit(document);
    return out;
  }
  function canFocus(el) {
    return (
      el.matches(FOCUSABLE) &&
      el.tabIndex >= 0 &&
      !el.disabled &&
      !el.closest('[inert]') &&
      (!el.checkVisibility || el.checkVisibility({ checkVisibilityCSS: true }))
    );
  }
  // Same rule as sortTabOrder() outside the page.
  function tabOrder(elements) {
    const found = elements.filter(canFocus).map((el, index) => ({ el, index, tabIndex: el.tabIndex }));
    const positive = found.filter((i) => i.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex || a.index - b.index);
    return [...positive, ...found.filter((i) => i.tabIndex === 0)].map((i) => i.el);
  }

  // A CSS selector for an element, short enough to read.
  function selectorFor(el) {
    const doc = el.getRootNode();
    const unique = (id) => doc.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
    if (el.id && unique(el.id)) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== el.ownerDocument.documentElement) {
      if (node.id && unique(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === node.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }
  // axe-style path: frames as steps, shadow roots as a list inside a step.
  function targetFor(el) {
    const steps = [];
    let current = el;
    let step = [];
    while (current) {
      step.unshift(selectorFor(current));
      const root = current.getRootNode();
      if (root instanceof ShadowRoot) {
        current = root.host;
        continue;
      }
      steps.unshift(step.length > 1 ? step : step[0]);
      step = [];
      current = viewOf(current).frameElement;
    }
    return steps;
  }
  function snippet(el) {
    const html = el.outerHTML.replace(/\s+/g, ' ').trim();
    return html.length > SNIPPET ? html.slice(0, SNIPPET - 1) + '…' : html;
  }
  function item(el, note) {
    return { target: targetFor(el), html: snippet(el), failureSummary: note };
  }
  function visible(el) {
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function textOf(el) {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return label.trim();
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
    const img = el.querySelector('img[alt]');
    return img ? img.getAttribute('alt').trim() : '';
  }
  // Keep at most `max` items, but report the real count.
  function capped(list) {
    return { count: list.length, items: list.slice(0, options.max) };
  }
  // Groups of elements that share a key but point at different things.
  function sameKeyDifferentValue(elements, keyOf, valueOf) {
    const groups = new Map();
    for (const el of elements) {
      const key = keyOf(el);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    }
    return [...groups.values()].filter((list) => new Set(list.map(valueOf)).size > 1).flat();
  }

  try {
    if (options.mode === 'lists') {
      const roots = new Set();
      const all = composed(roots);
      const inAll = (selector) => all.filter((el) => el.matches(selector));

      // Things that look clickable but cannot be reached with Tab.
      // Only the outermost one is reported (cursor: pointer is inherited).
      const reachable = (el) => el.tabIndex >= 0 || el.closest('[tabindex]:not([tabindex="-1"])');
      const clickables = all.filter((el) => {
        if (el.matches(NATIVE_INTERACTIVE) || el.closest(NATIVE_INTERACTIVE)) return false;
        if (reachable(el)) return false;
        // tabindex="-1" means the page moves focus here itself (like the
        // inactive tabs in a tab list), so it is not flagged.
        if (el.hasAttribute('tabindex')) return false;
        if (!visible(el)) return false;
        const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
        if (STANDALONE_ROLES.includes(role)) return true;
        const style = viewOf(el).getComputedStyle(el);
        if (!el.hasAttribute('onclick') && style.cursor !== 'pointer') return false;
        const parent = el.parentElement;
        const parentPointer = parent && viewOf(parent).getComputedStyle(parent).cursor === 'pointer';
        return el.hasAttribute('onclick') || !parentPointer;
      });

      const headings = inAll('h1, h2, h3, h4, h5, h6, [role="heading"]')
        .filter(visible)
        .map((el) => ({
          level: Number(el.getAttribute('aria-level')) || Number(el.localName.slice(1)) || 2,
          text: textOf(el).slice(0, 120),
          target: targetFor(el),
        }));

      const links = inAll('a[href]').filter(visible);
      const linkText = (a) =>
        textOf(a)
          .toLowerCase()
          .replace(/[.!:…]+$/, '');
      const genericLinks = links.filter((a) => GENERIC_LINKS.includes(linkText(a)));
      // Same words, different places: "Edit" twice, going to two pages.
      const duplicateLinks = sameKeyDifferentValue(links, linkText, (a) => a.href.split('#')[0]);

      const images = inAll('img[alt]').filter((img) => img.getAttribute('alt').trim() !== '');
      const altOf = (img) => img.getAttribute('alt').trim();
      const oddAlts = images.filter((img) => {
        const alt = altOf(img);
        return (
          /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(alt) ||
          /^(img|dsc|image|photo|pic|screenshot)[-_ ]?\d+$/i.test(alt) ||
          /^(image|picture|photo) of\b/i.test(alt) ||
          VAGUE_ALT.includes(alt.toLowerCase()) ||
          alt.length > 150
        );
      });
      const sameAlts = sameKeyDifferentValue(
        images,
        (img) => altOf(img).toLowerCase(),
        (img) => img.currentSrc || img.src,
      );

      const liveRegions = inAll(
        '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], output',
      );

      const placeholderOnly = inAll('input[placeholder], textarea[placeholder]').filter(
        (el) =>
          visible(el) &&
          (!el.labels || el.labels.length === 0) &&
          !el.getAttribute('aria-label') &&
          !el.getAttribute('aria-labelledby') &&
          !el.getAttribute('title'),
      );

      const roles = all.filter(
        (el) => el.hasAttribute('role') && WIDGET_ROLES.includes(el.getAttribute('role').trim().split(/\s+/)[0]),
      );

      // A way past repeated content: a same-page link among the first three
      // Tab stops whose target exists, or a main landmark.
      const firstStops = tabOrder(all).slice(0, 3);
      const skipLink = firstStops.find((el) => {
        const href = el.getAttribute('href') || '';
        if (!href.startsWith('#') || href.length < 2) return false;
        const id = decodeURIComponent(href.slice(1));
        return Boolean(el.ownerDocument.getElementById(id) || el.ownerDocument.getElementsByName(id).length);
      });
      const hasMain = all.some((el) => el.matches('main, [role="main"]'));

      return {
        data: {
          clickables: capped(
            clickables.map((el) => item(el, 'Looks clickable, but you cannot reach it with the Tab key.')),
          ),
          headings: { count: headings.length, items: headings.slice(0, 200) },
          links: {
            total: links.length,
            ...capped(genericLinks.map((a) => item(a, `Link text "${textOf(a)}" does not say where it goes.`))),
          },
          duplicateLinks: capped(
            duplicateLinks.map((a) => item(a, `Other links with the text "${textOf(a)}" go somewhere else.`)),
          ),
          images: {
            total: images.length,
            ...capped(
              oddAlts.map((img) => item(img, `Alt text "${altOf(img).slice(0, 80)}" may not describe the image.`)),
            ),
          },
          sameAlts: capped(
            sameAlts.map((img) =>
              item(img, `Other images with different pictures also have the alt text "${altOf(img).slice(0, 80)}".`),
            ),
          ),
          liveRegions: capped(
            liveRegions.map((el) => item(el, 'Screen readers read out changes inside this element.')),
          ),
          placeholders: capped(
            placeholderOnly.map((el) =>
              item(
                el,
                `Only the placeholder "${el.getAttribute('placeholder')}" names this field. It disappears when people type.`,
              ),
            ),
          ),
          roles: capped(
            roles.map((el) =>
              item(
                el,
                `Custom "${el.getAttribute('role')}". Check with a screen reader that it says its name, role, and state.`,
              ),
            ),
          ),
          skip: { skipLink: Boolean(skipLink), hasMain },
        },
      };
    }

    if (options.mode === 'focusables') {
      const roots = new Set();
      const found = composed(roots).filter(canFocus);
      window.__handrailWalk = { found, roots: [...roots] };
      return { data: found.map((el, index) => ({ index, tabIndex: el.tabIndex })) };
    }

    const walk = window.__handrailWalk;
    if (!walk) return { error: 'The focus check lost its place. Scan again.' };

    // How an element looks, in the styles that usually show focus: the
    // element, its ::before and ::after, and its parent.
    const look = (el) => {
      if (!el) return '';
      const parts = [];
      for (const pseudo of [null, '::before', '::after']) {
        const s = viewOf(el).getComputedStyle(el, pseudo);
        const outline =
          s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0
            ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} ${s.outlineOffset}`
            : 'none';
        parts.push(
          outline,
          s.boxShadow,
          s.borderColor,
          s.borderWidth,
          s.borderStyle,
          s.backgroundColor,
          s.backgroundImage,
          s.color,
          s.textDecorationLine,
          s.textDecorationColor,
          s.transform,
          s.opacity,
        );
      }
      return parts.join('|');
    };
    const lookAround = (el) => `${look(el)}#${look(el.parentElement)}`;

    if (options.mode === 'walk-start') {
      walk.order = options.order.map((index) => walk.found[index]);
      walk.position = 0;
      const root = document.documentElement;
      walk.before = {
        active: document.activeElement,
        x: window.scrollX,
        y: window.scrollY,
        behavior: root.style.scrollBehavior,
        hadStyle: root.hasAttribute('style'),
      };
      // Smooth scrolling would make positions wrong mid-walk. Turn it off for now.
      root.style.scrollBehavior = 'auto';
      Object.assign(walk, {
        noVisibleFocus: [],
        candidates: [],
        invisibleFocus: [],
        coveredBySticky: [],
        orderJumps: [],
        positiveTabindex: [],
        lastVisible: null,
        previous: null,
        unreadableSheets: 0,
        styles: [],
        focusVisibleSupported: null,
      });

      // While the user is in the side panel, the page does not have focus, and
      // Chrome then does not apply :focus styles at all (tested; window.focus()
      // does not change that). So we copy the page's own :focus rules onto a
      // temporary attribute and set that attribute on each element instead.
      // Each document and open shadow root gets its own copy.
      const toFlag = (selector) =>
        selector
          .replace(/:focus-within/g, `:is(:has(${FLAG}), ${FLAG})`)
          .replace(/:focus-visible/g, FLAG)
          .replace(/:focus(?![-\w])/g, FLAG);
      for (const scope of walk.roots) {
        const copies = [];
        const visitRules = (rules, wrap) => {
          for (const rule of rules) {
            if (rule instanceof CSSStyleRule) {
              if (rule.selectorText.includes(':focus'))
                copies.push(wrap(`${toFlag(rule.selectorText)} { ${rule.style.cssText} }`));
            } else if (rule.cssRules && rule.cssText.startsWith('@')) {
              // @media, @supports, @layer, @container: keep the same wrapper.
              const prelude = rule.cssText.slice(0, rule.cssText.indexOf('{'));
              visitRules(rule.cssRules, (text) => wrap(`${prelude}{ ${text} }`));
            }
          }
        };
        for (const sheet of [...scope.styleSheets, ...(scope.adoptedStyleSheets || [])]) {
          let rules;
          try {
            rules = sheet.cssRules;
          } catch {
            walk.unreadableSheets += 1; // style sheets from other sites cannot be read
            continue;
          }
          visitRules(rules, (text) => text);
        }
        const doc = scope.ownerDocument || scope;
        const host = scope instanceof ShadowRoot ? scope : doc.head || doc.documentElement;
        // Chrome's own focus ring, in the lowest layer, so any page rule that
        // changes the outline wins, as it does with the real ring.
        const ring = doc.createElement('style');
        ring.textContent = `@layer handrail-ring { ${FLAG} { outline: auto 1px -webkit-focus-ring-color; } }`;
        host.prepend(ring);
        const copy = doc.createElement('style');
        copy.textContent = copies.join('\n');
        host.append(copy);
        walk.styles.push(ring, copy);
      }
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return { data: { total: walk.order.length } };
    }

    if (options.mode === 'walk-step') {
      const end = Math.min(walk.order.length, walk.position + options.count);
      const ltr = getComputedStyle(document.documentElement).direction !== 'rtl';
      for (; walk.position < end; walk.position++) {
        const el = walk.order[walk.position];
        if (!el || !el.isConnected) continue;
        if (walk.previous) walk.previous.removeAttribute(ATTR);
        const lookBefore = lookAround(el);
        el.setAttribute(ATTR, '');
        walk.previous = el;
        if (el.tabIndex > 0)
          walk.positiveTabindex.push(
            item(el, `tabindex="${el.getAttribute('tabindex')}" moves this to the front of the Tab order.`),
          );
        // The real focus too: it scrolls the element into view like Tab does.
        el.focus({ focusVisible: true });
        if (el.getRootNode().activeElement !== el && el.ownerDocument.activeElement !== el) continue;
        if (walk.focusVisibleSupported === null) walk.focusVisibleSupported = el.matches(':focus-visible');
        const rect = screenRect(el);

        if (
          rect.width < 1 ||
          rect.height < 1 ||
          rect.right <= 0 ||
          rect.bottom <= 0 ||
          rect.left >= innerWidth ||
          rect.top >= innerHeight
        ) {
          walk.invisibleFocus.push(item(el, 'This gets keyboard focus but cannot be seen.'));
          continue;
        }

        const animating =
          el.getAnimations().length > 0 || (el.parentElement && el.parentElement.getAnimations().length > 0);
        if (!animating && lookAround(el) === lookBefore) {
          walk.noVisibleFocus.push(item(el, 'Nothing about this element looked different when it had focus.'));
          walk.candidates.push(el);
        }

        // Is every visible part of it under a fixed or sticky bar? Checked in
        // its own document, where elementFromPoint works.
        const local = el.getBoundingClientRect();
        const view = viewOf(el);
        const points = [
          [local.left + local.width / 2, local.top + local.height / 2],
          [local.left + 2, local.top + 2],
          [local.right - 2, local.top + 2],
          [local.left + 2, local.bottom - 2],
          [local.right - 2, local.bottom - 2],
        ].filter(([x, y]) => x >= 0 && y >= 0 && x < view.innerWidth && y < view.innerHeight);
        let coveredBy = null;
        const stickyAncestor = (n) => {
          for (; n && n !== n.ownerDocument.body; n = n.parentElement) {
            const pos = viewOf(n).getComputedStyle(n).position;
            if (pos === 'fixed' || pos === 'sticky') return n;
          }
          return null;
        };
        const allCovered =
          points.length > 0 &&
          points.every(([x, y]) => {
            const hit = el.ownerDocument.elementFromPoint(x, y);
            if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return false;
            const bar = stickyAncestor(hit);
            if (bar && !bar.contains(el)) coveredBy = bar;
            return Boolean(bar && !bar.contains(el));
          });
        if (allCovered && coveredBy) {
          walk.coveredBySticky.push(
            item(el, `Hidden behind a fixed or sticky element (${selectorFor(coveredBy)}) when it has focus.`),
          );
        }

        // Big jumps in the Tab order: more than a screen back up the page, or
        // backwards along the same row on a left-to-right page.
        const pageY = rect.top + window.scrollY;
        const last = walk.lastVisible;
        if (last && pageY < last.bottom - innerHeight) {
          walk.orderJumps.push(item(el, `Focus jumps back up the page to here, from ${last.selector}.`));
        } else if (last && ltr && pageY < last.bottom && pageY + rect.height > last.top && rect.right <= last.left) {
          walk.orderJumps.push(item(el, `Focus moves backwards along the row to here, from ${last.selector}.`));
        }
        walk.lastVisible = { top: pageY, bottom: pageY + rect.height, left: rect.left, selector: selectorFor(el) };
      }
      return { data: { done: walk.position } };
    }

    if (options.mode === 'pixel-count') return { data: { count: walk.candidates.length } };

    if (options.mode === 'pixel-prep' || options.mode === 'pixel-flag') {
      const el = walk.candidates[options.k];
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (options.mode === 'pixel-prep') {
        for (const other of walk.order) if (other) other.removeAttribute(ATTR);
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        await nextFrame();
        const r = screenRect(el);
        const inView =
          r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        return {
          data: { inView, left: r.left, top: r.top, width: r.width, height: r.height, viewportWidth: innerWidth },
        };
      }
      el.setAttribute(ATTR, '');
      el.focus({ focusVisible: true, preventScroll: true });
      // Let focus transitions finish (up to half a second) before the screenshot.
      const animations = [...el.getAnimations(), ...(el.parentElement ? el.parentElement.getAnimations() : [])];
      await Promise.race([
        Promise.all(animations.map((a) => a.finished.catch(() => {}) /* cancelled animations reject; that is fine */)),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      await nextFrame();
      return { data: {} };
    }

    if (options.mode === 'walk-end') {
      // Sort "no visible change" by what the screenshots showed.
      const noFocusConfirmed = [];
      const faintFocus = [];
      const maybeNoFocus = [];
      walk.noVisibleFocus.forEach((found, k) => {
        const level = (options.pixel.find((p) => p.k === k) || {}).level;
        if (level === 'none')
          noFocusConfirmed.push({ ...found, failureSummary: 'Nothing changed on screen when this had focus.' });
        else if (level === 'faint')
          faintFocus.push({
            ...found,
            failureSummary: 'Only a very small or faint change showed on screen when this had focus.',
          });
        else if (level !== 'visible') maybeNoFocus.push(found);
      });

      // Put things back the way they were.
      for (const el of walk.order) if (el) el.removeAttribute(ATTR);
      for (const style of walk.styles) style.remove();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      const before = walk.before;
      if (before) {
        if (before.active && before.active !== document.body && before.active.focus)
          before.active.focus({ preventScroll: true });
        window.scrollTo(before.x, before.y);
        const root = document.documentElement;
        root.style.scrollBehavior = before.behavior;
        if (!before.hadStyle && root.getAttribute('style') === '') root.removeAttribute('style');
      }
      window.__handrailWalk = null;

      return {
        data: {
          stops: walk.position || 0,
          unreadableSheets: walk.unreadableSheets,
          focusVisibleSupported: walk.focusVisibleSupported,
          noFocusConfirmed: capped(noFocusConfirmed),
          faintFocus: capped(faintFocus),
          maybeNoFocus: capped(maybeNoFocus),
          invisibleFocus: capped(walk.invisibleFocus || []),
          coveredBySticky: capped(walk.coveredBySticky || []),
          orderJumps: capped(walk.orderJumps || []),
          positiveTabindex: capped(walk.positiveTabindex || []),
        },
      };
    }
    return { error: `Unknown helper mode: ${options.mode}` };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}
