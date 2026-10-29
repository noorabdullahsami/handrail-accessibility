import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, targetText, targetPlace, describeElement, CAVEAT } from '../../extension/lib/report.js';

const manualChecks = [
  { id: 'keyboard', title: 'Everything works with just a keyboard', wcag: '2.1.1', level: 'A' },
  { id: 'focus-visible', title: 'You can always see where the keyboard focus is', wcag: '2.4.7', level: 'AA' },
  {
    id: 'target-size',
    title: 'Buttons and links are big enough to tap',
    wcag: '2.5.8',
    level: 'AA',
    axe_rules: ['target-size'],
  },
];

const scan = {
  axeVersion: '4.14.0',
  scannedAt: '2026-10-25T10:00:00.000Z',
  url: 'http://localhost:8000/broken.html',
  violations: [
    {
      id: 'image-alt',
      impact: 'critical',
      tags: ['wcag2a'],
      help: 'Images must have alternative text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/image-alt',
      count: 2,
      nodes: [
        { target: ['img'], html: '<img>', failureSummary: '' },
        { target: [['shadow-card', 'img']], html: '<img>', failureSummary: '' },
      ],
    },
    {
      id: 'region',
      impact: 'moderate',
      tags: ['best-practice'],
      help: 'All page content should be contained by landmarks',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/region',
      count: 1,
      nodes: [{ target: ['p'], html: '<p>', failureSummary: '' }],
    },
  ],
  incomplete: [],
};

