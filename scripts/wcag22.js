// Writes extension/data/wcag22.json from W3C's machine-readable WCAG 2.2.
// Development only; the extension itself never makes network requests.
// Usage: node scripts/wcag22.js

import { writeFileSync } from 'node:fs';

const SOURCE = 'https://www.w3.org/WAI/WCAG22/wcag.json';
const SPEC = 'https://www.w3.org/TR/WCAG22/';

const wcag = await (await fetch(SOURCE)).json();
const spec = await (await fetch(SPEC)).text();
const published = spec.match(/dt-published"[^>]*datetime="([\d-]+)"/)?.[1];
if (!published) throw new Error(`Could not read the publication date from ${SPEC}`);

const criteria = wcag.principles
  .flatMap((principle) => principle.guidelines)
  .flatMap((guideline) => guideline.successcriteria)
  // 4.1.1 Parsing is in the file with no level: it was removed in WCAG 2.2.
  .filter((sc) => sc.level)
  .map((sc) => ({
    num: sc.num,
    name: sc.handle,
    level: sc.level,
    url: `https://www.w3.org/WAI/WCAG22/Understanding/${sc.id}.html`,
  }));

const data = { source: SOURCE, spec: SPEC, published, criteria };
writeFileSync('extension/data/wcag22.json', `${JSON.stringify(data, null, 2)}\n`);
console.log(`Wrote ${criteria.length} success criteria (WCAG 2.2, published ${published}).`);
