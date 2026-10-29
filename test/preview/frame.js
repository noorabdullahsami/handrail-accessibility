// Runs the real panel (extension/panel/panel.html markup and panel.js) with
// mock data. panel.html sets <base> to extension/panel/, so fetches below and
// the panel's own relative paths resolve from there.
//
// ?state=empty|scanning|typical|zero|many|long|error   which mock data

import { installMockChrome } from './mock-chrome.js';
import { STATES } from './mock-data.js';

const params = new URLSearchParams(location.search);
const state = STATES[params.get('state')] || STATES.typical;

// The real panel markup: the body of extension/panel/panel.html (our own file).
const source = await (await fetch('panel.html')).text();
const real = new DOMParser().parseFromString(source, 'text/html');
document.body.replaceChildren(...[...real.body.childNodes].map((n) => document.importNode(n, true)));

const messages = await (await fetch('../_locales/en/messages.json')).json();
installMockChrome({ messages, state });
await import('../../extension/panel/panel.js');

// Every state but "empty" and "error" starts a scan, as a click would.
if (state.scan && state.scan !== null) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  document.getElementById('scan-button').click();
}
