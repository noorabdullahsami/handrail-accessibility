// Background service worker.
//
// It has one job: when the user clicks the toolbar icon (or presses the
// keyboard shortcut, which Chrome treats as the same click), open the side
// panel. That click is also what gives us the `activeTab` permission for the
// page, so the panel can scan it.

chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open() only works in direct response to a user action, so call
  // it right away, before any `await`.
  chrome.sidePanel.open({ tabId: tab.id }).catch((error) => {
    console.error('Could not open the side panel:', error);
  });

  // Tell the panel which tab was just clicked. The panel listens for this so
  // it can refresh when the user clicks the icon on a different tab while the
  // panel is already open. `tab.url` is only filled in when Chrome gave us
  // access to the page.
  chrome.storage.session.set({
    lastClick: { tabId: tab.id, windowId: tab.windowId, url: tab.url || null, at: Date.now() },
  });
});
