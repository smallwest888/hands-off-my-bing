# Architecture and maintenance

The extension’s only runtime source is `src/`. It uses Manifest V3 and keeps its file and permission scope narrow.

| Area | Role |
|---|---|
| `manifest.json` | Declares the new-tab override, localized metadata, supported homepage roots, and limited permissions. |
| `preferences.js` | Validates the four `keep/off/on` display choices, automatic-apply setting, and delay. |
| `focus-guard.js` | Briefly protects search-box focus on supported homepage roots. |
| `content.js` | Applies native Bing homepage settings and removable display styles; it reports visible state without claiming that hiding content blocks all network requests. |
| `service-worker.js` | Tracks extension-managed tabs for the session and applies a narrow, per-tab carousel request rule when selected settings require it. |
| `newtab.html` / `newtab.js` | Replaces Chrome’s new tab and updates its own tab to Bing after preparing the needed rule. |
| `popup.*` | Provides settings, language selection, presets, delay control, and concise status. The same page supports the full options view. |
| `ui-language.js` / `_locales/` | Loads the packaged English, Chinese, or German messages and persists the selected interface language separately. |
| `privacy.html` | Shows the extension’s localized in-product privacy notice. Public static policy pages are under `docs/privacy/`. |

## Scope boundaries

- Content scripts operate only on the HTTPS root pages of `www.bing.com`, `cn.bing.com`, and `bing.com`.
- The declared host permission is `https://www.bing.com/*`; no `tabs`, `webNavigation`, cookies, or broad all-sites permission is used.
- The carousel request rule applies only to an extension-managed tab and the specific carousel endpoint when automatic application is enabled and News is set to Off. Other content is not broadly blocked.
- Pausing preferences does not restore Chrome’s default new-tab page. Disabling or uninstalling the extension does.
- The extension does not read search text, page body text, cookies, account data, or request bodies, and includes no analytics or remote code.

## Checks

Run `node scripts/package-current.mjs --check` for static contracts and all seven offline test suites. The command also checks any frozen release snapshots present in the checkout. `--freeze` writes local build artifacts; generated archives are intentionally ignored by Git.
