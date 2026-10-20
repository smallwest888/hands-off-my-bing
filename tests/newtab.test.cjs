const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const extension = path.resolve(__dirname, '../src');
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
const source = fs.readFileSync(path.join(extension, 'newtab.js'), 'utf8');
const html = fs.readFileSync(path.join(extension, 'newtab.html'), 'utf8');
const css = fs.readFileSync(path.join(extension, 'newtab.css'), 'utf8');
assert.doesNotMatch(html, /<img\b|<h[1-6]\b|<title>[^<]+/i, 'the bridge starts visually blank without branding or status text');
assert.match(html, /id="fallback" hidden/, 'manual link is hidden unless navigation fails or the bridge is restored');
assert.match(css, /color-scheme:\s*light dark/);
assert.match(css, /background:\s*Canvas/);

async function runBridge(responses, {
  accelerateTimeouts = false,
  tabId = 44,
  historyState = { existing: 'preserved' },
  initialMarker = false,
  updateError = null,
  prepareNeverSettles = false
} = {}) {
  const order = [];
  const calls = [];
  const listeners = new Map();
  const fallback = { hidden: true };
  const message = { textContent: 'original', dataset: {} };
  let currentHistoryState = initialMarker ? { __bingHomePreferencesReturnToNewtab: true } : historyState;
  const script = accelerateTimeouts
    ? source.replace('registrationTimeoutMs = 1500', 'registrationTimeoutMs = 15').replace('cancellationTimeoutMs = 150', 'cancellationTimeoutMs = 10')
    : source;
  const context = vm.createContext({
    document: { getElementById: id => id === 'fallback' ? fallback : id === 'fallback-message' ? message : null },
    BingHomeI18n: { t(key) { return ({ ntFallback: 'Bing could not be opened. Use the link below.', ntNoTab: 'Could not verify this new tab. Open Bing manually.', ntUnsafe: 'Bing could not be opened safely. Open it manually.', ntReturned: 'Returned to the new-tab page. Select Open Bing to continue.' })[key]; } },
    window: {
      addEventListener(type, listener) { listeners.set(type, listener); }
    },
    chrome: {
      runtime: {
        getURL(file) { return `chrome-extension://test/${file}`; },
        lastError: null,
        sendMessage(request) {
          order.push(request.type);
          const response = responses[request.type];
          if (request.type === 'bhp:prepare-newtab' && prepareNeverSettles) return new Promise(() => {});
          return typeof response === 'function' ? response(request) : response;
        }
      },
      tabs: {
        getCurrent(callback) { order.push('tab-id'); callback(tabId == null ? undefined : { id: tabId }); },
        update(id, options, callback) {
          calls.push({ id, options });
          order.push(`update:${id}:${options.url}`);
          if (updateError) {
            context.chrome.runtime.lastError = { message: updateError };
            callback(undefined);
            context.chrome.runtime.lastError = null;
          } else callback({ id, url: options.url });
        }
      }
    },
    history: {
      get state() { return currentHistoryState; },
      replaceState(state, _unused, url) {
        order.push(`history:${url}`);
        currentHistoryState = state;
      }
    },
    location: { href: 'chrome-extension://test/newtab.html' },
    Promise, setTimeout, clearTimeout, console
  });
  vm.runInContext(script, context, { filename: 'newtab.js' });
  await new Promise(resolve => setTimeout(resolve, accelerateTimeouts ? 60 : 30));
  return {
    order, calls,
    get fallbackHidden() { return fallback.hidden; },
    get message() { return message.textContent; },
    historyState: () => currentHistoryState,
    emit(type, event = {}) { listeners.get(type)?.(event); },
    resolvePrepare: responses.resolvePrepare
  };
}

