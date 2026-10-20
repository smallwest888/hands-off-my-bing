const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '../src');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.equal(manifest.minimum_chrome_version, '111');
assert.deepEqual(manifest.permissions, ['storage', 'declarativeNetRequestWithHostAccess']);
const guard = manifest.content_scripts.find(script => script.js.includes('focus-guard.js'));
assert.ok(guard);
assert.equal(guard.world, 'MAIN');
assert.equal(guard.run_at, 'document_start');
assert.deepEqual(guard.include_globs, manifest.content_scripts[1].include_globs);
assert.deepEqual(manifest.host_permissions, ['https://www.bing.com/*']);
assert.equal(manifest.permissions.includes('tabs'), false);
const events = () => {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
};

const localData = { homepagePreferences: { enabled: true, menu: 'off', news: 'off', trending: 'off', image: 'keep', switchDelayMs: 80 } };
const sessionData = {};
let rules = [];
let regexSupportGate = null;
const runtime = { onMessage: events(), onStartup: events(), onInstalled: events(), getURL: file => `chrome-extension://test/${file}` };
const localChange = events();
const updated = events();
const removed = events();
const chrome = {
  runtime,
  storage: {
    local: { async get(key) { return { [key]: localData[key] }; } },
    session: {
      async get(key) { return { [key]: sessionData[key] }; },
      async set(value) { Object.assign(sessionData, value); }
    },
    onChanged: localChange
  },
  declarativeNetRequest: {
    async getSessionRules() { return structuredClone(rules); },
    async isRegexSupported({ regex }) {
      if (regexSupportGate) return regexSupportGate;
      try { new RegExp(regex); return { isSupported: true }; } catch { return { isSupported: false, reason: 'invalid regex' }; }
    },
    async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
      rules = rules.filter(rule => !removeRuleIds.includes(rule.id)).concat(structuredClone(addRules));
    }
  },
  tabs: {
    onUpdated: updated,
    onRemoved: removed,
    async get(tabId) { return { id: tabId, url: 'https://www.bing.com/' }; }
  }
};
const context = vm.createContext({ chrome, console, URL, setTimeout, clearTimeout });
context.importScripts = file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
vm.runInContext(fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8'), context, { filename: 'service-worker.js' });

function send(message, sender) {
  return new Promise((resolve, reject) => {
    try {
      const keepAlive = runtime.onMessage.listeners.map(listener => listener(message, sender, resolve)).some(Boolean);
      if (!keepAlive) resolve(undefined);
      setTimeout(() => reject(new Error(`message timeout: ${message.type}`)), 500);
    } catch (error) { reject(error); }
  });
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }

(async () => {
  const prepared = await send({ type: 'bhp:prepare-newtab', tabId: 17 }, {
    url: runtime.getURL('newtab.html'), tab: { id: 17 }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), { ok: true, ruleActive: true });
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].condition.tabIds, [17]);
  assert.deepEqual(rules[0].condition.resourceTypes, ['xmlhttprequest']);
  assert.match(rules[0].condition.regexFilter, /www\\\.bing\\\.com\/hp\/api\/v1\/carousel/);
  const regex = new RegExp(rules[0].condition.regexFilter);
  assert.equal(regex.test('https://www.bing.com/hp/api/v1/carousel?format=json'), true);
  assert.equal(regex.test('https://www.bing.com/hp/api/v1/carousel'), true);
  assert.equal(regex.test('https://www.bing.com/search?q=weather'), false);
  assert.equal(regex.test('https://www.bing.com/hp/api/v1/carouselx?x=1'), false);
  assert.equal(regex.test('https://cn.bing.com/hp/api/v1/carousel?x=1'), false);

  await send({ type: 'bhp:homepage-ready' }, { url: 'https://www.bing.com/', tab: { id: 17 } });
  localData.homepagePreferences.news = 'keep';
  localChange.emit({ homepagePreferences: {} }, 'local');
  await settle();
  assert.equal(rules.length, 0, 'keep must remove the block rule');

  localData.homepagePreferences.news = 'off';
  localChange.emit({ homepagePreferences: {} }, 'local');
  await settle();
  assert.equal(rules.length, 1, 'switching back to off on a managed homepage reinstalls the rule');

  updated.emit(17, { status: 'loading', url: 'https://www.bing.com/search?q=weather' }, { id: 17, url: 'https://www.bing.com/search?q=weather' });
  await settle();
  assert.equal(rules.length, 0, 'leaving root for search must remove the rule');
  assert.equal(Object.hasOwn(sessionData.bhpManagedHomeTabs, '17'), false);

  await send({ type: 'bhp:prepare-newtab', tabId: 23 }, { url: runtime.getURL('newtab.html'), tab: { id: 23 } });
  assert.equal(rules.length, 1);
  localData.homepagePreferences.enabled = false;
  localChange.emit({ homepagePreferences: {} }, 'local');
  await settle();
  assert.equal(rules.length, 0, 'pause must remove all managed rules');
  localData.homepagePreferences.enabled = true;
  localChange.emit({ homepagePreferences: {} }, 'local');
  await settle();
  assert.equal(rules.length, 1, 'reenabling with news off restores only the managed tab rule');

  removed.emit(23);
  await settle();
  assert.equal(rules.length, 0, 'closing a tab removes its rule');
  assert.equal(Object.hasOwn(sessionData.bhpManagedHomeTabs, '23'), false);

  localData.homepagePreferences.news = 'keep';
  const noRule = await send({ type: 'bhp:prepare-newtab', tabId: 31 }, { url: runtime.getURL('newtab.html'), tab: { id: 31 } });
  assert.deepEqual(JSON.parse(JSON.stringify(noRule)), { ok: true, ruleActive: false });
  assert.equal(rules.length, 0);
  const spoofed = await send({ type: 'bhp:prepare-newtab', tabId: 32 }, { url: 'https://example.org/' });
  assert.deepEqual(JSON.parse(JSON.stringify(spoofed)), { ok: false }, 'untrusted web sender is rejected');

  // A completed bridge page can have no readable URL before replace(); retain
  // this only while it is still in the awaiting-navigation phase.
  await send({ type: 'bhp:prepare-newtab', tabId: 41 }, {
    url: runtime.getURL('newtab.html'), tab: { id: 41 }
  });
  updated.emit(41, { status: 'complete' }, { id: 41 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(Object.hasOwn(sessionData.bhpManagedHomeTabs, '41'), true, 'unknown bridge completion must preserve pending state');
  const cancelled = await send({ type: 'bhp:cancel-newtab', tabId: 41 }, {
    url: runtime.getURL('newtab.html'), tab: { id: 41 }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)), { ok: true });
  assert.equal(Object.hasOwn(sessionData.bhpManagedHomeTabs, '41'), false);

  // If a completed destination URL is hidden, discard an active homepage
  // record and its rule instead of leaving a stale blocker behind.
  localData.homepagePreferences.news = 'off';
  await send({ type: 'bhp:prepare-newtab', tabId: 42 }, {
    url: runtime.getURL('newtab.html'), tab: { id: 42 }
  });
  updated.emit(42, { status: 'loading', url: 'https://www.bing.com/' }, { id: 42, url: 'https://www.bing.com/' });
  updated.emit(42, { status: 'complete', url: 'https://www.bing.com/' }, { id: 42, url: 'https://www.bing.com/' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rules.some(rule => rule.condition.tabIds.includes(42)), true);
  updated.emit(42, { status: 'complete' }, { id: 42 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rules.some(rule => rule.condition.tabIds.includes(42)), false, 'unknown completed destination must clear active rule');
  assert.equal(Object.hasOwn(sessionData.bhpManagedHomeTabs, '42'), false);

  // A service worker restart reconciles persisted records with session rules.
  await send({ type: 'bhp:prepare-newtab', tabId: 43 }, {
    url: runtime.getURL('newtab.html'), tab: { id: 43 }
  });
  updated.emit(43, { status: 'loading', url: 'https://www.bing.com/' }, { id: 43, url: 'https://www.bing.com/' });
  updated.emit(43, { status: 'complete', url: 'https://www.bing.com/' }, { id: 43, url: 'https://www.bing.com/' });
  await new Promise(resolve => setTimeout(resolve, 20));
  rules = [];
  runtime.onStartup.emit();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(rules.some(rule => rule.condition.tabIds.includes(43)), true, 'startup reconciliation restores rule for active managed homepage');

  // A timed-out bridge can enqueue cancellation while preparation is still
  // waiting. Cancellation runs afterward and removes the late-installed rule.
  let finishRegexCheck;
  regexSupportGate = new Promise(resolve => { finishRegexCheck = resolve; });
  const pendingPreparation = send({ type: 'bhp:prepare-newtab', tabId: 44 }, {
    url: runtime.getURL('newtab.html'), tab: { id: 44 }
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const pendingCancellation = send({ type: 'bhp:cancel-newtab', tabId: 44 }, {
    url: runtime.getURL('newtab.html'), tab: { id: 44 }
  });
  finishRegexCheck({ isSupported: true });
  const [latePrepared, lateCancelled] = await Promise.all([pendingPreparation, pendingCancellation]);
  assert.deepEqual(JSON.parse(JSON.stringify(latePrepared)), { ok: true, ruleActive: true });
  assert.deepEqual(JSON.parse(JSON.stringify(lateCancelled)), { ok: true });
  assert.equal(rules.some(rule => rule.condition.tabIds.includes(44)), false, 'queued cancel must clear a rule installed by delayed preparation');
  assert.equal(Object.hasOwn(sessionData.bhpManagedHomeTabs, '44'), false);
  regexSupportGate = null;

  console.log(`${manifest.version} service-worker/manifest tests passed: narrow host+tab scope, preference sync, hidden-URL cleanup, pending bridge retention/cancel, startup reconciliation, close cleanup, keep/pause, and static MAIN document_start focus-guard scope.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
