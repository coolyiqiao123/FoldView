import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { freshHome, makeBin, tmpDir, FOLDER_MJS } from './helpers.mjs';

const home = freshHome();
const { actionAi, buildAIProviderLaunch, buildAITerminalCommand } = await import('../folder.mjs');

function run(args, env = {}) {
  const childEnv = { ...process.env, HOME: home, ...env };
  delete childEnv.PM_NO_MAIN;
  return spawnSync(process.execPath, [FOLDER_MJS, ...args], { encoding: 'utf8', env: childEnv });
}

test('provider launch adapters emit only the exact allowlisted Codex and Kimi tokens', () => {
  assert.deepEqual(buildAIProviderLaunch('codex', '/bin/codex'), { env: [], argv: ['/bin/codex'] });
  assert.deepEqual(buildAIProviderLaunch('codex', '/bin/codex', 'deep', null),
    { env: [], argv: ['/bin/codex', '--model', 'deep'] });
  assert.deepEqual(buildAIProviderLaunch('codex', '/bin/codex', 'deep', 'high'),
    { env: [], argv: ['/bin/codex', '--model', 'deep', '--config', 'model_reasoning_effort="high"'] });
  assert.deepEqual(buildAIProviderLaunch('kimi', '/bin/kimi'), { env: [], argv: ['/bin/kimi'] });
  assert.deepEqual(buildAIProviderLaunch('kimi', '/bin/kimi', 'moon', null),
    { env: [], argv: ['/bin/kimi', '--model', 'moon'] });
  assert.deepEqual(buildAIProviderLaunch('kimi', '/bin/kimi', 'moon', 'medium'),
    { env: [{ name: 'KIMI_MODEL_THINKING_EFFORT', value: 'medium' }], argv: ['/bin/kimi', '--model', 'moon'] });
});

test('project, executable, model, and effort values survive the shell boundary without execution', () => {
  const root = tmpDir("foldview hostile ' $()-");
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const capture = path.join(root, 'capture.json');
  const pwned = path.join(root, 'PWNED');
  const cli = makeBin(bin, "fake cli'", `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify({argv:process.argv.slice(2), effort:process.env.KIMI_MODEL_THINKING_EFFORT}));\n`);
  const model = `model ' " $HOME $(touch ${pwned})\nsecond line`;
  const effort = `high ' " $HOME $(touch ${pwned})\nsecond line`;
  const command = buildAITerminalCommand(root, { executable: cli }, { provider: 'kimi', model, effort });
  const result = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), { argv: ['--model', model], effort });
  assert.equal(fs.existsSync(pwned), false, 'command substitution text must remain inert data');
});

test('pm ai machine commands reject missing JSON, duplicate flags, unknown flags, and non-lowercase providers', () => {
  assert.notEqual(run(['ai', 'catalog']).status, 0);
  for (const args of [
    ['ai', 'catalog', '--json', '--json'],
    ['ai', 'catalog', '--json', '--bogus'],
    ['ai', 'catalog', '--provider', 'Codex', '--json'],
    ['ai', 'defaults', 'get', '--json'],
    ['ai', 'defaults', 'get', '--provider', 'codex', '--model', 'x', '--json'],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.ok, false);
    assert.equal(result.stderr, '');
  }
});

test('pm ai catalog/defaults routes produce the frozen schema through the real CLI', () => {
  const bin = tmpDir('foldview-ai-route-bin-');
  const catalog = { models: [{ slug: 'route-model', display_name: 'Route Model', description: 'safe',
    visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }], default_reasoning_level: 'medium' }] };
  makeBin(bin, 'codex', `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(catalog))});\n`);
  const codexHome = tmpDir('foldview-ai-route-home-');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "route-model"\nmodel_reasoning_effort = "medium"\n', { mode: 0o600 });
  const env = { PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: codexHome };
  const catalogResult = run(['ai', 'catalog', '--provider', 'codex', '--json'], env);
  assert.equal(catalogResult.status, 0, catalogResult.stderr);
  const envelope = JSON.parse(catalogResult.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.deepEqual(envelope.providers.map(provider => provider.id), ['codex']);
  assert.equal(envelope.providers[0].models[0].id, 'route-model');
  const defaultsResult = run(['ai', 'defaults', 'get', '--provider', 'codex', '--json'], env);
  assert.equal(defaultsResult.status, 0, defaultsResult.stderr);
  assert.deepEqual(JSON.parse(defaultsResult.stdout), { schemaVersion: 1, provider: 'codex',
    defaultModel: 'route-model', defaultEffort: 'medium' });
});

test('pm ai defaults get reports effective catalog-normalized defaults when saved values disappeared', () => {
  const bin = tmpDir('foldview-ai-effective-bin-');
  const catalog = { models: [{ slug: 'new-model', display_name: 'New Model', description: 'safe',
    visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'low' }] };
  makeBin(bin, 'codex', `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(catalog))});\n`);
  const codexHome = tmpDir('foldview-ai-effective-home-');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "removed-model"\nmodel_reasoning_effort = "extreme"\n', { mode: 0o600 });
  const result = run(['ai', 'defaults', 'get', '--provider', 'codex', '--json'],
    { PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: codexHome });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, provider: 'codex', defaultModel: null, defaultEffort: null });
});

