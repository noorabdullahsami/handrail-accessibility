import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeFromChromeError, problemForUrl, explainProblem, AXE_TAGS } from '../../extension/lib/scan.js';

test('Chrome error strings map to plain-language problem codes', () => {
  assert.equal(codeFromChromeError('Cannot access a chrome:// URL'), 'chrome');
  assert.equal(codeFromChromeError('Cannot access a chrome-extension:// URL of different extension'), 'extension');
  assert.equal(codeFromChromeError('The extensions gallery cannot be scripted.'), 'webstore');
  assert.equal(
    codeFromChromeError(
      'Cannot access contents of url "file:///C:/a.html". Extension manifest must request permission to access this host.',
    ),
    'file-access',
  );
  assert.equal(
    codeFromChromeError(
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
    ),
    'no-access',
  );
  assert.equal(codeFromChromeError('Frame with ID 0 is showing error page'), 'error-page');
  assert.equal(codeFromChromeError('No tab with id: 5.'), 'no-tab');
  assert.equal(codeFromChromeError('Something new'), 'unknown');
});

test('problemForUrl blocks pages we know cannot be scanned', () => {
  assert.equal(problemForUrl('http://localhost:3000/'), null);
  assert.equal(problemForUrl('chrome://settings'), 'chrome');
  assert.equal(problemForUrl('https://chromewebstore.google.com/'), 'webstore');
  assert.equal(problemForUrl('file:///a.html', { fileAccessAllowed: false }), 'file-access');
  assert.equal(problemForUrl('file:///a.html', { fileAccessAllowed: true }), null);
  assert.equal(problemForUrl(undefined), 'no-access');
  assert.equal(problemForUrl('about:blank'), 'unsupported');
});

test('every problem has a title and a next step, with no em dashes or filler words', () => {
  const codes = [
    'no-access',
    'chrome',
    'extension',
    'webstore',
    'file-access',
    'error-page',
    'no-tab',
    'loading',
    'timeout',
    'busy',
    'unsupported',
    'unknown',
  ];
  for (const code of codes) {
    const { title, detail } = explainProblem(code, 'Handrail');
    assert.ok(title && detail, code);
    assert.doesNotMatch(title + detail, /\u2014|seamless|robust|powerful/, code);
  }
  assert.equal(explainProblem('no-access').title, 'Click the extension icon on this page to scan it.');
});

test('scan uses WCAG 2.0/2.1/2.2 A and AA tags plus best practices', () => {
  assert.deepEqual(AXE_TAGS, ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']);
});
