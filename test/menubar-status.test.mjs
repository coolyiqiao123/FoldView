// Contract tests for `pm status --format menubar-json` (buildMenubarStatus): schema shape,
// missing roots, invalid config, stale runtime records, and empty project lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome, makeBin, tmpDir, withPath } from './helpers.mjs';

freshHome();
const mod = await import('../folder.mjs');
const { buildMenubarStatus, writeConfig, CONFIG_PATH, recordRuntimeEntry } = mod;

test('missing roots: falls back to cwd and still returns a valid schemaVersion-1 payload', async () => {
  writeConfig({});
  const payload = await buildMenubarStatus();
  assert.equal(payload.schemaVersion, 1);
  assert.ok(payload.generatedAt);
  assert.ok(payload.summary && typeof payload.summary.projectCount === 'number');
  assert.ok(Array.isArray(payload.projects));
  assert.ok(Array.isArray(payload.aiClis));
});

test('invalid/corrupt config file is rejected instead of silently changing status semantics', async () => {
  fs.writeFileSync(CONFIG_PATH, '{ not valid json ', { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
  await assert.rejects(() => buildMenubarStatus(), /corrupt JSON/);
  fs.unlinkSync(CONFIG_PATH);
});

test('empty project list: a root with no marker directories reports an empty, internally-consistent list', async () => {
  const root = tmpDir('foldview-empty-root-');
  writeConfig({ roots: [root] });
  const payload = await buildMenubarStatus();
  assert.equal(payload.summary.projectCount, payload.projects.length);
  assert.equal(payload.summary.liveCount, payload.projects.filter(p => p.live).length);
});

test('stale runtime-registry record (long-gone PID) does not mark a project managed', async () => {
  const root = tmpDir('foldview-root-');
  const proj = path.join(root, 'my-app');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'my-app' }));
  writeConfig({ roots: [root] });
  recordRuntimeEntry({ project: proj, pid: 999999, pgid: 999999, port: 4321, startedAt: Date.now(),
    command: 'npm run dev', logFile: '', launcher: 'tui' });

  const payload = await buildMenubarStatus();
  const row = payload.projects.find(p => p.path === proj);
  assert.ok(row);
  assert.equal(row.managed, false, 'a stale registry entry must not be reported as managed');
});

test('a real project is reported with the exact frozen field shape', async () => {
  const root = tmpDir('foldview-root-');
  const proj = path.join(root, 'my-app');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'my-app', scripts: { dev: 'vite' } }));
  writeConfig({ roots: [root] });
  const payload = await buildMenubarStatus();
  const row = payload.projects.find(p => p.path === proj);
  assert.ok(row);
  for (const key of ['id', 'name', 'path', 'kind', 'live', 'port', 'launchable', 'managed', 'modifiedAt']) {
    assert.ok(key in row, `missing frozen field: ${key}`);
  }
  assert.equal(row.launchable, true, 'has a dev script → launchable');
  assert.equal(row.kind, 'project');
});

test('aiClis in the payload only contain {name, executable} — no key/shortcut leakage into the wire format', async () => {
  writeConfig({});
  const payload = await buildMenubarStatus();
  for (const cli of payload.aiClis) {
    assert.deepEqual(Object.keys(cli).sort(), ['executable', 'name']);
  }
});

test('periodic status discovers provider executables but never invokes provider catalog commands', async () => {
  const bin = tmpDir('foldview-status-provider-bin-');
  const marker = path.join(bin, 'provider-was-invoked');
  makeBin(bin, 'codex', `#!/bin/sh\n/bin/touch '${marker}'\nexit 91\n`);
  makeBin(bin, 'kimi', `#!/bin/sh\n/bin/touch '${marker}'\nexit 92\n`);
  const restore = withPath([bin]);
  try {
    writeConfig({});
    const payload = await buildMenubarStatus();
    assert.ok(payload.aiClis.some(cli => cli.name === 'Codex'));
    assert.ok(payload.aiClis.some(cli => cli.name === 'Kimi Code'));
    assert.equal(fs.existsSync(marker), false);
  } finally { restore(); }
});

test('showDiscoveredApps hides app rows without removing project rows', async () => {
  const root = tmpDir('foldview-visibility-root-');
  const proj = path.join(root, 'project');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'project', scripts: { dev: 'vite' } }));
  writeConfig({ roots: [root], apps: [{ name: 'Pinned local app', url: 'http://localhost:65534' }],
    menubar: { refreshSeconds: 60, showDiscoveredApps: false } });
  let payload = await buildMenubarStatus();
  assert.ok(payload.projects.some(row => row.name === 'project' && row.kind === 'project'));
  assert.ok(!payload.projects.some(row => row.kind === 'app'));

  writeConfig({ roots: [root], apps: [{ name: 'Pinned local app', url: 'http://localhost:65534' }],
    menubar: { refreshSeconds: 60, showDiscoveredApps: true } });
  payload = await buildMenubarStatus();
  assert.ok(payload.projects.some(row => row.name === 'project' && row.kind === 'project'));
  assert.ok(payload.projects.some(row => row.name === 'Pinned local app' && row.kind === 'app'));
});
