// Shared test infrastructure. This file has no test() calls, so node --test just imports it
// (harmlessly contributing 0 tests) when it globs everything under test/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FOLDER_MJS = fileURLToPath(new URL('../folder.mjs', import.meta.url));

// folder.mjs derives CONFIG_PATH / RUNTIME_PATH from os.homedir() at module-load time, so HOME
// must be set to a throwaway directory *before* the module is first imported. node --test runs
// each matched file in its own process by default, so this never leaks across test files.
export function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foldview-home-'));
  process.env.HOME = home;
  process.env.PM_NO_MAIN = '1';
  return home;
}

export function tmpDir(prefix = 'foldview-t-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeBin(dir, name, script) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
  return p;
}

// Replace PATH entirely (not prepend) for the duration of a test, so discovery tests are
// deterministic regardless of what's actually installed on the machine running the suite.
// `command -v` is a shell builtin — it needs no external binaries beyond /bin/sh itself, which
// execSync always invokes by absolute path, so an isolated PATH containing only `dirs` is enough.
export function withPath(dirs) {
  const prev = process.env.PATH;
  process.env.PATH = dirs.join(path.delimiter);
  return () => { process.env.PATH = prev; };
}
