// Fills in the extension name (from _locales/en/messages.json) on static pages.
const name = chrome.i18n.getMessage('extShortName');
if (name) {
  for (const node of document.querySelectorAll('[data-name]')) node.textContent = name;
  document.title = `${document.title}: ${name}`;
}
