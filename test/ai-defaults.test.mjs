import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome, makeBin, tmpDir, withPath } from './helpers.mjs';

const home = freshHome();
const mod = await import('../folder.mjs');
const { readAIProviderDefaults, writeAIProviderDefaults, parseCodexCatalogPayload } = mod;
const fixtures = path.join(import.meta.dirname, 'fixtures', 'ai-catalog');
const fixture = name => fs.readFileSync(path.join(fixtures, name));
const codexModels = parseCodexCatalogPayload(fixture('codex-bare-raw.json'));
const codexCatalog = { available: true, defaultModel: 'codex-deep', defaultEffort: 'medium', models: codexModels };

function configAt(root, relative, content, mode = 0o600) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, content, { mode }); fs.chmodSync(file, mode);
  return file;
}

test('Codex defaults round trip preserves CRLF, quoted hashes, comments, unknown content, and permissions', async () => {
  const codexHome = path.join(home, 'codex-roundtrip');
  const original = 'model  =  "codex-fast" # keep this comment\r\nmodel_reasoning_effort = "low"\r\nunknown = "a#b"\r\n\r\n[provider]\r\ntoken = "secret#value"\r\n';
  const file = configAt(codexHome, 'config.toml', original, 0o400);
  const saved = await writeAIProviderDefaults('codex', 'codex-deep', 'high', { codexHome, loadCatalog: async () => codexCatalog });
  assert.deepEqual(saved, { schemaVersion: 1, provider: 'codex', defaultModel: 'codex-deep', defaultEffort: 'high', saved: true });
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /^model  =  "codex-deep" # keep this comment\r$/m);
  assert.match(after, /unknown = "a#b"\r\n\r\n\[provider\]/);
  assert.match(after, /token = "secret#value"/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o400);
  const backups = fs.readdirSync(codexHome).filter(name => name.includes('.foldview-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.statSync(path.join(codexHome, backups[0])).mode & 0o777, 0o400);
  assert.equal(fs.readFileSync(path.join(codexHome, backups[0]), 'utf8'), original);
});

test('Codex model-only save preserves a supported effort and falls back/clears deterministically', async () => {
  const codexHome = path.join(home, 'codex-fallback');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\nmodel_reasoning_effort = "medium"\n');
  await writeAIProviderDefaults('codex', 'codex-deep', undefined, { codexHome, loadCatalog: async () => codexCatalog });
  assert.match(fs.readFileSync(file, 'utf8'), /model_reasoning_effort = "medium"/);
  const fixed = { available: true, defaultModel: null, defaultEffort: null,
    models: [{ id: 'fixed', label: 'Fixed', detail: 'fixed', efforts: [], defaultEffort: null }] };
  await writeAIProviderDefaults('codex', 'fixed', undefined, { codexHome, loadCatalog: async () => fixed });
  assert.equal(fs.readFileSync(file, 'utf8').includes('model_reasoning_effort'), false);
});

test('Codex missing config is created privately only after catalog validation', async () => {
  const codexHome = path.join(home, 'codex-new'); fs.mkdirSync(codexHome, { mode: 0o700 });
  const saved = await writeAIProviderDefaults('codex', 'codex-deep', undefined, { codexHome, loadCatalog: async () => codexCatalog });
  const file = path.join(codexHome, 'config.toml');
  assert.equal(saved.defaultModel, 'codex-deep');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(codexHome).some(name => name.includes('backup')), false);
});

test('inserting missing Codex defaults preserves an existing no-final-newline policy', async () => {
  const codexHome = path.join(home, 'codex-no-final-newline');
  const file = configAt(codexHome, 'config.toml', 'unknown = true');
  await writeAIProviderDefaults('codex', 'codex-deep', 'high', { codexHome, loadCatalog: async () => codexCatalog });
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after.endsWith('\n'), false);
  assert.equal(after, 'unknown = true\nmodel = "codex-deep"\nmodel_reasoning_effort = "high"');
});

test('Kimi defaults round trip preserves aliases/unknown tables and explicit effort enables thinking', async () => {
  const file = configAt(home, '.kimi-code/config.toml', fixture('kimi-config.toml'));
  let source = fs.readFileSync(file, 'utf8').replace('enabled = true', 'enabled = false');
  fs.writeFileSync(file, source); fs.chmodSync(file, 0o600);
  const saved = await writeAIProviderDefaults('kimi', 'moonshot/k3', 'low', { home });
  assert.equal(saved.defaultEffort, 'low');
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /\[thinking\]\nenabled = true\neffort = "low"/);
  assert.match(after, /endpoint = "https:\/\/example\.invalid\/api#fragment"/);
  assert.match(after, /provider = "fixture-provider"/);
});

