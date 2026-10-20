const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const base = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(base, 'src/ui-language.js'), 'utf8');
const css = fs.readFileSync(path.join(base, 'src/popup.css'), 'utf8');
const popupHtml = fs.readFileSync(path.join(base, 'src/popup.html'), 'utf8');
const privacyHtml = fs.readFileSync(path.join(base, 'src/privacy.html'), 'utf8');
const newtabHtml = fs.readFileSync(path.join(base, 'src/newtab.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'src/manifest.json'), 'utf8'));
const sourceByLocale = Object.fromEntries(['en', 'de', 'zh_CN'].map(locale => [locale,
  JSON.parse(fs.readFileSync(path.join(base, `src/_locales/${locale}/messages.json`), 'utf8'))]));

async function create({ stored = 'auto', system = 'en-US', storageFails = false, fetchImpl, deferReady = false } = {}) {
  const textNodes = ['appTitle', 'autoApply', 'privacyTitle', 'privacyHeading2', 'privacy1', 'privacy3', 'privacy6'].map(key => ({
    dataset: { i18n: key }, textContent: ''
  }));
  const ariaNodes = [{ dataset: { i18nAria: 'languageSelect' }, setAttribute(name, value) { this[name] = value; } }];
  const select = { value: '', options: [], dataset: {}, appendChild(option) { this.options.push(option); } };
  const fieldSelect = { options: ['keep', 'off', 'on'].map(value => ({ value, textContent: `stale-${value}` })), appendChild(option) { this.options.push(option); } };
  const classes = new Set(['settings-page']);
  const document = {
    documentElement: {}, body: { classList: { add: value => classes.add(value), contains: value => classes.has(value) } },
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return textNodes;
      if (selector === '[data-i18n-aria]') return ariaNodes;
      if (selector === '#uiLanguage') return [select];
      if (selector === '[data-field]') return [fieldSelect];
      return [];
    },
    createElement(tag) { return { tag, value: '', textContent: '' }; }
  };
  const chrome = {
    i18n: { getUILanguage: () => system },
    storage: { local: { get: async () => { if (storageFails) throw new Error('storage denied'); return { uiLanguage: stored }; } } },
    tabs: { getCurrent: callback => callback(undefined) },
    runtime: { getURL: path => path }
  };
  const fetchCounts = new Map();
  const localFetch = fetchImpl || (async resourceUrl => {
    const file = resourceUrl.replace(/^_locales\//, '').replace(/\/messages\.json$/, '');
    fetchCounts.set(file, (fetchCounts.get(file) || 0) + 1);
    return { ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(base, `src/_locales/${file}/messages.json`), 'utf8')) };
  });
  const context = vm.createContext({ document, chrome, navigator: { language: system }, globalThis: null, URL, fetch: localFetch });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'ui-language.js' });
  const ready = context.BingHomeI18n.ready;
  if (!deferReady) await ready;
  return { i18n: context.BingHomeI18n, ready, textNodes, ariaNodes, select, fieldSelect, classes, fetchCounts };
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

