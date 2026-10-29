const IMG = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40">';
customElements.define('swap-card', class extends HTMLElement {
  constructor() {
    super();
    // data-mode="closed" makes the same component with a closed root.
    this.attachShadow({ mode: this.dataset.mode === 'closed' ? 'closed' : 'open' }).innerHTML = IMG;
  }
});
customElements.define('sealed-card', class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'closed' }).innerHTML = IMG;
  }
});
