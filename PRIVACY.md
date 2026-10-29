# Privacy policy: Handrail

Last updated: 29 October 2026

Handrail is a Chrome extension that checks web pages for accessibility problems. Everything it does happens in your browser, on your computer.

## The short version

- Handrail does not collect, send, sell or share any data.
- It makes no network requests. It has no analytics, no tracking and no accounts.
- It does not load code or settings from the internet.

## What it reads

When you select **Scan this page**, Handrail reads the page you have open so it can check it. The page content is processed in memory and is not saved or sent anywhere.

To check whether keyboard focus can be seen, Handrail may take screenshots of the visible part of the page (at most 20 per scan). It compares them in memory and discards them right away. Screenshots are never saved or sent anywhere.

Handrail can only read a page after you click its toolbar icon, or press its keyboard shortcut, on that page. Chrome takes that access away when the tab goes to a different site.

## What it saves

To keep your progress, Handrail saves a small amount of data in the browser's extension storage (`chrome.storage.local`). For each page you check, it saves:

- The page address: the origin and path, with anything after a `?` or `#` removed. For a file on your computer, this is the file's path.
- Your answers to the guided checks: Looks good or Has a problem.
- A summary of the last scan: its date and time, the axe-core version, and how many problems each check found.

It does not save the page's content, its code, or anything you typed into it.

While the browser is open, Handrail also keeps the tab and address of your last click on its icon in Chrome's session storage, so the panel knows which page you asked it to check. Chrome keeps session storage in memory only and clears it when the browser closes.

This data stays in your browser. It is not synced to your Google account.

## Incognito windows

Handrail does not run in incognito windows unless you allow it on `chrome://extensions`. If you do allow it, Handrail saves progress for incognito pages in the same way as for other pages, and you can clear it as described below.

## Clearing your data

- In the panel, select **Clear this page's data** or **Clear all data**.
- Removing the extension from Chrome deletes everything it saved.

## Permissions

Handrail asks Chrome for four permissions, and only these:

- **activeTab**: to read the page you are on, only after you click the icon.
- **scripting**: to run the checks on that page.
- **sidePanel**: to show results in Chrome's side panel.
- **storage**: to save your progress in your browser, as described above.

## Changes

If this policy changes, the new version will be posted here with a new date.

## Contact

Questions: open an issue on GitHub at <https://github.com/noorabdullahsami/handrail-accessibility/issues>.
