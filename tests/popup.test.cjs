const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const base = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(base, 'src/preferences.js'), 'utf8');
const popup = fs.readFileSync(path.join(base, 'src/popup.js'), 'utf8');

class Element {
  constructor(id, props = {}) {
    this.id = id;
    this.listeners = new Map();
    this.dataset = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    Object.assign(this, props);
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  fire(type, properties = {}) {
    const event = { target: this, key: '', preventDefault() { this.prevented = true; }, ...properties };
    for (const callback of this.listeners.get(type) || []) callback(event);
    return event;
  }
}

function createPopup({ stored, response, activeTab = { id: 7 }, storageSet } = {}) {
  const ids = ['preferences', 'controls', 'enabled', 'menu', 'news', 'trending', 'image', 'switchDelayMs',
    'delayError', 'delaySummaryValue', 'saveDelay', 'status', 'retry', 'uiLanguage'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  const presets = ['wallpaper', 'off'].map(preset => new Element(`preset-${preset}`, { dataset: { preset } }));
  const writes = [];
  const sent = [];
  let statusResponse = response || { phase: 'done', applied: [], missing: [] };
  let currentTab = activeTab;
  let failNextSave = false;
  let messageHandler = null;
  elements.preferences.listeners = new Map();
  const document = {
    activeElement: null,
    getElementById: id => elements[id] || null,
    querySelectorAll: selector => selector === '[data-preset]' ? presets : selector === '#uiLanguage' ? [elements.uiLanguage] : []
  };
  let selectedLanguage = 'auto';
  let activeLocale = 'zh_CN';
  const languageStrings = {
    zh_CN: { languageSaved:'语言已保存。', languageSaveFailed:'语言保存失败 · 已恢复之前的语言。', saving:'正在保存…',
      delayInvalid:'请输入 0–2000 之间的整数。', saveFailed:'保存失败 · 请重新选择或重开扩展。',
      noChanges:'已保存 · 选择要自动更改的项目即可开始。', newsLayoutSettling:'新闻区域已隐藏 · Bing 正在调整版面。',
      waitingFocusNews:'新闻区域已隐藏 · 等待页面焦点后继续应用 Bing 设置。', waitingFocus:'等待页面焦点后继续；地址栏不会被主动聚焦。',
      loadingBing:'正在检查 Bing 首页…', applying:'正在应用设置…', done:'主页设置已应用。', unmanaged:'已保存 · 打开或刷新 Bing 首页以应用。',
      interrupted:'自动设置已停止 · 可重试。', unsupported:'未找到主页设置 · 页面可能尚未加载或已改版。', error:'读取设置状态失败 · 可重试。',
      paused:'已暂停 · Bing 当前设置保持不变。', unableRetry:'无法重试 · 请打开或刷新 Bing 首页。', partialUnknown:'部分设置尚未确认。',
      newsPending:'新闻区域已隐藏 · Bing 开关待完成：{items}。', pendingItems:'部分设置待完成：{items}。', newsLayoutUnknown:'新闻区域已隐藏 · 此版主页布局暂无法确认。', doneNews:'已应用 · 新闻区域已隐藏。',
      pageMenu:'菜单栏', pageNews:'新闻和关注', pageTrending:'必应热点', pageImage:'背景图片', saved:'已保存。' },
    en: { languageSaved:'Language saved.', languageSaveFailed:'Could not save the language · Previous language restored.', noChanges:'Saved · Choose an item to change.', saving:'Saving…',
      delayInvalid:'Enter a whole number from 0 to 2000.', saveFailed:'Could not save · Choose again or reopen the extension.' },
    de: { languageSaved:'Sprache gespeichert.', languageSaveFailed:'Sprache konnte nicht gespeichert werden · Vorherige Sprache wiederhergestellt.', noChanges:'Gespeichert · Wähle eine Einstellung zum Ändern.', saving:'Wird gespeichert…',
      delayInvalid:'Gib eine ganze Zahl von 0 bis 2000 ein.', saveFailed:'Speichern fehlgeschlagen · Wähle die Einstellung erneut oder öffne die Erweiterung neu.' }
  };
  const i18n = {
    ready: Promise.resolve(),
    t(key, vars = {}) { return String(languageStrings[activeLocale][key] || key).replace(/\{(\w+)\}/g, (_m, k) => vars[k] || ''); },
    get selected() { return selectedLanguage; },
    get locale() { return activeLocale; },
    normalize(value) { return ['auto', 'zh_CN', 'en', 'de'].includes(value) ? value : 'auto'; },
    setSelected(value) { selectedLanguage = value; activeLocale = value === 'auto' ? 'zh_CN' : value; }
  };
  const chrome = {
    storage: { local: {
      get: async () => ({ homepagePreferences: stored }),
      set: async values => {
        if (values.homepagePreferences) writes.push(structuredClone(values.homepagePreferences));
        if (storageSet) await storageSet(values, writes.length);
        if (failNextSave) { failNextSave = false; throw new Error('storage failure'); }
      }
    } },
    tabs: {
      query: async () => currentTab ? [currentTab] : [],
      getCurrent: callback => callback(undefined),
      sendMessage: async (tabId, message) => {
        sent.push({ tabId, message });
        if (messageHandler) return messageHandler(tabId, message);
        if (message.type === 'bing-home:apply') return { phase: 'applying' };
        return statusResponse;
      }
    }
  };
  const timers = [];
  const context = vm.createContext({
    document, chrome, console, BingHomeI18n: i18n,
    window: { addEventListener() {}, setTimeout() { return 1; } },
    setInterval(callback) { timers.push(callback); return timers.length; },
    clearInterval() {},
    URL,
    structuredClone
  });
  vm.runInContext(source, context, { filename: 'preferences.js' });
  vm.runInContext(popup, context, { filename: 'popup.js' });
  return {
    elements, presets, writes, sent, timers, i18n,
    setResponse(value) { statusResponse = value; },
    setMessageHandler(handler) { messageHandler = handler; },
    setTab(value) { currentTab = value; },
    failNextSave() { failNextSave = true; },
    async flush() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

(async () => {
  const starting = { enabled: true, menu: 'keep', news: 'keep', trending: 'keep', image: 'keep', switchDelayMs: 300 };
  const app = createPopup({ stored: starting, response: { phase: 'done', applied: [] } });
  await app.flush();
  assert.equal(app.elements.menu.value, 'keep');
  assert.equal(app.elements.switchDelayMs.value, '300');
  assert.equal(app.elements.delaySummaryValue.textContent, '300 ms');
  assert.equal(app.elements.status.textContent, '已保存 · 选择要自动更改的项目即可开始。');
  assert.deepEqual(app.presets.map(item => item.dataset.preset), ['wallpaper', 'off'], 'only the two useful presets remain');

  app.elements.news.value = 'off';
  app.elements.preferences.fire('change', { target: app.elements.news });
  await app.flush();
  assert.equal(app.writes.at(-1).news, 'off', 'a setting change is persisted');
  assert.equal(app.writes.at(-1).switchDelayMs, 300, 'existing delay is preserved');

  app.presets[0].fire('click');
  await app.flush();
  assert.deepEqual([app.writes.at(-1).menu, app.writes.at(-1).news, app.writes.at(-1).trending, app.writes.at(-1).image], ['off', 'off', 'off', 'on']);
  assert.equal(app.writes.at(-1).switchDelayMs, 300, 'wallpaper preset does not reset the delay');
  app.presets[1].fire('click');
  await app.flush();
  assert.deepEqual([app.writes.at(-1).menu, app.writes.at(-1).news, app.writes.at(-1).trending, app.writes.at(-1).image], ['off', 'off', 'off', 'off']);
  assert.equal(app.writes.at(-1).switchDelayMs, 300, 'all-off preset does not reset the delay');

  app.elements.switchDelayMs.value = '2001';
  app.elements.saveDelay.fire('click');
  await app.flush();
  assert.equal(app.elements.delayError.textContent, '请输入 0–2000 之间的整数。');
  assert.equal(app.elements.switchDelayMs.value, '300');
  const writesBeforeValidDelay = app.writes.length;
  app.elements.switchDelayMs.value = '50';
  app.elements.preferences.fire('submit');
  const enter = app.elements.switchDelayMs.fire('keydown', { key: 'Enter' });
  await app.flush();
  assert.equal(enter.prevented, true, 'Enter saves without submitting the settings form');
  assert.equal(app.writes.length, writesBeforeValidDelay + 1);
  assert.equal(app.writes.at(-1).switchDelayMs, 50, 'valid custom delay is stored as a number');
  assert.equal(app.elements.delaySummaryValue.textContent, '50 ms');

  app.setResponse({ phase: 'partial', missing: ['新闻和关注'], layout: 'settling', displayOverrides: { newsHidden: true }, diagnostics: [{ label: 'internal detail must not show' }] });
  app.timers[0]();
  await app.flush();
  assert.match(app.elements.status.textContent, /新闻区域已隐藏/);
  assert.match(app.elements.status.textContent, /正在调整版面/);
  assert.doesNotMatch(app.elements.status.textContent, /internal detail|初始|点击\d|aria|诊断/);
  assert.equal(app.elements.retry.hidden, false, 'partial status keeps retry available');

  app.setResponse({ phase: 'waiting-focus', displayOverrides: { newsHidden: true } });
  app.timers[0]();
  await app.flush();
  assert.match(app.elements.status.textContent, /等待页面焦点/);
  assert.match(app.elements.status.textContent, /新闻区域已隐藏/);

  for (const [phase, expected] of [
    ['loading', '正在检查 Bing 首页'], ['applying', '正在应用设置'], ['done', '主页设置已应用'],
    ['unmanaged', '打开或刷新 Bing 首页'], ['interrupted', '自动设置已停止'],
    ['unsupported', '未找到主页设置'], ['error', '读取设置状态失败']
  ]) {
    app.setResponse({ phase, diagnostics: [{ label: 'secret internal detail', outcome: 'diagnostic' }] });
    app.timers[0]();
    await app.flush();
    assert.match(app.elements.status.textContent, new RegExp(expected), `${phase} has a concise user-facing label`);
    assert.doesNotMatch(app.elements.status.textContent, /secret internal detail|diagnostic|点击\d|aria/);
  }

  app.setResponse({ phase: 'paused' });
  app.elements.enabled.checked = false;
  app.elements.preferences.fire('change', { target: app.elements.enabled });
  await app.flush();
  assert.match(app.elements.status.textContent, /已暂停/);

  app.setTab(null);
  app.elements.retry.fire('click');
  await app.flush();
  assert.match(app.elements.status.textContent, /无法重试/);
  assert.equal(app.elements.retry.hidden, false, 'missing active tab is reported as retryable');

  const failedSave = createPopup({ stored: starting });
  await failedSave.flush();
  failedSave.failNextSave();
  failedSave.elements.news.value = 'off';
  failedSave.elements.preferences.fire('change', { target: failedSave.elements.news });
  await failedSave.flush();
  assert.match(failedSave.elements.status.textContent, /保存失败/);
  assert.doesNotMatch(failedSave.elements.status.textContent, /已应用/);

  let releaseFirst;
  const serial = createPopup({ stored: starting, storageSet: () => new Promise(resolve => { releaseFirst ||= resolve; }) });
  await serial.flush();
  serial.elements.menu.value = 'off';
  serial.elements.preferences.fire('change', { target: serial.elements.menu });
  serial.elements.news.value = 'off';
  serial.elements.preferences.fire('change', { target: serial.elements.news });
  await serial.flush();
  assert.equal(serial.writes.length, 1, 'writes are serialized; a second write waits for the first');
  releaseFirst();
  await serial.flush();
  assert.equal(serial.writes.length, 2);
  assert.equal(serial.writes[0].menu, 'off');
  assert.equal(serial.writes[1].news, 'off');

  const lateSuccess = deferred();
  const successRace = createPopup({ stored: { ...starting, menu: 'off' }, response: lateSuccess.promise });
  await successRace.flush();
  successRace.failNextSave();
  successRace.elements.news.value = 'off';
  successRace.elements.preferences.fire('change', { target: successRace.elements.news });
  await successRace.flush();
  assert.match(successRace.elements.status.textContent, /保存失败/);
  lateSuccess.resolve({ phase: 'done', applied: [] });
  await successRace.flush();
  assert.match(successRace.elements.status.textContent, /保存失败/, 'a stale successful status response cannot overwrite a later save failure');

  const lateFailure = deferred();
  const failureRace = createPopup({ stored: { ...starting, menu: 'off' }, response: lateFailure.promise });
  await failureRace.flush();
  failureRace.failNextSave();
  failureRace.elements.news.value = 'off';
  failureRace.elements.preferences.fire('change', { target: failureRace.elements.news });
  await failureRace.flush();
  assert.match(failureRace.elements.status.textContent, /保存失败/);
  lateFailure.reject(new Error('old status request failed'));
  await failureRace.flush();
  assert.match(failureRace.elements.status.textContent, /保存失败/, 'a stale failed status request cannot overwrite a later save failure');

  const lateRetryFailure = deferred();
  const retryRace = createPopup({ stored: { ...starting, menu: 'off' } });
  await retryRace.flush();
  retryRace.setMessageHandler((_tabId, message) => message.type === 'bing-home:apply' ? lateRetryFailure.promise : { phase: 'done' });
  retryRace.elements.retry.fire('click');
  await retryRace.flush();
  retryRace.failNextSave();
  retryRace.elements.news.value = 'off';
  retryRace.elements.preferences.fire('change', { target: retryRace.elements.news });
  await retryRace.flush();
  assert.match(retryRace.elements.status.textContent, /保存失败/);
  lateRetryFailure.reject(new Error('old retry failed'));
  await retryRace.flush();
  assert.match(retryRace.elements.status.textContent, /保存失败/, 'a stale retry failure cannot overwrite a later save failure');

  const languageApp = createPopup({ stored: starting });
  await languageApp.flush();
  languageApp.elements.uiLanguage.value = 'de';
  languageApp.elements.uiLanguage.fire('change', { target: languageApp.elements.uiLanguage });
  await languageApp.flush();
  assert.equal(languageApp.writes.at(-1), undefined, 'language is stored separately from homepage preferences');
  assert.equal(languageApp.i18n.selected, 'de');
  assert.match(languageApp.elements.status.textContent, /Gespeichert/, 'a successful language change resumes ordinary status instead of holding a stale success message');

  const languageFailure = createPopup({ stored: starting });
  await languageFailure.flush();
  languageFailure.failNextSave();
  languageFailure.elements.uiLanguage.value = 'en';
  languageFailure.elements.uiLanguage.fire('change', { target: languageFailure.elements.uiLanguage });
  await languageFailure.flush();
  assert.equal(languageFailure.i18n.selected, 'auto', 'failed language write restores previous persisted language choice');
  assert.match(languageFailure.elements.status.textContent, /语言保存失败/);

  const staleStatus = deferred();
  const languageRace = createPopup({ stored: { ...starting, menu: 'off' }, response: staleStatus.promise });
  await languageRace.flush();
  languageRace.failNextSave();
  languageRace.elements.uiLanguage.value = 'en';
  languageRace.elements.uiLanguage.fire('change', { target: languageRace.elements.uiLanguage });
  await languageRace.flush();
  assert.match(languageRace.elements.status.textContent, /语言保存失败/);
  languageRace.timers[0]();
  await languageRace.flush();
  staleStatus.resolve({ phase: 'done', missing: [] });
  await languageRace.flush();
  assert.match(languageRace.elements.status.textContent, /语言保存失败/, 'late status and polling cannot overwrite the language save error');
  assert.equal(languageRace.writes.filter(value => value !== undefined).length, 0, 'failed language save does not write homepage preferences');

  const prefsFailureThenLanguageSuccess = createPopup({ stored: starting });
  await prefsFailureThenLanguageSuccess.flush();
  prefsFailureThenLanguageSuccess.failNextSave();
  prefsFailureThenLanguageSuccess.elements.news.value = 'off';
  prefsFailureThenLanguageSuccess.elements.preferences.fire('change', { target: prefsFailureThenLanguageSuccess.elements.news });
  await prefsFailureThenLanguageSuccess.flush();
  prefsFailureThenLanguageSuccess.elements.uiLanguage.value = 'en';
  prefsFailureThenLanguageSuccess.elements.uiLanguage.fire('change', { target: prefsFailureThenLanguageSuccess.elements.uiLanguage });
  await prefsFailureThenLanguageSuccess.flush();
  assert.match(prefsFailureThenLanguageSuccess.elements.status.textContent, /Could not save/, 'language success preserves an outstanding homepage save error in the new language');

  console.log('PASS: popup preferences, two presets, custom delay, concise status, retry/error handling, serialized writes, and separate language persistence');
})().catch(error => { console.error(error); process.exitCode = 1; });
