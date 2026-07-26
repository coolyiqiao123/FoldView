// The lsof-sweep localhost detection: parseLsofListeners (pure transcript parsing), the widened
// readLogPort announcement patterns, and a live end-to-end run — a real net server on an uncommon
// (ephemeral) port must be found by scanPorts and attributed to its owning project directory,
// which the old fixed COMMON_PORTS probe list could never do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { freshHome, tmpDir } from './helpers.mjs';

const home = freshHome();                       // HOME → throwaway dir; PM_NO_MAIN set
const { parseLsofListeners, readLogPort, scanPorts, liveServerFor, mergeDiscovered, pathInside, state } =
  await import('../folder.mjs');

// ─────────────────────────── parseLsofListeners ───────────────────────────

test('parseLsofListeners: multi-process transcript — v4+v6 dup folds, wildcard kept, LAN bind dropped', () => {
  const transcript = [
    'p344',                    // macOS ControlCenter dual-binds AirPlay ports on the v4+v6 wildcards
    'cControlCenter',
    'n*:7000',
    'n*:5000',
    'p8120',                   // a node dev server bound to both loopbacks — one entry, first pid wins
    'cnode',
    'n127.0.0.1:3000',
    'n[::1]:3000',
    'n[::1]:8899',             // second port on the same pid — its own entry
    'p9001',
    'cpython3.12',
    'n0.0.0.0:8000',
    'n192.168.1.20:8001',      // LAN-only bind: not reachable via localhost → dropped
    'n[fe80::1%lo0]:8002',     // link-local w/ zone → dropped
  ].join('\n');
  const got = parseLsofListeners(transcript);
  assert.deepEqual(got.sort((a, b) => a.port - b.port), [
    { port: 3000, pid: 8120, comm: 'node' },
    { port: 5000, pid: 344, comm: 'ControlCenter' },
    { port: 7000, pid: 344, comm: 'ControlCenter' },
    { port: 8000, pid: 9001, comm: 'python3.12' },
    { port: 8899, pid: 8120, comm: 'node' },
  ]);
});

test('parseLsofListeners: same port on two different pids keeps the first pid (SO_REUSEPORT / forked workers)', () => {
  const got = parseLsofListeners('p100\ncnode\nn*:4000\np200\ncnode\nn*:4000\n');
  assert.deepEqual(got, [{ port: 4000, pid: 100, comm: 'node' }]);
});

test('parseLsofListeners: junk lines, unknown field tags, and empty input are all ignored safely', () => {
  assert.deepEqual(parseLsofListeners(''), []);
  assert.deepEqual(parseLsofListeners(null), []);
  const got = parseLsofListeners([
    'garbage that is not a field line',
    'f42',                     // fd field (not requested, but lsof variants can emit it)
    'p777',
    'cdeno',
    'n[::1]:9229',
    'nlocalhost:notaport',     // malformed name field
    'n*:0',                    // port 0 is never a real listener
  ].join('\n'));
  assert.deepEqual(got, [{ port: 9229, pid: 777, comm: 'deno' }]);
});

// ─────────────────────────────── readLogPort ──────────────────────────────

test('readLogPort: accepts 0.0.0.0 / [::] / arbitrary-host url announcements', () => {
  const dir = tmpDir();
  const cases = [
    ['ready - started server on 0.0.0.0:4321', 4321],
    ['Listening on [::]:8080', 8080],
    ['  ➜  Network: http://myhost.lan:9999/', 9999],
    ['serving at https://192.168.1.7:8443', 8443],
    ['dev server: http://[::1]:5173/', 5173],
    ['no port announced here', null],
  ];
  cases.forEach(([line, want], i) => {
    const f = path.join(dir, `log-${i}.txt`);
    fs.writeFileSync(f, line + '\n');
    assert.equal(readLogPort(f), want, `case: ${line}`);
  });
});

test('readLogPort: last match wins across mixed forms (auto-increment fallback)', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'log.txt');
  fs.writeFileSync(f, 'Port 3000 is in use, trying another one...\n' +
    '   ▲ Next.js dev server\n   - Local:   http://localhost:3001\n' +
    '   - Network: http://0.0.0.0:3001\n');
  assert.equal(readLogPort(f), 3001);
});

// ───────────────────────── discovered-entry filtering ─────────────────────

test('mergeDiscovered: privileged ports (<1024) are never surfaced as discovered apps', () => {
  const owner = path.join(home, 'someuserdir');
  fs.mkdirSync(owner, { recursive: true });
  state.projects = [];
  state.livePorts = new Map([[445, ''], [8899, owner]]);   // smb-ish system port vs a real user server
  mergeDiscovered();
  const discovered = state.projects.filter(p => p.app && p.app.discovered);
  assert.deepEqual(discovered.map(p => p.app.port), [8899], 'only the >=1024 port may be discovered');
  assert.equal(discovered[0].name, 'someuserdir', 'discovered entry is named after its owner cwd');
});

// ──────────────────────────── live e2e attribution ────────────────────────

test('scanPorts finds a real server on an uncommon port and liveServerFor attributes it to the owning dir',
  { skip: process.platform === 'win32' ? 'lsof sweep is not available on win32' : false },
  async () => {
    // the listening pid is this test process, so chdir into a throwaway "project" first — lsof
    // reports the symlink-resolved cwd (/var → /private/var on macOS), hence realpath everywhere.
    const proj = fs.realpathSync(tmpDir('foldview-proj-'));
    const prevCwd = process.cwd();
    process.chdir(proj);
    const srv = net.createServer();
    try {
      await new Promise((res, rej) => srv.listen(0, '127.0.0.1', res).on('error', rej));
      const port = srv.address().port;             // ephemeral — never in COMMON_PORTS, so the old probe missed it
      const live = await scanPorts();
      assert.ok(live.has(port), `sweep did not find the listener on :${port}`);
      assert.ok(pathInside(live.get(port), proj), `owner cwd ${live.get(port)} not inside ${proj}`);
      state.projects = [];
      state.livePorts = live;
      assert.equal(liveServerFor(proj), port, 'server not attributed to its owning directory');
    } finally {
      process.chdir(prevCwd);
      srv.close();
    }
  });
