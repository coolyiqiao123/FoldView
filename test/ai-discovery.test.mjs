// Unit tests: known-CLI discovery (mocked `command -v` via PATH), custom-CLI validation/
// rejection, dedupe by resolved path, deterministic shortcut assignment, and config merging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome, makeBin, withPath, tmpDir } from './helpers.mjs';

freshHome();
const mod = await import('../folder.mjs');
const { discoverAIClis, resolveExecutable, assignFreeKey, resolveCustomCli, saveCustomCli, readConfig, writeConfig,
  classifyAIProvider } = mod;

test('resolveExecutable: `command -v` only finds what is actually resolvable on PATH', () => {
  const bin = tmpDir('foldview-bin-');
  const exe = makeBin(bin, 'claude', '#!/bin/sh\necho fake-claude\n');
  const restore = withPath([bin]);
  try {
    assert.equal(resolveExecutable('claude'), exe);
    assert.equal(resolveExecutable('definitely-not-a-real-cli-xyz'), null);
  } finally { restore(); }
});

test('discoverAIClis: only resolvable known CLIs appear, each with its table shortcut', () => {
  const bin = tmpDir('foldview-bin-');
  makeBin(bin, 'claude', '#!/bin/sh\n');
  makeBin(bin, 'gemini', '#!/bin/sh\n');
  const restore = withPath([bin]);
  try {
    const found = discoverAIClis();
    assert.deepEqual(found.map(f => f.name).sort(), ['Claude', 'Gemini']);
    assert.equal(found.find(f => f.name === 'Claude').key, 'c');
    assert.equal(found.find(f => f.name === 'Gemini').key, 'g');
  } finally { restore(); }
});

test('discoverAIClis: recognizes native Codex and Kimi with stable internal provider IDs', () => {
  const bin = tmpDir('foldview-bin-');
  const codex = makeBin(bin, 'codex', '#!/bin/sh\n');
  const kimi = makeBin(bin, 'kimi', '#!/bin/sh\n');
  const restore = withPath([bin]);
  try {
    const found = discoverAIClis();
    assert.deepEqual(found.map(({ name, provider }) => ({ name, provider })), [
      { name: 'Codex', provider: 'codex' },
      { name: 'Kimi Code', provider: 'kimi' },
    ]);
    assert.equal(classifyAIProvider(codex), 'codex');
    assert.equal(classifyAIProvider(kimi), 'kimi');
  } finally { restore(); }
});

test('discoverAIClis: with nothing installed, returns an empty list (footer still shows +custom/esc)', () => {
  const restore = withPath(['/definitely/does/not/exist']);
  try { assert.deepEqual(discoverAIClis(), []); } finally { restore(); }
});

test('assignFreeKey: deterministic collision resolution — name letters first, then digits', () => {
  const used = new Set(['c']);
  assert.equal(assignFreeKey('Codex', used), 'o');
  for (const k of ['o', 'd', 'e', 'x']) used.add(k);
  assert.equal(assignFreeKey('Codex', used), '1', 'name exhausted → first free digit');
});

test('resolveCustomCli: rejects empty input, shell metacharacters, and relative paths', () => {
  const bad = ['', '   ', 'claude | rm -rf /', 'claude; rm -rf /', 'claude && rm', '$(rm -rf /)',
    '`rm -rf /`', 'claude > out.txt', 'claude < in.txt', 'a & b', './bin/claude', '../claude'];
  for (const s of bad) assert.equal(resolveCustomCli(s).ok, false, `expected rejection for ${JSON.stringify(s)}`);
});

test('resolveCustomCli: allows spaces (real paths can contain them) — only shell syntax is forbidden', () => {
  const bin = tmpDir('foldview bin with spaces');
  const exe = makeBin(bin, 'my agent', '#!/bin/sh\n');
  const r = resolveCustomCli(exe);
  assert.equal(r.ok, true);
  assert.equal(r.executable, exe);
});

test('resolveCustomCli: resolves a bare name via PATH, validates an absolute path exists + is executable', () => {
  const bin = tmpDir('foldview-bin-');
  const exe = makeBin(bin, 'my-agent', '#!/bin/sh\n');
  const restore = withPath([bin]);
  try {
    assert.equal(resolveCustomCli('my-agent').ok, true);
    assert.equal(resolveCustomCli('my-agent').executable, exe);
    assert.equal(resolveCustomCli(exe).ok, true);

    const nonExec = path.join(bin, 'not-executable');
    fs.writeFileSync(nonExec, '#!/bin/sh\n');   // deliberately not chmod +x
    assert.equal(resolveCustomCli(nonExec).ok, false);

    assert.equal(resolveCustomCli(path.join(bin, 'nope')).ok, false, 'nonexistent absolute path');
    assert.equal(resolveCustomCli('nonexistent-bare-name-xyz').ok, false);
  } finally { restore(); }
});

test('saveCustomCli + discoverAIClis: persists, dedupes by resolved absolute path, preserves unrelated recognized config', () => {
  const bin = tmpDir('foldview-bin-');
  const exe = makeBin(bin, 'my-agent', '#!/bin/sh\n');
  const restore = withPath([bin]);
  try {
    writeConfig({ apps: [{ name: 'kept', port: 4321 }], hidden: [4322] });
    saveCustomCli({ name: 'my-agent', executable: exe });
    saveCustomCli({ name: 'my-agent-dup', executable: exe });   // same resolved path — must not duplicate

    const cfg = readConfig();
    assert.equal(cfg.aiClis.filter(a => a.executable === exe).length, 1, 'deduped by resolved absolute path');
    assert.equal(cfg.apps[0].name, 'kept', 'unrelated config field preserved');
    assert.deepEqual(cfg.hidden, [4322], 'unrelated recognized field preserved');

    const found = discoverAIClis().find(f => f.executable === exe);
    assert.ok(found, 'custom CLI appears in discovery');
    assert.ok(found.key, 'custom CLI is assigned a shortcut');
  } finally { restore(); }
});

test('discoverAIClis: an entry with no free key stays in config but is omitted from the one-key menu', () => {
  const bin = tmpDir('foldview-bin-');
  const restore = withPath([bin]);
  try {
    const keys = [...'abcdefghijklmnopqrstuvwxyz0123456789'];   // all 36 possible single-key shortcuts
    const aiClis = keys.map(ch => ({ name: ch, executable: makeBin(bin, `agent-${ch}`, '#!/bin/sh\n') }));
    const overflowExe = makeBin(bin, 'agent-overflow', '#!/bin/sh\n');
    aiClis.push({ name: 'overflow', executable: overflowExe });
    writeConfig({ aiClis });

    const found = discoverAIClis();
    assert.equal(found.filter(f => f.key).length, 36, 'all 36 shortcuts assigned');
    const overflow = found.find(f => f.executable === overflowExe);
    assert.ok(overflow, 'still present / discoverable');
    assert.equal(overflow.key, null, 'no free shortcut left');
  } finally { restore(); }
});
