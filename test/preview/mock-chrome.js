// A stand-in for the chrome.* APIs the panel uses, so the real panel code
// can run on a normal web page with mock data. Test only, never shipped.
//
// chrome.scripting.executeScript answers by the name of the function the
// panel asks to run in the page (runAxeInPage, pageHelperInPage, ...).

export function installMockChrome({ messages, state }) {
  const store = { local: {}, session: {} };
  const area = (name) => ({
    async get(key) {
      if (key === null || key === undefined) return structuredClone(store[name]);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => k in store[name]).map((k) => [k, structuredClone(store[name][k])]));
    },
    async set(items) {
      Object.assign(store[name], structuredClone(items));
    },
    async remove(key) {
      delete store[name][key];
    },
    async clear() {
      store[name] = {};
    },
    onChanged: { addListener() {} },
  });
  const tab = {
    id: 1,
    windowId: 1,
    url: state.url || 'https://shop.linenandloom.com/products/linen-shirt?ref=home',
    title: state.title || 'Linen shirt | Linen & Loom',
    status: 'complete',
  };
  const forever = new Promise(() => {});
  let walkDone = 0;

  async function answer(func, args) {
    switch (func.name) {
      case 'runAxeInPage':
        if (state.scan === 'never') return forever;
        return { axeVersion: '4.14.0', url: tab.url, scannedAt: new Date().toISOString(), ...state.scan };
      case 'pageHelperInPage': {
        const { mode } = args[0];
        if (mode === 'lists') return { data: state.lists };
        if (mode === 'focusables') {
          const total = (state.walk && state.walk.total) || (state.walk && state.walk.stops) || 0;
          return { data: Array.from({ length: total }, (_, index) => ({ index, tabIndex: 0 })) };
        }
        if (mode === 'walk-start') {
          walkDone = 0;
          return { data: { total: args[0].order.length } };
        }
        if (mode === 'walk-step') {
          walkDone += args[0].count;
          return { data: { done: walkDone } };
        }
        if (mode === 'pixel-count') return { data: { count: 0 } };
        if (mode === 'walk-end') return { data: state.walk };
        return { data: {} };
      }
      case 'highlightInPage':
        return { ok: true, matches: 1, changed: false };
      default:
        return true;
    }
  }

  globalThis.chrome = {
    i18n: { getMessage: (key) => (messages[key] ? messages[key].message : '') },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      captureVisibleTab: async () => {
        throw new Error('No screenshots in the preview.');
      },
    },
    storage: { local: area('local'), session: area('session') },
    scripting: {
      async executeScript({ func, files, args = [] }) {
        if (files) return [{ frameId: 0, result: undefined }];
        return [{ frameId: 0, result: await answer(func, args) }];
      },
    },
    extension: { isAllowedFileSchemeAccess: async () => true },
  };
}
