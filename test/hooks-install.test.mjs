// Tests for `pm hooks install|uninstall|status`: idempotent additive installs into Claude
// settings.json and Kimi config.toml, exact preservation of pre-existing user content,
// one-time backups, reversible uninstall, corrupt-file refusal, and bridge liveness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome } from './helpers.mjs';

const home = freshHome();
const {
  cmdHooks, hooksStatus, CLAUDE_HOOK_EVENTS, KIMI_HOOK_EVENTS, NOTCH_BRIDGE_PATH,
} = await import('../folder.mjs');

const claudePath = path.join(home, '.claude', 'settings.json');
const kimiPath = path.join(home, '.kimi-code', 'config.toml');
const readClaude = () => JSON.parse(fs.readFileSync(claudePath, 'utf8'));
const readKimi = () => fs.readFileSync(kimiPath, 'utf8');

async function captureJSON(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = orig; }
  return JSON.parse(lines.join('\n'));
}
// our hook entries are matched by the command string the installer writes
const ourHookCommands = settings =>
  Object.values(settings.hooks || {}).flat().flatMap(e => e.hooks || [])
    .filter(h => typeof h.command === 'string' && h.command.includes('hook-bridge'))
    .map(h => h.command);

const ORIGINAL_CLAUDE = {
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-hook', timeout: 5 }] }],
  },
};
const ORIGINAL_KIMI = '[core]\nfoo = "bar"\n\n[[hooks]]\nevent = "UserEvent"\ncommand = "user-cmd"\ntimeout = 3\n';

