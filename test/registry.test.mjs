// Unit tests: managed runtime registry ownership validation — PID alive, command matches, cwd
// inside the project, port owned by that tree. Uses real short-lived subprocesses so the checks
// (ps/lsof-based) are exercised for real, not mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freshHome, tmpDir } from './helpers.mjs';

freshHome();
const { recordRuntimeEntry, findOwnedRegistryEntry, loadRuntimeRegistry } = await import('../folder.mjs');

function spawnSleeper(cwd) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 15000)'], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('findOwnedRegistryEntry: validates a real, alive, cwd-matching process as ours', async () => {
  const dir = tmpDir('foldview-proj-');
  const child = spawnSleeper(dir);
  await wait(250);
  try {
    recordRuntimeEntry({ project: dir, pid: child.pid, pgid: child.pid, port: null, startedAt: Date.now(),
      command: `${process.execPath} -e`, logFile: '', launcher: 'tui' });
    const entry = findOwnedRegistryEntry(loadRuntimeRegistry(), dir);
    assert.ok(entry, 'a real, matching, alive process validates as owned');
  } finally { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
});

test('findOwnedRegistryEntry: an exited process is stale — rejected and removed from the registry', async () => {
  const dir = tmpDir('foldview-proj-');
  const child = spawn(process.execPath, ['-e', '1'], { cwd: dir, detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise(resolve => child.on('exit', resolve));
  await wait(150);
  recordRuntimeEntry({ project: dir, pid: child.pid, pgid: child.pid, port: null, startedAt: Date.now(),
    command: `${process.execPath} -e`, logFile: '', launcher: 'tui' });
  const entry = findOwnedRegistryEntry(loadRuntimeRegistry(), dir);
  assert.equal(entry, null, 'an exited PID never validates as owned');
  const reg = loadRuntimeRegistry();
  assert.ok(!reg.entries.some(e => e.project === dir), 'the stale record is deleted');
});

test('findOwnedRegistryEntry: command mismatch (recorded command no longer matches the live process) is rejected', async () => {
  const dir = tmpDir('foldview-proj-');
  const child = spawnSleeper(dir);
  await wait(250);
  try {
    recordRuntimeEntry({ project: dir, pid: child.pid, pgid: child.pid, port: null, startedAt: Date.now(),
      command: 'this-command-does-not-appear-anywhere', logFile: '', launcher: 'tui' });
    const entry = findOwnedRegistryEntry(loadRuntimeRegistry(), dir);
    assert.equal(entry, null, 'a mismatched command (e.g. a different process now on this PID) is rejected');
  } finally { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
});

test('findOwnedRegistryEntry: cwd mismatch (process alive, but running outside the project) is rejected', async () => {
  const dir = tmpDir('foldview-proj-');
  const elsewhere = tmpDir('foldview-elsewhere-');
  const child = spawnSleeper(elsewhere);
  await wait(250);
  try {
    recordRuntimeEntry({ project: dir, pid: child.pid, pgid: child.pid, port: null, startedAt: Date.now(),
      command: `${process.execPath} -e`, logFile: '', launcher: 'tui' });
    const entry = findOwnedRegistryEntry(loadRuntimeRegistry(), dir);
    assert.equal(entry, null, "a process alive elsewhere is not this project's server");
  } finally { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
});

test('findOwnedRegistryEntry: a long-gone / implausible PID (simulating PID reuse) is rejected and removed', () => {
  const dir = tmpDir('foldview-proj-');
  recordRuntimeEntry({ project: dir, pid: 999999, pgid: 999999, port: null, startedAt: Date.now(),
    command: 'anything', logFile: '', launcher: 'tui' });
  const entry = findOwnedRegistryEntry(loadRuntimeRegistry(), dir);
  assert.equal(entry, null);
  assert.ok(!loadRuntimeRegistry().entries.some(e => e.project === dir));
});

test('findOwnedRegistryEntry: no registry record at all (an externally-started listener) is never "ours"', () => {
  const dir = tmpDir('foldview-proj-');
  assert.equal(findOwnedRegistryEntry(loadRuntimeRegistry(), dir), null);
});

test('findOwnedRegistryEntry: a symlinked ancestor (e.g. /tmp -> /private/tmp on macOS) still matches', async () => {
  // regression test for a realpath bug found while manually verifying this feature
  const dir = tmpDir('foldview-proj-');
  const child = spawnSleeper(dir);
  await wait(250);
  try {
    // record the entry using the *unresolved* path form, as a caller working from a raw user path would
    recordRuntimeEntry({ project: dir, pid: child.pid, pgid: child.pid, port: null, startedAt: Date.now(),
      command: `${process.execPath} -e`, logFile: '', launcher: 'tui' });
    const entry = findOwnedRegistryEntry(loadRuntimeRegistry(), dir);
    assert.ok(entry, 'symlink-resolved cwd still matches the recorded project path');
  } finally { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
});
