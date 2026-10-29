# Manual testing checklist

Run this before each release. It covers what the automated tests cannot: real screen readers, the real toolbar icon click, and your own judgment.

Write the date, Chrome version, OS, and screen reader version at the top of your notes. Mark each step **OK** or write down what went wrong.

## Setup

1. Load the `extension/` folder unpacked (see README). Pin it to the toolbar.
2. In a terminal, from the repository folder: `python3 -m http.server 8000 --directory test/fixtures` (on Windows: `python -m http.server 8000 --directory test/fixtures`).
3. Open `http://localhost:8000/broken.html`.

## 1. First click, with the mouse

The automated test uses the keyboard shortcut. This is the only place the mouse click on the icon is tested.

1. On `broken.html`, click the Handrail icon. The side panel opens. **Expected:** "Page: Broken test page", with "localhost:8000/broken.html" under it, and no error. The summary says "Not scanned yet", and **Copy report** says "Scan this page first".
2. Select **Scan this page**. **Expected:** "0 of 8 core checks look good". Counts match the comment at the top of `broken.html`:
   - Text contrast: Issues found (3), Needs review (1)
   - Image descriptions: Issues found (3)
   - Form labels: Issues found (2)
   - Link names: Issues found (2)
   - Button names: Issues found (3)
   - Page language: Issues found (1)
   - "1 frame on this page could not be scanned", listing `127.0.0.1:8000/frame-other.html` with a link to open it on its own
   - In the Image descriptions issue, one element reads "An image inside the shadow-card component". Its **Copy selector** button copies `shadow-card >>> img`.
   - The guided check "Buttons and links are big enough to tap" shows "Scan: Issues found (4)".

## 2. Keyboard only

Put the mouse away for this whole section.

1. On `broken.html`, press **Alt+Shift+K**. **Expected:** the panel opens (or stays open) for this page.
2. Press **F6** (or Shift+F6) until focus is in the side panel. Note how many presses it took.
3. Tab to **Scan this page** and press Enter. **Expected:** focus moves to the "Summary" heading after the scan.
4. Tab through the whole panel. **Expected:** every control can be reached, the focus outline is always visible, and the order follows the page from top to bottom.
5. Open an item in "Fix these next" with Enter. Tab to **Show on page**, press Enter. **Expected:** the element is outlined on the page with a dark and light ring and a number. **Remove highlight** appears near the top. Press it. **Expected:** the outline is gone.
   - Press **Next** in the same row. **Expected:** the next element in the group is outlined, and focus is on that row's **Next**. Keep pressing Enter to step through. **Previous** goes back.
   - Show an element, then press Escape. **Expected:** the outline is gone.
   - In the Image descriptions issue, show "Image with no description, inside the shadow-card component", and in Button names, the button "inside a frame on this page". **Expected:** both are outlined in the right place.
   - In the Summary, press **Show issues** on Image descriptions. **Expected:** that issue opens and focus moves to it.
6. Open a guided check. Use the arrow keys in "Your result for this check". **Expected:** the status in the item title and the Core 8 summary update.
7. Use **Show all other issues** and **Best practices**. **Expected:** both open and close with Enter or Space.
8. Use **Clear this page's data**. **Expected:** focus moves to the confirmation box. **Cancel** works.

## 3. Screen reader

Use NVDA with Chrome on Windows, or VoiceOver with Chrome on Mac. (VoiceOver on iPhone does not apply: Chrome on iPhone has no extensions.)

1. Move to the panel and read it from the top. **Expected:** one heading level 1 (the name), then level 2 sections in order: Summary, Fix these next, Other issues, Needs a human check, Best practices, Report and saved data.
2. Scan. **Expected:** you hear "Scanning the page..." and then "Scan complete: X of 8 core checks look good" without moving focus.
3. List headings (NVDA: Insert+F7; VoiceOver: VO+U). **Expected:** each issue title is a level 3 heading.
4. Open an item. **Expected:** it is announced as expanded. The status ("Issues found (3)") is read as words.
5. On a guided check, the radio group is announced as "Your result for this check".
6. **Show on page** is announced with which element it is, for example "Show on page: button 2 of 3". After pressing it, the screen reader says "Highlighted on page:" and the element's description.
7. Select **Copy report**. **Expected:** "Report copied as Markdown."
8. Go to another site in the same tab, then select **Scan this page**. **Expected:** the message "Click the extension icon on this page to scan it." is read out.

## 4. Text size and narrow width

1. Make the side panel as narrow as Chrome allows (drag its edge). **Expected:** no sideways scrolling. Nothing cut off.
2. Go to `chrome://settings/appearance` and set **Font size** to **Very large**, or zoom the panel to 200% (click inside the panel and press Ctrl and + several times). **Expected:** everything still fits and can be read, no sideways scrolling.

## 5. Light and dark mode

1. Switch your OS to light mode. Scan `broken.html`. Check the text is easy to read and status badges are clear.
2. Switch your OS to dark mode. Repeat. Every status still has a word, not only a color.

## 6. Localhost and a normal site

