#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE_FILES = [
  'manifest.json', 'content.js', 'focus-guard.js', 'preferences.js', 'ui-language.js', 'popup.js', 'popup.html', 'popup.css',
  'newtab.html', 'newtab.js', 'newtab.css', 'service-worker.js', 'privacy.html',
  '_locales/en/messages.json', '_locales/zh_CN/messages.json', '_locales/de/messages.json',
  'icons/16.png', 'icons/32.png', 'icons/48.png', 'icons/128.png'
];
export const LEGACY_PACKAGE_FILES = [
  'manifest.json', 'content.js', 'focus-guard.js', 'preferences.js', 'popup.js', 'popup.html', 'popup.css',
  'newtab.html', 'newtab.js', 'newtab.css', 'service-worker.js', 'privacy.html',
  'icons/16.png', 'icons/32.png', 'icons/48.png', 'icons/128.png'
];
export const EXPECTED_PERMISSIONS = ['storage', 'declarativeNetRequestWithHostAccess'];
export const EXPECTED_HOSTS = ['https://www.bing.com/*'];
export const EXPECTED_MINIMUM_CHROME = '111';
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LEGACY_PACKAGE_VERSIONS = new Set(['1.2.7', '1.2.8', '1.2.9']);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultBase = path.resolve(scriptDir, '..');
const fixedDate = new Date('2000-01-01T00:00:00.000Z');

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function assertSemver(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error('Version must be a plain semver triplet');
  return version;
}

function packageFilesForVersion(version) {
  return LEGACY_PACKAGE_VERSIONS.has(version) ? LEGACY_PACKAGE_FILES : PACKAGE_FILES;
}

