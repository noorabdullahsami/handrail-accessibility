// Writes THIRD_PARTY_NOTICES.md from the real license files.
// Run after updating axe-core: npm run notices
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (path) => readFileSync(path, 'utf8').trim();
const { version } = JSON.parse(read('node_modules/axe-core/package.json'));
const fence = '```';

const VENDORED = 'extension/vendor/axe.min.js';
const vendored = readFileSync(VENDORED);
if (!vendored.equals(readFileSync('node_modules/axe-core/axe.min.js'))) {
  throw new Error(`${VENDORED} differs from axe-core@${version} in node_modules. Run npm run vendor first.`);
}
const sha256 = createHash('sha256').update(vendored).digest('hex');
const copyright = vendored
  .toString('utf8', 0, 300)
  .match(/Copyright \(c\)[^\n]*/)[0]
  .trim();

const text = `# Third-party notices

The Handrail extension includes the following third-party software and fonts.

## axe-core ${version}

- File: \`extension/vendor/axe.min.js\`, copied unchanged from the npm package \`axe-core@${version}\`
- SHA-256: \`${sha256}\`
- ${copyright}
- License: Mozilla Public License 2.0 (MPL-2.0), full text below.
- Source code: https://github.com/dequelabs/axe-core

axe-core includes other open source code. Its notice for those parts follows the MPL text.

### Mozilla Public License 2.0

${fence}text
${read('node_modules/axe-core/LICENSE')}
${fence}

### Third-party code included in axe-core

${fence}text
${read('node_modules/axe-core/LICENSE-3RD-PARTY.txt')}
${fence}

## TeX Gyre Heros font

- Files: \`extension/fonts/heros/texgyreheros-regular.otf\`, \`extension/fonts/heros/texgyreheros-bold.otf\`, shipped unmodified (not renamed, converted or subset)
- License: GUST Font License (an instance of the LaTeX Project Public License 1.3c). The license and the font's readme are in \`extension/fonts/heros/\`.
- Source: https://ctan.org/pkg/tex-gyre-heros

### Notice (extension/fonts/heros/NOTICE.txt)

${fence}text
${read('extension/fonts/heros/NOTICE.txt')}
${fence}

### GUST Font License (extension/fonts/heros/GUST-FONT-LICENSE.txt)

${fence}text
${read('extension/fonts/heros/GUST-FONT-LICENSE.txt')}
${fence}
`;

writeFileSync('THIRD_PARTY_NOTICES.md', text);
console.log(`THIRD_PARTY_NOTICES.md written for axe-core ${version}.`);
