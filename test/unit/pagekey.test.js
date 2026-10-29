import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageKey, pageLabel, classifyUrl } from '../../extension/lib/pagekey.js';

test('pageKey keeps origin and path, drops query and hash', () => {
  assert.equal(pageKey('https://example.com/about/?utm=x#team'), 'https://example.com/about/');
  assert.equal(pageKey('http://localhost:3000/'), 'http://localhost:3000/');
  assert.equal(pageKey('http://localhost:3000'), 'http://localhost:3000/');
  assert.equal(pageKey('http://localhost:5173/app?x=1'), pageKey('http://localhost:5173/app#y'));
});

test('pageKey treats different ports and paths as different pages', () => {
  assert.notEqual(pageKey('http://localhost:3000/'), pageKey('http://localhost:3001/'));
  assert.notEqual(pageKey('https://a.com/one'), pageKey('https://a.com/two'));
});

test('pageKey handles file URLs and refuses pages we cannot scan', () => {
  assert.equal(pageKey('file:///C:/site/index.html?x#y'), 'file:///C:/site/index.html');
  assert.equal(pageKey('chrome://settings'), null);
  assert.equal(pageKey(undefined), null);
  assert.equal(pageKey('not a url'), null);
});

test('pageLabel is short and readable', () => {
  assert.equal(pageLabel('https://example.com/about?x=1'), 'example.com/about');
  assert.equal(pageLabel('http://localhost:8000/broken.html'), 'localhost:8000/broken.html');
  assert.equal(pageLabel('file:///C:/My%20Site/index.html'), 'index.html');
});

test('pageLabel shows non-Latin paths as words, not percent codes', () => {
  assert.equal(
    pageLabel('https://shop.example.jp/ja/%E3%82%B3%E3%83%AC%E3%82%AF%E3%82%B7%E3%83%A7%E3%83%B3?x=1'),
    'shop.example.jp/ja/コレクション',
  );
  // A broken escape stays as it was rather than throwing.
  assert.equal(pageLabel('https://example.com/100%25-linen/%E3%82'), 'example.com/100%25-linen/%E3%82');
  assert.equal(pageLabel('file:///C:/sites/%E6%97%A5%E6%9C%AC.html'), '日本.html');
});

test('pageLabel never shows private details: no folders, queries, or hashes', () => {
  // A Windows path shows the user name. Only the file name may appear.
  const file = pageLabel('file:///C:/Users/sam/Documents/site/broken.html?x=1#top');
  assert.equal(file, 'broken.html');
  assert.doesNotMatch(file, /sam|Users|Documents/);
  assert.equal(pageLabel('https://example.com/reset?token=abc123#me@example.com'), 'example.com/reset');
  assert.equal(pageLabel('file:///'), 'Local file');
});

test('classifyUrl sorts pages into the kinds we handle', () => {
  assert.equal(classifyUrl('https://example.com'), 'web');
  assert.equal(classifyUrl('http://localhost:8080/'), 'web');
  assert.equal(classifyUrl('http://127.0.0.1:5500/index.html'), 'web');
  assert.equal(classifyUrl('file:///tmp/a.html'), 'file');
  assert.equal(classifyUrl('chrome://extensions'), 'chrome');
  assert.equal(classifyUrl('chrome://newtab/'), 'chrome');
  assert.equal(classifyUrl('chrome-extension://abcdef/popup.html'), 'extension');
  assert.equal(classifyUrl('https://chromewebstore.google.com/detail/x'), 'webstore');
  assert.equal(classifyUrl('https://chrome.google.com/webstore/category/extensions'), 'webstore');
  assert.equal(classifyUrl('https://chrome.google.com/other'), 'web');
  assert.equal(classifyUrl('about:blank'), 'other');
  assert.equal(classifyUrl('view-source:https://a.com'), 'other');
  assert.equal(classifyUrl(undefined), 'unknown');
});
