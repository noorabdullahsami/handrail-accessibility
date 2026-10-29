// Copies axe-core's minified file from node_modules into extension/vendor/, unchanged.
// Usage: npm install && node scripts/vendor.mjs
import { copyFile, readFile } from 'node:fs/promises';

await copyFile('node_modules/axe-core/axe.min.js', 'extension/vendor/axe.min.js');
const { version } = JSON.parse(await readFile('node_modules/axe-core/package.json', 'utf8'));
console.log(
  `Copied axe-core ${version} to extension/vendor/axe.min.js. Update THIRD_PARTY_NOTICES.md if the version changed.`,
);
