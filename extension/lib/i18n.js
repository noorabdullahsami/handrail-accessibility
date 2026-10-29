// User-facing text lives in _locales/en/messages.json.
//
// t("name", { count: 3 }) returns that message with {count} filled in. In the
// extension, Chrome reads the file (chrome.i18n). In Node tests there is no
// chrome, so the file is read directly. Named {placeholders} are filled in
// here, the same way in both places; Chrome only treats "$" as special.

const fromFile = globalThis.chrome?.i18n
  ? null
  : JSON.parse(
      (await import('node:fs')).readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'),
    );

export function t(key, values = {}) {
  const message = fromFile ? fromFile[key]?.message : chrome.i18n.getMessage(key);
  // A missing key shows itself, so a test or a person notices.
  if (!message) return key;
  return message.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));
}
