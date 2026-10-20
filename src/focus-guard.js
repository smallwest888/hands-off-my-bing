(() => {
  'use strict';
  let current;
  try { current = new URL(location.href); } catch { return; }
  if (window.top !== window || current.protocol !== 'https:' ||
      !['www.bing.com', 'cn.bing.com', 'bing.com'].includes(current.hostname) || current.pathname !== '/') return;

  const requestEvent = 'bhp:focus-lease-request';
  const responseEvent = 'bhp:focus-lease-response';
  const leaseMarker = 'data-bhp-focus-lease';
  const maxLeaseMs = 20000;
  const prototype = globalThis.HTMLElement?.prototype;
  const originalFocus = prototype?.focus;
  if (typeof originalFocus !== 'function') return;

  let searchGuardActive = true;
  let lease = null;
  let observer = null;
  let searchTimer = null;
  let leaseTimer = null;
  let leaseWatchTimer = null;
  let lifecycleListenersInstalled = false;
  const removeSearchAutofocus = node => {
    if (node?.nodeType !== 1) return;
    if (node.id === 'sb_form_q' && node.hasAttribute('autofocus')) node.removeAttribute('autofocus');
    for (const input of node.querySelectorAll?.('#sb_form_q[autofocus]') || []) input.removeAttribute('autofocus');
  };
  const pageHasFocus = () => {
    try { return typeof document.hasFocus === 'function' && document.hasFocus() === true; }
    catch { return false; }
  };
  function dispatchResponse(payload) {
    try { window.dispatchEvent(new CustomEvent(responseEvent, { detail: JSON.stringify(payload) })); }
    catch { /* The isolated content script will fail closed if it gets no acknowledgement. */ }
  }
  function restoreWrapperIfIdle() {
    if (!searchGuardActive && !lease && prototype.focus === guardedFocus) prototype.focus = originalFocus;
  }
  function finishSearchGuard() {
    if (!searchGuardActive) return;
    searchGuardActive = false;
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = null;
    observer?.disconnect();
    observer = null;
    restoreWrapperIfIdle();
  }
  function endLease(reason) {
    const previous = lease;
    if (!previous) return;
    lease = null;
    if (leaseTimer !== null) clearTimeout(leaseTimer);
    leaseTimer = null;
    if (leaseWatchTimer !== null) clearInterval(leaseWatchTimer);
    leaseWatchTimer = null;
    try {
      const marker = JSON.parse(document.documentElement?.getAttribute(leaseMarker) || 'null');
      if (marker?.nonce === previous.nonce && marker?.revision === previous.revision &&
          marker?.expiresAt === previous.expiresAt) document.documentElement.removeAttribute(leaseMarker);
    } catch { /* A page-modified marker is left untouched; it never grants a lease. */ }
    restoreWrapperIfIdle();
    dispatchResponse({ op: 'ended', nonce: previous.nonce, revision: previous.revision, reason });
  }
  function guardedFocus(...args) {
    if (lease && prototype.focus !== guardedFocus) endLease('focus-owner-changed');
    if (lease && Date.now() < lease.expiresAt && !pageHasFocus()) return undefined;
    if (searchGuardActive && this?.id === 'sb_form_q') return undefined;
    return originalFocus.apply(this, args);
  }
  function installWrapper() {
    if (prototype.focus === guardedFocus) return true;
    // Never replace a focus implementation installed by the page after ours.
    if (prototype.focus !== originalFocus) return false;
    try { prototype.focus = guardedFocus; } catch { return false; }
    return prototype.focus === guardedFocus;
  }
  function onTrustedInteraction(event) {
    if (!event.isTrusted) return;
    if (event.type === 'keydown' && (event.metaKey || event.ctrlKey || event.altKey ||
        ['Meta', 'Control', 'Alt'].includes(event.key))) return;
    finishSearchGuard();
    endLease('trusted-interaction');
  }
  function parseDetail(event) {
    if (typeof event.detail !== 'string' || event.detail.length > 1024) return null;
    try { return JSON.parse(event.detail); } catch { return null; }
  }
  function onLeaseRequest(event) {
    const request = parseDetail(event);
    if (!request || typeof request.nonce !== 'string' || request.nonce.length < 8 || request.nonce.length > 128 ||
        !Number.isSafeInteger(request.revision) || request.revision < 0) return;
    if (request.op === 'end') {
      if (lease?.nonce === request.nonce && lease.revision === request.revision) endLease('content-ended');
      return;
    }
    if (request.op === 'validate') {
      let focused;
      try { focused = typeof document.hasFocus === 'function' ? document.hasFocus() : null; }
      catch { focused = null; }
      const page = (() => {
        try {
          const current = new URL(location.href);
          return window.top === window && current.protocol === 'https:' &&
            ['www.bing.com', 'cn.bing.com', 'bing.com'].includes(current.hostname) && current.pathname === '/';
        } catch { return false; }
      })();
      const marker = JSON.stringify(lease && {
        nonce: lease.nonce, revision: lease.revision, expiresAt: lease.expiresAt
      });
      const valid = page && focused === false && lease && lease.nonce === request.nonce &&
        lease.revision === request.revision && Date.now() < lease.expiresAt &&
        prototype.focus === guardedFocus && document.documentElement?.getAttribute(leaseMarker) === marker;
      if (!valid) {
        if (lease?.nonce === request.nonce && lease.revision === request.revision) endLease('validation-failed');
        dispatchResponse({ op: 'denied', nonce: request.nonce, revision: request.revision, reason: 'lease-invalid' });
      } else {
        dispatchResponse({ op: 'valid', nonce: lease.nonce, revision: lease.revision, expiresAt: lease.expiresAt });
      }
      return;
    }
    if (request.op !== 'begin' || !Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1) return;
    const ttlMs = Math.min(maxLeaseMs, request.ttlMs);
    endLease('replaced');
    let focused;
    try { focused = typeof document.hasFocus === 'function' ? document.hasFocus() : null; }
    catch { focused = null; }
    if (focused !== false || !installWrapper() || !document.documentElement?.setAttribute) {
      dispatchResponse({ op: 'denied', nonce: request.nonce, revision: request.revision, reason: 'focus-owner-changed' });
      return;
    }
    lease = { nonce: request.nonce, revision: request.revision, expiresAt: Date.now() + ttlMs };
    const markerValue = JSON.stringify(lease);
    document.documentElement.setAttribute(leaseMarker, markerValue);
    if (document.documentElement.getAttribute(leaseMarker) !== markerValue) {
      lease = null;
      restoreWrapperIfIdle();
      dispatchResponse({ op: 'denied', nonce: request.nonce, revision: request.revision, reason: 'marker-unavailable' });
      return;
    }
    leaseTimer = setTimeout(() => endLease('expired'), ttlMs);
    leaseWatchTimer = setInterval(() => {
      if (lease && prototype.focus !== guardedFocus) endLease('focus-owner-changed');
    }, 25);
    dispatchResponse({
      op: 'ack', nonce: lease.nonce, revision: lease.revision, expiresAt: lease.expiresAt
    });
  }

  function onWindowFocus() { endLease('page-focused'); }
  function onPageHide() {
    finishSearchGuard();
    endLease('pagehide');
    removeLifecycleListeners();
  }
  function installLifecycleListeners() {
    if (lifecycleListenersInstalled) return;
    lifecycleListenersInstalled = true;
    window.addEventListener('pointerdown', onTrustedInteraction, true);
    window.addEventListener('keydown', onTrustedInteraction, true);
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener(requestEvent, onLeaseRequest);
    window.addEventListener('pagehide', onPageHide, { once: true });
  }
  function removeLifecycleListeners() {
    if (!lifecycleListenersInstalled) return;
    lifecycleListenersInstalled = false;
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener(requestEvent, onLeaseRequest);
    window.removeEventListener('pointerdown', onTrustedInteraction, true);
    window.removeEventListener('keydown', onTrustedInteraction, true);
    window.removeEventListener('focus', onWindowFocus);
  }

  if (!installWrapper()) return;
  installLifecycleListeners();
  window.addEventListener('pageshow', event => {
    if (event.persisted) installLifecycleListeners();
  });
  searchTimer = setTimeout(finishSearchGuard, maxLeaseMs);

  try {
    observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') removeSearchAutofocus(record.target);
        else for (const node of record.addedNodes || []) removeSearchAutofocus(node);
      }
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['id', 'autofocus'] });
    removeSearchAutofocus(document.getElementById('sb_form_q'));
  } catch {
    observer?.disconnect();
    observer = null;
  }
})();
