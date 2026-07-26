import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FOLDER_MJS, freshHome } from './helpers.mjs';

const home = freshHome();
const { readConfig, writeConfig, updateConfig, CONFIG_PATH } = await import('../folder.mjs');

test('missing config returns the exact normalized schema-v1 shape', () => {
  assert.deepEqual(readConfig(), {
    schemaVersion: 1, roots: [], recentProjects: [],
    menubar: { refreshSeconds: 60, showDiscoveredApps: true },
    apps: [], hidden: [], aiClis: [],
  });
});

test('write is atomic, 0600, normalized, and preserves every recognized field', () => {
  assert.equal(writeConfig({
    roots: ['/tmp/root'], recentProjects: ['/tmp/recent'],
    menubar: { refreshSeconds: 120, showDiscoveredApps: false },
    apps: [{ name: 'x', port: 4321, path: '/tmp/x' }], hidden: [4444],
    aiClis: [{ name: 'agent', executable: '/bin/agent' }], ignored: 'drop me',
  }), true);
  const cfg = readConfig();
  assert.deepEqual(Object.keys(cfg), ['schemaVersion', 'roots', 'recentProjects', 'menubar', 'apps', 'hidden', 'aiClis']);
  assert.deepEqual(cfg.roots, ['/tmp/root']);
  assert.deepEqual(cfg.recentProjects, ['/tmp/recent']);
  assert.deepEqual(cfg.apps, [{ name: 'x', port: 4321, path: '/tmp/x' }]);
  assert.deepEqual(cfg.hidden, [4444]);
  assert.deepEqual(cfg.aiClis, [{ name: 'agent', executable: '/bin/agent' }]);
  assert.equal(fs.statSync(CONFIG_PATH).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(home).filter(name => name.includes('.tmp-')), []);
});

test('updateConfig performs a locked read-modify-write and preserves unrelated recognized fields', () => {
  assert.equal(updateConfig(cfg => cfg.roots.push('/tmp/second')), true);
  const cfg = readConfig();
  assert.deepEqual(cfg.roots, ['/tmp/root', '/tmp/second']);
  assert.deepEqual(cfg.aiClis, [{ name: 'agent', executable: '/bin/agent' }]);
  assert.deepEqual(cfg.apps, [{ name: 'x', port: 4321, path: '/tmp/x' }]);
});

test('rejects corrupt, unknown-schema, malformed, and insecure config files', () => {
  const cases = [
    ['{not json', /corrupt JSON/],
    [JSON.stringify({ schemaVersion: 2 }), /unsupported schemaVersion/],
    [JSON.stringify({ roots: ['relative'] }), /must be an absolute path/],
    [JSON.stringify({ menubar: { refreshSeconds: 1 } }), /integer from 15 to 600/],
    [JSON.stringify({ aiClis: [{ name: 'x', executable: 'relative' }] }), /must be absolute/],
  ];
  for (const [contents, expected] of cases) {
    fs.writeFileSync(CONFIG_PATH, contents, { mode: 0o600 });
    fs.chmodSync(CONFIG_PATH, 0o600);
    assert.throws(() => readConfig(), expected);
  }
  fs.writeFileSync(CONFIG_PATH, '{}', { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o644);
  assert.throws(() => readConfig(), /0600 regular file/);
  fs.unlinkSync(CONFIG_PATH);
  fs.symlinkSync('/dev/null', CONFIG_PATH);
  assert.throws(() => readConfig(), /0600 regular file/);
  fs.unlinkSync(CONFIG_PATH);
  fs.mkdirSync(CONFIG_PATH);
  assert.throws(() => readConfig(), /0600 regular file/);
  fs.rmdirSync(CONFIG_PATH);
  writeConfig({});
});

function runCLI(args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home };
    delete env.PM_NO_MAIN;
    const child = spawn(process.execPath, [FOLDER_MJS, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`)));
  });
}

test('concurrent CLI writers serialize without losing any read-modify-write update', async () => {
  writeConfig({});
  const executables = Array.from({ length: 12 }, (_, index) => {
    const executable = path.join(home, `agent-${index}`);
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    return executable;
  });
  await Promise.all(executables.map((executable, index) =>
    runCLI(['aiclis', 'add', '--name', `agent ${index}`, '--executable', executable])));
  const cfg = readConfig();
  assert.equal(cfg.aiClis.length, executables.length);
  assert.deepEqual(new Set(cfg.aiClis.map(item => item.executable)), new Set(executables));
  assert.equal(fs.existsSync(CONFIG_PATH + '.lock'), false);
});
