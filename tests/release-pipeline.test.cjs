const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

(async () => {
  const script = path.resolve(__dirname, '../scripts/package-current.mjs');
  const api = await import(pathToFileURL(script).href);
  const base = path.resolve(__dirname, '..');

  const packageBefore = new Map();
  const snapshot = target => {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isFile()) packageBefore.set(path.resolve(target), crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'));
    else for (const name of fs.readdirSync(target)) snapshot(path.join(target, name));
  };
  for (const target of [
    path.join(base, 'src'), path.join(base, 'extension'), path.join(base, 'candidates'), path.join(base, 'releases'),
    path.join(base, 'bing-home-preferences.zip'), path.join(base, 'SHA256SUMS.txt')
  ]) snapshot(target);
  api.checkProject(base, { runSuites: false });
  const afterCheck = new Map();
  for (const target of [
    path.join(base, 'src'), path.join(base, 'extension'), path.join(base, 'candidates'), path.join(base, 'releases'),
    path.join(base, 'bing-home-preferences.zip'), path.join(base, 'SHA256SUMS.txt')
  ]) {
    if (!fs.existsSync(target)) continue;
    const visit = item => {
      if (fs.statSync(item).isFile()) afterCheck.set(path.resolve(item), crypto.createHash('sha256').update(fs.readFileSync(item)).digest('hex'));
      else for (const name of fs.readdirSync(item)) visit(path.join(item, name));
    };
    visit(target);
  }
  assert.deepEqual(afterCheck, packageBefore, '--check must not change generated or archived files');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bhp-release-test-'));
  try {
    const fixtureBase = path.join(temp, 'project/outputs/bing-home-preferences');
    const source = path.join(fixtureBase, 'src');
    fs.mkdirSync(source, { recursive: true });
    const manifest = {
      manifest_version: 3,
      version: '9.8.7',
      permissions: ['storage'],
      host_permissions: ['https://www.bing.com/*'],
      minimum_chrome_version: '111'
    };
    fs.writeFileSync(path.join(source, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    fs.writeFileSync(path.join(source, 'app.js'), 'globalThis.testBuild = true;\n');
    const files = ['manifest.json', 'app.js'];
    const first = api.createDeterministicZip(source, files);
    const second = api.createDeterministicZip(source, files);
    assert.deepEqual(first, second, 'fixed timestamps, modes and order should make ZIP bytes reproducible');

    const result = api.freezeArtifacts({ base: fixtureBase, sourceDir: source, manifest, packageFiles: files });
    assert.equal(result.releaseCreated, true);
    assert.equal(result.candidateCreated, true);
    const releasePath = path.join(fixtureBase, 'releases/9.8.7');
    const releaseBefore = fs.readFileSync(path.join(releasePath, 'bing-home-preferences-9.8.7.zip'));
    const metadataBefore = fs.readFileSync(path.join(releasePath, 'release-manifest.json'));
    assert.equal(api.verifyReleaseDirectory(releasePath, '9.8.7', {
      packageFiles: files, permissions: manifest.permissions, hosts: manifest.host_permissions
    }).zipSha256, api.sha256(releaseBefore));
    const repeated = api.freezeArtifacts({ base: fixtureBase, sourceDir: source, manifest, packageFiles: files });
    assert.equal(repeated.releaseCreated, false);
    assert.equal(repeated.candidateCreated, false);
    assert.deepEqual(fs.readFileSync(path.join(releasePath, 'bing-home-preferences-9.8.7.zip')), releaseBefore,
      'repeated same-source freeze must reuse the ZIP');
    assert.deepEqual(fs.readFileSync(path.join(releasePath, 'release-manifest.json')), metadataBefore,
      'repeated freeze must not rewrite release metadata');

    fs.writeFileSync(path.join(source, 'app.js'), 'globalThis.testBuild = false;\n');
    assert.throws(() => api.freezeArtifacts({ base: fixtureBase, sourceDir: source, manifest, packageFiles: files }), /differs from current source/,
      'same-version changed source must be rejected');
    assert.deepEqual(fs.readFileSync(path.join(releasePath, 'bing-home-preferences-9.8.7.zip')), releaseBefore,
      'rejected source changes must leave the frozen release untouched');

    const tampered = path.join(fixtureBase, 'releases/9.8.7/bing-home-preferences-9.8.7.zip');
    fs.appendFileSync(tampered, Buffer.from([0]));
    assert.throws(() => api.verifyReleaseDirectory(releasePath, '9.8.7', {
      packageFiles: files, permissions: manifest.permissions, hosts: manifest.host_permissions
    }), /SHA-256/,
      'verification must reject a modified archive');
    assert.throws(() => api.assertSemver('../9.8.7'), /semver/,
      'version values must not permit path traversal');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const currentRelease = path.join(base, 'releases', JSON.parse(fs.readFileSync(path.join(base, 'src/manifest.json'), 'utf8')).version);
  if (fs.existsSync(currentRelease)) {
    const currentVersion = JSON.parse(fs.readFileSync(path.join(base, 'src/manifest.json'), 'utf8')).version;
    assert.doesNotThrow(() => api.verifyReleaseDirectory(currentRelease, currentVersion),
      'CLI policy defaults must accept either current or legacy canonical frozen releases');
  }

  const currentManifest = JSON.parse(fs.readFileSync(path.join(base, 'src/manifest.json'), 'utf8'));
  const runtimeFiles = api.PACKAGE_FILES;
  const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhp-policy-test-'));
  try {
    const fixtureSource = path.join(policyDir, 'src');
    const malformedRelease = path.join(policyDir, 'releases', currentManifest.version);
    fs.mkdirSync(fixtureSource, { recursive: true });
    fs.mkdirSync(malformedRelease, { recursive: true });
    for (const file of runtimeFiles) {
      const to = path.join(fixtureSource, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(base, 'src', file), to);
    }
    const changedManifest = { ...currentManifest, permissions: ['storage'] };
    fs.writeFileSync(path.join(fixtureSource, 'manifest.json'), `${JSON.stringify(changedManifest)}\n`);
    const changedZip = api.createDeterministicZip(fixtureSource, runtimeFiles);
    const zipName = `bing-home-preferences-${currentManifest.version}.zip`;
    const hashes = Object.fromEntries(runtimeFiles.map(file => [file, api.sha256(fs.readFileSync(path.join(fixtureSource, file)))]));
    const alteredMeta = api.makeReleaseManifest({
      version: currentManifest.version, zipFile: zipName, zipHash: api.sha256(changedZip),
      runtimeHashes: hashes, manifest: changedManifest, packageFiles: runtimeFiles
    });
    fs.writeFileSync(path.join(malformedRelease, zipName), changedZip);
    fs.writeFileSync(path.join(malformedRelease, 'release-manifest.json'), `${JSON.stringify(alteredMeta, null, 2)}\n`);
    fs.writeFileSync(path.join(malformedRelease, 'SHA256SUMS.txt'), `${api.sha256(changedZip)}  ${zipName}\n`);
    assert.throws(() => api.verifyReleaseDirectory(malformedRelease, currentManifest.version), /permission declaration/,
      'self-consistent release metadata and ZIP must still obey the canonical permissions');

    const extraFiles = [...runtimeFiles, 'extra.js'];
    fs.writeFileSync(path.join(fixtureSource, 'extra.js'), '/* not in the release allowlist */\n');
    const extraZip = api.createDeterministicZip(fixtureSource, extraFiles);
    const extraHashes = Object.fromEntries(extraFiles.map(file => [file, api.sha256(fs.readFileSync(path.join(fixtureSource, file)))]));
    const extraMeta = api.makeReleaseManifest({
      version: currentManifest.version, zipFile: zipName, zipHash: api.sha256(extraZip),
      runtimeHashes: extraHashes, manifest: currentManifest, packageFiles: extraFiles
    });
    fs.writeFileSync(path.join(malformedRelease, zipName), extraZip);
    fs.writeFileSync(path.join(malformedRelease, 'release-manifest.json'), `${JSON.stringify(extraMeta, null, 2)}\n`);
    fs.writeFileSync(path.join(malformedRelease, 'SHA256SUMS.txt'), `${api.sha256(extraZip)}  ${zipName}\n`);
    assert.throws(() => api.verifyReleaseDirectory(malformedRelease, currentManifest.version), /allowlist/,
      'self-consistent release metadata and ZIP must still obey the canonical file allowlist');
  } finally {
    fs.rmSync(policyDir, { recursive: true, force: true });
  }
  for (const [version, expectedHash] of [
    ['1.2.7', '5e51e8f75bbc2cfb3f48a88dd5cb3d8d6be30dc0b3516a7cb258c317da936ecb'],
    ['1.2.8', '65927ad0cd3e5e8ae7be4d53333c14edba2089ae1cae5bab994d409d0411469d'],
    ['1.2.9', 'ccd5441a6baed5a855ae90edb2eb2b3e1929e891abb2381ee07c9ba7b069f6c6']
  ]) {
    const archivedRelease = path.join(base, 'releases', version);
    if (!fs.existsSync(archivedRelease)) continue;
    const result = api.verifyReleaseDirectory(archivedRelease, version);
    assert.equal(result.zipSha256, expectedHash, `${version} historical archive remains byte-for-byte intact`);
  }
  console.log('PASS: read-only check, deterministic allowlist ZIP, immutable same-version freeze, changed-source refusal, SHA verification, and semver path validation');
})().catch(error => { console.error(error); process.exitCode = 1; });
