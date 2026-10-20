const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../src/focus-guard.js'), 'utf8');

function run({ url = 'https://www.bing.com/', top = true, autofocus = false, hasFocus = true } = {}) {
  const listeners = new Map();
  let timerFn;
  let nextTimerId = 11;
  const timers = new Map();
  const intervals = new Map();
  const responses = [];
  let observerInstance;
  const calls = [];
  let focusValue = hasFocus;
  class HTMLElement {
    constructor(id, hasAutofocus = false) { this.id = id; this.nodeType = 1; this.attrs = new Set(hasAutofocus ? ['autofocus'] : []); this.removed = []; }
    hasAttribute(name) { return this.attrs.has(name); }
    removeAttribute(name) { this.attrs.delete(name); this.removed.push(name); }
    querySelectorAll(selector) { return selector === '#sb_form_q[autofocus]' ? this.descendants || [] : []; }
    focus(...args) { calls.push({ receiver: this, args }); return 'native-result'; }
  }
  const prototype = HTMLElement.prototype;
  const target = new HTMLElement('sb_form_q', autofocus);
  const other = new HTMLElement('not-the-search-box');
  const doc = {
    querySelectorAll() { return []; },
    getElementById(id) { return id === 'sb_form_q' ? target : null; },
    hasFocus() { if (hasFocus === 'throws') throw new Error('focus unavailable'); return focusValue; },
    documentElement: {
      attrs: new Map(),
      setAttribute(name, value) { this.attrs.set(name, String(value)); },
      getAttribute(name) { return this.attrs.get(name) ?? null; },
      removeAttribute(name) { this.attrs.delete(name); }
    }
  };
  if (hasFocus === 'missing') delete doc.hasFocus;
  const window = {
    top: null,
    addEventListener(name, fn, capture) { (listeners.get(name) || listeners.set(name, []).get(name)).push({ fn, capture }); },
    removeEventListener(name, fn, capture) { listeners.set(name, (listeners.get(name) || []).filter(item => item.fn !== fn || item.capture !== capture)); },
    dispatchEvent(event) {
      for (const { fn } of [...(listeners.get(event.type) || [])]) fn(event);
      if (event.type === 'bhp:focus-lease-response') responses.push(JSON.parse(event.detail));
      return true;
    }
  };
  window.top = top ? window : {};
  class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.isTrusted = false; } }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observerInstance = this; }
    observe(node, options) { this.node = node; this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const context = {
    window, document: doc, HTMLElement, MutationObserver, CustomEvent, URL,
    location: { href: url },
    setTimeout(fn, ms) { const id = nextTimerId++; timers.set(id, { fn, ms }); if (ms === 20000 && !timerFn) timerFn = fn; return id; },
    clearTimeout(id) { timers.delete(id); if (timerFn && ![...timers.values()].some(item => item.fn === timerFn)) timerFn = null; },
    setInterval(fn, ms) { const id = nextTimerId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
  vm.runInNewContext(source, context, { filename: 'focus-guard.js' });
  return {
    prototype, target, other, doc, listeners, calls, responses, timers, intervals, timer: () => timerFn,
    setFocus(value) { focusValue = value; },
    requestLease(payload) { window.dispatchEvent(new CustomEvent('bhp:focus-lease-request', { detail: JSON.stringify(payload) })); },
    tickIntervals() { for (const { fn } of [...intervals.values()]) fn(); },
    dispatchPagehide() { for (const { fn } of [...(listeners.get('pagehide') || [])]) fn({ type: 'pagehide', isTrusted: false }); },
    dispatchWindow(name, event = {}) { for (const { fn } of [...(listeners.get(name) || [])]) fn({ type: name, isTrusted: false, ...event }); },
    observer: () => observerInstance,
    dispatch(name, init = {}) {
      const event = { isTrusted: true, type: name, ...init };
      for (const { fn } of listeners.get(name) || []) fn(event);
    }
  };
}

const homepage = run({ autofocus: true });
const guarded = homepage.prototype.focus;
assert.notEqual(guarded, undefined);
assert.equal(homepage.target.hasAttribute('autofocus'), false, 'existing search autofocus is removed');
assert.equal(homepage.prototype.focus.call(homepage.target, { preventScroll: true }), undefined, 'programmatic focus on the search box is suppressed');
assert.equal(homepage.calls.length, 0);
assert.equal(homepage.prototype.focus.call(homepage.other, 'arg'), 'native-result', 'other elements use native focus');
assert.equal(homepage.calls.length, 1);
assert.equal(homepage.calls[0].receiver, homepage.other, 'native receiver is preserved');
assert.equal(homepage.calls[0].args[0], 'arg', 'native arguments are preserved');
assert.equal(homepage.observer().options.subtree, true);

const dynamic = new homepage.target.constructor('wrapper');
const newSearch = new homepage.target.constructor('sb_form_q', true);
dynamic.descendants = [newSearch];
homepage.observer().callback([{ type: 'childList', addedNodes: [dynamic] }]);
assert.equal(newSearch.hasAttribute('autofocus'), false, 'autofocus on a later inserted search node is removed');
homepage.dispatch('pointerdown');
assert.equal(homepage.prototype.focus, homepage.prototype.focus, 'focus prototype remains callable after trusted interaction');
assert.notEqual(homepage.prototype.focus, guarded, 'trusted interaction restores the original method');
assert.equal(homepage.observer().disconnected, true);
assert.equal(homepage.listeners.get('pointerdown').length, 1, 'the single trusted-interaction listener remains available for bounded future leases');
assert.equal(homepage.prototype.focus.call(homepage.target), 'native-result', 'search focus is allowed after trusted interaction');

const timed = run();
const timedGuard = timed.prototype.focus;
timed.timer()();
assert.notEqual(timed.prototype.focus, timedGuard, 'the 20-second timer restores native focus behavior');
assert.equal(timed.observer().disconnected, true);

for (const shortcut of [
  { key: 'l', metaKey: true },
  { key: 'l', ctrlKey: true },
  { key: 'Meta' },
  { key: 'Control' },
  { key: 'Alt' }
]) {
  const protectedShortcut = run();
  const before = protectedShortcut.prototype.focus;
  protectedShortcut.dispatch('keydown', shortcut);
  assert.equal(protectedShortcut.prototype.focus, before, 'address-bar shortcuts and modifier-only keys do not release guard');
}
for (const pageKey of [{ key: 'x' }, { key: 'Enter' }, { key: 'Tab' }, { key: 'X', shiftKey: true }]) {
  const pageInteraction = run();
  const before = pageInteraction.prototype.focus;
  pageInteraction.dispatch('keydown', pageKey);
  assert.notEqual(pageInteraction.prototype.focus, before, 'ordinary page keyboard interaction releases guard');
}

for (const input of [
  { url: 'https://www.bing.com/search?q=weather' },
  { url: 'https://cn.bing.com/images/search?q=x' },
  { url: 'https://evilbing.com/' },
  { url: 'http://www.bing.com/' },
  { url: 'https://bing.com/path' },
  { url: 'https://www.bing.com/', top: false }
]) {
  const excluded = run(input);
  assert.equal(excluded.listeners.size, 0, `guard does not install for ${input.url}`);
  assert.equal(excluded.observer(), undefined);
  const native = excluded.prototype.focus;
  assert.equal(native.call(excluded.target), 'native-result');
  assert.equal(excluded.calls.length, 1);
}

const replacedByOther = run();
const ourGuard = replacedByOther.prototype.focus;
const thirdPartyFocus = function (...args) { return `third:${args.length}`; };
replacedByOther.prototype.focus = thirdPartyFocus;
replacedByOther.timer()();
assert.equal(replacedByOther.prototype.focus, thirdPartyFocus, 'cleanup does not overwrite a later prototype owner');
assert.notEqual(replacedByOther.prototype.focus, ourGuard);

const leased = run({ hasFocus: false });
leased.requestLease({ op: 'begin', nonce: 'lease-nonce-0001', revision: 4, ttlMs: 1000 });
const leaseAck = leased.responses.find(message => message.op === 'ack');
assert.ok(leaseAck, 'a current unfocused top-level homepage can grant a lease');
assert.equal(leaseAck.revision, 4);
assert.ok(leaseAck.expiresAt <= Date.now() + 1100, 'lease lifetime is bounded by requested TTL');
assert.equal(leased.prototype.focus.call(leased.other), undefined, 'while unfocused the lease suppresses programmatic focus for every element');
assert.equal(leased.calls.length, 0);
const liveMarker = JSON.parse(leased.doc.documentElement.getAttribute('data-bhp-focus-lease'));
assert.equal(liveMarker.nonce, 'lease-nonce-0001');
assert.equal(liveMarker.revision, 4);
assert.equal(liveMarker.expiresAt, leaseAck.expiresAt);
leased.requestLease({ op: 'validate', nonce: 'lease-nonce-0001', revision: 4 });
assert.equal(leased.responses.at(-1).op, 'valid', 'each background click can synchronously revalidate its current lease');
assert.equal(leased.responses.at(-1).expiresAt, leaseAck.expiresAt);
leased.dispatch('keydown', { key: 'l', metaKey: true });
assert.equal(leased.responses.some(message => message.op === 'ended'), false, 'Cmd+L does not terminate the lease');
leased.dispatch('keydown', { key: 'x' });
assert.equal(leased.responses.at(-1).reason, 'trusted-interaction', 'ordinary trusted input revokes the lease');
assert.equal(leased.prototype.focus.call(leased.other), 'native-result', 'the native focus method is restored after revocation');
assert.equal(leased.doc.documentElement.getAttribute('data-bhp-focus-lease'), null);

const focusedLeaseRequest = run({ hasFocus: true });
focusedLeaseRequest.requestLease({ op: 'begin', nonce: 'lease-nonce-0002', revision: 1, ttlMs: 1000 });
assert.equal(focusedLeaseRequest.responses.at(-1).op, 'denied', 'foreground documents do not receive a background lease');

for (const focusState of ['missing', 'throws']) {
  const unknownFocus = run({ hasFocus: focusState });
  unknownFocus.requestLease({ op: 'begin', nonce: `lease-unknown-${focusState}`, revision: 1, ttlMs: 1000 });
  assert.equal(unknownFocus.responses.at(-1).op, 'denied', `unavailable focus state (${focusState}) fails closed`);
}

const expiredLease = run({ hasFocus: false });
expiredLease.requestLease({ op: 'begin', nonce: 'lease-nonce-0003', revision: 2, ttlMs: 1000 });
const leaseTimer = [...expiredLease.timers.values()].find(item => item.ms === 1000);
assert.ok(leaseTimer);
leaseTimer.fn();
assert.equal(expiredLease.responses.at(-1).reason, 'expired');
assert.equal(expiredLease.prototype.focus.call(expiredLease.other), 'native-result', 'expired leases stop blocking focus');

const ownerChangesDuringLease = run({ hasFocus: false });
ownerChangesDuringLease.requestLease({ op: 'begin', nonce: 'lease-nonce-0004', revision: 3, ttlMs: 1000 });
const laterOwner = function () { return 'later-owner'; };
ownerChangesDuringLease.prototype.focus = laterOwner;
ownerChangesDuringLease.requestLease({ op: 'validate', nonce: 'lease-nonce-0004', revision: 3 });
assert.equal(ownerChangesDuringLease.responses.at(-1).op, 'denied', 'a replaced prototype owner is rejected at the next click validation');
ownerChangesDuringLease.tickIntervals();
assert.equal(ownerChangesDuringLease.prototype.focus, laterOwner, 'lease cleanup never overwrites a later page owner');
assert.equal(ownerChangesDuringLease.doc.documentElement.getAttribute('data-bhp-focus-lease'), null);

const restoredLease = run({ hasFocus: false });
restoredLease.dispatchPagehide();
assert.equal(restoredLease.listeners.get('bhp:focus-lease-request').length, 0, 'pagehide removes the request listener');
restoredLease.dispatchWindow('pageshow', { persisted: true });
assert.equal(restoredLease.listeners.get('bhp:focus-lease-request').length, 1, 'BFCache pageshow reinstalls the lease request listener');
restoredLease.requestLease({ op: 'begin', nonce: 'lease-after-bfcache', revision: 7, ttlMs: 1000 });
assert.equal(restoredLease.responses.at(-1).op, 'ack', 'a restored homepage can obtain a fresh bounded lease');

console.log('PASS: search-only programmatic focus guard is root-path/top-frame scoped, preserves all other native focus calls, removes autofocus attributes, restores on trusted interaction or timeout, and respects third-party prototype replacement.');
