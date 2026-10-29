// Mock scan results for the preview page, one set per state. Shapes match
// what extension/lib/scan.js and extension/lib/helpers.js return in a real scan.

const AXE = 'https://dequeuniversity.com/rules/axe/4.14';
const WCAG = ['wcag2a', 'wcag2aa'];

function rule(id, nodes, { impact = 'serious', tags = WCAG, help = id, count = nodes.length } = {}) {
  return { id, impact, tags, help, description: help, helpUrl: `${AXE}/${id}`, count, nodes };
}
function node(target, html, failureSummary = 'Fix any of the following:\n  Element has no name') {
  return { target: Array.isArray(target) ? target : [target], html, failureSummary, impact: 'serious' };
}
function items(list, note) {
  return {
    count: list.length,
    items: list.map(([target, html]) => ({ target: [target], html, failureSummary: note })),
  };
}
const none = { count: 0, items: [] };

const typicalScan = {
  violations: [
    rule(
      'button-name',
      [
        node(
          '.toolbar > button:nth-child(2)',
          '<button type="button" class="icon-btn"><svg aria-hidden="true" width="16" height="16"></svg></button>',
        ),
        node('#cart-close', '<button id="cart-close" type="button"></button>'),
        node(['iframe[title="Checkout"]', 'button.pay'], '<button class="pay" type="submit"></button>'),
      ],
      { impact: 'critical' },
    ),
    rule(
      'image-alt',
      [
        node('.hero > img', '<img src="/img/hero-banner.jpg" width="1200" height="400">'),
        node('.team img:nth-child(3)', '<img src="/img/team/priya.png">'),
        node([['product-card', '.thumb']], '<img class="thumb" src="/img/p/4421.webp">'),
      ],
      { impact: 'critical' },
    ),
    rule('color-contrast', [
      node(
        '.price-note',
        '<p class="price-note">Prices include tax.</p>',
        'Fix any of the following:\n  Element has insufficient color contrast of 2.85 (foreground color: #9a9a9a, background color: #ffffff, font size: 10.5pt (14px), font weight: normal). Expected contrast ratio of 4.5:1',
      ),
      node('footer .legal', '<small class="legal">© 2026 Linen &amp; Loom</small>'),
      node('.badge-new', '<span class="badge-new">New</span>'),
    ]),
    rule(
      'label',
      [
        node('#newsletter-email', '<input id="newsletter-email" type="email">'),
        node('#qty', '<input id="qty" type="number" value="1">'),
      ],
      { impact: 'critical' },
    ),
    rule('link-name', [
      node('.social > a:nth-child(1)', '<a href="https://instagram.com/shop"><span class="icon-x"></span></a>'),
      node('.social > a:nth-child(2)', '<a href="https://youtube.com/shop"><span class="icon-play"></span></a>'),
    ]),
    rule('target-size', [
      node('.pager > a:nth-child(1)', '<a href="?page=1">1</a>'),
      node('.pager > a:nth-child(2)', '<a href="?page=2">2</a>'),
      node('.pager > a:nth-child(3)', '<a href="?page=3">3</a>'),
      node('.pager > a:nth-child(4)', '<a href="?page=4">4</a>'),
    ]),
    rule(
      'region',
      [
        node('.promo-strip', '<div class="promo-strip">Free shipping over $50</div>'),
        node('#chat-launcher', '<div id="chat-launcher">Chat</div>'),
      ],
      { impact: 'moderate', tags: ['best-practice'] },
    ),
    rule('heading-order', [node('.reviews h4', '<h4>Reviews</h4>')], { impact: 'moderate', tags: ['best-practice'] }),
  ],
  incomplete: [
    rule('color-contrast', [
      node(
        '.hero-title',
        '<h1 class="hero-title">Summer sale</h1>',
        "Fix any of the following:\n  Element's background color could not be determined due to a background image",
      ),
    ]),
    rule(
      'frame-tested',
      [
        {
          ...node(
            'iframe[title="Map"]',
            '<iframe src="https://maps.linenandloom.com/embed?q=shop" title="Map"></iframe>',
          ),
          frameUrl: 'https://maps.linenandloom.com/embed?q=shop',
        },
      ],
      { impact: 'critical', tags: ['best-practice'] },
    ),
  ],
};

