// The panel's colour tokens, read from panel.css, must keep their contrast,
// and the stylesheet must not use the effects the visual style rules out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../extension/panel/panel.css', import.meta.url), 'utf8');

function tokens(block) {
  return Object.fromEntries(
    [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]),
  );
}
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {'))));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf('}', css.indexOf(':root {', darkStart)))) };

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('contrast math matches known values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrast('#064734', '#e0ffc2').toFixed(2), '9.83');
});

for (const [name, t] of [
  ['light', light],
  ['dark', dark],
]) {
  test(`${name} theme: text at 4.5:1, borders and focus at 3:1, on the ground and the surface`, () => {
    for (const ground of ['bg', 'surface']) {
      for (const role of ['ink', 'text', 'muted', 'issue', 'review']) {
        const ratio = contrast(t[role], t[ground]);
        assert.ok(ratio >= 4.5, `${name}: ${role} on ${ground} is ${ratio.toFixed(2)}:1`);
      }
      for (const role of ['control', 'focus']) {
        const ratio = contrast(t[role], t[ground]);
        assert.ok(ratio >= 3, `${name}: ${role} on ${ground} is ${ratio.toFixed(2)}:1`);
      }
    }
    // The primary button: on-ink text on the ink fill.
    assert.ok(contrast(t['on-ink'], t.ink) >= 4.5, `${name}: primary button text`);
    // Lime is only ever a fill behind #064734.
    assert.ok(contrast(t['on-lime'], t.lime) >= 4.5, `${name}: text on lime`);
  });
}

test('the brand colours have not drifted', () => {
  assert.equal(light.ink, '#064734');
  assert.equal(light.lime, '#e0ffc2');
  assert.equal(dark.ink, '#e0ffc2');
  assert.equal(dark.bg, '#03241a');
});

test('panel.css uses none of the banned devices', () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /box-shadow/, 'box-shadow (only the on-page highlight label may have one)');
  assert.doesNotMatch(rules, /linear-gradient|radial-gradient/, 'gradient');
  assert.doesNotMatch(rules, /text-transform:\s*uppercase/, 'uppercase');
  assert.doesNotMatch(rules, /\u2192|\u203a|\u00bb|\u25b8|\u25be|\u2713|\u2715/, 'arrow or glyph characters');
  for (const m of rules.matchAll(/border-left(?:-width)?:\s*([\d.]+)px/g))
    assert.ok(Number(m[1]) <= 1, `border-left ${m[1]}px`);
  assert.doesNotMatch(rules, /Atkinson/, 'old typeface');
  assert.match(rules, /font-family: 'TeX Gyre Heros'/);
  // Weights 400 and 700 only.
  for (const m of rules.matchAll(/font-weight:\s*(\d+)/g))
    assert.ok(['400', '700'].includes(m[1]), `font-weight ${m[1]}`);
});
