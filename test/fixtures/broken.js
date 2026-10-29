// A web component whose shadow DOM holds an image with no alt text.
customElements.define('shadow-card', class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40">';
  }
});
// Load the same server under a different origin (localhost <-> 127.0.0.1).
const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
document.getElementById('cross-origin').src = `${location.protocol}//${other}:${location.port}/frame-other.html`;
