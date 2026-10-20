/* Shared by the popup and the isolated content script. No page globals used. */
(() => {
  const fields = Object.freeze([
    { key: 'menu', id: 'qs_menu_ctrl', label: '菜单栏' },
    { key: 'news', id: 'qs_carousel_ctrl', label: '新闻和关注' },
    { key: 'trending', id: 'qs_tobbs_ctrl', label: '必应上的热点' },
    { key: 'image', id: 'qs_iotd_ctrl', label: '主页图片' }
  ]);
  const defaultSwitchDelayMs = 80;
  const maxSwitchDelayMs = 2000;
  const isValidSwitchDelay = value => Number.isSafeInteger(value) && value >= 0 && value <= maxSwitchDelayMs;
  function normalize(value) {
    const source = value && typeof value === 'object' ? value : {};
    const result = {
      enabled: source.enabled !== false,
      switchDelayMs: isValidSwitchDelay(source.switchDelayMs) ? source.switchDelayMs : defaultSwitchDelayMs
    };
    for (const { key } of fields) {
      result[key] = ['off', 'on', 'keep'].includes(source[key]) ? source[key] : 'keep';
    }
    return result;
  }
  globalThis.BingHomePreferences = Object.freeze({
    fields,
    defaultSwitchDelayMs,
    maxSwitchDelayMs,
    isValidSwitchDelay,
    normalize,
    storageKey: 'homepagePreferences',
    isHomepage(url) {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' &&
          ['www.bing.com', 'cn.bing.com', 'bing.com'].includes(parsed.hostname) &&
          parsed.pathname === '/';
      } catch { return false; }
    }
  });
})();
