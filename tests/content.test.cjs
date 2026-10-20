const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../src');
const preferenceSource = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const focusGuardSource = fs.readFileSync(path.join(root, 'focus-guard.js'), 'utf8');

class Element {
  constructor(id, attrs = {}) { this.id = id; this.attrs = { ...attrs }; this.listeners = {}; this.isConnected = true; this.clicks = 0; this.style = {}; this.children = []; this.className = id.endsWith('-switch') ? 'toggle_img' : ''; this.classList = { contains: value => this.className.split(/\s+/).includes(value) }; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); Element.doc?.notifyMutation?.(); }
  removeAttribute(name) { delete this.attrs[name]; Element.doc?.notifyMutation?.(); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(x => x !== fn); }
  click() { this.clicks++; for (const fn of this.listeners.click || []) fn({ isTrusted: false }); }
  querySelector(selector) { return selector === '.toggle_ctrl .toggle_img' ? this.children[0] || null : null; }
  focus() { this.focusCalls = (this.focusCalls || 0) + 1; Element.doc.activeElement = this; }
  remove() { this.isConnected = false; this.removed = true; }
}
function makePage({ url = 'https://www.bing.com/', stored, initiallyOpen = false, lazyDelay = 0, withControls = true, handlerReadyAfter = 0, toggleDelay = 0, initialStates = {}, hasFocus = true, initialFocus = 'button', onSwitchClick, mainFocusGuard = false, initialLayout = 'show_none', initialCarousel = 'hide' } = {}) {
  const attrs = { 'qs_menu_ctrl': false, 'qs_carousel_ctrl': true, 'qs_tobbs_ctrl': true, 'qs_iotd_ctrl': true };
  Object.assign(attrs, initialStates);
  const switchClickTimes = [];
  const elements = new Map();
  let document;
  elements.set('hp_app', new Element('hp_app'));
  const scroll = new Element('scroll_cont');
  scroll.className = `scroll_cont ${initialLayout}`;
  elements.set('scroll_cont', scroll);
  const carousel = new Element('carousel');
  carousel.className = initialCarousel;
  elements.set('carousel', carousel);
  const button = new Element('id_sc', { 'aria-expanded': String(initiallyOpen) });
  elements.set('id_sc', button);
  const searchInput = new Element('sb_form_q');
  elements.set('sb_form_q', searchInput);
  const addControls = () => {
    for (const [id, value] of Object.entries(attrs)) {
      const el = new Element(id, { 'aria-checked': String(value) });
      const switchImage = new Element(`${id}-switch`);
      switchImage.addEventListener('click', () => {
        switchClickTimes.push(Date.now());
        onSwitchClick?.(switchClickTimes.length, document);
        const flip = () => el.setAttribute('aria-checked', String(el.getAttribute('aria-checked') !== 'true'));
        if (toggleDelay) setTimeout(flip, toggleDelay); else flip();
      });
      el.children.push(switchImage);
      elements.set(id, el);
    }
    elements.set('id_hbfo', new Element('id_hbfo', { 'aria-hidden': 'false' }));
    document?.notifyMutation?.();
  };
  if (initiallyOpen && withControls) addControls();
  button.addEventListener('click', () => {
    // Simulate Bing painting the button before its listener is ready. The
    // first synthetic click is ignored; a bounded retry must open it later.
    if (button.clicks <= handlerReadyAfter) return;
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    if (open && withControls) setTimeout(addControls, lazyDelay);
  });
  const documentListeners = new Map();
  const activeObservers = new Set();
  let focusValue = hasFocus === 'throws' ? false : hasFocus;
  document = {
    activeElement: initialFocus === 'search' ? searchInput : button,
    head: { appendChild: el => { elements.set(el.id === 'bhp-news-visibility' ? el.id : 'veil', el); el.isConnected = true; document.notifyMutation(); } },
    documentElement: Object.assign(new Element('html'), { appendChild: el => { elements.set('veil', el); document.notifyMutation(); } }),
    createElement: () => new Element('style'),
    getElementById: id => elements.get(id) || null,
    notifyMutation() { for (const observer of [...activeObservers]) observer.callback([{ type: 'attributes', target: scroll, attributeName: 'class' }]); },
    addEventListener(name, fn) { (documentListeners.get(name) || documentListeners.set(name, []).get(name)).push(fn); },
    removeEventListener(name, fn) { documentListeners.set(name, (documentListeners.get(name) || []).filter(item => item !== fn)); },
    dispatch(name, event) { for (const fn of documentListeners.get(name) || []) fn(event); }
  };
  if (hasFocus === 'throws') document.hasFocus = () => { throw new Error('focus state unavailable'); };
  else if (hasFocus !== 'missing') document.hasFocus = () => focusValue;
  Element.doc = document;
  class MutationObserverMock {
    constructor(callback) { this.callback = callback; this.connected = false; }
    observe() { this.connected = true; activeObservers.add(this); }
    disconnect() { if (this.connected) activeObservers.delete(this); this.connected = false; }
  }
  const storageListeners = [];
  const messageListeners = [];
  const chrome = {
    runtime: { onMessage: { addListener: fn => messageListeners.push(fn) } },
    storage: {
      local: { get: async key => ({ [key]: stored }) },
      onChanged: { addListener: fn => storageListeners.push(fn) }
    }
  };
  const windowListeners = new Map();
  const windowEvents = [];
  const window = {
    addEventListener(name, fn) { (windowListeners.get(name) || windowListeners.set(name, []).get(name)).push(fn); },
    removeEventListener(name, fn) { windowListeners.set(name, (windowListeners.get(name) || []).filter(item => item !== fn)); },
    dispatch(name, event = {}) { event.type ||= name; windowEvents.push({ name, detail: event.detail }); for (const fn of [...(windowListeners.get(name) || [])]) fn(event); },
    dispatchEvent(event) { this.dispatch(event.type, event); return true; }
  };
  window.top = window;
  class HTMLElementMock { focus(...args) { return `isolated-native-focus-${args.length}`; } }
  class MainHTMLElementMock { focus(...args) { return `main-native-focus-${args.length}`; } }
  class CustomEventMock { constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.isTrusted = false; } }
  let clockOffset = 0;
  const mockDate = { now: () => Date.now() + clockOffset };
  const context = { document, chrome, window, MutationObserver: MutationObserverMock, HTMLElement: HTMLElementMock, CustomEvent: CustomEventMock, location: { href: url }, URL, Date: mockDate, Promise, setTimeout, clearTimeout, console };
  vm.runInNewContext(preferenceSource, context, { filename: 'preferences.js' });
  const mainTimers = new Map();
  const mainIntervals = new Map();
  let mainTimerId = 1;
  if (mainFocusGuard) {
    const mainContext = {
      document, window, HTMLElement: MainHTMLElementMock, CustomEvent: CustomEventMock, MutationObserver: MutationObserverMock,
      location: { href: url }, URL, Date, globalThis: null,
      setTimeout(fn, ms) { const id = mainTimerId++; mainTimers.set(id, { fn, ms }); return id; },
      clearTimeout(id) { mainTimers.delete(id); },
      setInterval(fn, ms) { const id = mainTimerId++; mainIntervals.set(id, { fn, ms }); return id; },
      clearInterval(id) { mainIntervals.delete(id); }
    };
    mainContext.globalThis = mainContext;
    vm.runInNewContext(focusGuardSource, mainContext, { filename: 'focus-guard-main.js' });
  }
  vm.runInNewContext(contentSource, context, { filename: 'content.js' });
  const status = () => {
    let result;
    for (const listener of messageListeners) listener({ type: 'bing-home:status' }, {}, value => { result = value; });
    return result;
  };
  const waitFor = async predicate => {
    for (let i = 0; i < 1100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 25)); }
    assert.fail('timed out waiting for state');
  };
  return {
    context, document, elements, button, storageListeners, activeObservers, switchClickTimes, status, waitFor, window, windowEvents, mainTimers, mainIntervals, HTMLElementMock, MainHTMLElementMock,
    setFocus(value) { focusValue = value; },
    setStored(value) { stored = value; },
    focus() { focusValue = true; window.dispatch('focus'); document.dispatch('focusin', {}); },
    trustedInteraction(name, init = {}) { const event = { isTrusted: true, ...init }; window.dispatch(name, event); document.dispatch(name, event); },
    setPrototypeFocus(fn) { HTMLElementMock.prototype.focus = fn; },
    runMainIntervals() { for (const item of [...mainIntervals.values()]) item.fn(); },
    advanceTime(ms) { clockOffset += ms; }
  };
}
const delay = ms => new Promise(r => setTimeout(r, ms));
function selectorMatchesFixture(node, selector) {
  const ancestors = [];
  for (let current = node; current; current = current.parent) ancestors.push(current);
  if (selector === '#hp_app .module.feed_bg') {
    return ancestors.some(item => item.id === 'hp_app') && node.classList?.has('module') && node.classList?.has('feed_bg');
  }
  if (selector === '#hp_app #crs_pane') {
    return ancestors.some(item => item.id === 'hp_app') && node.id === 'crs_pane';
  }
  if (selector === '#hp_app #carousel') {
    return ancestors.some(item => item.id === 'hp_app') && node.id === 'carousel';
  }
  if (selector === '#hp_app .bottom_row #scroll_cont.scroll_cont_unified_backplate') {
    return node.id === 'scroll_cont' && node.classList?.has('scroll_cont_unified_backplate') &&
      ancestors.some(item => item.id === 'hp_app') && ancestors.some(item => item.className === 'bottom_row');
  }
  if (selector === '#hp_app .bottom_row #scroll_cont.scroll_cont_unified_backplate:not(.show_none) .vs_cont:has(>.vs>#carousel.show)>.mc_caro .musCard') {
    const scroll = ancestors.find(item => item.id === 'scroll_cont');
    const vsCont = ancestors.find(item => item.className === 'vs_cont');
    const mcCaro = node.parent;
    const vs = vsCont?.children?.find(item => item.className === 'vs');
    const shownCarousel = vs?.children?.find(item => item.id === 'carousel' && item.classList?.has('show'));
    return node.className === 'musCard' && mcCaro?.className === 'mc_caro' &&
      mcCaro.parent === vsCont && scroll?.classList?.has('scroll_cont_unified_backplate') &&
      !scroll.classList.has('show_none') && shownCarousel && ancestors.some(item => item.id === 'hp_app');
  }
  return false;
}

