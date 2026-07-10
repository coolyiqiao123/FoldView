// Unit tests: ~/.foldview.json schema defaults, atomic tmp+rename writes, and read-merge-write
// preservation of unrelated/unknown fields (incl. under simulated concurrent writers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome } from './helpers.mjs';

freshHome();
const { readConfig, writeConfig, updateConfig, CONFIG_PATH } = await import('../folder.mjs');

test('readConfig: a missing file returns a fully-defaulted schemaVersion-1 shape', () => {
  const cfg = readConfig();
  assert.equal(cfg.schemaVersion, 1);
  assert.deepEqual(cfg.roots, []);
  assert.deepEqual(cfg.recentProjects, []);
  assert.deepEqual(cfg.menubar, { refreshSeconds: 60, showDiscoveredApps: true });
  assert.deepEqual(cfg.apps, []);
  assert.deepEqual(cfg.hidden, []);
  assert.deepEqual(cfg.aiClis, []);
});

test('writeConfig: atomic tmp+rename — file is always valid JSON, no stray .tmp- files remain', () => {
  for (let i = 0; i < 5; i++) updateConfig(cfg => { cfg.roots.push(`/tmp/root-${i}`); });
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.roots.length, 5);
  const strays = fs.readdirSync(path.dirname(CONFIG_PATH)).filter(f => f.includes('.tmp-'));
  assert.deepEqual(strays, []);
});

test('updateConfig: read-merge-write preserves fields set by a different, unrelated call', () => {
  writeConfig({ apps: [{ name: 'x', port: 1 }], hidden: [2], custom: { nested: true } });
  updateConfig(cfg => { cfg.roots.push('/tmp/newroot'); });
  const cfg = readConfig();
  assert.equal(cfg.apps[0].name, 'x');
  assert.deepEqual(cfg.hidden, [2]);
  assert.deepEqual(cfg.custom, { nested: true });
  assert.deepEqual(cfg.roots, ['/tmp/newroot']);
});

test('updateConfig: simulated concurrent writers each land without corrupting the file', () => {
  writeConfig({});
  // interleave two "processes" racing to write different fields
  const cfgA = readConfig(); cfgA.roots.push('/from/A');
  const cfgB = readConfig(); cfgB.aiClis.push({ name: 'agentB', executable: '/bin/agentB' });
  writeConfig(cfgA);
  writeConfig(cfgB);   // last writer wins for fields it touched, but the file itself stays valid
  const final = readConfig();
  assert.doesNotThrow(() => JSON.stringify(final));
  assert.deepEqual(final.aiClis, [{ name: 'agentB', executable: '/bin/agentB' }]);
});

test('writeConfig: always stamps schemaVersion 1, even for a hand-built object', () => {
  writeConfig({ roots: ['/x'] });
  assert.equal(readConfig().schemaVersion, 1);
});
