(() => {
  'use strict';
  const api = globalThis.BingHomePreferences;
  if (!api.isHomepage(location.href)) return;

  // Confirm the bridged newtab reached Bing. Directly opened Bing pages have
  // no session block rule unless they came through the extension newtab page.
  try { void chrome.runtime.sendMessage({ type: 'bhp:homepage-ready' }).catch(() => {}); }
  catch { /* The normal native-toggle path remains available. */ }

  let revision = 0;
  let running = false;
  let settings = api.normalize();
  let status = { phase: 'loading', applied: [], missing: [], diagnostics: [] };
  const pendingWaits = new Set();
  const wakePendingWaits = () => { for (const wake of [...pendingWaits]) wake(); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let focusRetryPending = false;
  let focusResumeScheduled = false;
  let deferredMenuCleanup = null;
  let focusLease = null;
  let focusLeaseCounter = 0;
  let pageLeaving = false;
  let newsVisibilityStyle = null;
  const hasPageFocus = () => {
    try { return typeof document.hasFocus === 'function' && document.hasFocus() === true; }
    catch { return false; }
  };
  const focusLeaseRequestEvent = 'bhp:focus-lease-request';
  const focusLeaseResponseEvent = 'bhp:focus-lease-response';
  const focusLeaseMarker = 'data-bhp-focus-lease';
  const parseLeaseMessage = event => {
    if (typeof event?.detail !== 'string' || event.detail.length > 1024) return null;
    try { return JSON.parse(event.detail); } catch { return null; }
  };
  const hasCurrentLeaseMarker = (token, lease = focusLease) => {
    if (!lease?.active || lease.revision !== token || lease.expiresAt <= Date.now()) return false;
    try {
      const marker = JSON.parse(document.documentElement?.getAttribute(focusLeaseMarker) || 'null');
      return marker?.nonce === lease.nonce && marker?.revision === token && marker?.expiresAt === lease.expiresAt;
    } catch { return false; }
  };
  const safeClickAllowed = (token = revision) => hasPageFocus() || hasCurrentLeaseMarker(token);
  function onFocusLeaseResponse(event) {
    const message = parseLeaseMessage(event);
    if (!message || !focusLease || message.nonce !== focusLease.nonce || message.revision !== focusLease.revision) return;
    if (message.op === 'ended' || message.op === 'denied') {
      focusLease.active = false;
      wakePendingWaits();
    }
  }
  window.addEventListener(focusLeaseResponseEvent, onFocusLeaseResponse);
  function sendFocusLeaseEnd(lease) {
    if (!lease) return;
    try {
      window.dispatchEvent(new CustomEvent(focusLeaseRequestEvent, {
        detail: JSON.stringify({ op: 'end', nonce: lease.nonce, revision: lease.revision })
      }));
    } catch { /* A missing bridge never grants background clicks. */ }
  }
  function validateFocusLease(token) {
    if (hasPageFocus()) return true;
    const lease = focusLease;
    if (!lease || !hasCurrentLeaseMarker(token, lease)) return false;
    let validation = null;
    const onValidation = event => {
      const message = parseLeaseMessage(event);
      if (message?.nonce === lease.nonce && message?.revision === token &&
          ['valid', 'denied'].includes(message.op)) validation = message;
    };
    window.addEventListener(focusLeaseResponseEvent, onValidation);
    try {
      window.dispatchEvent(new CustomEvent(focusLeaseRequestEvent, {
        detail: JSON.stringify({ op: 'validate', nonce: lease.nonce, revision: token })
      }));
    } catch { validation = null; }
    finally { window.removeEventListener(focusLeaseResponseEvent, onValidation); }
    if (validation?.op !== 'valid' || validation.expiresAt !== lease.expiresAt ||
        !hasCurrentLeaseMarker(token, lease)) {
      lease.active = false;
      return false;
    }
    return true;
  }
  function revokeFocusLease() {
    if (!focusLease) return;
    sendFocusLeaseEnd(focusLease);
    focusLease.active = false;
    focusLease = null;
  }
  const removeDeferredInteractionListeners = () => {
    document.removeEventListener('pointerdown', cancelDeferredForUser, true);
    document.removeEventListener('keydown', cancelDeferredForUser, true);
  };
  const deferForPageFocus = (applied = [], missing = []) => {
    focusRetryPending = true;
    document.addEventListener('pointerdown', cancelDeferredForUser, true);
    document.addEventListener('keydown', cancelDeferredForUser, true);
    status = { phase: 'waiting-focus', applied: [...applied], missing: [...missing] };
  };
  function cancelDeferredForUser(event) {
    if (!event.isTrusted || (!focusRetryPending && !deferredMenuCleanup)) return;
    focusRetryPending = false;
    if (deferredMenuCleanup) {
      deferredMenuCleanup.veil?.remove();
      deferredMenuCleanup = null;
    }
    removeDeferredInteractionListeners();
    status = { phase: 'interrupted', applied: [], missing: [] };
  }
  function releaseDeferredMenuCleanup() {
    const cleanup = deferredMenuCleanup;
    if (!cleanup || !hasPageFocus() || pageLeaving) return false;
    deferredMenuCleanup = null;
    removeDeferredInteractionListeners();
    try {
      if (cleanup.button?.getAttribute('aria-expanded') === 'true' && hasPageFocus()) cleanup.button.click();
      if (hasPageFocus() && document.activeElement === cleanup.focusAfterOpen && cleanup.priorFocus?.isConnected) {
        cleanup.priorFocus.focus({ preventScroll: true });
      }
    } finally { cleanup.veil?.remove(); }
    return true;
  }
  function scheduleFocusResume() {
    if ((!focusRetryPending && !deferredMenuCleanup) || focusResumeScheduled) return;
    focusResumeScheduled = true;
    setTimeout(() => {
      focusResumeScheduled = false;
      if (!hasPageFocus() || pageLeaving) return;
      releaseDeferredMenuCleanup();
      if (focusRetryPending) {
        focusRetryPending = false;
        removeDeferredInteractionListeners();
        void requestApply();
      }
    }, 0);
  }
  window.addEventListener('focus', scheduleFocusResume);
  document.addEventListener('focusin', scheduleFocusResume, true);
  window.addEventListener('pagehide', () => {
    pageLeaving = true;
    focusRetryPending = false;
    wakePendingWaits();
    newsVisibilityStyle?.remove();
    newsVisibilityStyle = null;
    deferredMenuCleanup?.veil?.remove();
    deferredMenuCleanup = null;
    sendFocusLeaseEnd(focusLease);
    focusLease = null;
    window.removeEventListener(focusLeaseResponseEvent, onFocusLeaseResponse);
    removeDeferredInteractionListeners();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    window.removeEventListener(focusLeaseResponseEvent, onFocusLeaseResponse);
    window.addEventListener(focusLeaseResponseEvent, onFocusLeaseResponse);
    pageLeaving = false;
    const restoreRevision = revision;
    chrome.storage.local.get(api.storageKey).then(result => {
      if (pageLeaving || restoreRevision !== revision || !api.isHomepage(location.href)) return;
      settings = api.normalize(result[api.storageKey]);
      updateNewsVisibility(settings);
      void requestApply();
    }).catch(() => { status = { phase: 'error', applied: [], missing: [] }; });
  });
  const control = field => document.getElementById(field.id);
  // Bing stores the state on the option wrapper, but its current UI handles
  // clicks on the inner visual switch. Clicking the wrapper does not descend
  // into that child and can therefore leave aria-checked unchanged.
  const clickTarget = field => {
    const option = control(field);
    return option?.querySelector('.toggle_ctrl .toggle_img') ||
      option?.querySelector('.toggle_ctrl') || option;
  };
  const checked = element => {
    const value = element?.getAttribute('aria-checked');
    return value === 'true' ? true : value === 'false' ? false : null;
  };
  function nativeLayoutState(preferences) {
    if (!preferences.enabled || preferences.news !== 'off' || preferences.trending !== 'off') return 'not-required';
    const scroll = document.getElementById('scroll_cont');
    if (!scroll?.classList) return 'unconfirmed';
    const carousel = document.getElementById('carousel');
    const openingClasses = ['show_all', 'show_tob_only', 'show_all_onerowup', 'show_all_halfrowup', 'show_all_onepninerowup', 'show_title'];
    const scrollHasNone = scroll.classList.contains('show_none');
    const scrollSettling = openingClasses.some(className => scroll.classList.contains(className));
    const scrollReady = scrollHasNone && !scrollSettling;
    if (!scrollReady && !scrollSettling) return 'unconfirmed';
    let carouselReady = true;
    let carouselSettling = false;
    if (carousel) {
      if (!carousel.classList) return 'unconfirmed';
      const carouselHasHide = carousel.classList.contains('hide');
      const carouselHasShow = carousel.classList.contains('show');
      if (!carouselHasHide && !carouselHasShow) return 'unconfirmed';
      carouselReady = carouselHasHide && !carouselHasShow;
      carouselSettling = carouselHasShow || !carouselHasHide;
      if (!carouselReady && !carouselSettling) return 'unconfirmed';
    }
    return scrollReady && carouselReady ? 'ready' : 'settling';
  }

  function updateNewsVisibility(preferences) {
    const shouldHide = preferences.enabled && preferences.news === 'off';
    if (!shouldHide) {
      newsVisibilityStyle?.remove();
      newsVisibilityStyle = null;
      return;
    }
    const compactRows = shouldHide && preferences.trending === 'off';
    const rules = [];
    if (shouldHide) {
      rules.push('#hp_app .module.feed_bg, #hp_app #crs_pane { display: none !important; }');
    }
    if (compactRows) {
      rules.push('#hp_app #carousel { display: none !important; }');
      rules.push('#hp_app .bottom_row #scroll_cont.scroll_cont { top: calc(100% - 2.9375rem) !important; }');
      rules.push('#hp_app .bottom_row #scroll_cont.scroll_cont.no_vs { top: calc(100% - 7.5rem) !important; }');
      rules.push('#hp_app .bottom_row #scroll_cont.scroll_cont_unified_backplate { margin-block-start: 0 !important; }');
      rules.push('#hp_app .bottom_row #scroll_cont.scroll_cont_unified_backplate:not(.show_none) .vs_cont:has(>.vs>#carousel.show)>.mc_caro .musCard { bottom: auto !important; }');
    }
    const cssText = rules.join('\n');
    if (newsVisibilityStyle?.isConnected) {
      if (newsVisibilityStyle.textContent !== cssText) newsVisibilityStyle.textContent = cssText;
      return;
    }
    const style = document.createElement('style');
    style.id = 'bhp-news-visibility';
    style.textContent = cssText;
    const parent = document.head || document.documentElement;
    if (!parent?.appendChild) return;
    parent.appendChild(style);
    newsVisibilityStyle = style;
  }

  function statusSnapshot() {
    let snapshot = {
      ...status,
      applied: [...(status.applied || [])],
      missing: [...(status.missing || [])],
      diagnostics: (status.diagnostics || []).map(item => ({ ...item })),
      displayOverrides: { newsHidden: Boolean(newsVisibilityStyle?.isConnected) }
    };
    // Bing can rebuild the feed after the initial application. Re-read its
    // native switches when reporting status, without opening or clicking UI.
    if (['done', 'partial'].includes(status.phase)) {
      const applied = [];
      const missing = [];
      for (const field of api.fields) {
        if (settings[field.key] === 'keep') continue;
        const wanted = settings[field.key] === 'on';
        const actual = checked(control(field));
        const diagnostic = snapshot.diagnostics.find(item => item.label === field.label);
        if (diagnostic) {
          diagnostic.final = actual;
          diagnostic.outcome = actual === wanted ? 'applied' : actual === null ? 'state-not-found' : 'drifted';
        }
        (actual === wanted ? applied : missing).push(field.label);
      }
      snapshot = {
        ...snapshot,
        layout: nativeLayoutState(settings),
        phase: missing.length || ['settling', 'unconfirmed'].includes(nativeLayoutState(settings)) ? 'partial' : 'done',
        applied,
        missing,
        displayOverrides: { newsHidden: Boolean(newsVisibilityStyle?.isConnected) }
      };
      status = snapshot;
    }
    return snapshot;
  }

  const onRouteChange = () => {
    if (!api.isHomepage(location.href)) {
      newsVisibilityStyle?.remove();
      newsVisibilityStyle = null;
      revision += 1;
      wakePendingWaits();
      revokeFocusLease();
      focusRetryPending = false;
      removeDeferredInteractionListeners();
      status = { phase: 'unmanaged', applied: [], missing: [] };
      return;
    }
    updateNewsVisibility(settings);
  };
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('popstate', onRouteChange);

  // Serialize applications; a preference change invalidates the current run.
  async function requestApply() {
    revision += 1;
    revokeFocusLease();
    wakePendingWaits();
    focusRetryPending = false;
    removeDeferredInteractionListeners();
    if (running) return;
    running = true;
    let completed;
    try {
      do {
        completed = revision;
        try { await apply(completed, settings); }
        catch { status = { phase: 'error', applied: [], missing: [] }; }
      } while (completed !== revision);
    } finally { running = false; }
  }

  async function apply(token, preferences) {
    const fields = api.fields.filter(field => preferences[field.key] !== 'keep');
    if (!preferences.enabled || !fields.length) {
      if (deferredMenuCleanup) {
        if (hasPageFocus()) releaseDeferredMenuCleanup();
        else {
          deferredMenuCleanup.veil?.remove();
          deferredMenuCleanup = null;
        }
      }
      status = { phase: preferences.enabled ? 'unmanaged' : 'paused', applied: [], missing: [] };
      return;
    }
    if (deferredMenuCleanup) {
      if (!hasPageFocus()) {
        deferForPageFocus();
        return;
      }
      releaseDeferredMenuCleanup();
    }
    const diagnostics = [];
    const menuDiagnostic = {
      expandedBefore: null,
      attempts: 0,
      expandedAfter: null,
      controlsReady: false,
      timedOut: false
    };
    status = { phase: 'applying', applied: [], missing: [], diagnostics, menuDiagnostic };
    const deadline = Date.now() + 20000;
    let interrupted = false;
    let openedByUs = false;
    let veil = null;
    let focusAfterOpen = null;
    const priorFocus = document.activeElement;
    const interrupt = event => {
      if (event.isTrusted) { interrupted = true; wakePendingWaits(); }
    };
    const alive = () => token === revision && !interrupted && !pageLeaving && api.isHomepage(location.href);
    const waitFor = async (predicate, timeoutMs = Math.max(0, deadline - Date.now())) => {
      if (predicate()) return true;
      if (!alive() || timeoutMs <= 0) return false;
      const Observer = globalThis.MutationObserver;
      if (typeof Observer !== 'function') {
        const end = Math.min(deadline, Date.now() + timeoutMs);
        while (alive() && Date.now() < end) {
          if (predicate()) return true;
          await pause(Math.min(200, Math.max(1, end - Date.now())));
        }
        return alive() && predicate();
      }
      return new Promise(resolve => {
        let settled = false;
        let timer;
        const finish = value => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearTimeout(timer);
          pendingWaits.delete(check);
          window.removeEventListener?.('hashchange', check);
          window.removeEventListener?.('popstate', check);
          window.removeEventListener?.('pagehide', cancel);
          resolve(value);
        };
        const check = () => {
          if (!alive()) finish(false);
          else if (predicate()) finish(true);
        };
        const cancel = () => finish(false);
        const observer = new Observer(check);
        pendingWaits.add(check);
        observer.observe(document.documentElement || document.body, {
          attributes: true,
          attributeFilter: ['aria-checked', 'aria-expanded', 'class'],
          childList: true,
          subtree: true
        });
        window.addEventListener('hashchange', check);
        window.addEventListener('popstate', check);
        window.addEventListener('pagehide', cancel, { once: true });
        timer = setTimeout(() => { check(); finish(false); }, Math.min(timeoutMs, Math.max(0, deadline - Date.now())));
        check();
      });
    };
    async function ensureClickPermission() {
      if (!alive()) return false;
      if (hasPageFocus()) return true;
      if (hasCurrentLeaseMarker(token)) return true;
      const ttlMs = Math.min(20000, deadline - Date.now());
      if (ttlMs <= 0) return false;
      const nonce = `${Date.now().toString(36)}-${token.toString(36)}-${(++focusLeaseCounter).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      const grant = await new Promise(resolve => {
        let settled = false;
        let timer;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingWaits.delete(cancel);
          window.removeEventListener(focusLeaseResponseEvent, onResponse);
          resolve(value);
        };
        const onResponse = event => {
          const message = parseLeaseMessage(event);
          if (!message || message.nonce !== nonce || message.revision !== token) return;
          if (message.op === 'ack') finish(message);
          else if (message.op === 'denied') finish(null);
        };
        const cancel = () => {
          sendFocusLeaseEnd({ nonce, revision: token });
          finish(null);
        };
        pendingWaits.add(cancel);
        window.addEventListener(focusLeaseResponseEvent, onResponse);
        timer = setTimeout(cancel, Math.min(250, ttlMs));
        try {
          window.dispatchEvent(new CustomEvent(focusLeaseRequestEvent, {
            detail: JSON.stringify({ op: 'begin', nonce, revision: token, ttlMs })
          }));
        } catch { finish(null); }
      });
      if (!alive() || !grant || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() ||
          grant.expiresAt > deadline + 1000) {
        if (grant) sendFocusLeaseEnd({ nonce, revision: token });
        return false;
      }
      focusLease = { nonce, revision: token, expiresAt: grant.expiresAt, active: true };
      if (!hasPageFocus() && !hasCurrentLeaseMarker(token)) {
        focusLease.active = false;
        sendFocusLeaseEnd(focusLease);
        return false;
      }
      return hasPageFocus() || hasCurrentLeaseMarker(token) && alive();
    }
    async function clickWithPermission(target) {
      if (!target || !await ensureClickPermission()) return false;
      // This synchronous MAIN-world validation is the final check before click;
      // no await/yield occurs between validation and the native DOM click.
      if (!alive() || !validateFocusLease(token) || !safeClickAllowed(token)) return false;
      target.click();
      return true;
    }
    // Avoid fighting the person using the page while the menu is loading.
    document.addEventListener('pointerdown', interrupt, true);
    document.addEventListener('keydown', interrupt, true);
    try {
      const ready = await waitFor(() => document.getElementById('hp_app') &&
        (fields.every(field => checked(control(field)) !== null) || document.getElementById('id_sc')));
      if (!alive()) return;
      if (!ready) {
        status = {
          phase: 'unsupported', applied: [], missing: fields.map(f => f.label),
          timedOut: Date.now() >= deadline,
          diagnostics: fields.map(field => ({ label: field.label, initial: null, target: 'not-found', clicks: 0, final: null, outcome: 'menu-timeout' }))
        };
        return;
      }

      if (!fields.every(field => checked(control(field)) !== null)) {
        const menuButton = document.getElementById('id_sc');
        menuDiagnostic.expandedBefore = menuButton?.getAttribute('aria-expanded') ?? null;
        if (menuButton?.getAttribute('aria-expanded') === 'false') {
          if (!await ensureClickPermission()) {
            if (!alive()) return;
            deferForPageFocus();
            return;
          }
          // The native menu is lazy-loaded. Hide only our automatic opening.
          veil = document.createElement('style');
          veil.textContent = '#id_hbfo { visibility: hidden !important; pointer-events: none !important; }';
          (document.head || document.documentElement).appendChild(veil);
          openedByUs = true;
          if (!await clickWithPermission(menuButton)) {
            if (!alive()) return;
            deferForPageFocus();
            return;
          }
          menuDiagnostic.attempts += 1;
          focusAfterOpen = document.activeElement;
        }
        // Bing may render #id_sc before binding its click handler. Retry only
        // while the menu is still explicitly closed and its lazy controls are
        // absent. Once expanded, never click it again (click is a toggle).
        let nextMenuRetry = Date.now() + 600;
        while (alive() && Date.now() < deadline) {
          const controlsReady = fields.every(field => checked(control(field)) !== null);
          if (controlsReady) break;
          const stillClosed = menuButton?.getAttribute('aria-expanded') === 'false';
          if (stillClosed && menuDiagnostic.attempts < 8 && Date.now() >= nextMenuRetry) {
            if (!await ensureClickPermission()) {
              if (!alive()) return;
              deferForPageFocus();
              return;
            }
            if (!await clickWithPermission(menuButton)) {
              if (!alive()) return;
              deferForPageFocus();
              return;
            }
            menuDiagnostic.attempts += 1;
            nextMenuRetry = Date.now() + 600;
            continue;
          }
          const untilRetry = stillClosed && menuDiagnostic.attempts < 8
            ? Math.max(1, nextMenuRetry - Date.now())
            : Math.max(1, deadline - Date.now());
          await waitFor(() => fields.every(field => checked(control(field)) !== null), untilRetry);
        }
        menuDiagnostic.expandedAfter = menuButton?.getAttribute('aria-expanded') ?? null;
        menuDiagnostic.controlsReady = fields.every(field => checked(control(field)) !== null);
        menuDiagnostic.timedOut = !menuDiagnostic.controlsReady && Date.now() >= deadline;
      }
      if (!alive()) return;

      const applied = [], missing = [];
      for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
        const field = fields[fieldIndex];
        if (!alive()) return;
        const wanted = preferences[field.key] === 'on';
        const initial = checked(control(field));
        const selectedTarget = clickTarget(field);
        const diagnostic = {
          label: field.label,
          initial,
          target: selectedTarget === control(field) ? 'option' : selectedTarget?.classList?.contains('toggle_img') ? 'toggle_img' : 'toggle_ctrl',
          clicks: 0,
          final: initial,
          outcome: 'pending'
        };
        diagnostics.push(diagnostic);
        status.diagnostics = diagnostics;
        if (initial === null) { diagnostic.outcome = 'state-not-found'; continue; }
        if (!selectedTarget) { diagnostic.target = 'not-found'; diagnostic.outcome = 'target-not-found'; continue; }
        // Re-read before every click: never blindly toggle an already-correct switch.
        for (let attempt = 0; attempt < 2 && alive(); attempt += 1) {
          const element = control(field);
          const current = checked(element);
          if (current === wanted || current === null) break;
          if (!await ensureClickPermission()) {
            if (!alive()) return;
            deferForPageFocus(applied, missing);
            return;
          }
          diagnostic.clicks += 1;
          if (!await clickWithPermission(selectedTarget)) {
            if (!alive()) return;
            diagnostic.clicks -= 1;
            deferForPageFocus(applied, missing);
            return;
          }
          diagnostic.final = checked(control(field));
          if (diagnostic.final !== wanted) {
            // Synchronous updates advance immediately; asynchronous updates
            // get a 600 ms observed-state deadline instead of a fixed pause.
            await waitFor(() => checked(control(field)) === wanted, 600);
            diagnostic.final = checked(control(field));
          }
        }
        diagnostic.final = checked(control(field));
        diagnostic.outcome = diagnostic.final === wanted ? 'applied' : 'unchanged-or-reset';
        if (diagnostic.clicks > 0 && fields.slice(fieldIndex + 1).some(next => {
          const nextState = checked(control(next));
          return nextState !== null && nextState !== (preferences[next.key] === 'on');
        })) if (preferences.switchDelayMs > 0) await pause(preferences.switchDelayMs);
      }

      // A later Bing click can supersede an earlier optimistic aria update.
      // Re-read the whole set and make at most two ordered repair passes.
      for (let pass = 0; pass < 2 && alive(); pass += 1) {
        for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
          const field = fields[fieldIndex];
          const wanted = preferences[field.key] === 'on';
          const diagnostic = diagnostics.find(item => item.label === field.label);
          let current = checked(control(field));
          if (current !== wanted && current !== null && diagnostic?.target !== 'not-found') {
            if (!await ensureClickPermission()) {
              if (!alive()) return;
              deferForPageFocus(applied, missing);
              return;
            }
            const target = clickTarget(field);
            if (target) {
              diagnostic.clicks += 1;
              if (!await clickWithPermission(target)) {
                if (!alive()) return;
                diagnostic.clicks -= 1;
                deferForPageFocus(applied, missing);
                return;
              }
              current = checked(control(field));
              if (current !== wanted) {
                await waitFor(() => checked(control(field)) === wanted, 600);
                current = checked(control(field));
              }
              if (fields.slice(fieldIndex + 1).some(next => {
                const nextState = checked(control(next));
                return nextState !== null && nextState !== (preferences[next.key] === 'on');
              })) if (preferences.switchDelayMs > 0) await pause(preferences.switchDelayMs);
            }
          }
          if (diagnostic) {
            diagnostic.final = checked(control(field));
            diagnostic.outcome = diagnostic.final === wanted ? 'applied' : 'unchanged-or-reset';
          }
        }
      }
      for (const field of fields) {
        const wanted = preferences[field.key] === 'on';
        const final = checked(control(field));
        const diagnostic = diagnostics.find(item => item.label === field.label);
        if (diagnostic) {
          diagnostic.final = final;
          diagnostic.outcome = final === wanted ? 'applied' : final === null ? 'state-not-found' : 'unchanged-or-reset';
        }
        (final === wanted ? applied : missing).push(field.label);
      }
      let layout = nativeLayoutState(preferences);
      if (layout === 'settling' && alive()) {
        await waitFor(() => nativeLayoutState(preferences) === 'ready', Math.min(2000, Math.max(0, deadline - Date.now())));
        layout = nativeLayoutState(preferences);
      }
      if (alive()) status = {
        phase: missing.length || ['settling', 'unconfirmed'].includes(layout) ? 'partial' : 'done',
        applied, missing, diagnostics, menuDiagnostic, layout
      };
    } finally {
      // Leave a menu that was already open alone. Never override a user's interaction.
      try {
        if (openedByUs && !interrupted) {
          const button = document.getElementById('id_sc');
          if (button?.getAttribute('aria-expanded') === 'true' && !pageLeaving) {
            const canClose = alive() && await ensureClickPermission();
            if (interrupted || pageLeaving) {
              // A trusted interaction or page exit owns the menu now.
            } else {
              const closed = canClose && alive() && await clickWithPermission(button);
              if (!closed && !interrupted && !pageLeaving && api.isHomepage(location.href)) {
              deferredMenuCleanup = { button, priorFocus, focusAfterOpen, veil };
              veil = null;
              if (token === revision && !pageLeaving) deferForPageFocus();
              }
            }
          }
          if (!interrupted && alive() && hasPageFocus() && document.activeElement === focusAfterOpen && priorFocus?.isConnected) {
            priorFocus.focus({ preventScroll: true });
          }
        }
      } finally {
        document.removeEventListener('pointerdown', interrupt, true);
        document.removeEventListener('keydown', interrupt, true);
        if (interrupted || pageLeaving || !api.isHomepage(location.href)) {
          deferredMenuCleanup?.veil?.remove();
          deferredMenuCleanup = null;
        }
        veil?.remove();
        if (focusLease?.revision === token) {
          sendFocusLeaseEnd(focusLease);
          focusLease.active = false;
          focusLease = null;
        }
      }
      if (interrupted && token === revision) status = { phase: 'interrupted', applied: [], missing: [], diagnostics };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'bing-home:status') respond(statusSnapshot());
    if (message?.type === 'bing-home:apply') { void requestApply(); respond({ phase: 'applying' }); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[api.storageKey]) return;
    settings = api.normalize(changes[api.storageKey].newValue);
    if (pageLeaving) return;
    updateNewsVisibility(settings);
    void requestApply();
  });
  const initialRevision = revision;
  chrome.storage.local.get(api.storageKey).then(result => {
    if (pageLeaving || revision !== initialRevision) return;
    settings = api.normalize(result[api.storageKey]);
    updateNewsVisibility(settings);
    void requestApply();
  }).catch(() => { status = { phase: 'error', applied: [], missing: [] }; });
})();
