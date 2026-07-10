// Unit tests: POSIX single-quoting (shq) and AppleScript double-quoted string escaping (asq).
// Both are round-tripped through the real shell / osascript rather than re-implemented, so a
// regression in the escaping logic itself is what fails these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshHome } from './helpers.mjs';

freshHome();
const { shq, asq } = await import('../folder.mjs');

const CASES = [
  'simple',
  'has space',
  "it's got an apostrophe",
  'has "double quotes"',
  'back\\slash',
  'uni\u{1F680}code café',
  "mix 'quotes' and \"more\" and \\slashes\\",
  "/Users/e g/My Proj's \"folder\"",
];

test('shq: POSIX single-quoting round-trips through a real shell (/bin/sh -c)', () => {
  for (const s of CASES) {
    const r = spawnSync('/bin/sh', ['-c', `printf '%s' ${shq(s)}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, `shell exited non-zero for ${JSON.stringify(s)}: ${r.stderr}`);
    assert.equal(r.stdout, s, `shq(${JSON.stringify(s)}) did not round-trip`);
  }
});

test('asq: AppleScript double-quoted string literal round-trips through osascript', () => {
  for (const s of CASES) {
    const script = `return "${asq(s)}"`;
    const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, `osascript exited non-zero for ${JSON.stringify(s)}: ${r.stderr}`);
    assert.equal(r.stdout.replace(/\n$/, ''), s, `asq(${JSON.stringify(s)}) did not round-trip`);
  }
});

test('shq + asq composition: a full "cd <path> && <cli>" command survives both quoting layers', () => {
  for (const projectPath of ["/tmp/My Proj's \"folder\"", '/tmp/plain', '/tmp/uni\u{1F680}code']) {
    const cli = '/usr/bin/env';
    const cmd = `cd ${shq(projectPath)} && ${shq(cli)}`;
    const script = `return "${asq(cmd)}"`;
    const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.replace(/\n$/, ''), cmd, 'the exact command text survives AppleScript embedding');
  }
});