test('report includes date, page, axe version, Core 8, issues, manual statuses and the caveat', () => {
  const report = buildReport({
    name: 'Handrail',
    date: new Date(2026, 9, 25, 14, 5),
    page: 'localhost:8000/broken.html',
    scan,
    lastScan: null,
    manual: { keyboard: 'looks-good' },
    manualChecks,
    titles: { 'image-alt': 'Images have a text description' },
    since: { fixed: 3, new: 1 },
    auto: { 'focus-visible': { i: 0, p: 2 }, keyboard: { i: 0, p: 0 } },
  });
  assert.match(report, /^# Accessibility report: localhost:8000\/broken.html/);
  assert.match(report, /- Date: 2026-10-25 14:05/);
  assert.match(report, /axe-core 4\.14\.0/);
  assert.match(report, /Since last scan: 3 fixed, 1 new/);
  assert.match(report, /## Core checks: 6 of 8 look good/);
  assert.match(report, /- Image descriptions: Issues found \(2\)/);
  assert.match(report, /- Keyboard access: Looks good/);
  assert.match(report, /- Visible focus: Needs a quick check/);
  assert.match(report, /\*\*Images have a text description\*\* \(rule `image-alt`, 2 elements, impact critical\)/);
  assert.match(report, /`shadow-card >>> img`/);
  assert.match(report, /## Best practices \(not WCAG failures\)/);
  assert.match(report, /1 of 3 checked\./);
  assert.match(report, /focus is \(WCAG 2\.4\.7, level AA\): Not checked\. Scan: Possible problems \(2\)/);
  assert.ok(report.includes(CAVEAT));
  assert.doesNotMatch(report, /\bpass(ed)?\b|compliant/i);
});

test('report without a scan in this session says so', () => {
  const report = buildReport({
    name: 'Handrail',
    date: new Date(2026, 9, 25),
    page: 'example.com/',
    scan: null,
    lastScan: { at: '2026-10-24T10:00:00.000Z', axeVersion: '4.14.0', rules: { label: { v: 1, i: 0 } } },
    manualChecks,
  });
  assert.match(report, /- Form labels: Issues found \(1\)/);
  assert.match(report, /Details are not available/);
});

test('report before any scan never says "0 of 8" or "axe-core not scanned"', () => {
  const report = buildReport({
    name: 'Handrail',
    date: new Date(2026, 9, 25),
    page: 'example.com/',
    scan: null,
    lastScan: null,
    manualChecks,
  });
  assert.match(report, /## Core checks: Not scanned yet/);
  assert.match(report, /- Tool: Handrail\r?\n/);
  assert.doesNotMatch(report, /0 of 8|axe-core|not scanned\b/);
});

test('guided checks show the automated findings for their rules', () => {
  const report = buildReport({
    name: 'Handrail',
    date: new Date(2026, 9, 25),
    page: 'example.com/',
    scan: null,
    lastScan: {
      at: '2026-10-24T10:00:00.000Z',
      axeVersion: '4.14.0',
      rules: { 'target-size': { v: 4, i: 0 } },
      auto: { 'target-size': { i: 4, p: 0 } },
    },
    manualChecks,
  });
  assert.match(
    report,
    /Buttons and links are big enough to tap \(WCAG 2\.5\.8, level AA\): Not checked\. Scan: Issues found \(4\)/,
  );
});

test('frames that could not be scanned are listed by address, without queries', () => {
  const withFrames = {
    ...scan,
    incomplete: [
      {
        id: 'frame-tested',
        impact: 'critical',
        tags: ['best-practice'],
        help: 'Frames should be tested',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/frame-tested',
        count: 2,
        nodes: [
          { target: ['#ad'], html: '<iframe>', frameUrl: 'https://ads.example.net/slot/1?user=42#x' },
          { target: ['#blocked'], html: '<iframe>', frameUrl: '' },
        ],
      },
    ],
  };
  const report = buildReport({
    name: 'Handrail',
    date: new Date(),
    page: 'example.com/',
    scan: withFrames,
    lastScan: null,
    manualChecks,
  });
  assert.match(report, /2 frame\(s\) on the page could not be scanned/);
  assert.match(report, /- ads\.example\.net\/slot\/1\n/);
  assert.match(report, /- A frame whose address could not be read/);
  assert.doesNotMatch(report, /user=42/);
});

test('targetPlace turns frame and shadow DOM selectors into words', () => {
  assert.equal(targetPlace([['shadow-card', 'img']]), 'inside the shadow-card component');
  assert.equal(targetPlace(['#same', 'button']), 'inside a frame on this page');
  assert.equal(
    targetPlace(['iframe', ['my-menu#main', 'a']]),
    'inside the my-menu component, inside a frame on this page',
  );
  assert.equal(targetPlace(['#plain']), '');
  assert.equal(targetPlace([]), '');
});

test('describeElement names the element type plus its text or label', () => {
  assert.equal(describeElement({ tag: 'button' }), 'Button with no text');
  assert.equal(describeElement({ tag: 'button', name: '  Save   draft ' }), 'Button: "Save draft"');
  assert.equal(describeElement({ tag: 'img', src: 'https://cdn.example.com/a/logo.png?v=3' }), 'Image: logo.png');
  assert.equal(describeElement({ tag: 'img', src: 'data:image/gif;base64,R0lG' }), 'Image with no description');
  assert.equal(describeElement({ tag: 'img', name: 'Team photo' }), 'Image: "Team photo"');
  assert.equal(describeElement({ tag: 'a', name: 'Read more' }), 'Link: "Read more"');
  assert.equal(describeElement({ tag: 'div', role: 'button' }), 'Button with no text');
  assert.equal(describeElement({ tag: 'input', type: 'email' }), 'Text field with no text');
  assert.equal(describeElement({ tag: 'input', type: 'submit', name: 'Send' }), 'Button: "Send"');
  assert.equal(describeElement({ tag: 'h2', name: 'Prices' }), 'Heading: "Prices"');
  assert.equal(describeElement({ tag: 'html' }), 'The whole page (the <html> element)');
  assert.equal(describeElement({ tag: 'shadow-card' }), '<shadow-card> element with no text');
  assert.equal(describeElement({}), 'Element with no text');
  const long = describeElement({ tag: 'p', name: 'x'.repeat(100) });
  assert.ok(long.length < 80 && long.endsWith('…"'), long);
});

test('targetText shows frames with >> and shadow DOM with >>>', () => {
  assert.equal(targetText(['#a']), '#a');
  assert.equal(targetText(['iframe', 'button']), 'iframe >> button');
  assert.equal(targetText([['x-card', 'img']]), 'x-card >>> img');
});
