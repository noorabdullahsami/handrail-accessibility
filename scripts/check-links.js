// Requests every W3C and Deque URL the extension links to and reports any
// that do not answer 200. Not run in CI, because it needs the network.
// Usage: npm run check:links

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const DATA = 'extension/data';
const PARALLEL = 6;

const urls = new Set();
for (const file of readdirSync(DATA).filter((f) => f.endsWith('.json'))) {
  const text = readFileSync(`${DATA}/${file}`, 'utf8');
  for (const [url] of text.matchAll(/https:\/\/[^"\s]+/g)) {
    if (/w3\.org|deque/.test(new URL(url).hostname)) urls.add(url);
  }
}
// Deque's rule pages come from axe at scan time, so ask axe for them.
const axe = createRequire(import.meta.url)('axe-core');
const ruleIds = Object.keys(JSON.parse(readFileSync(`${DATA}/axe-rules.json`, 'utf8')));
for (const rule of axe.getRules()) {
  if (ruleIds.includes(rule.ruleId)) urls.add(rule.helpUrl);
}

const failures = [];
const queue = [...urls].sort();
async function worker() {
  while (queue.length) {
    const url = queue.shift();
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status !== 200) failures.push(`${response.status} ${url}`);
    } catch (error) {
      failures.push(`${error.cause?.code || error.message} ${url}`);
    }
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));

console.log(`Checked ${urls.size} URLs.`);
for (const line of failures.sort()) console.log(line);
process.exitCode = failures.length ? 1 : 0;
