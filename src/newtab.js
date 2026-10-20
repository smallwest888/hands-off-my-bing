(() => {
  'use strict';
  const fallback = document.getElementById('fallback');
  const fallbackMessage = document.getElementById('fallback-message');
  const destination = 'https://www.bing.com/';
  const bridgeUrl = chrome.runtime.getURL('newtab.html');
  const returnMarker = '__bingHomePreferencesReturnToNewtab';
  const registrationTimeoutMs = 1500;
  const cancellationTimeoutMs = 150;

  let currentTabId;
  let pageLeaving = false;
  let navigationStarted = false;
  let lifecycle = 0;
  let cancellation;

  function showFallback(messageKey) {
    if (fallbackMessage) {
      fallbackMessage.dataset.i18n = messageKey;
      let message = '';
      try { message = globalThis.BingHomeI18n?.t(messageKey) || chrome.i18n?.getMessage('ntFallback') || ''; } catch {}
      fallbackMessage.textContent = message || 'Bing could not be opened. Use the link below.';
    }
    if (fallback) fallback.hidden = false;
  }

  // tabs.update creates a history entry. When the user goes Back, Chromium
  // can restore this bridge page; the marker prevents it from navigating
  // forward to Bing again in a loop.
  if (history.state?.[returnMarker] === true) {
    showFallback('ntReturned');
    return;
  }

  async function cancelPreparation(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    if (cancellation) return cancellation;
    cancellation = (async () => {
      try {
        const message = chrome.runtime.sendMessage({ type: 'bhp:cancel-newtab', tabId });
        let timer;
        await Promise.race([
          Promise.resolve(message).catch(() => null),
          new Promise(resolve => { timer = setTimeout(resolve, cancellationTimeoutMs); })
        ]);
        clearTimeout(timer);
      } catch { /* The browser may already have left the bridge page. */ }
    })();
    return cancellation;
  }

  function onPageHide() {
    pageLeaving = true;
    lifecycle += 1;
    if (!navigationStarted) void cancelPreparation(currentTabId);
  }
  window.addEventListener('pagehide', onPageHide, { once: true });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    // A Back navigation may restore the original bridge document from BFCache.
    // Do not resume the old pending preparation or perform a second update.
    pageLeaving = true;
    lifecycle += 1;
    showFallback('ntReturned');
    void cancelPreparation(currentTabId);
  });

  function getCurrentTabId() {
    return new Promise((resolve, reject) => {
      try {
        chrome.tabs.getCurrent(tab => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message || 'Could not read the bridge tab'));
          else if (!Number.isInteger(tab?.id) || tab.id < 0) reject(new Error('Bridge tab id unavailable'));
          else resolve(tab.id);
        });
      } catch (error) { reject(error); }
    });
  }

  function updateCurrentTab(tabId) {
    return new Promise((resolve, reject) => {
      if (!Number.isInteger(tabId) || tabId < 0) {
        reject(new Error('Bridge tab id unavailable'));
        return;
      }
      try {
        chrome.tabs.update(tabId, { url: destination }, tab => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message || 'Could not navigate the bridge tab'));
          else if (!tab) reject(new Error('Bridge tab navigation was not confirmed'));
          else resolve(tab);
        });
      } catch (error) { reject(error); }
    });
  }

  function markBridgeHistory() {
    const previousState = history.state;
    const markedState = previousState && typeof previousState === 'object' && !Array.isArray(previousState)
      ? { ...previousState, [returnMarker]: true }
      : { [returnMarker]: true, previousState };
    history.replaceState(markedState, '', location.href);
    return previousState;
  }

  async function openBing() {
    const attempt = lifecycle;
    try {
      // This script only ships in the override page. Require the tab id for
      // this exact bridge instead of ever updating whichever tab is active.
      if (location.href !== bridgeUrl) throw new Error('Not running in the newtab bridge');
      currentTabId = await getCurrentTabId();
      if (pageLeaving || attempt !== lifecycle) return;
    } catch {
      if (!pageLeaving && attempt === lifecycle) showFallback('ntNoTab');
      return;
    }

    let result = null;
    let timer;
    try {
      const registration = chrome.runtime.sendMessage({
        type: 'bhp:prepare-newtab',
        tabId: currentTabId
      });
      const deadline = new Promise(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), registrationTimeoutMs);
      });
      result = await Promise.race([Promise.resolve(registration), deadline]);
    } catch {
      result = null;
    } finally {
      clearTimeout(timer);
    }

    if (pageLeaving || attempt !== lifecycle) {
      await cancelPreparation(currentTabId);
      return;
    }

    if (!result?.ok) {
      // Cleanup is queued after a late preparation so it cannot leave a stale
      // rule behind. Both waits remain bounded; the bridge still fails open.
      await cancelPreparation(currentTabId);
    }
    if (pageLeaving || attempt !== lifecycle) return;

    let previousState;
    try {
      previousState = markBridgeHistory();
    } catch {
      showFallback('ntUnsafe');
      await cancelPreparation(currentTabId);
      return;
    }

    // Do not fall back to in-page navigation, which transfers initial omnibox
    // focus into the page. A failed update must remain a manual action.
    navigationStarted = true;
    try {
      await updateCurrentTab(currentTabId);
    } catch {
      navigationStarted = false;
      if (!pageLeaving && attempt === lifecycle) {
        try { history.replaceState(previousState, '', location.href); } catch { /* Keep the marker if restoration fails. */ }
        showFallback('ntFallback');
        await cancelPreparation(currentTabId);
      }
    }
  }

  void openBing();
})();