(async () => {
  const success = await runBridge({ 'bhp:prepare-newtab': Promise.resolve({ ok: true, ruleActive: true }) });
  assert.deepEqual(success.order, ['tab-id', 'bhp:prepare-newtab', 'history:chrome-extension://test/newtab.html', 'update:44:https://www.bing.com/']);
  assert.deepEqual(JSON.parse(JSON.stringify(success.calls)), [{ id: 44, options: { url: 'https://www.bing.com/' } }], 'only the bridge own tab is updated, without active/highlighted changes');
  assert.equal(success.fallbackHidden, true, 'normal navigation adds no intermediate text or wait');
  assert.equal(success.historyState().__bingHomePreferencesReturnToNewtab, true, 'the current bridge entry is marked before navigation');
  assert.equal(success.historyState().existing, 'preserved', 'existing object state is retained');

  const rejected = await runBridge({
    'bhp:prepare-newtab': Promise.reject(new Error('worker unavailable')),
    'bhp:cancel-newtab': Promise.resolve({ ok: true })
  });
  assert.deepEqual(rejected.order, ['tab-id', 'bhp:prepare-newtab', 'bhp:cancel-newtab', 'history:chrome-extension://test/newtab.html', 'update:44:https://www.bing.com/']);
  assert.equal(rejected.fallbackHidden, true, 'a worker rejection still fails open using tabs.update');

  const timedOut = await runBridge({
    'bhp:cancel-newtab': Promise.resolve({ ok: true })
  }, { accelerateTimeouts: true, prepareNeverSettles: true });
  assert.deepEqual(timedOut.order, ['tab-id', 'bhp:prepare-newtab', 'bhp:cancel-newtab', 'history:chrome-extension://test/newtab.html', 'update:44:https://www.bing.com/']);
  assert.equal(timedOut.fallbackHidden, true, 'a never-resolving worker is bounded and fails open without replace');

  const missingId = await runBridge({ 'bhp:prepare-newtab': Promise.resolve({ ok: true }) }, { tabId: null });
  assert.deepEqual(missingId.order, ['tab-id'], 'without the bridge own tab id, no prepare or navigation is attempted');
  assert.deepEqual(missingId.calls, []);
  assert.equal(missingId.fallbackHidden, false, 'missing tab id shows an explicit manual link');

  const updateFailed = await runBridge({
    'bhp:prepare-newtab': Promise.resolve({ ok: true }),
    'bhp:cancel-newtab': Promise.resolve({ ok: true })
  }, { updateError: 'tab no longer exists' });
  assert.equal(updateFailed.fallbackHidden, false, 'update failure exposes the manual link');
  assert.equal(updateFailed.message, 'Bing could not be opened. Use the link below.');
  assert.deepEqual(JSON.parse(JSON.stringify(updateFailed.historyState())), { existing: 'preserved' }, 'update failure removes its history marker');
  assert.equal(updateFailed.order.some(item => item.startsWith('update:')), true);
  assert.equal(updateFailed.order.some(item => item.startsWith('replace:')), false, 'navigation failure never falls back to location.replace');

  const restoredBridge = await runBridge({}, { initialMarker: true });
  assert.deepEqual(restoredBridge.order, [], 'Back-restored bridge does not prepare or navigate again');
  assert.equal(restoredBridge.fallbackHidden, false);
  assert.equal(restoredBridge.message, 'Returned to the new-tab page. Select Open Bing to continue.');

  let resolvePrepare;
  const pending = runBridge({
    'bhp:prepare-newtab': () => new Promise(resolve => { resolvePrepare = resolve; }),
    'bhp:cancel-newtab': Promise.resolve({ ok: true })
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const pendingResult = await pending;
  pendingResult.emit('pagehide');
  resolvePrepare({ ok: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(pendingResult.calls.length, 0, 'leaving the bridge before prepare resolves prevents a late tab update');
  assert.equal(pendingResult.order.includes('bhp:cancel-newtab'), true, 'leaving the bridge cancels its pending rule preparation');

  const bfcache = await runBridge({ 'bhp:prepare-newtab': Promise.resolve({ ok: true }) });
  bfcache.emit('pageshow', { persisted: true });
  assert.equal(bfcache.fallbackHidden, false, 'BFCache restoration provides the manual link');
  assert.equal(bfcache.message, 'Returned to the new-tab page. Select Open Bing to continue.');
  console.log(`${manifest.version} newtab bridge tests passed: own-tab tabs.update; prepare-before-navigation and bounded fail-open; no active-tab fallback; history marker prevents Back loop; update errors, missing ids, pagehide and BFCache are handled safely.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