function readManifest(sourceDir) {
  return JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, data, { mode: 0o644, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function assertFileSet(sourceDir, packageFiles) {
  const set = new Set();
  for (const file of packageFiles) {
    if (typeof file !== 'string' || file.startsWith('/') || file.split('/').includes('..') || set.has(file)) {
      throw new Error(`Unsafe or duplicate package path: ${file}`);
    }
    set.add(file);
    if (!fs.statSync(path.join(sourceDir, file)).isFile()) throw new Error(`Missing package file: ${file}`);
  }
}

function verifyArchive(zipPath, packageFiles, expectedVersion) {
  execFileSync('unzip', ['-tq', zipPath], { stdio: 'ignore' });
  const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const expected = [...packageFiles].sort();
  const actual = [...entries].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Archive entry allowlist mismatch: ${zipPath}`);
  if (!entries.includes('manifest.json')) throw new Error('Archive must contain manifest.json at its root');
  const archivedManifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' }));
  if (archivedManifest.manifest_version !== 3 || archivedManifest.version !== expectedVersion) {
    throw new Error(`Archive manifest version mismatch: ${zipPath}`);
  }
  return { entries, manifest: archivedManifest };
}

export function verifyArchiveMatchesSource(zipPath, sourceDir, packageFiles, expectedVersion) {
  const { entries } = verifyArchive(zipPath, packageFiles, expectedVersion);
  for (const file of entries) {
    const archived = execFileSync('unzip', ['-p', zipPath, file]);
    const source = fs.readFileSync(path.join(sourceDir, file));
    if (!archived.equals(source)) throw new Error(`Existing archive differs from current source: ${file}`);
  }
  return true;
}

export function createDeterministicZip(sourceDir, packageFiles) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bing-home-freeze-'));
  const stage = path.join(tempRoot, 'stage');
  const zipPath = path.join(tempRoot, 'bundle.zip');
  try {
    fs.mkdirSync(stage, { mode: 0o755 });
    for (const file of packageFiles) {
      const target = path.join(stage, file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.copyFileSync(path.join(sourceDir, file), target);
      fs.chmodSync(target, 0o644);
      fs.utimesSync(target, fixedDate, fixedDate);
    }
    execFileSync('zip', ['-q', '-X', '-0', zipPath, ...packageFiles], {
      cwd: stage,
      env: { ...process.env, TZ: 'UTC' },
      stdio: 'ignore'
    });
    verifyArchive(zipPath, packageFiles, readManifest(sourceDir).version);
    return fs.readFileSync(zipPath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertZipBufferMatchesSource(zipBytes, sourceDir, packageFiles, version) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bing-home-check-'));
  const zipPath = path.join(tempRoot, 'bundle.zip');
  try {
    fs.writeFileSync(zipPath, zipBytes);
    verifyArchiveMatchesSource(zipPath, sourceDir, packageFiles, version);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function fileHashes(sourceDir, packageFiles) {
  return Object.fromEntries(packageFiles.map(file => [file, sha256(fs.readFileSync(path.join(sourceDir, file)))]));
}

export function makeReleaseManifest({ version, zipFile, zipHash, runtimeHashes, manifest, packageFiles }) {
  return {
    format: 2,
    version,
    status: 'frozen-source-snapshot',
    runtimeAcceptanceAtFreeze: 'pending',
    zipFile,
    zipSha256: zipHash,
    packageFiles: [...packageFiles],
    runtimeFilesSha256: runtimeHashes,
    manifestPermissions: [...(manifest.permissions || [])],
    hostPermissions: [...(manifest.host_permissions || [])],
    minimumChromeVersion: manifest.minimum_chrome_version
  };
}

export function verifyReleaseDirectory(releaseDir, requestedVersion, {
  packageFiles,
  permissions = EXPECTED_PERMISSIONS,
  hosts = EXPECTED_HOSTS,
  minimumChromeVersion = EXPECTED_MINIMUM_CHROME
} = {}) {
  assertSemver(requestedVersion);
  packageFiles ||= packageFilesForVersion(requestedVersion);
  const manifestPath = path.join(releaseDir, 'release-manifest.json');
  const release = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const currentMeta = release.format === 2 && release.status === 'frozen-source-snapshot' &&
    release.runtimeAcceptanceAtFreeze === 'pending';
  const legacyMeta = release.format === 1 && release.status === 'frozen-candidate-awaiting-runtime-acceptance' &&
    release.chromeRuntimeVerified === false;
  if (release.version !== requestedVersion || (!currentMeta && !legacyMeta)) {
    throw new Error('Frozen release metadata has an unexpected format, version, or status');
  }
  if (release.zipFile !== `bing-home-preferences-${requestedVersion}.zip` ||
      JSON.stringify(release.packageFiles) !== JSON.stringify(packageFiles)) {
    throw new Error('Frozen release has an unexpected ZIP filename or package allowlist');
  }
  if (JSON.stringify(release.manifestPermissions) !== JSON.stringify(permissions) ||
      JSON.stringify(release.hostPermissions) !== JSON.stringify(hosts) ||
      release.minimumChromeVersion !== minimumChromeVersion) {
    throw new Error('Frozen release permission declaration is outside the reviewed scope');
  }
  const zipPath = path.join(releaseDir, release.zipFile);
  const expectedReleaseEntries = [release.zipFile, 'release-manifest.json', 'SHA256SUMS.txt'].sort();
  const actualReleaseEntries = fs.readdirSync(releaseDir).sort();
  if (JSON.stringify(actualReleaseEntries) !== JSON.stringify(expectedReleaseEntries)) throw new Error('Frozen release directory has unexpected or missing files');
  const zipBytes = fs.readFileSync(zipPath);
  if (sha256(zipBytes) !== release.zipSha256) throw new Error('Frozen ZIP SHA-256 does not match release metadata');
  const sums = fs.readFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), 'utf8');
  if (sums !== `${release.zipSha256}  ${release.zipFile}\n`) throw new Error('Frozen SHA256SUMS does not match release metadata');
  if (!Array.isArray(release.packageFiles) || !release.runtimeFilesSha256 ||
      JSON.stringify(Object.keys(release.runtimeFilesSha256).sort()) !== JSON.stringify([...release.packageFiles].sort())) {
    throw new Error('Frozen runtime file allowlist or hashes are malformed');
  }
  const { manifest } = verifyArchive(zipPath, release.packageFiles, requestedVersion);
  if (JSON.stringify(manifest.permissions || []) !== JSON.stringify(release.manifestPermissions) ||
      JSON.stringify(manifest.host_permissions || []) !== JSON.stringify(release.hostPermissions) ||
      manifest.minimum_chrome_version !== release.minimumChromeVersion) {
    throw new Error('Frozen permission metadata does not match archived manifest');
  }
  for (const file of release.packageFiles) {
    const archived = execFileSync('unzip', ['-p', zipPath, file]);
    if (sha256(archived) !== release.runtimeFilesSha256[file]) throw new Error(`Frozen file hash mismatch: ${file}`);
  }
  return { release, zipPath, zipSha256: sha256(zipBytes) };
}

function writeImmutable(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, data, { mode: 0o644, flag: 'wx' });
    try {
      fs.linkSync(temporary, file); // Same-directory hard link is an atomic no-clobber commit.
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!fs.readFileSync(file).equals(Buffer.from(data))) throw new Error(`Refusing to overwrite frozen file: ${file}`);
      return false;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function compareExistingZip(zipPath, sourceDir, packageFiles, version) {
  if (!fs.existsSync(zipPath)) return null;
  verifyArchiveMatchesSource(zipPath, sourceDir, packageFiles, version);
  return fs.readFileSync(zipPath);
}

function snapshotDirectory(sourceDir, packageFiles) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bing-home-publish-'));
  try {
    const dest = path.join(tmp, 'extension');
    fs.mkdirSync(dest, { recursive: true });
    for (const file of packageFiles) {
      const target = path.join(dest, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(sourceDir, file), target);
      fs.chmodSync(target, 0o644);
      fs.utimesSync(target, fixedDate, fixedDate);
    }
    return dest;
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

function replaceGeneratedDirectory(stageDir, targetDir) {
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true });
  const backup = `${targetDir}.previous-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backup);
  try {
    fs.renameSync(stageDir, targetDir);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(targetDir) && fs.existsSync(backup)) fs.renameSync(backup, targetDir);
    throw error;
  }
}