test('Kimi missing thinking section is appended; model-only fixed thinking clears effort without enabling', async () => {
  const file = configAt(home, '.kimi-code/config.toml', fixture('kimi-config.toml').toString('utf8').replace(/\n\[thinking\][\s\S]*?(?=\n\[providers)/, ''));
  await writeAIProviderDefaults('kimi', 'moonshot/k3', 'medium', { home });
  assert.match(fs.readFileSync(file, 'utf8'), /\[thinking\]\nenabled = true\neffort = "medium"/);
  await writeAIProviderDefaults('kimi', 'moonshot/k2.5', undefined, { home });
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /default_model = "moonshot\/k2\.5"/);
  assert.equal(/\neffort\s*=/.test(after), false);
  assert.match(after, /enabled = true/); // model-only never toggles an existing enabled value
  assert.deepEqual(readAIProviderDefaults('kimi', { home }), { provider: 'kimi', defaultModel: 'moonshot/k2.5', defaultEffort: null });
});

test('unsupported model/effort performs no write and creates no backup', async () => {
  const codexHome = path.join(home, 'codex-reject');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  const before = fs.readFileSync(file);
  await assert.rejects(writeAIProviderDefaults('codex', 'removed-model', undefined, { codexHome, loadCatalog: async () => codexCatalog }), err => err.code === 'unsupported_model');
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-fast', 'high', { codexHome, loadCatalog: async () => codexCatalog }), err => err.code === 'unsupported_effort');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readdirSync(codexHome).some(name => name.includes('backup')), false);
});

test('active lock contention is bounded and leaves config untouched', async () => {
  const codexHome = path.join(home, 'codex-locked');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  fs.writeFileSync(file + '.foldview.lock', JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-deep', undefined,
    { codexHome, loadCatalog: async () => codexCatalog, lockTimeoutMs: 35 }), err => err.code === 'config_locked');
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = "codex-fast"\n');
});

test('an orphaned dead-PID reaper guard is recovered atomically and removed after save', async () => {
  const codexHome = path.join(home, 'codex-orphan-reaper');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  const guard = file + '.foldview.lock.reap';
  fs.writeFileSync(guard, '999999\n', { mode: 0o600 });
  const saved = await writeAIProviderDefaults('codex', 'codex-deep', 'high', {
    codexHome, loadCatalog: async () => codexCatalog, lockTimeoutMs: 1000,
  });
  assert.equal(saved.defaultModel, 'codex-deep');
  assert.equal(fs.existsSync(guard), false);
});

test('a live reaper guard is never deleted and contention fails within the bounded wait', async () => {
  const codexHome = path.join(home, 'codex-live-reaper');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  const guard = file + '.foldview.lock.reap';
  fs.writeFileSync(guard, `${process.pid}\n`, { mode: 0o600 });
  const before = fs.lstatSync(guard);
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-deep', undefined, {
    codexHome, loadCatalog: async () => codexCatalog, lockTimeoutMs: 45,
  }), err => err.code === 'config_locked');
  const after = fs.lstatSync(guard);
  assert.equal(after.ino, before.ino);
  assert.equal(fs.readFileSync(guard, 'utf8'), `${process.pid}\n`);
});

test('reaper guard identity replacement is preserved and cannot authorize stale-lock deletion', async () => {
  const codexHome = path.join(home, 'codex-reaper-replaced');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  const mainLock = file + '.foldview.lock', guard = mainLock + '.reap';
  fs.writeFileSync(mainLock, JSON.stringify({
    pid: 999999, createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString()
  }), { mode: 0o600 });
  let replacementInode = null;
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-deep', undefined, {
    codexHome, loadCatalog: async () => codexCatalog, lockTimeoutMs: 45,
    onReaperGuardAcquired: target => {
      fs.unlinkSync(target);
      fs.writeFileSync(target, `${process.pid}\n`, { mode: 0o600 });
      replacementInode = fs.lstatSync(target).ino;
    },
  }), err => err.code === 'config_locked');
  assert.equal(fs.lstatSync(guard).ino, replacementInode);
  assert.equal(fs.readFileSync(guard, 'utf8'), `${process.pid}\n`);
  assert.equal(fs.existsSync(mainLock), true, 'the stale main lock was not deleted under a replaced guard');
});

test('without shlock, an orphaned guard fails bounded instead of being deleted unsafely', async () => {
  const codexHome = path.join(home, 'codex-no-shlock');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  const guard = file + '.foldview.lock.reap';
  fs.writeFileSync(guard, '999999\n', { mode: 0o600 });
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-deep', undefined, {
    codexHome, loadCatalog: async () => codexCatalog, lockTimeoutMs: 35, shlockPath: null,
  }), err => err.code === 'config_locked');
  assert.equal(fs.readFileSync(guard, 'utf8'), '999999\n');
});

test('a cooperating writer cannot steal the stale-lock reaper creation gap', async () => {
  const codexHome = path.join(home, 'codex-stale-race');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  fs.writeFileSync(file + '.foldview.lock', JSON.stringify({
    pid: 999999, createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString()
  }), { mode: 0o600 });
  let contender = null;
  const winner = writeAIProviderDefaults('codex', 'codex-deep', 'high', {
    codexHome, loadCatalog: async () => codexCatalog, lockTimeoutMs: 1000,
    onStaleLockVerified: () => {
      contender = writeAIProviderDefaults('codex', 'codex-fast', 'low', {
        codexHome, loadCatalog: async () => codexCatalog, lockTimeoutMs: 1000
      });
      contender.catch(() => {});
    },
  });
  await winner;
  await assert.rejects(contender, err => err.code === 'config_changed');
  assert.match(fs.readFileSync(file, 'utf8'), /model = "codex-deep"/);
  assert.equal(fs.existsSync(file + '.foldview.lock.reap'), false);
});

