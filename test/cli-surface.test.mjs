// Integration tests, invoked exactly as a user/script would: `node folder.mjs ...` as a real
// subprocess, with no TTY. Confirms `pm --list`/`--json`/`--help` are unchanged in shape, and
// exercises the new CLI bridge subcommands non-interactively.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freshHome, tmpDir, FOLDER_MJS } from './helpers.mjs';

const home = freshHome();

function run(args, { env: extraEnv = {}, ...opts } = {}) {
  // PM_NO_MAIN is set in *this* test process so its own dynamic imports of folder.mjs don't
  // launch the TUI — it must NOT leak into the child `node folder.mjs` invocation under test,
  // or main() never runs and every subcommand silently no-ops. Deleted last, after merging any
  // caller-supplied extra env vars, so it can never sneak back in.
  const env = { ...process.env, HOME: home, ...extraEnv };
  delete env.PM_NO_MAIN;
  return execFileSync(process.execPath, [FOLDER_MJS, ...args], { encoding: 'utf8', env, ...opts });
}

test('pm --help: prints without throwing, mentions the Foldview brand and AI terminals', () => {
  const out = run(['--help']);
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /foldview/i);
  assert.match(plain, /AI terminals/);
});

test('pm --list: prints a table without throwing, on a plain directory', () => {
  const root = tmpDir('foldview-list-');
  const out = run(['--list', root]);
  assert.match(out.replace(/\x1b\[[0-9;]*m/g, ''), /projects/);
});

test('pm --json: preserves the historical per-project field shape', () => {
  const root = tmpDir('foldview-json-');
  const proj = path.join(root, 'app');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'app', scripts: { dev: 'vite' } }));
  const rows = JSON.parse(run(['--json', root]));
  assert.ok(Array.isArray(rows));
  const row = rows.find(r => r.name === 'app');
  assert.ok(row);
  for (const key of ['name', 'path', 'loc', 'files', 'srcBytes', 'nodeModules', 'total',
    'branch', 'dirty', 'devName', 'devCmd', 'port', 'pkgName', 'mtime', 'langs']) {
    assert.ok(key in row, `missing historical field: ${key}`);
  }
});

test('pm roots add/list/remove: works without a TTY and persists across separate invocations', () => {
  const root = tmpDir('foldview-root-');
  run(['roots', 'add', root]);
  assert.ok(JSON.parse(run(['roots', 'list', '--json'])).includes(root));
  run(['roots', 'remove', root]);
  assert.ok(!JSON.parse(run(['roots', 'list', '--json'])).includes(root));
});

test('pm roots add: rejects a relative path and a nonexistent directory', () => {
  assert.throws(() => run(['roots', 'add', 'relative/path']));
  assert.throws(() => run(['roots', 'add', '/definitely/not/a/real/dir/xyz']));
});

test('pm action editor: runs without a TTY and reports success', () => {
  const proj = tmpDir('foldview-editor-proj-');
  const out = run(['action', 'editor', '--project', proj], { env: { EDITOR: '/bin/echo' } });
  assert.match(out, /opened in/);
});

test('pm action ai: rejects a non-absolute --cli and an out-of-range --count without launching anything', () => {
  const proj = tmpDir('foldview-ai-proj-');
  assert.throws(() => run(['action', 'ai', '--project', proj, '--cli', 'relative-name', '--count', '3']));
  assert.throws(() => run(['action', 'ai', '--project', proj, '--cli', '/bin/echo', '--count', '99']));
  assert.throws(() => run(['action', 'ai', '--project', proj, '--cli', '/bin/echo', '--count', '0']));
});

test('pm status --format menubar-json: works without a TTY and returns a schemaVersion-1 payload', () => {
  const root = tmpDir('foldview-status-');
  const payload = JSON.parse(run(['status', '--format', 'menubar-json'], { cwd: root }));
  assert.equal(payload.schemaVersion, 1);
});

test('pm status: rejects an unsupported --format', () => {
  assert.throws(() => run(['status', '--format', 'xml']));
});

test('pm menubar / --force-install: prints a stub describing what would be installed/launched', () => {
  assert.match(run(['menubar']), /menu-bar companion/);
  assert.match(run(['menubar', '--force-install']), /install|launch/);
});

test('status --format menubar-json: warm refresh comfortably meets the <500ms target for an ordinary root', (t) => {
  const root = tmpDir('foldview-perf-');
  const proj = path.join(root, 'app');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'app', scripts: { dev: 'vite' } }));
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(proj, `f${i}.js`), 'console.log(1);\n'.repeat(200));

  const t0 = Date.now();
  run(['status', '--format', 'menubar-json'], { cwd: root });
  const fastMs = Date.now() - t0;
  assert.ok(fastMs < 500, `fast path took ${fastMs}ms, expected comfortably under the 500ms target`);

  // measured separately, logged (not asserted): the fast path must never walk LOC/disk/git the way
  // --list/--json do, but with a tiny fixture and two fresh Node process starts, wall-clock alone
  // is too noisy to assert a strict inequality reliably.
  const t1 = Date.now();
  run(['--json', root]);
  const fullMs = Date.now() - t1;
  t.diagnostic(`fast path (status --format menubar-json): ${fastMs}ms — full scan (--json): ${fullMs}ms`);
});
