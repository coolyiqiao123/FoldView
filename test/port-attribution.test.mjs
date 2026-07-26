// Regression: a port owned by a known app (e.g. claude-mem on :37701) must never be attributed to
// a scanned project just because the app's worker happens to run with a cwd inside that project's
// folder. Before the fix, `foldview-cli` showed claude-mem's :37701 as its own live server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome } from './helpers.mjs';

const home = freshHome();                       // HOME → throwaway dir; PM_NO_MAIN set
const { buildProjectList, liveServerFor, state } = await import('../folder.mjs');

test('a known app port is not credited to a project whose folder contains the app worker cwd', () => {
  // claude-mem app on :37701, discovered via ~/.claude-mem/worker.pid
  const cmDir = path.join(home, '.claude-mem');
  fs.mkdirSync(cmDir, { recursive: true });
  fs.writeFileSync(path.join(cmDir, 'worker.pid'), JSON.stringify({ port: 37701 }));

  // a scanned project; simulate the claude-mem worker running with cwd INSIDE it
  const proj = path.join(home, 'foldview-cli');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'foldview-cli' }));

  buildProjectList(home);                       // (re)builds appIndex — claude-mem now a known app on :37701
  state.livePorts = new Map([[37701, proj]]);   // the bug scenario: :37701 owner cwd resolves inside the project

  // the project must NOT claim the app's port…
  assert.equal(liveServerFor(proj), null, 'project wrongly claimed the app port');
  // …while the app itself still reports its own live port.
  assert.equal(liveServerFor(cmDir), 37701, 'app lost its own live port');
});

test('a genuine project server (non-app port) is still attributed to the project', () => {
  const proj = path.join(home, 'realapp');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'realapp', scripts: { dev: 'vite' } }));
  buildProjectList(home);
  state.livePorts = new Map([[5173, proj]]);    // 5173 is not any app's port
  assert.equal(liveServerFor(proj), 5173, 'project lost its own dev-server port');
});
