import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome, makeBin, tmpDir, withPath } from './helpers.mjs';

const home = freshHome();
const mod = await import('../folder.mjs');
const { parseCodexCatalogPayload, parseKimiCatalogSource, loadCodexCatalog, buildAIProviderCatalog,
  validateAISelection, buildAIProviderLaunch } = mod;
const fixtures = path.join(import.meta.dirname, 'fixtures', 'ai-catalog');
const fixture = name => fs.readFileSync(path.join(fixtures, name));

function privateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

test('Codex adapter accepts wrapped and bare catalogs, filters visibility, and sorts deterministically', () => {
  for (const name of ['codex-wrapped-raw.json', 'codex-bare-raw.json']) {
    const models = parseCodexCatalogPayload(fixture(name));
    assert.deepEqual(models.map(m => m.id), ['codex-deep', 'codex-fast']);
    assert.equal(models.some(m => m.id === 'codex-hidden'), false);
    assert.deepEqual(models[0].efforts, ['low', 'medium', 'high']);
  }
});

test('Codex normalization rejects control IDs, sanitizes presentation text, and keeps first duplicates', () => {
  const models = parseCodexCatalogPayload(fixture('codex-adversarial-raw.json'));
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'safe-model');
  assert.equal(models[0].label, 'Safe Model');
  assert.equal(models[0].detail, 'Line Break');
  assert.deepEqual(models[0].efforts, ['high']);
});

test('catalog normalization enforces UTF-8 byte and provider-scoped collection limits', () => {
  const unicodeTooWide = '😀'.repeat(65); // 65 scalars, but 260 UTF-8 bytes.
  const models = parseCodexCatalogPayload(JSON.stringify([
    { slug: unicodeTooWide, display_name: 'short', visibility: 'list' },
    { slug: 'oversized-label', display_name: '😀'.repeat(1025), visibility: 'list' },
    { slug: 'safe', display_name: 'Safe', visibility: 'list' },
  ]));
  assert.deepEqual(models.map(model => model.id), ['safe']);

  const tooManyEfforts = [{ slug: 'many', visibility: 'list', supported_reasoning_levels:
    Array.from({ length: 17 }, (_, i) => ({ effort: `e${i}` })) }];
  assert.throws(() => parseCodexCatalogPayload(JSON.stringify(tooManyEfforts)), err => {
    assert.equal(err.code, 'malformed_catalog');
    assert.equal(err.toJSON().provider, 'codex');
    return true;
  });
  const tooManyModels = Array.from({ length: 257 }, (_, i) => ({ slug: `m${i}`, visibility: 'list' }));
  assert.throws(() => parseCodexCatalogPayload(JSON.stringify(tooManyModels)), err => {
    assert.equal(err.code, 'malformed_catalog');
    assert.equal(err.toJSON().provider, 'codex');
    return true;
  });
});

test('Kimi adapter preserves alias declaration order, quoted hashes, selectable efforts, and fixed thinking', () => {
  const parsed = parseKimiCatalogSource(fixture('kimi-config.toml').toString('utf8'));
  assert.deepEqual(parsed.models.map(m => m.id), ['moonshot/k3', 'moonshot/k2.5']);
  assert.equal(parsed.models[0].label, 'Kimi # Preview');
  assert.deepEqual(parsed.models[0].efforts, ['low', 'medium', 'high']);
  assert.deepEqual(parsed.models[1].efforts, []);
  assert.equal(parsed.models[1].detail, 'Thinking is always on');
  assert.equal(parsed.defaultModel, 'moonshot/k3');
  assert.equal(parsed.defaultEffort, 'high');
});

test('Kimi adapter rejects unsupported multiline TOML', () => {
  assert.throws(() => parseKimiCatalogSource(fixture('kimi-config-malformed-multiline.toml').toString('utf8')),
    err => err.code === 'malformed_catalog');
});

test('opaque TOML lines must be complete and valid without mistaking unrelated dotted keys for targets', () => {
  const valid = [
    'default_model = "alias"',
    'provider.model = "opaque-not-a-target"',
    'unknown = { nested = ["x", 1], flag = true }',
    '',
    '[models."alias"]',
    'model = "remote"',
  ].join('\n');
  const parsed = parseKimiCatalogSource(valid);
  assert.equal(parsed.models[0].id, 'alias');
  assert.throws(() => parseKimiCatalogSource(valid.replace('unknown = { nested = ["x", 1], flag = true }', 'unknown = { nonsense }')),
    err => err.code === 'malformed_catalog');
  assert.throws(() => parseKimiCatalogSource(valid.replace('provider.model = "opaque-not-a-target"', 'default_model.child = "ambiguous"')),
    err => err.code === 'malformed_catalog');
});

test('quoted semantic Kimi targets and thinking tables are rejected instead of becoming opaque settings', () => {
  const base = fixture('kimi-config.toml').toString('utf8');
  const rejected = [
    base.replace('default_model =', '"default_model" ='),
    base.replace('[thinking]', '["thinking"]'),
    base.replace('enabled = true', '"enabled" = true'),
    base.replace('effort = "high"', '"effort" = "high"'),
    base.replace('effort = "high"', '"effort".child = "high"'),
    base.replace('enabled = true', '"default_effort" = "high"\nenabled = true'),
    base.replace('[thinking]', '[thinking]\nenabled = true\n\n["thinking"]'),
  ];
  for (const source of rejected) {
    assert.throws(() => parseKimiCatalogSource(source), err => err.code === 'malformed_catalog');
  }
});