const typicalLists = {
  clickables: items(
    [['.card.product', '<div class="card product" onclick="openProduct(4421)">Linen shirt</div>']],
    'Looks clickable, but you cannot reach it with the Tab key.',
  ),
  headings: {
    count: 4,
    items: [
      { level: 1, text: 'Summer sale', target: ['h1'] },
      { level: 2, text: 'New arrivals', target: ['h2'] },
      { level: 4, text: 'Reviews', target: ['h4'] },
      { level: 2, text: 'Help', target: ['h2:nth-of-type(2)'] },
    ],
  },
  links: {
    total: 48,
    ...items(
      [['.blog a.more', '<a class="more" href="/blog/linen">Read more</a>']],
      'Link text "Read more" does not say where it goes.',
    ),
  },
  duplicateLinks: none,
  images: {
    total: 9,
    ...items(
      [['.gallery img:nth-child(2)', '<img src="/img/IMG_0042.jpg" alt="IMG_0042.jpg">']],
      'Alt text "IMG_0042.jpg" may not describe the image.',
    ),
  },
  sameAlts: none,
  liveRegions: items(
    [['#cart-status', '<div id="cart-status" role="status"></div>']],
    'Screen readers read out changes inside this element.',
  ),
  placeholders: items(
    [['#search', '<input id="search" placeholder="Search products">']],
    'Only the placeholder "Search products" names this field. It disappears when people type.',
  ),
  roles: items(
    [['.size-picker', '<div class="size-picker" role="radiogroup">']],
    'Custom "radiogroup". Check with a screen reader that it says its name, role, and state.',
  ),
  skip: { skipLink: true, hasMain: true },
};

const typicalWalk = {
  stops: 64,
  unreadableSheets: 0,
  focusVisibleSupported: true,
  noFocusConfirmed: items(
    [['.nav > a:nth-child(3)', '<a href="/sale">Sale</a>']],
    'Nothing changed on screen when this had focus.',
  ),
  faintFocus: none,
  maybeNoFocus: none,
  invisibleFocus: none,
  coveredBySticky: items(
    [['#size-guide', '<a id="size-guide" href="#guide">Size guide</a>']],
    'Hidden behind a fixed or sticky element (header.site-header) when it has focus.',
  ),
  orderJumps: none,
  positiveTabindex: none,
};

const cleanLists = {
  ...typicalLists,
  clickables: none,
  links: { total: 12, ...none },
  images: { total: 3, ...none },
  placeholders: none,
};
const cleanWalk = { ...typicalWalk, stops: 18, noFocusConfirmed: none, coveredBySticky: none };

// 300 issues across many rules. Real scans keep at most 50 elements per rule.
const manyScan = {
  violations: [
    ['color-contrast', 120],
    ['image-alt', 64],
    ['link-name', 40],
    ['target-size', 30],
    ['label', 18],
    ['button-name', 12],
    ['aria-allowed-attr', 6],
    ['list', 4],
    ['duplicate-id-aria', 3],
    ['meta-viewport', 1],
    ['document-title', 1],
    ['html-has-lang', 1],
  ].map(([id, count]) =>
    rule(
      id,
      Array.from({ length: Math.min(count, 50) }, (_, i) =>
        node(`.grid > .item:nth-child(${i + 1}) > .${id}`, `<div class="${id}">Item ${i + 1}</div>`),
      ),
      { count },
    ),
  ),
  incomplete: [
    rule(
      'color-contrast',
      Array.from({ length: 8 }, (_, i) => node(`.banner:nth-child(${i + 1}) h2`, `<h2>Banner ${i + 1}</h2>`)),
    ),
  ],
};
const manyLists = {
  ...typicalLists,
  clickables: {
    count: 37,
    items: Array.from({ length: 37 }, (_, i) => ({
      target: [`.tile:nth-child(${i + 1})`],
      html: `<div class="tile" onclick="go(${i})">Tile ${i + 1}</div>`,
      failureSummary: 'Looks clickable, but you cannot reach it with the Tab key.',
    })),
  },
};

// Very long selectors and snippets, as from deep framework markup.
const deep = Array.from({ length: 14 }, (_, i) => `div.css-1x9k${i}q2 > div:nth-of-type(${i + 2})`).join(' > ');
const longScan = {
  violations: [
    rule(
      'button-name',
      [
        node(
          `${deep} > button.MuiButtonBase-root.MuiIconButton-root.MuiIconButton-sizeMedium.css-k0ab3s`,
          `<button class="MuiButtonBase-root MuiIconButton-root MuiIconButton-sizeMedium css-k0ab3s" tabindex="0" type="button" data-testid="toolbar-overflow-menu-trigger-button-with-a-very-long-test-id"><svg class="MuiSvgIcon-root MuiSvgIcon-fo…`,
        ),
        node(
          [['app-shell', 'nav-drawer', 'drawer-section-with-a-really-long-component-name', 'button.close']],
          '<button class="close"></button>',
        ),
      ],
      { impact: 'critical' },
    ),
    rule(
      'image-alt',
      [
        node(
          `${deep} > img`,
          '<img src="https://cdn.linenandloom.com/assets/2026/10/very/long/path/to/an/image/file/name/that/keeps/going/hero-banner-final-final-v3.jpg">',
        ),
      ],
      { impact: 'critical' },
    ),
  ],
  incomplete: [],
};

