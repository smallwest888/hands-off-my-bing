(() => {
  'use strict';
  const api = globalThis.BingHomePreferences;
  const i18n = globalThis.BingHomeI18n;
  const status = document.getElementById('status');
  const controls = document.getElementById('controls');
  const retry = document.getElementById('retry');
  const delayInput = document.getElementById('switchDelayMs');
  const delayError = document.getElementById('delayError');
  const delaySummaryValue = document.getElementById('delaySummaryValue');
  const languageInputs = [...document.querySelectorAll('#uiLanguage')];
  let preferences = api.normalize();
  let saving = Promise.resolve();
  let saveVersion = 0;
  let savedVersion = 0;
  let saveFailed = false;
  let lastPersistedLanguage = 'auto';
  let languageSaving = false;
  let settingsReady = false;
  let feedbackRevision = 0;
  let feedbackHold = false;
  let statusKey = 'loadingSettings';
  let statusVars = {};

  function t(key, vars) { return i18n.t(key, vars); }
  function renderStatus() { status.textContent = t(statusKey, statusVars); }
  function setStatus(key, vars = {}) { statusKey = key; statusVars = vars; renderStatus(); }
  globalThis.BingHomeRenderStatus = renderStatus;

  function render() {
    document.getElementById('enabled').checked = preferences.enabled;
    if (document.activeElement !== delayInput) delayInput.value = String(preferences.switchDelayMs);
    delaySummaryValue.textContent = `${preferences.switchDelayMs} ms`;
    for (const field of api.fields) {
      const element = document.getElementById(field.key);
      element.value = preferences[field.key];
      element.dataset.mode = element.value;
    }
  }

  function statusForResult(result) {
    const missing = Array.isArray(result?.missing) ? result.missing.map(key => {
      const map = {
        menu: 'pageMenu', news: 'pageNews', trending: 'pageTrending', image: 'pageImage',
        '菜单栏': 'pageMenu', '新闻和关注': 'pageNews', '必应上的热点': 'pageTrending', '主页图片': 'pageImage', '背景图片': 'pageImage'
      };
      return t(map[key] || 'itemPending');
    }) : [];
    const newsHidden = result?.displayOverrides?.newsHidden === true;
    if (result?.phase === 'waiting-focus') return [newsHidden ? 'waitingFocusNews' : 'waitingFocus', {}];
    if (result?.phase === 'partial') {
      if (newsHidden && result.layout === 'settling') return ['newsLayoutSettling', {}];
      if (newsHidden && result.layout === 'unconfirmed') return ['newsLayoutUnknown', {}];
      if (newsHidden && missing.length) return ['newsPending', { items: missing.join(i18n.locale === 'zh_CN' ? '、' : ', ') }];
      return missing.length ? ['pendingItems', { items: missing.join(', ') }] : ['partialUnknown', {}];
    }
    if (newsHidden && result?.phase === 'done') return ['doneNews', {}];
    const labels = {
      loading: 'loadingBing', applying: 'applying', done: 'done', unmanaged: 'unmanaged', paused: 'paused',
      interrupted: 'interrupted', unsupported: 'unsupported', error: 'error'
    };
    return [labels[result?.phase] || 'saved', {}];
  }

  function currentStatus() {
    if (savedVersion !== saveVersion || saveFailed || languageSaving || feedbackHold) return Promise.resolve();
    const requestVersion = saveVersion;
    const requestFeedback = feedbackRevision;
    const stillCurrent = () => requestVersion === saveVersion && savedVersion === requestVersion &&
      requestFeedback === feedbackRevision && !saveFailed && !languageSaving && !feedbackHold;
    retry.hidden = true;
    if (!preferences.enabled) { setStatus('paused'); return Promise.resolve(); }
    if (api.fields.every(field => preferences[field.key] === 'keep')) {
      setStatus('noChanges');
      return Promise.resolve();
    }
    return (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!stillCurrent()) return;
        if (!tab?.id) throw new Error('Missing active tab');
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'bing-home:status' });
        if (!stillCurrent()) return;
        const [key, vars] = statusForResult(result);
        setStatus(key, vars);
        retry.hidden = !['interrupted', 'unsupported', 'error', 'partial', 'unmanaged'].includes(result?.phase);
      } catch {
        if (!stillCurrent()) return;
        setStatus('unmanaged');
        retry.hidden = false;
      }
    })();
  }

  function save() {
    ++feedbackRevision;
    feedbackHold = false;
    render();
    const snapshot = api.normalize(preferences);
    const version = ++saveVersion;
    saveFailed = false;
    retry.hidden = true;
    setStatus('saving');
    saving = saving.then(() => chrome.storage.local.set({ [api.storageKey]: snapshot }))
      .then(() => {
        savedVersion = version;
        if (version === saveVersion) void currentStatus();
      }).catch(() => {
        if (version === saveVersion) {
          saveFailed = true;
          feedbackHold = true;
          retry.hidden = true;
          setStatus('saveFailed');
        }
      });
  }

  function saveLanguage(value) {
    ++feedbackRevision;
    const next = i18n.normalize(value);
    languageSaving = true;
    feedbackHold = true;
    controls.disabled = true;
    for (const input of languageInputs) input.disabled = true;
    const localeReady = i18n.setSelected(next);
    setStatus('saving');
    saving = saving.then(async () => {
      await localeReady;
      setStatus('saving');
      await chrome.storage.local.set({ uiLanguage: next });
    }).then(() => {
      lastPersistedLanguage = next;
      languageSaving = false;
      for (const input of languageInputs) input.disabled = false;
      controls.disabled = !settingsReady;
      if (saveFailed) setStatus('saveFailed');
      else {
        feedbackHold = false;
        void currentStatus();
      }
    }).catch(async () => {
      await i18n.setSelected(lastPersistedLanguage);
      for (const input of languageInputs) { input.disabled = false; input.value = lastPersistedLanguage; }
      languageSaving = false;
      feedbackHold = true;
      controls.disabled = !settingsReady;
      setStatus('languageSaveFailed');
    });
  }

  document.getElementById('preferences').addEventListener('submit', event => event.preventDefault());
  document.getElementById('preferences').addEventListener('change', event => {
    const key = event.target.id;
    if (key === 'enabled') preferences.enabled = event.target.checked;
    else if (api.fields.some(field => field.key === key)) preferences[key] = event.target.value;
    else return;
    save();
  });

  function commitDelay() {
    const raw = String(delayInput.value).trim();
    if (!/^\d+$/.test(raw) || !api.isValidSwitchDelay(Number(raw))) {
      delayError.textContent = t('delayInvalid');
      delayInput.value = String(preferences.switchDelayMs);
      return;
    }
    delayError.textContent = '';
    preferences.switchDelayMs = Number(raw);
    save();
  }
  document.getElementById('saveDelay').addEventListener('click', commitDelay);
  delayInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); commitDelay(); }
  });

  for (const select of languageInputs) select.addEventListener('change', event => {
    for (const other of languageInputs) other.value = event.target.value;
    saveLanguage(event.target.value);
  });

  for (const button of document.querySelectorAll('[data-preset]')) {
    button.addEventListener('click', () => {
      const preset = button.dataset.preset;
      preferences.enabled = true;
      for (const field of api.fields) preferences[field.key] = 'off';
      if (preset === 'wallpaper') preferences.image = 'on';
      save();
    });
  }

  retry.addEventListener('click', async () => {
    ++feedbackRevision;
    feedbackHold = false;
    const requestVersion = saveVersion;
    const requestFeedback = feedbackRevision;
    const stillCurrent = () => requestVersion === saveVersion && savedVersion === requestVersion &&
      requestFeedback === feedbackRevision && !saveFailed && !languageSaving;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!stillCurrent()) return;
      if (!tab?.id) throw new Error('Missing active tab');
      await chrome.tabs.sendMessage(tab.id, { type: 'bing-home:apply' });
      if (!stillCurrent()) return;
      await currentStatus();
    } catch {
      if (!stillCurrent()) return;
      feedbackHold = true;
      setStatus('unableRetry');
      retry.hidden = false;
    }
  });

  void (async () => {
    try {
      await i18n.ready;
      lastPersistedLanguage = i18n.selected;
      const result = await chrome.storage.local.get(api.storageKey);
      preferences = api.normalize(result[api.storageKey]);
      render();
      settingsReady = true;
      controls.disabled = languageSaving;
      void currentStatus();
      const timer = setInterval(currentStatus, 1000);
      window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
    } catch {
      setStatus('readFailed');
    }
  })();
})();