(async () => {
  const prefs = { URL };
  vm.runInNewContext(preferenceSource, prefs);
  const api = prefs.BingHomePreferences;
  for (const url of [
    'https://www.bing.com/', 'https://www.bing.com/?q=x#top',
    'https://cn.bing.com/#foo', 'https://bing.com/?form=test'
  ]) assert.equal(api.isHomepage(url), true, url);
  for (const url of ['http://www.bing.com/', 'https://www.bing.com/search?q=x', 'https://evilbing.com/']) assert.equal(api.isHomepage(url), false, url);
  assert.deepEqual(JSON.parse(JSON.stringify(api.normalize({ menu: 'bad', enabled: false }))), { enabled: false, switchDelayMs: 80, menu: 'keep', news: 'keep', trending: 'keep', image: 'keep' });
  for (const value of ['150', -1, 2001, 1.5, Infinity, NaN, null]) assert.equal(api.normalize({ switchDelayMs: value }).switchDelayMs, 80);
  for (const value of [0, 50, 80, 150, 300, 600, 2000]) assert.equal(api.normalize({ switchDelayMs: value }).switchDelayMs, value);

  const untouched = makePage({ stored: {} });
  await untouched.waitFor(() => untouched.status()?.phase === 'unmanaged');
  assert.equal(untouched.button.clicks, 0, 'keep mode must not open the settings menu');

  const paused = makePage({ stored: { enabled: false, image: 'off' } });
  await paused.waitFor(() => paused.status()?.phase === 'paused');
  assert.equal(paused.button.clicks, 0, 'paused mode must not manipulate Bing');

  const configuredStarted = Date.now();
  const configured = makePage({ stored: { enabled: true, menu: 'off', news: 'off', trending: 'off', image: 'keep' }, initialStates: { qs_menu_ctrl: true }, lazyDelay: 80 });
  await configured.waitFor(() => ['done', 'partial'].includes(configured.status()?.phase));
  const configuredElapsed = Date.now() - configuredStarted;
  assert.ok(configuredElapsed >= 160 && configuredElapsed < 1000, `three changes should take two short inter-click gaps, not three 600 ms waits (elapsed ${configuredElapsed} ms)`);
  assert.equal(configured.status().phase, 'done');
  assert.equal(configured.elements.get('qs_menu_ctrl').getAttribute('aria-checked'), 'false');
  assert.equal(configured.elements.get('qs_carousel_ctrl').getAttribute('aria-checked'), 'false');
  assert.equal(configured.elements.get('qs_tobbs_ctrl').getAttribute('aria-checked'), 'false');
  assert.equal(configured.elements.get('qs_iotd_ctrl').getAttribute('aria-checked'), 'true', 'keep mode must leave the image unchanged');
  assert.equal(configured.elements.get('qs_menu_ctrl').clicks, 0, 'automation must click Bing’s inner switch target, not only its state wrapper');
  assert.ok(configured.elements.get('qs_menu_ctrl').children[0].clicks > 0, 'inner switch receives the click');
  assert.equal(configured.switchClickTimes.length, 3, 'the three off settings each toggle once');
  assert.ok(configured.switchClickTimes[1] - configured.switchClickTimes[0] >= 75, 'second option click follows the first by about 80 ms');
  assert.ok(configured.switchClickTimes[2] - configured.switchClickTimes[1] >= 75, 'third option click follows the second by about 80 ms');
  assert.equal(configured.status().diagnostics[0].target, 'toggle_img');
  assert.equal(configured.status().diagnostics[0].outcome, 'applied');
  assert.equal(configured.status().menuDiagnostic.expandedBefore, 'false');
  assert.equal(configured.status().menuDiagnostic.attempts, 1);
  assert.equal(configured.status().menuDiagnostic.expandedAfter, 'true', 'diagnostic captures the open state before cleanup closes the menu');
  assert.equal(configured.status().menuDiagnostic.controlsReady, true);
  assert.equal(configured.button.getAttribute('aria-expanded'), 'false', 'menu opened by automation must be restored closed');
  assert.equal(configured.elements.get('veil').isConnected, false, 'temporary menu veil must be removed');
  assert.equal(configured.activeObservers.size, 0, 'ready and synchronous option waits must disconnect observers');
  const newsStyle = configured.elements.get('bhp-news-visibility');
  assert.equal(newsStyle.isConnected, true, 'news off keeps a reversible scoped visibility rule installed');
  assert.match(newsStyle.textContent, /^#hp_app \.module\.feed_bg, #hp_app #crs_pane \{ display: none !important; \}/);
  assert.match(newsStyle.textContent, /#hp_app #carousel \{ display: none !important; \}/);
  assert.match(newsStyle.textContent, /top: calc\(100% - 2\.9375rem\) !important/);
  assert.match(newsStyle.textContent, /\.no_vs \{ top: calc\(100% - 7\.5rem\) !important/);
  assert.equal(configured.status().displayOverrides.newsHidden, true);
  configured.elements.get('scroll_cont').className = 'scroll_cont show_all';
  assert.equal(configured.status().layout, 'settling', 'status rechecks Bing layout drift after native aria has settled');
  assert.equal(configured.status().phase, 'partial', 'aria alone is not reported done while Bing still lays out the carousel row');

  const hpRoot = { id: 'hp_app', classList: new Set(), parent: null };
  const feedModule = { id: '', classList: new Set(['module', 'feed_bg', 'show', 'five_col']), parent: hpRoot };
  const feedWidget = { id: 'widget_container', classList: new Set(['widgetfeed']), parent: feedModule };
  const carouselPane = { id: 'crs_pane', classList: new Set(), parent: hpRoot };
  const carousel = { id: 'carousel', classList: new Set(['hide']), parent: hpRoot };
  const videoResults = { id: 'vs_cont', classList: new Set(), parent: hpRoot };
  const unrelatedModule = { id: '', classList: new Set(['module', 'other']), parent: hpRoot };
  const bottomRow = { id: '', className: 'bottom_row', children: [], parent: hpRoot };
  const scrollBackplate = { id: 'scroll_cont', className: 'scroll_cont scroll_cont_unified_backplate show_all', classList: new Set(['scroll_cont', 'scroll_cont_unified_backplate', 'show_all']), children: [], parent: bottomRow };
  const wallVsCont = { id: '', className: 'vs_cont', children: [], parent: scrollBackplate };
  const wallVs = { id: '', className: 'vs', children: [], parent: wallVsCont };
  const shownCarousel = { id: 'carousel', classList: new Set(['show']), parent: wallVs };
  wallVs.children.push(shownCarousel);
  const mcCaro = { id: '', className: 'mc_caro', children: [], parent: wallVsCont };
  const musCard = { id: '', className: 'musCard', parent: mcCaro };
  mcCaro.children.push(musCard);
  wallVsCont.children.push(wallVs, mcCaro);
  bottomRow.children.push(scrollBackplate);
  const exactSelectors = newsStyle.textContent.split('\n').flatMap(rule => rule.slice(0, rule.indexOf('{')).split(',').map(item => item.trim()));
  assert.equal(exactSelectors.some(selector => selectorMatchesFixture(scrollBackplate, selector)), true, 'the precise backplate spacing rule targets the native scroll container');
  assert.equal(exactSelectors.some(selector => selectorMatchesFixture(musCard, selector)), true, 'the precise wallpaper card adjustment matches only the known carousel descendant structure');
  assert.equal(exactSelectors.some(selector => selectorMatchesFixture(videoResults, selector)), false, 'the spacing rules do not hide the wallpaper/video region');
  const selectors = newsStyle.textContent.split('\n').flatMap(rule => rule.slice(0, rule.indexOf('{')).split(',').map(item => item.trim()));
  assert.equal(selectors.some(selector => selectorMatchesFixture(feedModule, selector)), true, 'the known feed module with show/five_col remains matched');
  assert.equal(selectors.some(selector => selectorMatchesFixture(carouselPane, selector)), true, 'the known carousel pane remains matched');
  assert.equal(selectors.some(selector => selectorMatchesFixture(carousel, selector)), true, 'the carousel itself is hidden while the wallpaper remains untouched');
  assert.equal(selectors.some(selector => selectorMatchesFixture(videoResults, selector)), false, 'video/search regions are outside the hide rule');
  assert.equal(selectors.some(selector => selectorMatchesFixture(unrelatedModule, selector)), false, 'unrelated homepage modules remain visible');
  assert.equal(feedWidget.parent, feedModule, 'late/recreated feed children remain inside the persistently hidden module');

  const clicksBeforePreferenceRestore = configured.switchClickTimes.length;
  configured.storageListeners[0]({ homepagePreferences: { newValue: { enabled: true, menu: 'off', news: 'keep', trending: 'off', image: 'keep' } } }, 'local');
  assert.equal(newsStyle.isConnected, false, 'switching news to keep immediately removes the visibility rule');
  await configured.waitFor(() => configured.status()?.phase === 'done');
  assert.equal(configured.switchClickTimes.length, clicksBeforePreferenceRestore, 'preference changes do not add clicks when native states are already correct');
  assert.equal(newsStyle.isConnected, false, 'news keep removes the hide rule and temporary native none-position fallback');
  configured.storageListeners[0]({ homepagePreferences: { newValue: { enabled: true, menu: 'off', news: 'on', trending: 'off', image: 'keep' } } }, 'local');
  assert.equal(configured.elements.get('bhp-news-visibility').isConnected, false, 'switching news on removes the visibility rule immediately');
  await configured.waitFor(() => configured.status()?.phase === 'done');
  assert.equal(configured.elements.get('qs_carousel_ctrl').getAttribute('aria-checked'), 'true', 'news on still applies Bing’s native switch');
  assert.equal(configured.switchClickTimes.length, clicksBeforePreferenceRestore + 1, 'only the native on preference adds its expected click');
  configured.storageListeners[0]({ homepagePreferences: { newValue: { enabled: false, menu: 'off', news: 'off', trending: 'off', image: 'keep' } } }, 'local');
  assert.equal(configured.elements.get('bhp-news-visibility').isConnected, false, 'pause removes the visibility rule synchronously');
  await configured.waitFor(() => configured.status()?.phase === 'paused');

  const delayedLayout = makePage({
    stored: { enabled: true, menu: 'keep', news: 'off', trending: 'off', image: 'keep' },
    initialStates: { qs_carousel_ctrl: false, qs_tobbs_ctrl: false },
    initialLayout: 'show_all_onerowup',
    initialCarousel: 'show'
  });
  setTimeout(() => {
    delayedLayout.elements.get('scroll_cont').className = 'scroll_cont show_none';
    delayedLayout.elements.get('carousel').className = 'hide';
    delayedLayout.document.notifyMutation();
  }, 100);
  await delayedLayout.waitFor(() => delayedLayout.status()?.phase === 'done');
  assert.equal(delayedLayout.status().layout, 'ready', 'the content observer waits for Bing class changes after aria updates');

  const unknownLayout = makePage({
    stored: { enabled: true, menu: 'keep', news: 'off', trending: 'off', image: 'keep' },
    initialStates: { qs_carousel_ctrl: false, qs_tobbs_ctrl: false },
    initialLayout: 'future_variant'
  });
  await unknownLayout.waitFor(() => unknownLayout.status()?.phase === 'partial');
  assert.equal(unknownLayout.status().layout, 'unconfirmed', 'an unrecognized Bing layout is reported without waiting or mutating its classes');

  const keepTrending = makePage({
    stored: { enabled: true, menu: 'keep', news: 'off', trending: 'on', image: 'keep' },
    initialStates: { qs_carousel_ctrl: false, qs_tobbs_ctrl: false },
    initialLayout: 'show_all'
  });
  await keepTrending.waitFor(() => keepTrending.status()?.phase === 'done');
  assert.doesNotMatch(keepTrending.elements.get('bhp-news-visibility').textContent, /top:/, 'news-only hiding does not force the trending layout closed');
  assert.doesNotMatch(keepTrending.elements.get('bhp-news-visibility').textContent, /#hp_app #carousel \{/, 'news off with trending kept does not hide the whole carousel navigation');
  assert.match(keepTrending.elements.get('bhp-news-visibility').textContent, /#hp_app #crs_pane/, 'news off still hides the precise news pane when trending is kept');
  assert.equal(keepTrending.elements.get('qs_tobbs_ctrl').getAttribute('aria-checked'), 'true', 'trending on still applies the native switch while preserving its carousel');

  const unfocusedNews = makePage({
    stored: { enabled: true, menu: 'keep', news: 'off', trending: 'keep', image: 'keep' },
    hasFocus: false,
    initialStates: { qs_carousel_ctrl: true }
  });
  await unfocusedNews.waitFor(() => unfocusedNews.status()?.phase === 'waiting-focus');
  assert.equal(unfocusedNews.elements.get('bhp-news-visibility').isConnected, true, 'news is hidden even while native menu clicks wait for page focus');
  assert.equal(unfocusedNews.switchClickTimes.length, 0, 'the hide rule does not synthesize native clicks while unfocused');
  unfocusedNews.focus();
  await unfocusedNews.waitFor(() => unfocusedNews.status()?.phase === 'done');
  assert.equal(unfocusedNews.elements.get('bhp-news-visibility').isConnected, true);
  unfocusedNews.window.dispatch('pagehide');
  assert.equal(unfocusedNews.elements.get('bhp-news-visibility').isConnected, false, 'pagehide removes the rule before leaving/BFCache');
  unfocusedNews.setStored({ enabled: true, menu: 'keep', news: 'keep', trending: 'keep', image: 'keep' });
  unfocusedNews.window.dispatch('pageshow', { persisted: true });
  await unfocusedNews.waitFor(() => unfocusedNews.status()?.phase === 'unmanaged');
  assert.equal(unfocusedNews.elements.get('bhp-news-visibility').isConnected, false, 'BFCache restoration rereads storage and respects a newer keep preference');
  unfocusedNews.setStored({ enabled: true, menu: 'keep', news: 'off', trending: 'keep', image: 'keep' });
  unfocusedNews.window.dispatch('pagehide');
  unfocusedNews.window.dispatch('pageshow', { persisted: true });
  await unfocusedNews.waitFor(() => unfocusedNews.status()?.phase === 'done');
  assert.equal(unfocusedNews.elements.get('bhp-news-visibility').isConnected, true, 'BFCache restoration reinstalls the rule only when the current stored preference remains off');

  let backgroundFocusResult = 'not-called';
  const backgroundLeaseApply = makePage({
    stored: { enabled: true, menu: 'off', news: 'off', trending: 'off', image: 'keep', switchDelayMs: 80 },
    hasFocus: false,
    mainFocusGuard: true,
    initialStates: { qs_menu_ctrl: true, qs_carousel_ctrl: true, qs_tobbs_ctrl: true },
    onSwitchClick() {
      backgroundFocusResult = backgroundLeaseApply.MainHTMLElementMock.prototype.focus.call({ id: 'bing-controlled-element' });
    }
  });
  await delay(750);
  await backgroundLeaseApply.waitFor(() => backgroundLeaseApply.status()?.phase === 'done');
  await backgroundLeaseApply.waitFor(() => backgroundLeaseApply.document.documentElement.getAttribute('data-bhp-focus-lease') === null);
  assert.deepEqual(
    ['qs_menu_ctrl', 'qs_carousel_ctrl', 'qs_tobbs_ctrl'].map(id => backgroundLeaseApply.elements.get(id).getAttribute('aria-checked')),
    ['false', 'false', 'false'],
    'the acknowledged MAIN-world lease allows native controls to apply while the tab lacks focus'
  );
  assert.equal(backgroundFocusResult, undefined, 'the bounded MAIN lease blocks Bing focus attempts during background auto-clicks');
  assert.equal(backgroundLeaseApply.HTMLElementMock.prototype.focus.call({ id: 'isolated-element' }), 'isolated-native-focus-0', 'the test models distinct MAIN and isolated-world prototypes');
  assert.equal(backgroundLeaseApply.document.documentElement.getAttribute('data-bhp-focus-lease'), null, 'apply completion revokes and clears the lease marker');
  assert.equal(backgroundLeaseApply.button.getAttribute('aria-expanded'), 'false');
  const clicksBeforeBfCache = backgroundLeaseApply.switchClickTimes.length;
  backgroundLeaseApply.elements.get('qs_carousel_ctrl').setAttribute('aria-checked', 'true');
  backgroundLeaseApply.window.dispatch('pagehide');
  backgroundLeaseApply.window.dispatch('pageshow', { persisted: true });
  await backgroundLeaseApply.waitFor(() => backgroundLeaseApply.elements.get('qs_carousel_ctrl').getAttribute('aria-checked') === 'false');
  await backgroundLeaseApply.waitFor(() => backgroundLeaseApply.document.documentElement.getAttribute('data-bhp-focus-lease') === null);
  assert.equal(backgroundLeaseApply.switchClickTimes.length, clicksBeforeBfCache + 1, 'BFCache pageshow installs a fresh response listener for reapplication');
  assert.deepEqual(backgroundLeaseApply.elements.get('qs_carousel_ctrl').getAttribute('aria-checked'), 'false', 'BFCache pageshow can reacquire the lease and reapply current settings');

  const noMainBridge = makePage({
    stored: { enabled: true, menu: 'off', news: 'off', trending: 'off', image: 'keep' },
    hasFocus: false,
    initialStates: { qs_menu_ctrl: true, qs_carousel_ctrl: true, qs_tobbs_ctrl: true }
  });
  await noMainBridge.waitFor(() => noMainBridge.status()?.phase === 'waiting-focus');
  assert.equal(noMainBridge.switchClickTimes.length, 0, 'a missing MAIN acknowledgement fails closed and waits for page focus');

  const forgedLease = makePage({
    stored: { enabled: true, menu: 'off', news: 'off', trending: 'off', image: 'keep' },
    hasFocus: false,
    initialStates: { qs_menu_ctrl: true, qs_carousel_ctrl: true, qs_tobbs_ctrl: true }
  });
  forgedLease.window.addEventListener('bhp:focus-lease-request', event => {
    const request = JSON.parse(event.detail);
    if (request.op !== 'begin') return;
    const expiresAt = Date.now() + 10000;
    forgedLease.document.documentElement.setAttribute('data-bhp-focus-lease', JSON.stringify({ nonce: request.nonce, revision: request.revision, expiresAt }));
    forgedLease.window.dispatchEvent(new forgedLease.context.CustomEvent('bhp:focus-lease-response', {
      detail: JSON.stringify({ op: 'ack', nonce: request.nonce, revision: request.revision, expiresAt })
    }));
  });
  await forgedLease.waitFor(() => forgedLease.status()?.phase === 'waiting-focus');
  assert.equal(forgedLease.switchClickTimes.length, 0, 'a forged acknowledgement without MAIN fresh validation does not authorize clicks');

  let interruptedLease;
  interruptedLease = makePage({
    stored: { enabled: true, menu: 'off', news: 'off', trending: 'off', image: 'keep' },
    hasFocus: false,
    mainFocusGuard: true,
    initialStates: { qs_menu_ctrl: true, qs_carousel_ctrl: true, qs_tobbs_ctrl: true },
    onSwitchClick(count) { if (count === 1) interruptedLease.trustedInteraction('pointerdown'); }
  });
  await interruptedLease.waitFor(() => interruptedLease.status()?.phase === 'interrupted');
  assert.equal(interruptedLease.switchClickTimes.length, 1, 'trusted interaction ends a background lease before later native clicks');
  assert.equal(interruptedLease.document.documentElement.getAttribute('data-bhp-focus-lease'), null, 'trusted interaction clears the MAIN lease marker');
  assert.equal(interruptedLease.elements.get('veil')?.isConnected, false, 'interruption removes its temporary menu veil');

  let cleanupRace;
  cleanupRace = makePage({
    stored: { enabled: true, menu: 'off', news: 'off', trending: 'off', image: 'keep' },
    hasFocus: false,
    mainFocusGuard: true,
    initialStates: { qs_menu_ctrl: true, qs_carousel_ctrl: true, qs_tobbs_ctrl: true },
    onSwitchClick(count, doc) {
      if (count === 3) doc.documentElement.removeAttribute('data-bhp-focus-lease');
    }
  });
  cleanupRace.window.addEventListener('bhp:focus-lease-response', event => {
    const message = JSON.parse(event.detail);
    if (message.op === 'ack' && cleanupRace.switchClickTimes.length === 3) cleanupRace.trustedInteraction('pointerdown');
  });
  await cleanupRace.waitFor(() => cleanupRace.status()?.phase === 'interrupted');
  assert.equal(cleanupRace.switchClickTimes.length, 3, 'trusted input during asynchronous cleanup cannot trigger an extra menu click');
  assert.equal(cleanupRace.button.getAttribute('aria-expanded'), 'true', 'the interrupted cleanup leaves the user-facing menu open');
  assert.equal(cleanupRace.elements.get('veil')?.isConnected, false, 'interrupted cleanup removes its veil');
  assert.equal(cleanupRace.document.documentElement.getAttribute('data-bhp-focus-lease'), null, 'interrupted cleanup revokes the renewed lease');
  cleanupRace.focus();
  await delay(50);
  assert.equal(cleanupRace.button.getAttribute('aria-expanded'), 'true', 'a later focus event does not perform a stale deferred close');
  assert.equal(cleanupRace.button.focusCalls || 0, 0, 'interrupted cleanup does not restore the old focus target');

  let pausedLease;
  pausedLease = makePage({
    stored: { enabled: true, menu: 'off', news: 'off', trending: 'off', image: 'keep' },
    hasFocus: false,
    mainFocusGuard: true,
    initialStates: { qs_menu_ctrl: true, qs_carousel_ctrl: true, qs_tobbs_ctrl: true },
    onSwitchClick(count) {
      if (count === 1) for (const listener of pausedLease.storageListeners) {
        listener({ homepagePreferences: { newValue: { enabled: false, menu: 'off', news: 'off', trending: 'off', image: 'keep' } } }, 'local');
      }
    }
  });
  await pausedLease.waitFor(() => pausedLease.status()?.phase === 'paused');
  assert.equal(pausedLease.switchClickTimes.length, 1, 'a preference revision ends the old lease before further stale clicks');
  assert.equal(pausedLease.document.documentElement.getAttribute('data-bhp-focus-lease'), null, 'pause revokes the MAIN lease');
  assert.equal(pausedLease.elements.get('veil')?.isConnected, false, 'pause does not strand a hidden menu veil');

  const driftedNews = makePage({
    stored: { enabled: true, menu: 'keep', news: 'off', trending: 'keep', image: 'keep' },
    initialStates: { qs_carousel_ctrl: false }
  });
  await driftedNews.waitFor(() => driftedNews.status()?.phase === 'done');
  const driftedClicks = driftedNews.switchClickTimes.length;
  driftedNews.elements.get('qs_carousel_ctrl').setAttribute('aria-checked', 'true');
  const driftStatus = driftedNews.status();
  assert.equal(driftStatus.phase, 'partial', 'status detects Bing restoring the native news switch');
  assert.deepEqual(JSON.parse(JSON.stringify(driftStatus.missing)), ['新闻和关注']);
  assert.equal(driftStatus.diagnostics[0].outcome, 'drifted');
  assert.equal(driftStatus.displayOverrides.newsHidden, true, 'native switch drift does not remove the visual hide rule');
  assert.equal(driftedNews.switchClickTimes.length, driftedClicks, 'status checks report drift without opening menus or clicking controls');

  const searchPath = makePage({ url: 'https://www.bing.com/search?q=public-test', stored: { enabled: true, news: 'off' } });
  assert.equal(searchPath.elements.has('bhp-news-visibility'), false, 'search paths are not changed');

  for (const switchDelayMs of [0, 50, 80, 150, 300, 600, 2000]) {
    const delayTrial = makePage({
      stored: { enabled: true, menu: 'off', news: 'off', trending: 'keep', image: 'keep', switchDelayMs },
      initiallyOpen: true,
      initialStates: { qs_menu_ctrl: true, qs_carousel_ctrl: true }
    });
    await delayTrial.waitFor(() => delayTrial.status()?.phase === 'done');
    assert.equal(delayTrial.switchClickTimes.length, 2, `${switchDelayMs} ms mode should toggle both requested fields once`);
    if (switchDelayMs === 0) assert.ok(delayTrial.switchClickTimes[1] - delayTrial.switchClickTimes[0] < 50, 'zero mode should add no scheduled delay');
    else assert.ok(delayTrial.switchClickTimes[1] - delayTrial.switchClickTimes[0] >= switchDelayMs - 5, `${switchDelayMs} ms mode should apply its configured gap`);
    assert.equal(delayTrial.status().phase, 'done');
    assert.equal(delayTrial.activeObservers.size, 0);
  }

  const asyncStarted = Date.now();
  const asynchronous = makePage({ stored: { image: 'off' }, lazyDelay: 0, toggleDelay: 80 });
  await asynchronous.waitFor(() => asynchronous.status()?.phase === 'done');
  const asynchronousElapsed = Date.now() - asyncStarted;
  assert.ok(asynchronousElapsed < 600, 'an asynchronous aria update must wake the observer before the fallback deadline');
  assert.equal(asynchronous.status().diagnostics[0].clicks, 1, 'asynchronous update must not trigger an unnecessary second toggle');
  assert.equal(asynchronous.activeObservers.size, 0, 'asynchronous option wait must disconnect its observer');

  const alreadyOpen = makePage({ initiallyOpen: true, stored: { image: 'off' } });
  await alreadyOpen.waitFor(() => alreadyOpen.status()?.phase === 'done');
  assert.equal(alreadyOpen.button.clicks, 0, 'an already-open menu must be left alone');
  assert.equal(alreadyOpen.button.getAttribute('aria-expanded'), 'true');

  const lateHandler = makePage({ stored: { image: 'off' }, handlerReadyAfter: 1, lazyDelay: 40 });
  await lateHandler.waitFor(() => lateHandler.status()?.phase === 'done');
  assert.equal(lateHandler.status().menuDiagnostic.expandedBefore, 'false');
  assert.equal(lateHandler.status().menuDiagnostic.attempts, 2, 'retry once when the first click lands before Bing binds its handler');
  assert.equal(lateHandler.status().menuDiagnostic.expandedAfter, 'true');
  assert.equal(lateHandler.status().menuDiagnostic.controlsReady, true);
  assert.equal(lateHandler.button.getAttribute('aria-expanded'), 'false', 'late-handler retry must still restore the menu closed');

  const wrongPath = makePage({ url: 'https://www.bing.com/search?q=x', stored: { image: 'off' } });
  await delay(100);
  assert.equal(wrongPath.status(), undefined, 'non-homepage paths must not register or run the content script');

  const interrupted = makePage({ stored: { image: 'off' }, lazyDelay: 350, hasFocus: true, initialFocus: 'search' });
  await interrupted.waitFor(() => interrupted.button.getAttribute('aria-expanded') === 'true');
  const interrupt = { isTrusted: true };
  interrupted.document.dispatch('pointerdown', interrupt);
  await interrupted.waitFor(() => interrupted.status()?.phase === 'interrupted');
  assert.equal(interrupted.button.getAttribute('aria-expanded'), 'true', 'user interaction must stop automation without closing the menu under the user');
  assert.equal(interrupted.elements.get('veil').isConnected, false, 'interruption must remove the temporary veil');
  assert.equal(interrupted.activeObservers.size, 0, 'trusted interaction must disconnect pending observers');
  assert.equal(interrupted.elements.get('sb_form_q').focusCalls || 0, 0, 'trusted user interruption must not restore prior page focus');

  const revised = makePage({ stored: { image: 'off' }, lazyDelay: 350 });
  await revised.waitFor(() => revised.button.getAttribute('aria-expanded') === 'true');
  await delay(100);
  for (const listener of revised.storageListeners) listener({ homepagePreferences: { newValue: { image: 'keep' } } }, 'local');
  await revised.waitFor(() => revised.status()?.phase === 'unmanaged');
  assert.equal(revised.button.getAttribute('aria-expanded'), 'false', 'a superseded run must restore its own temporary menu state');
  assert.equal(revised.activeObservers.size, 0, 'preference revision must cancel and disconnect pending observers');

  const missingControls = makePage({ stored: { image: 'off' }, withControls: false });
  await missingControls.waitFor(() => missingControls.status()?.phase === 'partial');
  assert.deepEqual(JSON.parse(JSON.stringify(missingControls.status().missing)), ['主页图片'], 'missing native controls must be reported instead of claimed applied');
  assert.equal(missingControls.button.getAttribute('aria-expanded'), 'false', 'timeout must still restore the automatically opened menu');
  assert.equal(missingControls.status().menuDiagnostic.attempts, 1, 'an expanded menu must never be toggled again, even if controls fail to load');
  assert.equal(missingControls.status().menuDiagnostic.expandedAfter, 'true');
  assert.equal(missingControls.activeObservers.size, 0, 'timeout must disconnect pending observers');

  const unfocusedOmnibox = makePage({ stored: { image: 'off' }, hasFocus: false, initialFocus: 'search' });
  await unfocusedOmnibox.waitFor(() => unfocusedOmnibox.status()?.phase === 'waiting-focus');
  assert.equal(unfocusedOmnibox.button.clicks, 0, 'an initially unfocused page must not open the Bing menu');
  assert.equal(unfocusedOmnibox.elements.get('sb_form_q').focusCalls || 0, 0, 'lost page focus must never restore focus to Bing search');
  assert.equal(unfocusedOmnibox.document.getElementById('veil'), null, 'initial focus deferral must not leave a menu veil');
  unfocusedOmnibox.advanceTime(25000);
  await delay(60);
  assert.equal(unfocusedOmnibox.status().phase, 'waiting-focus', 'focus deferral must remain pending beyond the menu deadline');
  unfocusedOmnibox.focus();
  await unfocusedOmnibox.waitFor(() => unfocusedOmnibox.status()?.phase === 'done');
  assert.equal(unfocusedOmnibox.button.clicks, 2, 'after focus returns the native menu opens and closes once');
  assert.equal(unfocusedOmnibox.elements.get('sb_form_q').focusCalls || 0, 1, 'focus restoration retains the prior behavior only after the page has focus again');

  const blursMidRun = makePage({
    stored: { menu: 'off', news: 'off', trending: 'off', image: 'keep', switchDelayMs: 80 },
    initialStates: { qs_menu_ctrl: true, qs_carousel_ctrl: true, qs_tobbs_ctrl: true },
    onSwitchClick(count, doc) { if (count === 1) blursMidRun?.setFocus(false); }
  });
  await blursMidRun.waitFor(() => blursMidRun.status()?.phase === 'waiting-focus');
  assert.equal(blursMidRun.switchClickTimes.length, 1, 'only the first switch may click before focus is lost');
  assert.equal(blursMidRun.button.getAttribute('aria-expanded'), 'true', 'the opened menu remains open while its cleanup is deferred');
  assert.equal(blursMidRun.elements.get('veil')?.isConnected, true, 'the temporary veil stays in place while the menu cannot safely close');
  blursMidRun.advanceTime(25000);
  await delay(60);
  assert.equal(blursMidRun.switchClickTimes.length, 1, 'no late switch or cleanup click occurs while unfocused');
  assert.equal(blursMidRun.elements.get('veil')?.isConnected, true, 'deadline expiry must not reveal the open menu');
  blursMidRun.focus();
  await blursMidRun.waitFor(() => blursMidRun.status()?.phase === 'done');
  assert.equal(blursMidRun.elements.get('qs_menu_ctrl').getAttribute('aria-checked'), 'false');
  assert.equal(blursMidRun.elements.get('qs_carousel_ctrl').getAttribute('aria-checked'), 'false');
  assert.equal(blursMidRun.elements.get('qs_tobbs_ctrl').getAttribute('aria-checked'), 'false');
  assert.equal(blursMidRun.button.getAttribute('aria-expanded'), 'false', 'deferred cleanup closes the menu after focus returns');
  assert.equal(blursMidRun.elements.get('veil')?.isConnected, false, 'deferred cleanup removes the veil after closing');

  const revisedDuringDeferredCleanup = makePage({
    stored: { image: 'off' },
    onSwitchClick(_count, doc) { revisedDuringDeferredCleanup?.setFocus(false); }
  });
  await revisedDuringDeferredCleanup.waitFor(() => revisedDuringDeferredCleanup.status()?.phase === 'waiting-focus');
  assert.equal(revisedDuringDeferredCleanup.elements.get('veil')?.isConnected, true);
  for (const listener of revisedDuringDeferredCleanup.storageListeners) {
    listener({ homepagePreferences: { newValue: { enabled: false, image: 'off' } } }, 'local');
  }
  await revisedDuringDeferredCleanup.waitFor(() => revisedDuringDeferredCleanup.status()?.phase === 'paused');
  assert.equal(revisedDuringDeferredCleanup.elements.get('veil')?.isConnected, false, 'pause removes the deferred menu veil immediately');
  revisedDuringDeferredCleanup.document.dispatch('pointerdown', { isTrusted: true });
  assert.equal(revisedDuringDeferredCleanup.status().phase, 'paused', 'a canceled revision remains paused after later interaction');
  revisedDuringDeferredCleanup.focus();
  await delay(100);
  assert.equal(revisedDuringDeferredCleanup.button.getAttribute('aria-expanded'), 'true', 'after user interaction the script leaves the open menu alone');
  assert.equal(revisedDuringDeferredCleanup.switchClickTimes.length, 1, 'preference revision cannot queue stale switch clicks');

  const trustedWhilePending = makePage({ stored: { image: 'off' }, hasFocus: false });
  await trustedWhilePending.waitFor(() => trustedWhilePending.status()?.phase === 'waiting-focus');
  trustedWhilePending.document.dispatch('keydown', { isTrusted: true });
  assert.equal(trustedWhilePending.status().phase, 'interrupted', 'trusted interaction cancels a pending auto-apply');
  trustedWhilePending.focus();
  await delay(100);
  assert.equal(trustedWhilePending.button.clicks, 0, 'cancelled pending work cannot run after focus returns');

  const disabledWhilePending = makePage({ stored: { image: 'off' }, hasFocus: false });
  await disabledWhilePending.waitFor(() => disabledWhilePending.status()?.phase === 'waiting-focus');
  for (const listener of disabledWhilePending.storageListeners) {
    listener({ homepagePreferences: { newValue: { enabled: false, image: 'off' } } }, 'local');
  }
  await disabledWhilePending.waitFor(() => disabledWhilePending.status()?.phase === 'paused');
  disabledWhilePending.focus();
  await delay(100);
  assert.equal(disabledWhilePending.button.clicks, 0, 'disabling while focus is pending cancels all stale clicks');

  const focusedPage = makePage({ stored: { image: 'off' }, hasFocus: true, initialFocus: 'search' });
  await focusedPage.waitFor(() => focusedPage.status()?.phase === 'done');
  assert.equal(focusedPage.elements.get('sb_form_q').focusCalls, 1, 'a focused page retains the existing search-focus restoration behavior');

  const unavailableFocusApi = makePage({ stored: { image: 'off' }, hasFocus: 'missing', initialFocus: 'search' });
  await unavailableFocusApi.waitFor(() => unavailableFocusApi.status()?.phase === 'waiting-focus');
  assert.equal(unavailableFocusApi.elements.get('sb_form_q').focusCalls || 0, 0, 'missing document.hasFocus must fail safe without restoring focus');
  assert.equal(unavailableFocusApi.button.clicks, 0, 'a missing focus API must fail safe without clicking Bing controls');

  const throwingFocusApi = makePage({ stored: { image: 'off' }, hasFocus: 'throws', initialFocus: 'search' });
  await throwingFocusApi.waitFor(() => throwingFocusApi.status()?.phase === 'waiting-focus');
  assert.equal(throwingFocusApi.elements.get('sb_form_q').focusCalls || 0, 0, 'a throwing focus API must fail safe without restoring focus');
  assert.equal(throwingFocusApi.button.clicks, 0, 'a throwing focus API must fail safe without clicking Bing controls');

  console.log(`TIMING: three synchronous option changes ${configuredElapsed} ms total; click gaps ${configured.switchClickTimes[1] - configured.switchClickTimes[0]} ms and ${configured.switchClickTimes[2] - configured.switchClickTimes[1]} ms; one 80 ms asynchronous state change ${asynchronousElapsed} ms total.`);
  console.log('PASS: host/path filtering, normalization, keep defaults, lazy menu application/restoration, existing-menu preservation, trusted-user interruption, preference-revision cancellation, and missing-control timeout reporting');
})().catch(error => { console.error(error); process.exitCode = 1; });