test('pm action ai JSON rejects provider mismatch and unsupported selection before AppleScript', () => {
  const bin = tmpDir('foldview-action-bin-');
  const project = tmpDir('foldview-action-project-');
  const marker = path.join(bin, 'osascript-ran');
  const catalog = { models: [{ slug: 'supported', display_name: 'Supported', description: 'safe',
    visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'low' }] };
  const codex = makeBin(bin, 'codex', `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(catalog))});\n`);
  makeBin(bin, 'osascript', `#!/bin/sh\n/bin/touch '${marker}'\nexit 0\n`);
  const codexHome = tmpDir('foldview-codex-home-');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "supported"\nmodel_reasoning_effort = "low"\n', { mode: 0o600 });
  const env = { PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: codexHome };

  let result = run(['action', 'ai', '--project', project, '--cli', codex, '--count', '1',
    '--provider', 'kimi', '--model', 'supported', '--json'], env);
  assert.notEqual(result.status, 0); assert.equal(JSON.parse(result.stdout).error.code, 'provider_mismatch');
  assert.equal(result.stderr, ''); assert.equal(fs.existsSync(marker), false);

  result = run(['action', 'ai', '--project', project, '--cli', codex, '--count', '1',
    '--provider', 'codex', '--model', 'missing', '--json'], env);
  assert.notEqual(result.status, 0); assert.equal(JSON.parse(result.stdout).error.code, 'unsupported_model');
  assert.equal(fs.existsSync(marker), false);
});

test('pm action ai JSON success reports only applied overrides and uses one AppleScript owner', () => {
  const bin = tmpDir('foldview-action-success-bin-');
  const project = tmpDir('foldview-action-success-project-');
  const capture = path.join(bin, 'osascript.json');
  const catalog = { models: [{ slug: 'supported', display_name: 'Supported', description: 'safe',
    visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'low' }] };
  const codex = makeBin(bin, 'codex', `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(catalog))});\n`);
  makeBin(bin, 'osascript', '#!/bin/sh\nprintf \'%s\' "$2" > "$CAPTURE"\n');
  const codexHome = tmpDir('foldview-codex-success-home-');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "supported"\nmodel_reasoning_effort = "low"\n', { mode: 0o600 });
  const result = run(['action', 'ai', '--project', project, '--cli', codex, '--count', '3',
    '--provider', 'codex', '--model', 'supported', '--effort', 'low', '--json'],
  { PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: codexHome, CAPTURE: capture });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, ok: true, launched: 3,
    provider: 'codex', model: 'supported', effort: 'low' });
  const script = fs.readFileSync(capture, 'utf8');
  assert.equal((script.match(/do script/g) || []).length, 3);
  assert.doesNotMatch(script, /every window|windows of application/);
});

test('legacy pm action ai remains human-readable and never probes a provider catalog', () => {
  const bin = tmpDir('foldview-action-legacy-bin-');
  const project = tmpDir('foldview-action-legacy-project-');
  const probed = path.join(bin, 'provider-probed');
  const cli = makeBin(bin, 'custom-agent', `#!/bin/sh\n/bin/touch '${probed}'\n`);
  makeBin(bin, 'osascript', '#!/bin/sh\nexit 0\n');
  const result = run(['action', 'ai', '--project', project, '--cli', cli, '--count', '2'],
    { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /opened 2 × custom-agent/);
  assert.equal(fs.existsSync(probed), false, 'legacy launch must not run a model catalog probe');
});

test('legacy and JSON action forms reject executable directories before AppleScript', () => {
  const bin = tmpDir('foldview-action-directory-bin-');
  const project = tmpDir('foldview-action-directory-project-');
  const cliDirectory = path.join(bin, 'agent-dir'); fs.mkdirSync(cliDirectory); fs.chmodSync(cliDirectory, 0o700);
  const marker = path.join(bin, 'osascript-ran');
  makeBin(bin, 'osascript', `#!/bin/sh\n/bin/touch '${marker}'\n`);
  for (const extra of [[], ['--json']]) {
    const result = run(['action', 'ai', '--project', project, '--cli', cliDirectory, '--count', '1', ...extra],
      { PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    if (extra.length) { assert.equal(JSON.parse(result.stdout).error.code, 'provider_unavailable'); assert.equal(result.stderr, ''); }
  }
  assert.equal(fs.existsSync(marker), false);
});

test('action accepts an executable symlink whose resolved target is a regular file', () => {
  const bin = tmpDir('foldview-action-symlink-bin-');
  const project = tmpDir('foldview-action-symlink-project-');
  const target = makeBin(bin, 'real-agent', '#!/bin/sh\n');
  const link = path.join(bin, 'linked-agent'); fs.symlinkSync(target, link);
  makeBin(bin, 'osascript', '#!/bin/sh\nexit 0\n');
  const result = run(['action', 'ai', '--project', project, '--cli', link, '--count', '1'],
    { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /opened 1 × linked-agent/);
});

test('late launch rejection in JSON mode becomes exactly one safe stdout document with empty stderr', async () => {
  const project = { name: 'late', path: tmpDir('foldview-late-project-') };
  const logs = [], errors = [], oldLog = console.log, oldError = console.error;
  const oldExitCode = process.exitCode;
  console.log = value => logs.push(String(value)); console.error = value => errors.push(String(value));
  try {
    await actionAi(project, '/bin/echo', 1, { json: true,
      spawnTerminals: async () => { throw new Error('late secret rejection'); } });
  } finally { console.log = oldLog; console.error = oldError; process.exitCode = oldExitCode; }
  assert.equal(logs.length, 1); assert.deepEqual(errors, []);
  const payload = JSON.parse(logs[0]);
  assert.equal(payload.schemaVersion, 1); assert.equal(payload.ok, false); assert.equal(payload.error.code, 'launch_failed');
  assert.doesNotMatch(logs[0], /secret/);
});