// The worst realistic case, every field at once.
const fourHundred = `#__next > div.layout_root__x8f2k > main.layout_main__q1w9z > section:nth-of-type(3) > div.ProductGrid_grid__3nB7d > div.ProductCard_card__Zk2p9:nth-child(14) > div.ProductCard_body__9xQwL > div.ProductCard_actions__mN4vT > div.Tooltip_wrapper__kq1Lm > span.Tooltip_trigger__p0Xc2 > button.IconButton_root__a8VnE.IconButton_sizeSmall__c3Ue1.IconButton_variantGhost__r7Hn2`;
const worstScan = {
  violations: [
    rule(
      'color-contrast',
      Array.from({ length: 50 }, (_, i) =>
        node(
          `.listing > li:nth-child(${i + 1}) .meta`,
          `<span class="meta">Free returns within 30 days</span>`,
          'Fix any of the following:\n  Element has insufficient color contrast of 2.54 (foreground color: rgba(118, 118, 118, 0.85), background color: rgb(250, 250, 250), font size: 9.75pt (13px), font weight: normal). Expected contrast ratio of 4.5:1',
        ),
      ),
      { count: 1284 },
    ),
    rule(
      'button-name',
      [
        node(
          fourHundred,
          '<button class="IconButton_root__a8VnE IconButton_sizeSmall__c3Ue1 IconButton_variantGhost__r7Hn2" type="button" data-analytics-id="product-card-quick-add-to-wishlist-button-secondary-variant-b"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21.35l-1.45-1.32C5.4 1…',
        ),
        node(
          [
            [
              'storefront-application-shell',
              'product-recommendation-carousel-with-infinite-scroll',
              'carousel-navigation-control-button',
            ],
          ],
          '<button class="next"></button>',
        ),
        node(['iframe[title="مساعد المتجر"]', 'button.send'], '<button class="send" type="submit"></button>'),
      ],
      { impact: 'critical' },
    ),
    rule('link-name', [
      node(
        '.footer a.app-store',
        `<a class="app-store" href="https://apps.apple.com/app/linen-and-loom/id1234567890" aria-label="${'Download the Linen & Loom app for iPhone and iPad to get early access to seasonal sales, free shipping on every order and members-only collections '.repeat(2).trim()}"><img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjAgNDAiPjxyZWN0IHdpZHRoPSIxMjAiIGhlaWdodD0iNDAiLz48L3N2Zz4="></a>`,
      ),
    ]),
    rule(
      'image-alt',
      [
        node(
          '.hero img',
          '<img src="https://cdn.linenandloom.com/assets/campaigns/2026/autumn-winter/hero/linen-and-loom-autumn-winter-2026-campaign-hero-image-final-v7-approved-by-brand-team.jpg" width="1600" height="900">',
        ),
      ],
      { impact: 'critical' },
    ),
  ],
  incomplete: [
    rule(
      'frame-tested',
      [
        {
          ...node('iframe#reviews', '<iframe id="reviews">'),
          frameUrl:
            'https://widgets.reviews-platform-for-online-stores.example-cdn.net/embed/v3/storefronts/linen-and-loom/products/linen-shirt-in-washed-indigo-with-mother-of-pearl-buttons/reviews?locale=ja-JP&theme=light',
        },
      ],
      { impact: 'critical', tags: ['best-practice'] },
    ),
  ],
};
const worstLists = {
  ...cleanLists,
  links: {
    total: 1,
    ...items([['.promo a', '<a href="/sale">here</a>']], 'Link text "here" does not say where it goes.'),
  },
};

export const STATES = {
  empty: { scan: null },
  scanning: { scan: 'never' },
  typical: { scan: typicalScan, lists: typicalLists, walk: typicalWalk },
  zero: { scan: { violations: [], incomplete: [] }, lists: cleanLists, walk: cleanWalk },
  many: { scan: manyScan, lists: manyLists, walk: { ...typicalWalk, stops: 500, total: 812 } },
  long: { scan: longScan, lists: cleanLists, walk: cleanWalk },
  error: { url: 'chrome://settings/' },
  worst: {
    scan: worstScan,
    lists: worstLists,
    walk: { ...cleanWalk, stops: 500, total: 1284 },
    url: 'https://shop.linenandloom.com/ja/コレクション/秋冬-2026/リネンシャツ-ウォッシュドインディゴ?variant=40213&utm_source=newsletter',
    title: 'リネンシャツ（ウォッシュドインディゴ）｜Linen & Loom 公式オンラインストア — Льняная рубашка',
  },
};
