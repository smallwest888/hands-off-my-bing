(() => {
  'use strict';
  const supported = new Set(['auto', 'zh_CN', 'en', 'de']);
  let selected = 'auto';
  let locale = 'en';
  let messages = Object.create(null);
  let loadSequence = 0;
  const localeCache = new Map();

  function normalize(value) { return supported.has(value) ? value : 'auto'; }
  function systemLocale() {
    let raw = '';
    try { raw = chrome.i18n?.getUILanguage?.() || navigator.language || ''; } catch {}
    const low = String(raw).toLowerCase();
    if (low.startsWith('zh')) return 'zh_CN';
    if (low.startsWith('de')) return 'de';
    return 'en';
  }
  function syncMessage(key) {
    try { return chrome.i18n?.getMessage?.(key) || ''; } catch { return ''; }
  }
  function translate(key, vars = {}) {
    let value = messages[key] || syncMessage(key) || key;
    return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, name) => String(vars[name] ?? ''));
  }
  function setTitleAndLang() {
    if (!document?.documentElement) return;
    document.documentElement.lang = locale === 'zh_CN' ? 'zh-CN' : locale;
  }
  function apply() {
    if (typeof document === 'undefined') return;
    setTitleAndLang();
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = translate(node.dataset.i18n);
    for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', translate(node.dataset.i18nAria));
    for (const select of document.querySelectorAll('#uiLanguage')) select.value = selected;
    for (const select of document.querySelectorAll('[data-field]')) {
      const existing = new Map([...select.options].map(option => [option.value, option]));
      for (const mode of ['keep', 'off', 'on']) {
        let option = existing.get(mode);
        if (!option) {
          option = document.createElement('option');
          option.value = mode;
          select.appendChild(option);
        }
        option.textContent = translate(mode);
      }
    }
    if (document.body?.classList.contains('settings-page')) {
      try { chrome.tabs.getCurrent(tab => { if (tab?.id) document.body.classList.add('options-page'); }); } catch {}
    }
    document.body?.classList.add('i18n-ready');
    try { globalThis.BingHomeRenderStatus?.(); } catch {}
  }
  function localeMessages(targetLocale) {
    if (!localeCache.has(targetLocale)) {
      const pending = (async () => {
        const url = chrome.runtime.getURL(`_locales/${targetLocale}/messages.json`);
        const response = await fetch(url);
        if (!response.ok) throw new Error('Could not load packaged language file');
        const json = await response.json();
        return Object.fromEntries(Object.entries(json)
          .filter(([, entry]) => typeof entry?.message === 'string')
          .map(([key, entry]) => [key, entry.message]));
      })();
      localeCache.set(targetLocale, pending);
      pending.catch(() => localeCache.delete(targetLocale));
    }
    return localeCache.get(targetLocale);
  }
  async function loadLocale(next) {
    const sequence = ++loadSequence;
    const targetLocale = next === 'auto' ? systemLocale() : next;
    locale = targetLocale;
    try {
      const loadedMessages = await localeMessages(targetLocale);
      if (sequence === loadSequence) messages = loadedMessages;
    } catch { /* Chrome's built-in messages are the packaged browser-locale fallback. */ }
    if (sequence === loadSequence) apply();
    return selected;
  }
  const ready = (async () => {
    try {
      const stored = await chrome.storage.local.get('uiLanguage');
      selected = normalize(stored.uiLanguage);
    } catch { selected = 'auto'; }
    await loadLocale(selected);
    return selected;
  })();
  globalThis.BingHomeI18n = {
    ready, t: translate, apply,
    get selected() { return selected; },
    get locale() { return locale; },
    normalize,
    setSelected(value) {
      selected = normalize(value);
      return loadLocale(selected);
    }
  };
})();