export function freezeArtifacts({ base, sourceDir, manifest, packageFiles = PACKAGE_FILES }) {
  const version = assertSemver(manifest.version);
  assertFileSet(sourceDir, packageFiles);
  const candidateDir = path.join(base, 'candidates', version);
  const candidateZip = path.join(candidateDir, `bing-home-preferences-${version}-candidate.zip`);
  const releaseDir = path.join(base, 'releases', version);
  const releaseZipName = `bing-home-preferences-${version}.zip`;
  const releaseZip = path.join(releaseDir, releaseZipName);
  let zipBytes = compareExistingZip(candidateZip, sourceDir, packageFiles, version);
  if (!zipBytes && fs.existsSync(releaseDir)) {
    if (fs.existsSync(releaseZip)) {
      verifyArchiveMatchesSource(releaseZip, sourceDir, packageFiles, version);
      zipBytes = fs.readFileSync(releaseZip);
    } else if (fs.readdirSync(releaseDir).length) {
      throw new Error(`Refusing to overwrite incomplete frozen release: ${releaseDir}`);
    }
  }
  if (!zipBytes) zipBytes = createDeterministicZip(sourceDir, packageFiles);
  assertZipBufferMatchesSource(zipBytes, sourceDir, packageFiles, version);
  const runtimeHashes = fileHashes(sourceDir, packageFiles);
  const zipHash = sha256(zipBytes);
  const expectedRelease = makeReleaseManifest({
    version, zipFile: releaseZipName, zipHash, runtimeHashes, manifest, packageFiles
  });
  const candidateSums = `${zipHash}  ${path.basename(candidateZip)}\n${zipHash}  ../../bing-home-preferences.zip\n`;
  const candidateSumsPath = path.join(candidateDir, 'SHA256SUMS.txt');
  if (fs.existsSync(candidateSumsPath) && fs.readFileSync(candidateSumsPath, 'utf8') !== candidateSums) {
    throw new Error(`Candidate checksum file disagrees with its immutable ZIP/source: ${candidateSumsPath}`);
  }
  const releaseExists = fs.existsSync(releaseDir) && fs.readdirSync(releaseDir).length > 0;
  if (releaseExists) {
    const current = verifyReleaseDirectory(releaseDir, version, {
      packageFiles, permissions: manifest.permissions || [], hosts: manifest.host_permissions || [],
      minimumChromeVersion: manifest.minimum_chrome_version
    });
    if (JSON.stringify(current.release) !== JSON.stringify(expectedRelease)) {
      throw new Error(`Frozen release metadata/source differs; increment the version instead of replacing ${releaseDir}`);
    }
    verifyArchiveMatchesSource(releaseZip, sourceDir, packageFiles, version);
  }

  const genericZipPath = path.join(base, 'bing-home-preferences.zip');
  if (fs.existsSync(genericZipPath)) {
    const oldManifest = JSON.parse(execFileSync('unzip', ['-p', genericZipPath, 'manifest.json'], { encoding: 'utf8' }));
    if (oldManifest.version === version) verifyArchiveMatchesSource(genericZipPath, sourceDir, packageFiles, version);
    else if (compareSemver(oldManifest.version, version) > 0) throw new Error('Refusing to replace a newer generic ZIP with an older source');
  }

  fs.mkdirSync(candidateDir, { recursive: true });
  const candidateCreated = writeImmutable(candidateZip, zipBytes);
  writeImmutable(candidateSumsPath, candidateSums);

  if (!releaseExists) {
    const releasesDir = path.join(base, 'releases');
    fs.mkdirSync(releasesDir, { recursive: true });
    const stageRelease = fs.mkdtempSync(path.join(releasesDir, `.${version}.freeze-`));
    try {
      fs.writeFileSync(path.join(stageRelease, releaseZipName), zipBytes, { mode: 0o644 });
      fs.writeFileSync(path.join(stageRelease, 'release-manifest.json'), `${JSON.stringify(expectedRelease, null, 2)}\n`, { mode: 0o644 });
      fs.writeFileSync(path.join(stageRelease, 'SHA256SUMS.txt'), `${zipHash}  ${releaseZipName}\n`, { mode: 0o644 });
      verifyReleaseDirectory(stageRelease, version, {
        packageFiles, permissions: manifest.permissions || [], hosts: manifest.host_permissions || [],
        minimumChromeVersion: manifest.minimum_chrome_version
      });
      fs.renameSync(stageRelease, releaseDir);
    } finally {
      fs.rmSync(stageRelease, { recursive: true, force: true });
    }
  }

  atomicWrite(genericZipPath, zipBytes);
  atomicWrite(path.join(base, 'SHA256SUMS.txt'), `${zipHash}  bing-home-preferences.zip\n`);

  const stageDir = snapshotDirectory(sourceDir, packageFiles);
  try { replaceGeneratedDirectory(stageDir, path.join(base, 'extension')); }
  finally { fs.rmSync(path.dirname(stageDir), { recursive: true, force: true }); }
  return { version, zipHash, candidateZip, releaseDir, candidateCreated, releaseCreated: !releaseExists };
}

