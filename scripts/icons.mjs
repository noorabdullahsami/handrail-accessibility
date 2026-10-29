// Renders icons/handrail-mark.svg to the PNG sizes Chrome needs. Dev tool only.
// Usage: node scripts/icons.mjs
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const svg = await readFile(new URL('../extension/icons/handrail-mark.svg', import.meta.url), 'utf8');
const browser = await puppeteer.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: `extension/icons/icon-${size}.png`, omitBackground: true });
}
await browser.close();
console.log('Icons written.');