test('Codex probe uses literal debug/models argv and accepts a bare catalog', async () => {
  const bin = tmpDir('foldview-catalog-bin-');
  const raw = path.join(bin, 'raw.json'); fs.writeFileSync(raw, fixture('codex-bare-raw.json'));
  const exe = makeBin(bin, 'codex-fixture', `#!/bin/sh\n/bin/cat '${raw}'\n`);
  const configHome = path.join(home, 'codex-probe');
  privateFile(path.join(configHome, 'config.toml'), 'model = "codex-deep"\nmodel_reasoning_effort = "high"\n');
  const loaded = await loadCodexCatalog(exe, { codexHome: configHome });
  assert.equal(loaded.defaultModel, 'codex-deep');
  assert.equal(loaded.defaultEffort, 'high');
});

test('Codex probe has a bounded timeout and never reflects captured secrets', async () => {
  const bin = tmpDir('foldview-catalog-bin-');
  const exe = makeBin(bin, 'codex-slow', '#!/bin/sh\necho "API_TOKEN=do-not-leak" >&2\n/bin/sleep 2\n');
  const configHome = path.join(home, 'codex-timeout');
  privateFile(path.join(configHome, 'config.toml'), '');
  await assert.rejects(loadCodexCatalog(exe, { codexHome: configHome, timeoutMs: 30 }), err => {
    assert.equal(err.code, 'catalog_timeout');
    assert.equal(JSON.stringify(err.toJSON()).includes('do-not-leak'), false);
    return true;
  });
});

test('catalog aggregation preserves Kimi when Codex output is malformed and emits no secrets', async () => {
  const bin = tmpDir('foldview-catalog-bin-');
  makeBin(bin, 'codex', '#!/bin/sh\necho "secret-token" >&2\necho not-json\n');
  makeBin(bin, 'kimi', '#!/bin/sh\nexit 0\n');
  privateFile(path.join(home, '.codex', 'config.toml'), '');
  privateFile(path.join(home, '.kimi-code', 'config.toml'), fixture('kimi-config.toml'));
  const restore = withPath([bin]);
  try {
    const catalog = await buildAIProviderCatalog(null, {
      home, codexHome: path.join(home, '.codex'), now: new Date('2026-07-19T00:00:00.000Z')
    });
    assert.equal(catalog.providers[0].available, false);
    assert.equal(catalog.providers[0].error.code, 'malformed_catalog');
    assert.equal(catalog.providers[1].available, true);
    assert.equal(JSON.stringify(catalog).includes('secret-token'), false);
  } finally { restore(); }
});

test('catalog aggregation preserves Codex when Kimi is malformed (reverse partial failure)', async () => {
  const bin = tmpDir('foldview-catalog-bin-');
  const raw = path.join(bin, 'codex.json'); fs.writeFileSync(raw, fixture('codex-bare-raw.json'));
  makeBin(bin, 'codex', `#!/bin/sh\n/bin/cat '${raw}'\n`);
  makeBin(bin, 'kimi', '#!/bin/sh\nexit 0\n');
  privateFile(path.join(home, '.codex', 'config.toml'), 'model = "codex-deep"\n');
  privateFile(path.join(home, '.kimi-code', 'config.toml'), 'default_model = "broken"\nvalue = { nope }\n');
  const restore = withPath([bin]);
  try {
    const catalog = await buildAIProviderCatalog(null, {
      home, codexHome: path.join(home, '.codex'), now: new Date('2026-07-19T00:00:00.000Z')
    });
    assert.equal(catalog.providers[0].available, true);
    assert.equal(catalog.providers[1].available, false);
    assert.equal(catalog.providers[1].error.code, 'malformed_catalog');
  } finally { restore(); }
});

test('a discovered provider with no required Kimi config reports provider_unavailable', async () => {
  const bin = tmpDir('foldview-catalog-bin-');
  makeBin(bin, 'kimi', '#!/bin/sh\nexit 0\n');
  const missingHome = tmpDir('foldview-kimi-missing-');
  const restore = withPath([bin]);
  try {
    const catalog = await buildAIProviderCatalog('kimi', { home: missingHome });
    assert.equal(catalog.providers[0].available, false);
    assert.equal(catalog.providers[0].error.code, 'provider_unavailable');
    assert.equal(catalog.providers[0].error.provider, 'kimi');
  } finally { restore(); }
});

test('selection validation and launch builders are closed provider allowlists', () => {
  const provider = { available: true, defaultModel: 'codex-deep', models: parseCodexCatalogPayload(fixture('codex-bare-raw.json')) };
  assert.deepEqual(validateAISelection('codex', provider, 'codex-deep', 'high').selectedModel.id, 'codex-deep');
  assert.throws(() => validateAISelection('codex', provider, 'removed', null), err => err.code === 'unsupported_model');
  assert.throws(() => validateAISelection('codex', provider, 'codex-fast', 'high'), err => err.code === 'unsupported_effort');
  assert.deepEqual(buildAIProviderLaunch('codex', '/bin/codex', 'm', 'high'), {
    env: [], argv: ['/bin/codex', '--model', 'm', '--config', 'model_reasoning_effort="high"']
  });
  assert.deepEqual(buildAIProviderLaunch('kimi', '/bin/kimi', 'm', 'high'), {
    env: [{ name: 'KIMI_MODEL_THINKING_EFFORT', value: 'high' }], argv: ['/bin/kimi', '--model', 'm']
  });
});
