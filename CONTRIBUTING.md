# Contributing

Thanks for helping. Handrail is small on purpose, so please keep changes simple.

## Run it locally

You need Node.js 22.2 or newer, Python 3, and Chrome.

```sh
npm install
npm run test:unit   # unit tests, a few seconds
npm run lint
npm run test:e2e    # end-to-end tests in a real Chrome window
```

To try your changes, load the `extension/` folder with **Load unpacked** on `chrome://extensions`, and select the reload icon on Handrail's card after each change.

`npm run test:e2e` runs three suites:

- `test/e2e/run.mjs` opens the panel with the real keyboard shortcut. Automation tools can't click the toolbar icon, so it presses Alt+Shift+K at the operating system level. It only works on Windows, with a visible window. Don't type while it runs.
- `test/e2e/hints.mjs` checks the guided-check hints against the fixture pages, on any OS.
- `test/e2e/preview.mjs` renders every panel state from mock data and runs axe on each one.

CI runs the unit tests, lint, `hints.mjs` and `preview.mjs` in headless Chrome. It leaves out `run.mjs`, because that test needs a real keyboard shortcut and a visible window. Run it yourself before a pull request that touches the panel or the scan.

The manual checklist in [docs/testing.md](docs/testing.md) covers what automated tests can't, like screen readers.

## Folder layout

- `extension/`: everything Chrome loads. Only runtime files go here.
  - `background.js` opens the side panel.
  - `panel/` is the side panel. `lib/` is the scan, scoring, storage, report and highlight logic.
  - `data/` holds the checks and their plain-language copy.
- `test/unit/`, `test/e2e/`, `test/fixtures/` (the test pages), `test/preview.html` (a preview of every panel state).
- `scripts/`: build, link check, and maintenance scripts.

## Fixing or adding a check

The checks live in `extension/data/`:

- `manual-checks.json`: the 23 guided checks.
- `automated-core.json`: copy for the six scanned Core 8 checks.
- `axe-rules.json`: a plain title, why it matters and how to fix it, for every axe-core rule the scan can return.
- `wcag22.json`: every WCAG 2.2 success criterion. Don't edit it by hand; run `npm run wcag` to rebuild it from W3C's published data.

Each check names its success criterion by number in the `wcag` field, with its `level` and the W3C Understanding page in `url`. A unit test checks these against `wcag22.json`.

Writing rules:

- Plain words and short sentences, about an 8th grade reading level.
- If you must use a term like "ARIA" or "landmark", explain it in a few words.
- Never say "pass", "compliant", "accessible" or "makes your site accessible" about a result.
- Don't paste W3C's normative text. Paraphrase it and link to the Understanding page. Success criterion names are fine to use.
- No em dashes. No filler like "seamless", "robust" or "powerful".
- Check every claim against the W3C Understanding page, and say which page in your pull request.

After changing any URL, run `npm run check:links`. It needs the network, so it isn't part of CI.

## False positives are bugs

If Handrail flags something that is fine, or misses something that is broken, that is a bug. Every fix to a check needs a fixture page in `test/fixtures/` that shows the problem, and a clean page that must not be flagged. Add the expected counts in a comment at the top of the page, and assert them in the tests.

## Code rules

- Plain JavaScript modules, HTML and CSS. No bundler, framework or TypeScript.
- No new permissions, no network requests, no remote code, no inline scripts.
- The extension name is only in `extension/_locales/en/messages.json`. Don't hard-code it.
- The panel must stay accessible. The end-to-end tests run axe on it.

## Pull requests

1. Fork the repository and create a branch.
2. Make your change, with tests and a fixture page if it touches a check.
3. Run `npm run lint`, `npm run format` and `npm test`.
4. Open a pull request and fill in the template.