test('hooks install: adds our entries, preserves existing hooks, creates backups, prints status JSON', async () => {
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.writeFileSync(claudePath, JSON.stringify(ORIGINAL_CLAUDE, null, 2) + '\n');
  fs.mkdirSync(path.dirname(kimiPath), { recursive: true });
  fs.writeFileSync(kimiPath, ORIGINAL_KIMI);

  const status = await captureJSON(() => cmdHooks(['install']));
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.ok, true);
  assert.equal(status.claude.installed, true);
  assert.deepEqual(status.claude.events, CLAUDE_HOOK_EVENTS.map(e => e.event));
  assert.equal(status.kimi.installed, true);
  assert.deepEqual(status.kimi.events, KIMI_HOOK_EVENTS.map(e => e.event));
  assert.equal(status.bridge.running, false);

  const s = readClaude();
  assert.equal(s.model, 'opus', 'unrelated settings keys are preserved');
  assert.equal(s.hooks.PreToolUse.length, 2, 'user entry + ours');
  assert.deepEqual(s.hooks.PreToolUse[0], ORIGINAL_CLAUDE.hooks.PreToolUse[0], 'the user hook entry is verbatim first');
  const ours = s.hooks.PreToolUse[1];
  assert.equal(ours.matcher, '', 'PreToolUse carries an empty matcher');
  assert.equal(ours.hooks.length, 1);
  assert.equal(ours.hooks[0].type, 'command');
  assert.equal(ours.hooks[0].timeout, 300);
  assert.match(ours.hooks[0].command, /^node \S*folder\.mjs hook-bridge claude PreToolUse$/);
  for (const { event, timeout } of CLAUDE_HOOK_EVENTS.slice(1)) {
    const list = s.hooks[event];
    assert.ok(Array.isArray(list) && list.length === 1, `${event} installed`);
    assert.ok(!('matcher' in list[0]), `${event} has no matcher field`);
    assert.equal(list[0].hooks[0].timeout, timeout);
    assert.match(list[0].hooks[0].command, new RegExp(`hook-bridge claude ${event}$`));
  }
  assert.equal(fs.readFileSync(claudePath + '.foldview-bak', 'utf8'), JSON.stringify(ORIGINAL_CLAUDE, null, 2) + '\n',
    'backup holds the pre-install content');

  const toml = readKimi();
  assert.ok(toml.includes('[core]\nfoo = "bar"'), 'existing TOML content is untouched');
  assert.ok(toml.includes('event = "UserEvent"'), 'existing user [[hooks]] block is untouched');
  assert.equal((toml.match(/# foldview-notch-hook/g) || []).length, KIMI_HOOK_EVENTS.length);
  assert.ok(toml.includes(`event = "PreToolUse"`));
  assert.ok(toml.includes('timeout = 300'));
  assert.match(toml, /command = "node \S*folder\.mjs hook-bridge kimi PreToolUse"/);
  assert.equal(fs.readFileSync(kimiPath + '.foldview-bak', 'utf8'), ORIGINAL_KIMI);
});

test('hooks install again: fully idempotent — no duplicate entries, backups not overwritten', async () => {
  const beforeClaude = fs.readFileSync(claudePath, 'utf8');
  const beforeKimi = readKimi();
  await captureJSON(() => cmdHooks(['install']));
  assert.equal(fs.readFileSync(claudePath, 'utf8'), beforeClaude, 'second install is a byte-identical no-op');
  assert.equal(readKimi(), beforeKimi);
  assert.equal(ourHookCommands(readClaude()).length, CLAUDE_HOOK_EVENTS.length, 'exactly one command per event');
  assert.equal((readKimi().match(/# foldview-notch-hook/g) || []).length, KIMI_HOOK_EVENTS.length);
});

test('hooks status: reports installed events and bridge liveness', async () => {
  const status = await captureJSON(() => cmdHooks(['status']));
  assert.equal(status.claude.installed, true);
  assert.equal(status.kimi.installed, true);
  assert.equal(status.bridge.running, false, 'no bridge state file yet');
  fs.mkdirSync(path.dirname(NOTCH_BRIDGE_PATH), { recursive: true });
  fs.writeFileSync(NOTCH_BRIDGE_PATH, JSON.stringify({ schemaVersion: 1, port: 43210, token: 't', pid: process.pid, launchedAt: new Date().toISOString() }));
  const s2 = await captureJSON(() => cmdHooks(['status']));
  assert.equal(s2.bridge.running, true, 'state file + live pid ⇒ running');
  assert.equal(s2.bridge.port, 43210);
  fs.writeFileSync(NOTCH_BRIDGE_PATH, JSON.stringify({ schemaVersion: 1, port: 43210, token: 't', pid: 999999, launchedAt: new Date().toISOString() }));
  const s3 = await captureJSON(() => cmdHooks(['status']));
  assert.equal(s3.bridge.running, false, 'a dead pid is not running');
});

test('hooks uninstall: removes exactly our entries, keeps user content, status flips back', async () => {
  await captureJSON(() => cmdHooks(['uninstall']));
  const s = readClaude();
  assert.deepEqual(s.hooks.PreToolUse, ORIGINAL_CLAUDE.hooks.PreToolUse, 'the user hook survives verbatim');
  assert.equal(ourHookCommands(s).length, 0, 'no hook-bridge commands remain');
  for (const { event } of CLAUDE_HOOK_EVENTS.slice(1)) assert.ok(!(event in s.hooks), `${event} entry removed`);
  assert.equal(s.model, 'opus');

  const toml = readKimi();
  assert.equal(toml, ORIGINAL_KIMI, 'uninstall restores the pre-install TOML byte-for-byte');

  const status = await captureJSON(() => cmdHooks(['status']));
  assert.equal(status.claude.installed, false);
  assert.deepEqual(status.claude.events, []);
  assert.equal(status.kimi.installed, false);
  assert.deepEqual(status.kimi.events, []);
  assert.ok(fs.existsSync(claudePath + '.foldview-bak'), 'backups are left in place');
  assert.ok(fs.existsSync(kimiPath + '.foldview-bak'));
});

test('hooks install on corrupt settings.json: typed failure, file untouched', async () => {
  fs.writeFileSync(claudePath, '{corrupt json');
  const out = await captureJSON(() => cmdHooks(['install']));
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'config_read_failed');
  assert.equal(fs.readFileSync(claudePath, 'utf8'), '{corrupt json', 'the file is not modified');
  assert.equal(process.exitCode, 1, 'typed failure sets a non-zero exit code');
  process.exitCode = 0;   // don't leak the exit code into the test runner
  // and a non-object JSON document is refused the same way
  fs.writeFileSync(claudePath, '[1,2,3]');
  const out2 = await captureJSON(() => cmdHooks(['install']));
  assert.equal(out2.ok, false);
  assert.equal(out2.error.code, 'config_read_failed');
  assert.equal(fs.readFileSync(claudePath, 'utf8'), '[1,2,3]');
  process.exitCode = 0;
});

test('hooks install into a fresh home: creates settings.json and config.toml from nothing', async () => {
  fs.rmSync(claudePath, { force: true });
  fs.rmSync(claudePath + '.foldview-bak', { force: true });
  fs.rmSync(kimiPath, { force: true });
  fs.rmSync(kimiPath + '.foldview-bak', { force: true });
  const status = await captureJSON(() => cmdHooks(['install']));
  assert.equal(status.claude.installed, true);
  assert.equal(status.kimi.installed, true);
  assert.ok(fs.existsSync(claudePath));
  assert.ok(fs.existsSync(kimiPath));
  assert.ok(!fs.existsSync(claudePath + '.foldview-bak'), 'no backup when there was nothing to back up');
  assert.ok(!fs.existsSync(kimiPath + '.foldview-bak'));
  assert.equal(readClaude().hooks.Notification[0].hooks[0].timeout, 10);
  assert.equal(hooksStatus().claude.installed, true);
  // clean up so this file leaves no hooks installed behind
  await captureJSON(() => cmdHooks(['uninstall']));
  assert.equal(hooksStatus().claude.installed, false);
});