(async () => {
  const zh = await create({ stored: 'zh_CN', system: 'en-US' });
  assert.equal(zh.i18n.locale, 'zh_CN');
  assert.equal(zh.i18n.t('autoApply'), '自动应用');
  assert.equal(zh.textNodes[0].textContent, '别动我的Bing主页');
  assert.deepEqual(zh.fieldSelect.options.map(option => option.textContent), ['保持原样', '关闭', '显示']);

  const en = await create({ stored: 'en', system: 'de-DE' });
  assert.equal(en.i18n.locale, 'en', 'saved language overrides the browser locale');
  assert.equal(en.textNodes[0].textContent, 'Hands Off My Bing');
  assert.equal(en.i18n.t('privacyTitle'), 'Hands Off My Bing — Privacy');
  assert.equal(en.i18n.t('privacyHeading2'), 'Temporary tab information');
  assert.match(en.i18n.t('privacy2'), /query/);
  assert.match(en.i18n.t('privacy3'), /single tab/);
  await en.i18n.setSelected('de');
  assert.deepEqual(en.fieldSelect.options.map(option => option.textContent), ['Unverändert', 'Ausblenden', 'Anzeigen'], 'existing option labels update when language changes');
  await en.i18n.setSelected('en');
  await en.i18n.setSelected('de');
  assert.equal(en.fetchCounts.get('de'), 1, 'packaged locale messages are cached after first local load');

  const de = await create({ stored: 'de', system: 'zh-CN' });
  assert.equal(de.i18n.locale, 'de');
  assert.equal(de.textNodes[0].textContent, 'Hands Off My Bing');
  assert.equal(de.i18n.t('languageAuto'), 'Automatisch');
  assert.match(de.i18n.t('delayHelp'), /0 bis 2000/);
  assert.match(de.i18n.t('privacy5'), /20 Sekunden/);
  assert.ok(de.i18n.t('privacy5').length < 300, 'German privacy copy stays concise');
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis|line-clamp/);
  assert.doesNotMatch(css, /backdrop-filter|linear-gradient|radial-gradient|box-shadow|prefers-color-scheme/, 'the dark Metro canvas stays solid and independent of the system theme');
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /:root\s*\{[^}]*background:\s*#090b10/, 'the default canvas is near-black');
  assert.match(css, /h1\s*\{[^}]*font-size:\s*26px[^}]*font-weight:\s*300/, 'the main title is large and lightweight');
  assert.match(css, /\.master\s*\{[^}]*background:\s*#0078d4[^}]*color:\s*#fff/, 'the master control is a flat blue tile');
  assert.match(css, /\.presets button:nth-child\(2\)\s*\{[^}]*background:\s*#005a9e/, 'the quick actions use solid blue fills');
  assert.doesNotMatch(css, /border-(?:top|bottom|left|right)\s*:/, 'settings and privacy groups have no divider lines');
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid/, 'keyboard focus stays visible');
  assert.match(css, /\.more-details summary::before/, 'the expandable settings row keeps a visible disclosure marker');
  assert.doesNotMatch(css.match(/body\.settings-page\s*\{[^}]*\}/)?.[0] || '', /min-height\s*:\s*100vh/, 'popup content determines its height instead of the viewport');
  assert.match(css.match(/body\.settings-page\s*\{[^}]*\}/)?.[0] || '', /width:\s*400px[\s\S]*max-height:\s*600px/, 'the popup uses a 400px width and a 600px scroll limit');
  assert.match(css, /body\.options-page \.panel\s*\{[^}]*width:\s*min\(560px, 100%\)/, 'the full options tab uses a centered 560px panel');
  assert.doesNotMatch(css.match(/body\.options-page\s*\{[^}]*\}/)?.[0] || '', /min-height\s*:\s*100vh/, 'the options tab does not force viewport-height whitespace');
  assert.equal((popupHtml.match(/class="panel"/g) || []).length, 1, 'the popup has one simple main surface');
  assert.match(popupHtml, /name="color-scheme" content="dark"/);
  assert.match(privacyHtml, /name="color-scheme" content="dark"/);
  assert.match(newtabHtml, /<title data-i18n="appTitle">别动我的Bing主页<\/title>/, 'the new-tab document has the Chinese brand fallback');
  assert.equal(manifest.version, '1.2.11');
  assert.equal(manifest.name, '__MSG_appName__');
  assert.equal(manifest.action.default_title, '__MSG_appName__');
  for (const [locale, expectedName] of Object.entries({
    zh_CN: '别动我的Bing主页', en: 'Hands Off My Bing', de: 'Hands Off My Bing'
  })) {
    assert.equal(sourceByLocale[locale].appName.message, expectedName, `${locale} manifest name matches the product brand`);
    assert.equal(sourceByLocale[locale].appTitle.message, expectedName, `${locale} UI title matches the product brand`);
    assert.match(sourceByLocale[locale].appDescription.message, /Chrome.*new tab|Chrome 新标签页|neuen Chrome-Tab/i, `${locale} description explains the new-tab behavior`);
    assert.match(sourceByLocale[locale].appDescription.message, /Bing/);
  }
  assert.match(css, /body\.privacy-page main\s*\{[^}]*width:\s*min\(560px, 100%\)/, 'the privacy page uses the same centered text width');
  assert.match(css, /\.privacy-item\s*\{[^}]*margin:\s*20px 0 0[^}]*padding:\s*0/, 'privacy sections are separated with whitespace');

  const privacyFacts = {
    en: [/stores .* locally/i, /current browser session/i, /background requests .* specific carousel endpoint/i, /Pausing does not restore/i, /at most 20 seconds.*up to 20 seconds/i, /no affiliation .* endorsement/i],
    de: [/speichert .* lokal/i, /aktuellen Browsersitzung/i, /Hintergrundanfragen .* Carousel-Endpunkt/i, /Pausieren stellt .* nicht wieder her/i, /höchstens 20 Sekunden .* bis zu 20 Sekunden/i, /ohne Zugehörigkeit .* Unterstützung/i],
    zh_CN: [/保存在本机/, /当前浏览器会话/, /轮播接口的后台请求/, /暂停时不会恢复/, /最长 20 秒.*最长也为 20 秒/, /无隶属关系，也未获其背书/]
  };
  for (const [locale, patterns] of Object.entries(privacyFacts)) {
    for (const [index, pattern] of patterns.entries()) assert.match(sourceByLocale[locale][`privacy${index + 1}`].message, pattern, `${locale} privacy section ${index + 1} retains its key fact`);
  }

  const autoDe = await create({ stored: 'auto', system: 'de-DE' });
  assert.equal(autoDe.i18n.locale, 'de', 'automatic mode follows browser language');
  autoDe.i18n.setSelected('fr');
  assert.equal(autoDe.i18n.selected, 'auto', 'unknown language falls back to automatic mode');
  assert.equal(autoDe.i18n.locale, 'de');

  const storageFallback = await create({ storageFails: true, system: 'zh-TW' });
  assert.equal(storageFallback.i18n.selected, 'auto');
  assert.equal(storageFallback.i18n.locale, 'zh_CN');
  assert.ok(storageFallback.classes.has('i18n-ready'));

  const requests = [];
  const racingFetch = resourceUrl => {
    const locale = resourceUrl.match(/_locales\/([^/]+)\/messages\.json$/)[1];
    const request = deferred();
    requests.push({ locale, request });
    return request.promise;
  };
  const racing = await create({ stored: 'auto', system: 'en-US', fetchImpl: racingFetch, deferReady: true });
  while (!requests.length) await new Promise(resolve => setImmediate(resolve));
  requests[0].request.resolve({ ok: true, json: async () => sourceByLocale.en });
  await racing.ready;
  const germanLoad = racing.i18n.setSelected('de');
  const englishLoad = racing.i18n.setSelected('en');
  await englishLoad;
  requests.find(item => item.locale === 'de').request.resolve({ ok: true, json: async () => sourceByLocale.de });
  await germanLoad;
  assert.equal(racing.i18n.locale, 'en');
  assert.equal(racing.i18n.t('privacyTitle'), 'Hands Off My Bing — Privacy', 'a late older locale response cannot replace newer language messages');

  console.log('PASS: three locales, browser-locale fallback, racing locale loads, Metro styling, popup/options sizing, privacy copy, and text wrapping');
})().catch(error => { console.error(error); process.exitCode = 1; });