function compareSemver(a, b) {
  assertSemver(a); assertSemver(b);
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export function checkProject(base = defaultBase, { runSuites = true } = {}) {
  const sourceDir = path.join(base, 'src');
  const manifest = readManifest(sourceDir);
  assertSemver(manifest.version);
  if (manifest.manifest_version !== 3) throw new Error('Only MV3 is allowed');
  if (manifest.default_locale !== 'en' || manifest.name !== '__MSG_appName__' || manifest.description !== '__MSG_appDescription__' || manifest.action?.default_title !== '__MSG_appName__') {
    throw new Error('Manifest must use the reviewed packaged locale metadata');
  }
  if (Number(manifest.minimum_chrome_version) < 111) throw new Error('MAIN/document_start requires minimum Chrome 111');
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(EXPECTED_PERMISSIONS)) throw new Error('Unexpected permission list');
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(EXPECTED_HOSTS)) throw new Error('Unexpected host permission scope');
  if (manifest.permissions.includes('tabs') || manifest.permissions.includes('webNavigation')) throw new Error('Broad tab/navigation permission is not allowed');

  const expectedGlobs = [
    'https://www.bing.com/', 'https://www.bing.com/?*', 'https://www.bing.com/#*',
    'https://cn.bing.com/', 'https://cn.bing.com/?*', 'https://cn.bing.com/#*',
    'https://bing.com/', 'https://bing.com/?*', 'https://bing.com/#*'
  ];
  const expectedMatches = ['https://www.bing.com/*', 'https://cn.bing.com/*', 'https://bing.com/*'];
  const scripts = manifest.content_scripts || [];
  const guard = scripts.find(entry => entry.js?.includes('focus-guard.js'));
  const isolated = scripts.find(entry => entry.js?.includes('content.js'));
  if (!guard || guard.world !== 'MAIN' || guard.run_at !== 'document_start') throw new Error('Missing static MAIN document_start focus guard');
  if (!isolated || isolated.world === 'MAIN' || isolated.run_at !== 'document_idle') throw new Error('Missing isolated-world homepage content script');
  for (const entry of [guard, isolated]) {
    if (JSON.stringify(entry.include_globs) !== JSON.stringify(expectedGlobs) ||
        JSON.stringify(entry.matches) !== JSON.stringify(expectedMatches)) {
      throw new Error('Content scripts must stay limited to supported homepage roots');
    }
  }
  const sw = fs.readFileSync(path.join(sourceDir, manifest.background.service_worker), 'utf8');
  if (!sw.includes("const carouselRegex = '^https://www\\\\.bing\\\\.com/hp/api/v1/carousel(\\\\?.*)?$';") ||
      !sw.includes("resourceTypes: ['xmlhttprequest']") || !sw.includes('tabIds: [tabId]')) {
    throw new Error('Carousel DNR scope must remain exact-path, XHR-only and per-tab');
  }
  const bridge = fs.readFileSync(path.join(sourceDir, 'newtab.js'), 'utf8');
  if (!bridge.includes('chrome.tabs.update(tabId, { url: destination }') || /location\.replace\s*\(/.test(bridge)) {
    throw new Error('Newtab bridge must update its own tab and must not use location.replace');
  }
  const content = fs.readFileSync(path.join(sourceDir, 'content.js'), 'utf8');
  for (const required of [
    '#hp_app .module.feed_bg, #hp_app #crs_pane { display: none !important; }',
    "rules.push('#hp_app #carousel { display: none !important; }')",
    'top: calc(100% - 2.9375rem)'
  ]) if (!content.includes(required)) throw new Error(`News display/layout contract missing: ${required}`);
  for (const broad of ['#hp_app {', '#vs_cont {', '#widget_container {']) if (content.includes(broad)) throw new Error(`Overbroad news selector found: ${broad}`);

  assertFileSet(sourceDir, PACKAGE_FILES);
  const packageSet = new Set(PACKAGE_FILES);
  const refs = new Set([
    manifest.background.service_worker, manifest.action?.default_popup, manifest.options_ui?.page,
    manifest.chrome_url_overrides?.newtab, ...Object.values(manifest.icons || {}),
    ...scripts.flatMap(entry => [...(entry.js || []), ...(entry.css || [])]),
    ...(manifest.web_accessible_resources || []).flatMap(entry => entry.resources || [])
  ].filter(Boolean));
  for (const ref of refs) if (!packageSet.has(ref)) throw new Error(`Manifest references a file outside the package allowlist: ${ref}`);
  for (const locale of ['en', 'zh_CN', 'de']) {
    const messages = JSON.parse(fs.readFileSync(path.join(sourceDir, '_locales', locale, 'messages.json'), 'utf8'));
    for (const key of ['appName', 'appDescription']) if (!messages[key]?.message?.trim()) throw new Error(`Missing ${key} translation for ${locale}`);
  }
  const localeMessages = Object.fromEntries(['en', 'zh_CN', 'de'].map(locale => [
    locale, JSON.parse(fs.readFileSync(path.join(sourceDir, '_locales', locale, 'messages.json'), 'utf8'))
  ]));
  const baseMessageKeys = Object.keys(localeMessages.en).sort();
  for (const locale of ['zh_CN', 'de']) {
    if (JSON.stringify(Object.keys(localeMessages[locale]).sort()) !== JSON.stringify(baseMessageKeys)) {
      throw new Error(`Locale message keys differ from English in ${locale}`);
    }
  }
  for (const locale of ['en', 'zh_CN', 'de']) {
    for (const [key, message] of Object.entries(localeMessages[locale])) {
      if (typeof message?.message !== 'string' || !message.message.trim()) throw new Error(`Empty translation ${key} in ${locale}`);
    }
  }
  for (const [size, file] of [[16, 'icons/16.png'], [32, 'icons/32.png'], [48, 'icons/48.png'], [128, 'icons/128.png']]) {
    const png = fs.readFileSync(path.join(sourceDir, file));
    if (png.length < 24 || png.toString('hex', 0, 8) !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) throw new Error(`Invalid ${size}px PNG: ${file}`);
  }
  for (const file of PACKAGE_FILES.filter(item => item.endsWith('.js'))) execFileSync(process.execPath, ['--check', path.join(sourceDir, file)], { stdio: 'inherit' });
  const reviewed = PACKAGE_FILES.filter(file => /\.(?:js|html|css)$/.test(file));
  for (const file of reviewed) {
    const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
    if (/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(text) || /@import\s+[^;]*https?:\/\//i.test(text) ||
        /url\(\s*["']?https?:\/\//i.test(text) || /\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) throw new Error(`Remote resource or dynamic code found in ${file}`);
  }
  const privacy = fs.readFileSync(path.join(sourceDir, 'privacy.html'), 'utf8');
  for (const key of ['privacyTitle', 'privacyDate', 'privacyHeading1', 'privacyHeading2', 'privacyHeading3', 'privacyHeading4', 'privacyHeading5', 'privacyHeading6', 'privacy1', 'privacy2', 'privacy3', 'privacy4', 'privacy5', 'privacy6']) {
    if (!privacy.includes(`data-i18n="${key}"`)) throw new Error(`Privacy page does not include localized disclosure ${key}`);
  }
  for (const file of ['popup.html', 'privacy.html', 'newtab.html']) {
    const html = fs.readFileSync(path.join(sourceDir, file), 'utf8');
    for (const [, key] of html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)) {
      if (!localeMessages.en[key] || !localeMessages.zh_CN[key] || !localeMessages.de[key]) throw new Error(`Missing localized key ${key} referenced by ${file}`);
    }
    for (const [, script] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      if (!packageSet.has(script)) throw new Error(`HTML references file outside package allowlist: ${file} -> ${script}`);
    }
  }
  if (runSuites) {
    const repo = path.resolve(base, '../..');
    for (const file of ['content.test.cjs', 'focus-guard.test.cjs', 'service-worker.test.cjs', 'newtab.test.cjs', 'ui-language.test.cjs', 'popup.test.cjs', 'release-pipeline.test.cjs']) {
      execFileSync(process.execPath, [path.join(base, 'tests', file)], { cwd: repo, stdio: 'inherit' });
    }
  }
  return { manifest, packageFiles: [...PACKAGE_FILES] };
}

function usage() {
  return 'Usage: node scripts/package-current.mjs --check | --freeze | --verify-release VERSION';
}

export function main(args = process.argv.slice(2), base = defaultBase) {
  if (args.length === 1 && args[0] === '--check') {
    const result = checkProject(base);
    console.log(`PASS: read-only checks and tests for ${result.manifest.version}`);
    return;
  }
  if (args.length === 1 && args[0] === '--freeze') {
    const { manifest, packageFiles } = checkProject(base);
    const result = freezeArtifacts({ base, sourceDir: path.join(base, 'src'), manifest, packageFiles });
    console.log(`Frozen candidate ${result.version}: ${path.join(result.releaseDir, `bing-home-preferences-${result.version}.zip`)}`);
    console.log(`SHA-256 ${result.zipHash}; candidate ${result.candidateCreated ? 'created' : 'reused'}; release ${result.releaseCreated ? 'created' : 'verified/reused'}`);
    return;
  }
  if (args.length === 2 && args[0] === '--verify-release') {
    const version = assertSemver(args[1]);
    const result = verifyReleaseDirectory(path.join(base, 'releases', version), version);
    console.log(`PASS: frozen release ${version}, SHA-256 ${result.zipSha256}`);
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); }
  catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