test('every Codex save uses the fresh injected loader and ignores stale direct catalog data', async () => {
  const codexHome = path.join(home, 'codex-fresh-loader');
  configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  let loads = 0;
  const loadCatalog = async () => { loads++; return codexCatalog; };
  const staleCatalog = { available: true, models: [] };
  await writeAIProviderDefaults('codex', 'codex-deep', 'low', { codexHome, catalog: staleCatalog, loadCatalog });
  await writeAIProviderDefaults('codex', 'codex-fast', 'medium', { codexHome, catalog: staleCatalog, loadCatalog });
  assert.equal(loads, 2);
});

test('the production Codex loader path validates against a discovered fake binary', async () => {
  const bin = tmpDir('foldview-defaults-bin-');
  const raw = path.join(bin, 'catalog.json'); fs.writeFileSync(raw, fixture('codex-bare-raw.json'));
  makeBin(bin, 'codex', `#!/bin/sh\n[ "$1" = debug ] && [ "$2" = models ] || exit 9\n/bin/cat '${raw}'\n`);
  const codexHome = path.join(home, 'codex-production-loader');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  const restore = withPath([bin]);
  try {
    const saved = await writeAIProviderDefaults('codex', 'codex-deep', 'high', { codexHome });
    assert.equal(saved.defaultModel, 'codex-deep');
    assert.match(fs.readFileSync(file, 'utf8'), /model_reasoning_effort = "high"/);
  } finally { restore(); }
});

test('an observable pre-rename external mutation returns config_changed and is not overwritten', async () => {
  const codexHome = path.join(home, 'codex-changed');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-deep', 'high', {
    codexHome, loadCatalog: async () => codexCatalog,
    beforeFinalCheck: target => { fs.writeFileSync(target, 'model = "external"\n'); fs.chmodSync(target, 0o600); },
  }), err => err.code === 'config_changed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = "external"\n');
});

test('a failed post-rename re-read is normalized to config_write_failed', async () => {
  const codexHome = path.join(home, 'codex-post-rename');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-deep', 'high', {
    codexHome, loadCatalog: async () => codexCatalog,
    afterRename: target => fs.chmodSync(target, 0o644),
  }), err => {
    assert.equal(err.code, 'config_write_failed');
    assert.equal(err.toJSON().provider, 'codex');
    return true;
  });
  fs.chmodSync(file, 0o600);
});

test('symlink and non-regular config paths are rejected before catalog loading or mutation', async () => {
  const symlinkHome = path.join(home, 'codex-symlink'); fs.mkdirSync(symlinkHome, { mode: 0o700 });
  const target = configAt(path.join(home, 'codex-symlink-target'), 'config.toml', 'model = "codex-fast"\n');
  fs.symlinkSync(target, path.join(symlinkHome, 'config.toml'));
  let loaded = false;
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-deep', undefined, {
    codexHome: symlinkHome, loadCatalog: async () => { loaded = true; return codexCatalog; }
  }), err => err.code === 'config_read_failed');
  assert.equal(loaded, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'model = "codex-fast"\n');

  const directoryHome = path.join(home, 'codex-directory-config');
  fs.mkdirSync(path.join(directoryHome, 'config.toml'), { recursive: true, mode: 0o700 });
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-deep', undefined, {
    codexHome: directoryHome, loadCatalog: async () => codexCatalog
  }), err => err.code === 'config_read_failed');
});

test('unsafe permissions and malformed target syntax fail without reflecting config secrets', async () => {
  const codexHome = path.join(home, 'codex-unsafe');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\ntoken = "do-not-leak"\n', 0o644);
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-deep', undefined, { codexHome, loadCatalog: async () => codexCatalog }), err => {
    assert.equal(err.code, 'config_read_failed');
    assert.equal(JSON.stringify(err.toJSON()).includes('do-not-leak'), false);
    return true;
  });
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, 'model = "a"\nmodel = "b"\ntoken = "do-not-leak"\n');
  await assert.rejects(writeAIProviderDefaults('codex', 'codex-deep', undefined, { codexHome, loadCatalog: async () => codexCatalog }), err => err.code === 'config_read_failed');
});

test('quoted or quoted-dotted Codex target keys are rejected as semantic targets, never treated as opaque', () => {
  const codexHome = path.join(home, 'codex-quoted-targets');
  const file = configAt(codexHome, 'config.toml', 'model = "codex-fast"\n');
  const rejected = [
    '"model" = "codex-fast"\n',
    '"model_reasoning_effort" = "high"\n',
    '"model".child = "codex-fast"\n',
    'model = "codex-fast"\n"model" = "codex-deep"\n',
  ];
  for (const source of rejected) {
    fs.writeFileSync(file, source); fs.chmodSync(file, 0o600);
    assert.throws(() => readAIProviderDefaults('codex', { codexHome }), err => err.code === 'config_read_failed', source);
  }
});
