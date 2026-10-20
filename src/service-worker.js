importScripts('preferences.js');

(() => {
  'use strict';

  const api = globalThis.BingHomePreferences;
  const recordKey = 'bhpManagedHomeTabs';
  const ruleIdStart = 1200000;
  const ruleIdEnd = 1204999;
  const carouselRegex = '^https://www\\.bing\\.com/hp/api/v1/carousel(\\?.*)?$';
  let serial = Promise.resolve();

  function enqueue(task) {
    const next = serial.then(task, task);
    serial = next.catch(() => {});
    return next;
  }

  async function preferences() {
    const stored = await chrome.storage.local.get(api.storageKey);
    return api.normalize(stored[api.storageKey]);
  }

  function shouldBlock(prefs) {
    return prefs.enabled && prefs.news === 'off';
  }

  async function readRecords() {
    const stored = await chrome.storage.session.get(recordKey);
    const value = stored[recordKey];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  async function writeRecords(records) {
    await chrome.storage.session.set({ [recordKey]: records });
  }

  async function ownRules() {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return rules.filter(rule => rule.id >= ruleIdStart && rule.id <= ruleIdEnd);
  }

  async function removeTabRule(tabId) {
    const ids = (await ownRules())
      .filter(rule => rule.condition.tabIds?.includes(tabId))
      .map(rule => rule.id);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  }

  function makeRule(id, tabId) {
    return {
      id,
      priority: 1,
      action: { type: 'block' },
      condition: {
        regexFilter: carouselRegex,
        resourceTypes: ['xmlhttprequest'],
        tabIds: [tabId]
      }
    };
  }

  async function ensureTabRule(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab id');
    const regexCheck = await chrome.declarativeNetRequest.isRegexSupported({ regex: carouselRegex });
    if (!regexCheck.isSupported) throw new Error(`Unsupported carousel rule: ${regexCheck.reason || 'regex rejected'}`);
    const rules = await ownRules();
    const forTab = rules.filter(rule => rule.condition.tabIds?.includes(tabId));
    if (forTab.length === 1 && forTab[0].condition.regexFilter === carouselRegex) return true;
    const removeRuleIds = forTab.map(rule => rule.id);
    const usedIds = new Set(rules.filter(rule => !removeRuleIds.includes(rule.id)).map(rule => rule.id));
    let id = ruleIdStart;
    while (id <= ruleIdEnd && usedIds.has(id)) id += 1;
    if (id > ruleIdEnd) throw new Error('No session rule id available');
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: [makeRule(id, tabId)]
    });
    return true;
  }

  async function syncTab(tabId, record, prefs) {
    const active = ['awaiting-navigation', 'home-loading', 'home'].includes(record.phase);
    if (active && shouldBlock(prefs)) await ensureTabRule(tabId);
    else await removeTabRule(tabId);
  }

  async function prepareNewTab(tabId) {
    const records = await readRecords();
    const record = { phase: 'awaiting-navigation' };
    records[String(tabId)] = record;
    await writeRecords(records);
    const prefs = await preferences();
    try { await syncTab(tabId, record, prefs); }
    catch (error) {
      delete records[String(tabId)];
      await writeRecords(records);
      try { await removeTabRule(tabId); } catch { /* Keep the homepage fallback available. */ }
      throw error;
    }
    return { ok: true, ruleActive: shouldBlock(prefs) };
  }

  async function reconcilePreferences() {
    const [records, prefs] = await Promise.all([readRecords(), preferences()]);
    for (const [rawId, record] of Object.entries(records)) {
      const tabId = Number(rawId);
      if (!Number.isInteger(tabId)) continue;
      if (record.phase !== 'awaiting-navigation') {
        let currentUrl;
        try { currentUrl = (await chrome.tabs.get(tabId))?.url; } catch { currentUrl = undefined; }
        if (!api.isHomepage(currentUrl)) {
          delete records[rawId];
          await removeTabRule(tabId);
          continue;
        }
      }
      await syncTab(tabId, record, prefs);
    }
    await writeRecords(records);
  }

  async function homepageReady(tabId, senderUrl) {
    if (!api.isHomepage(senderUrl)) return { ok: false };
    const records = await readRecords();
    const record = records[String(tabId)];
    if (!record) return { ok: true, managed: false };
    record.phase = 'home';
    records[String(tabId)] = record;
    await writeRecords(records);
    await syncTab(tabId, record, await preferences());
    return { ok: true, managed: true };
  }

  async function tabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
    const records = await readRecords();
    const key = String(tabId);
    const record = records[key];
    if (!record) return;

    const url = changeInfo.url || tab?.url;
    if (changeInfo.status === 'loading') {
      if (record.phase === 'awaiting-navigation') {
        // The newtab bridge registers its rule before updating this tab's URL.
        record.phase = 'home-loading';
        records[key] = record;
        await writeRecords(records);
        await syncTab(tabId, record, await preferences());
        return;
      }
      if (api.isHomepage(url)) {
        record.phase = 'home-loading';
        records[key] = record;
        await writeRecords(records);
        await syncTab(tabId, record, await preferences());
      } else {
        delete records[key];
        await writeRecords(records);
        await removeTabRule(tabId);
      }
      return;
    }

    if (url && api.isHomepage(url)) {
      record.phase = 'home';
      records[key] = record;
      await writeRecords(records);
      await syncTab(tabId, record, await preferences());
    } else if (url) {
      delete records[key];
      await writeRecords(records);
      await removeTabRule(tabId);
    } else if (record.phase !== 'awaiting-navigation') {
      // A completed cross-origin navigation may omit its URL when this
      // extension lacks access to that destination. Unknown completed
      // documents are not managed Bing homepages, so remove the tab rule.
      // Keep only the bridge's pending record until its first navigation.
      delete records[key];
      await writeRecords(records);
      await removeTabRule(tabId);
    }
  }

  async function removeManagedTab(tabId) {
    await removeTabRule(tabId);
    const records = await readRecords();
    delete records[String(tabId)];
    await writeRecords(records);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'bhp:prepare-newtab') {
      const expectedUrl = chrome.runtime.getURL('newtab.html');
      if (sender.url !== expectedUrl) { sendResponse({ ok: false }); return false; }
      const tabId = Number.isInteger(sender.tab?.id) ? sender.tab.id : message.tabId;
      enqueue(() => prepareNewTab(tabId)).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
    if (message?.type === 'bhp:cancel-newtab') {
      const expectedUrl = chrome.runtime.getURL('newtab.html');
      if (sender.url !== expectedUrl) { sendResponse({ ok: false }); return false; }
      const tabId = Number.isInteger(sender.tab?.id) ? sender.tab.id : message.tabId;
      if (!Number.isInteger(tabId) || tabId < 0) { sendResponse({ ok: false }); return false; }
      // This is intentionally queued after any pending prepare operation: if
      // that operation finishes late, its newly-created rule is removed here.
      enqueue(() => removeManagedTab(tabId)).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false })
      );
      return true;
    }
    if (message?.type === 'bhp:homepage-ready') {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) { sendResponse({ ok: false }); return false; }
      enqueue(() => homepageReady(tabId, sender.url)).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[api.storageKey]) void enqueue(reconcilePreferences);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void enqueue(() => tabUpdated(tabId, changeInfo, tab));
  });

  chrome.tabs.onRemoved.addListener(tabId => {
    void enqueue(() => removeManagedTab(tabId));
  });

  chrome.runtime.onStartup.addListener(() => { void enqueue(reconcilePreferences); });
  chrome.runtime.onInstalled.addListener(() => { void enqueue(reconcilePreferences); });
})();