1. Run any local dev server you use (for example Vite on `http://localhost:5173`). Click the icon and scan. **Expected:** works on the first click.
2. Go to a normal https site, for example `https://www.w3.org/WAI/`. Click the icon and scan. **Expected:** results, no errors.

## 7. file:// pages

1. Open `test/fixtures/good.html` directly from disk (drag it into Chrome). Click the icon and scan.
   **Expected (file access off, the default):** "To scan files from your computer, turn on file access." with the steps.
2. Turn on **Allow access to file URLs** for Handrail at `chrome://extensions`. Reload the page, click the icon, and scan. **Expected:** "6 of 8 core checks look good".

## 8. Pages that cannot be scanned

For each, click the icon, then select **Scan this page**. The message must be specific, never a generic error and never silent.

| Page                                                                                  | Expected title                                              |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `chrome://settings`                                                                   | Chrome does not let extensions scan its own pages.          |
| The New Tab page                                                                      | Chrome does not let extensions scan its own pages.          |
| `chrome://extensions`                                                                 | Chrome does not let extensions scan its own pages.          |
| Another extension's page (for example its options page)                               | This page belongs to an extension.                          |
| `https://chromewebstore.google.com/`                                                  | Chrome does not let extensions run on the Chrome Web Store. |
| `about:blank`                                                                         | This kind of page cannot be scanned.                        |
| A site that does not exist, for example `http://localhost:9999/` with nothing running | This tab is showing an error page.                          |

## 9. Access lost after navigating

1. Click the icon on `http://localhost:8000/good.html` and scan.
2. In the same tab, go to `http://localhost:8000/broken.html` (same site). Scan. **Expected:** it works.
3. In the same tab, go to `http://127.0.0.1:8000/good.html` (a different site). **Expected:** the panel shows "Click the extension icon on this page to scan it." Selecting **Scan this page** shows the same message.
4. Click the icon. **Expected:** the message goes away and scanning works.

## 10. What the scan checks inside the guided checks

Use `http://localhost:8000/keyboard.html`. The expected counts are in the comment at the top of that file.

1. Scan. **Expected:** after the axe scan, a line "Checking focus: N of M" and a **Cancel** button appear under the Scan button while the page scrolls. Then the page goes back to where it was, and you hear "Focus checks done. Core checks: X of 8 look good."
2. In the Summary, **Expected:** Keyboard access "Issues found (1)" and Visible focus "Issues found (2)". Neither is ever marked "Looks good" by the tool.
3. Open "Everything works with just a keyboard". **Expected:** "What the scan checked: ...", "Scan: Issues found (1)" (the tabindex="5" link) and "Scan: Possible problems (2)" (the card and the Menu item), and the line "A script cannot press the Tab key for real...".
4. Open "You can always see where the keyboard focus is". **Expected:** the Save button (no change on screen) and the hidden link. The skip link is not flagged.
5. Open a check with nothing found, like "Color is never the only signal". **Expected:** "Nothing found by automated checks. Still check: ...".
6. Open `http://localhost:8000/many.html` and scan. While "Checking focus" shows, press **Cancel**. **Expected:** the focus checks stop, and the visible focus check says "cancelled after N of 500 places".
7. Now press Tab through `keyboard.html` yourself. Do the results match what you see? Note anything wrong, and anything missed.
8. Try a real site and a framework app on localhost (React, Vite, and so on). Note if possible problems are useful or noisy, and if any clean page shows findings.

## 11. Single-page app and sticky header

1. Click the icon on `http://localhost:8000/spa.html` and scan. **Expected:** Image descriptions: Nothing found by automated checks.
2. Select **About** on the page. **Expected:** the panel's page changes to `/spa-about` and the old details are hidden.
3. Scan. **Expected:** Image descriptions: Issues found (1).
4. Do the guided check "Sticky bars don't cover the focused item" on the Home view. Tab down to the link at the bottom and back up. Decide if the sticky header ever hides the focused item.

## 12. Saved progress

1. Mark a few guided checks on `broken.html`. Close the panel and reopen it. **Expected:** your answers are still there, and the summary shows the last scan with "These results are from your last scan of this page."
2. Open `broken.html?x=1#top`. **Expected:** same saved progress (query and hash are ignored).
3. **Clear this page's data**, then **Clear all data**. **Expected:** everything resets.

## 13. Copy report

1. Scan `broken.html`, mark two guided checks, select **Copy report**, and paste into a text editor.
2. **Expected:** date, page, axe-core version, the Core 8 lines, the issues, the guided check statuses, and the line "Automated checks only find some problems. A clean scan does not mean your page meets WCAG."
3. Open `broken.html` as a file (`file://`), scan, and copy the report. **Expected:** the page line is only `broken.html`. No folder names, and not your user name.
4. Open `http://localhost:8000/frames.html`, scan, and check: Button names: Issues found (5), and only the `127.0.0.1` frame is listed as not scanned.

## 14. Scan timeout (optional)

Hard to set up. On a page that blocks the browser for more than 30 seconds, the panel should say "The scan took longer than 30 seconds, so it was stopped." Not tested yet.
