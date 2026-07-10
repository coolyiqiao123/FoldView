#!/usr/bin/env node
// foldview 🚀 — a friendly terminal home for projects, local apps, and AI coding agents.
// Your projects and AI coding tools, ready in one terminal. Zero dependencies. Arrow-key
// navigation, lines of code, disk/package size, language breakdown, git status, live-localhost
// detection, and AI terminals — open 1-9 Terminal windows running a detected or custom coding CLI.
//
//   node folder.mjs [path]        launch the TUI (scans [path], default: cwd)
//   node folder.mjs --list [path] print a plain table and exit
//   node folder.mjs --json [path] print JSON and exit
//   node folder.mjs --help
//   node folder.mjs status --format menubar-json   fast JSON status for the menu-bar bridge
//   node folder.mjs roots list|add|remove <dir>     manage scanned project roots
//   node folder.mjs action open|start|stop|editor|ai --project <dir> [...]  run one action
//   node folder.mjs menubar [--force-install]       install/launch the menu-bar companion

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import readline from 'node:readline';
import { execSync, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLATFORM = process.platform;               // 'darwin' | 'linux' | 'win32' | …
// this tool's own location + package name, so it never lists itself (see isSelfProject)
const SELF_FILE = fileURLToPath(import.meta.url); // this script, re-spawned as `node folder.mjs serve …`
const SELF_DIR = path.dirname(SELF_FILE);
const STATIC_PORT_BASE = 8080;                   // first port `pm serve` tries for a static-site project

// ─────────────────────────── local apps ───────────────────────────────
// Local web apps that aren't folder-scanned projects but should appear in the list like one.
// Three sources, all merged by loadExtraApps():
//   • detectors  — built-in, PRESENCE-GATED: an entry appears only if that app is actually installed
//                  on this machine, so a fresh user never sees a phantom. Ports are read live, never hardcoded.
//   • user apps  — persisted in ~/.foldview.json → { "apps":[{name,url,port,path?}], "hidden":[port,…] };
//                  added / removed from inside the dashboard (A to add, x to remove).
//   • discovered — any live localhost server that isn't already one of the above and isn't a scanned
//                  project's own dev server (see mergeDiscovered). Ephemeral; press s to pin one.
// Liveness is matched by PORT (not the listening process's working dir), since a daemon can run anywhere.
const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.foldview.json');
const appIndex = new Map();   // pseudo-project path -> app config (rebuilt on every scan)

// presence-gated built-in detectors — each returns an app entry ONLY when its app is present here.
function detectApps() {
  const apps = [];
  const cmDir = path.join(HOME, '.claude-mem');                          // claude-mem: memory & observations UI
  if (fs.existsSync(cmDir)) {
    const port = Number(readJSON(path.join(cmDir, 'worker.pid'))?.port) || 37701;   // real port, from its own pidfile
    apps.push({ name: 'claude-mem', desc: 'memory & observations UI', url: `http://localhost:${port}`,
                port, path: cmDir, dbFile: path.join(cmDir, 'claude-mem.db'), builtin: true });
  }
  return apps;
}

// ─────────────────────────────── theme ────────────────────────────────
const rgb   = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const bg    = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;
const R = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m', ITAL = '\x1b[3m';

// baby-blue theme. (keys amber/orange/red kept as the 3 accent slots — light→deep
// blue — so the gradient + every c(C.amber,…) call works unchanged.)
const C = {
  amber:  [150, 211, 245],   // primary accent — baby blue
  orange: [104, 173, 230],   // secondary — sky blue
  red:    [70,  132, 205],   // tertiary / gradient end — deeper blue
  text:   [224, 232, 240],   // cool near-white
  dim:    [122, 138, 156],   // cool gray
  faint:  [80,  98,  118],   // cooler faint
  border: [52,  72,  94],    // blue-gray border
  green:  [88,  214, 158],   // live / launchable (teal-green, the one warm-ish signal)
  notRun: [228, 102, 102],   // not launchable — a true red (theme's "red" slot is actually blue)
  blue:   [130, 206, 236],   // links / dev command — light cyan
  selBg:  [22,  36,  54],    // dark navy selection background
  bar:    [150, 211, 245],   // bar fill — baby blue
  barBg:  [40,  56,  74],    // bar track
  brand:  [255, 176, 102],   // foldview brand accent — light orange (wordmark + 🚀)
};
const c  = (col, s) => rgb(...col) + s + R;
const GRAD = [C.amber, C.orange, C.red];
// The foldview wordmark gets its own light-orange ramp so ONLY the brand is orange — the
// generic gradient() (project-name headline, Launch border) stays on the cool GRAD.
const BRAND_GRAD = [[255, 198, 132], [255, 158, 74]];

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function lerpStops(stops, t) {
  if (t <= 0) return stops[0];
  if (t >= 1) return stops[stops.length - 1];
  const seg = t * (stops.length - 1), i = Math.floor(seg);
  return lerp(stops[i], stops[i + 1], seg - i);
}
function gradient(text, stops = GRAD) {
  const chars = [...text];               // iterate by code point (keeps emoji/surrogates intact)
  const n = chars.length; let out = '';
  for (let i = 0; i < n; i++) out += rgb(...lerpStops(stops, n <= 1 ? 0 : i / (n - 1))) + chars[i];
  return out + R;
}

// ─────────────────────────── string helpers ───────────────────────────
const ESC = /\x1b\[[0-9;]*m/g;
const stripAnsi = s => String(s).replace(ESC, '');
const visLen    = s => stripAnsi(s).length;
function trunc(s, w) {
  s = String(s);
  if (w <= 0) return '';
  return s.length <= w ? s : (w === 1 ? '…' : s.slice(0, w - 1) + '…');
}
function padTo(s, w) {
  const l = visLen(s);
  return l >= w ? s : s + ' '.repeat(w - l);
}
// clamp a line to a visible width, keeping ANSI intact — so a line can NEVER be wider than
// the terminal and trigger a wrap (a wrap pushes the whole frame up and scrolls the header off).
function fit(s, w) {
  if (w <= 0) return '';
  const str = String(s);
  if (visLen(str) <= w) return str;
  let out = '', vis = 0, i = 0;
  while (i < str.length && vis < w) {
    if (str[i] === '\x1b') {                       // copy a whole escape sequence (zero width)
      const m = str.slice(i).match(/^\x1b\[[0-9;?]*[a-zA-Z]/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = str.codePointAt(i);                 // copy one code point; emoji count as width 2
    const ch = String.fromCodePoint(cp);
    out += ch; i += ch.length; vis += cp > 0xFFFF ? 2 : 1;
  }
  return out + R;
}
const repeat = (ch, n) => ch.repeat(Math.max(0, n));

// ──────────────────────────── formatting ──────────────────────────────
function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'K', 'M', 'G', 'T']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + u[i];
}
const fmtN = n => (n == null ? '—' : n.toLocaleString('en-US'));
function fmtK(n) {
  if (n == null) return '·';
  if (n < 1000) return '' + n;
  if (n < 1e6)  return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}
function ago(ms) {
  if (!ms) return '—';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24; if (d < 30) return `${Math.floor(d)}d ago`;
  const mo = d / 30; if (mo < 12) return `${Math.floor(mo)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
const shq = p => `'` + String(p).replace(/'/g, `'\\''`) + `'`;
// escape a string for embedding inside a double-quoted AppleScript string literal
const asq = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
function sh(cmd, timeout = 4000) {
  try { return execSync(cmd, { timeout, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch { return ''; }
}

// ─────────────────────────── AI terminals ─────────────────────────────
// known AI coding CLIs, checked via `command -v` in Foldview's own environment (no network,
// no shell-history inspection). Table order also doubles as the deterministic collision order
// for single-key shortcut assignment.
const KNOWN_AI_CLIS = [
  { key: 'c', name: 'Claude', executable: 'claude' },
  { key: 'x', name: 'Codex', executable: 'codex' },
  { key: 'g', name: 'Gemini', executable: 'gemini' },
  { key: 'o', name: 'OpenCode', executable: 'opencode' },
  { key: 'i', name: 'Aider', executable: 'aider' },
];
// reject anything that isn't a plain executable name or absolute path: pipes, redirects,
// command separators, command substitutions, and newlines. Spaces are allowed — paths may
// legitimately contain them, and we never hand this string to a shell for word-splitting.
const FORBIDDEN_CLI_CHARS = /[|&;<>`$(){}\n\r]/;
function resolveExecutable(name) {                // `command -v <name>` in this process's own env
  if (!name) return null;
  try {
    const out = execSync(`command -v ${shq(name)}`, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch { return null; }
}
// pick the first unused single-key shortcut: prefer letters/digits from the display name,
// then fall back to any unused digit 1-9. null means "no free key" — stays in config, off the menu.
function assignFreeKey(name, used) {
  for (const ch of String(name || '').toLowerCase()) {
    if (/[a-z0-9]/.test(ch) && !used.has(ch)) return ch;
  }
  for (const ch of '123456789') if (!used.has(ch)) return ch;
  return null;
}
// discover known CLIs (resolved, in table order) + saved custom CLIs (resolved, in config order),
// deduplicated by resolved absolute path, each assigned a deterministic single-key shortcut.
function discoverAIClis() {
  const cfg = readConfig();
  const used = new Set();
  const seen = new Set();
  const out = [];
  for (const k of KNOWN_AI_CLIS) {
    const exe = resolveExecutable(k.executable);
    if (!exe || seen.has(exe)) continue;
    seen.add(exe);
    const key = !used.has(k.key) ? k.key : assignFreeKey(k.name, used);
    if (key) used.add(key);
    out.push({ name: k.name, executable: exe, key });
  }
  for (const entry of (Array.isArray(cfg.aiClis) ? cfg.aiClis : [])) {
    if (!entry || !entry.executable) continue;
    let exe = entry.executable;
    try {
      if (path.isAbsolute(exe)) fs.accessSync(exe, fs.constants.X_OK);
      else { const r = resolveExecutable(exe); if (!r) continue; exe = r; }
    } catch { continue; }
    if (seen.has(exe)) continue;
    seen.add(exe);
    const name = entry.name || path.basename(exe);
    const key = assignFreeKey(name, used);
    if (key) used.add(key);
    out.push({ name, executable: exe, key });
  }
  return out;
}
// validate + resolve a custom CLI text-prompt value. Never a shell expression: reject pipes,
// redirects, separators, substitutions, and empty input. Bare names resolve via `command -v`;
// absolute paths must exist and be executable.
function resolveCustomCli(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'value cannot be empty' };
  if (FORBIDDEN_CLI_CHARS.test(s)) return { ok: false, error: 'must be a plain executable name or absolute path, not a shell expression' };
  if (s.includes('/') && !path.isAbsolute(s)) return { ok: false, error: 'relative paths are not supported — use an absolute path' };
  if (path.isAbsolute(s)) {
    try {
      if (!fs.statSync(s).isFile()) return { ok: false, error: 'not a file' };
      fs.accessSync(s, fs.constants.X_OK);
      return { ok: true, executable: s, name: path.basename(s) };
    } catch { return { ok: false, error: 'path does not exist or is not executable' }; }
  }
  const resolved = resolveExecutable(s);
  if (!resolved) return { ok: false, error: `"${s}" was not found on PATH` };
  return { ok: true, executable: resolved, name: s };
}
// persist a validated custom CLI to ~/.foldview.json → aiClis, deduped by resolved absolute path.
function saveCustomCli(entry) {
  return updateConfig(cfg => {
    cfg.aiClis = Array.isArray(cfg.aiClis) ? cfg.aiClis : [];
    if (!cfg.aiClis.some(a => a && a.executable === entry.executable)) {
      cfg.aiClis.push({ name: entry.name, executable: entry.executable });
    }
  });
}
// grid layout for `n` (1-9) new Terminal windows within `screen` ({x,y,width,height}), pure and
// testable. Goal: tile the whole screen with no wasted space and no overlap. rows = floor(sqrt(n))
// (so 1→1 row, 2·3→1 row, 4..8→2 rows, 9→3 rows), the n windows are distributed as evenly as
// possible across those rows (earlier rows take any remainder), and EVERY row is stretched to fill
// the full width by dividing it among just that row's windows. This yields exactly what you'd draw
// by hand: 1 = full area, 2 = left/right halves, 3 = three columns, 4 = 2×2, 9 = 3×3 — always
// gap-separated and always inside the screen bounds.
function computeGrid(n, screen, gap = 12) {
  n = Math.max(1, Math.min(9, Math.round(n)));
  const { x, y, width, height } = screen;
  const rows = Math.max(1, Math.floor(Math.sqrt(n)));
  const base = Math.floor(n / rows), extra = n % rows;         // earlier rows get the +1
  const perRow = Array.from({ length: rows }, (_, r) => base + (r < extra ? 1 : 0));
  const cellH = Math.max(1, Math.floor((height - gap * (rows + 1)) / rows));
  const rects = [];
  for (let r = 0; r < rows; r++) {
    const cols = perRow[r];
    const cellW = Math.max(1, Math.floor((width - gap * (cols + 1)) / cols));
    const rowY = y + gap + r * (cellH + gap);
    for (let ci = 0; ci < cols; ci++) {
      rects.push({ x: x + gap + ci * (cellW + gap), y: rowY, width: cellW, height: cellH });
    }
  }
  return rects;
}
// usable bounds of the main display, via Finder (a quick, read-only synchronous lookup — never
// moves or creates windows). Falls back to a sane default if it can't be determined.
function getMainDisplayBounds() {
  try {
    const out = execSync(`osascript -e 'tell application "Finder" to get bounds of window of desktop'`,
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = out.match(/(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/);
    if (m) { const [, l, t, r, b] = m.map(Number); return { x: l, y: t, width: r - l, height: b - t }; }
  } catch {}
  return { x: 0, y: 0, width: 1440, height: 900 };
}
// build the ONE AppleScript source that creates `cmds.length` new Terminal windows, runs one
// command per window, records references to just those new windows, applies `rects` as bounds,
// then activates Terminal — never touching any pre-existing window.
function buildAITerminalsScript(cmds, rects) {
  const lines = ['tell application "Terminal"', '  set newWindows to {}'];
  for (const cmd of cmds) lines.push(`  set end of newWindows to do script "${asq(cmd)}"`);
  lines.push('  set winCount to count of newWindows');
  rects.forEach((r, i) => {
    const L = Math.round(r.x), T = Math.round(r.y), Rr = Math.round(r.x + r.width), B = Math.round(r.y + r.height);
    lines.push(`  if winCount >= ${i + 1} then set bounds of (item ${i + 1} of newWindows) to {${L}, ${T}, ${Rr}, ${B}}`);
  });
  lines.push('  activate');
  lines.push('end tell');
  return lines.join('\n');
}
// core launch: resolves + validates, spawns exactly one detached osascript, and resolves once the
// child settles (error or exit). Never throws; never runs a different executable than requested.
function spawnAITerminals(p, cliEntry, n) {
  return new Promise(resolve => {
    if (PLATFORM !== 'darwin') { resolve({ ok: false, message: 'AI terminals: macOS only for now' }); return; }
    if (!p || !p.path || !fs.existsSync(p.path) || !fs.statSync(p.path).isDirectory()) {
      resolve({ ok: false, message: 'no local directory for this entry' }); return;
    }
    const exe = cliEntry && cliEntry.executable;
    try { if (!exe) throw new Error('missing'); fs.accessSync(exe, fs.constants.X_OK); }
    catch { resolve({ ok: false, message: `AI terminals: could not resolve ${(cliEntry && cliEntry.name) || 'CLI'}` }); return; }

    const cmd = `cd ${shq(p.path)} && ${shq(exe)}`;
    const cmds = Array.from({ length: n }, () => cmd);
    const rects = computeGrid(n, getMainDisplayBounds());
    const script = buildAITerminalsScript(cmds, rects);
    const displayName = (cliEntry && cliEntry.name) || path.basename(exe);
    let child;
    try { child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'ignore'], detached: true }); }
    catch { resolve({ ok: false, message: 'could not open Terminal windows' }); return; }
    let settled = false;
    child.on('error', () => { if (!settled) { settled = true; resolve({ ok: false, message: 'could not open Terminal windows' }); } });
    child.on('exit', code => {
      if (settled) return; settled = true;
      resolve(code === 0 ? { ok: true, message: `opened ${n} × ${displayName}` } : { ok: false, message: 'could not open Terminal windows' });
    });
    child.unref();
  });
}

// ──────────────────────────── scanning ────────────────────────────────
const IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', '.nuxt', '.output',
  'target', 'vendor', '.venv', 'venv', '__pycache__', '.cache', 'coverage',
  '.turbo', '.svelte-kit', 'bin', 'obj', 'Pods', '.gradle', '.idea', '.vscode',
  'tmp', '.parcel-cache', '.pnpm-store', '.angular', '.expo', '.docusaurus',
]);
const MARKERS = [
  'package.json', '.git', 'Cargo.toml', 'go.mod', 'pyproject.toml',
  'requirements.txt', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
  'deno.json', 'pubspec.yaml', 'mix.exs', 'CMakeLists.txt', 'Makefile',
];
const LANG = {
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby',
  php: 'PHP', c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++', cs: 'C#',
  swift: 'Swift', scala: 'Scala', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  lua: 'Lua', dart: 'Dart', vue: 'Vue', svelte: 'Svelte', sql: 'SQL',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'Less',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', md: 'Markdown',
  ex: 'Elixir', exs: 'Elixir', r: 'R', pl: 'Perl', elm: 'Elm', clj: 'Clojure',
};
// generated / lock / minified files: counted toward size + file count, but not LOC
const SKIP_FILE = /(^package-lock\.json$|^pnpm-lock\.yaml$|^yarn\.lock$|^composer\.lock$|\.lock$|\.min\.(js|css)$|\.map$|\.d\.ts$|-lock\.json$)/i;
const isMarker = dir => MARKERS.some(m => fs.existsSync(path.join(dir, m)));
// skip the *running* instance so it never lists itself — but only the exact directory this
// script runs from. A separate Foldview checkout (e.g. the source repo you're developing) is a
// real project you may want to open/serve, so it must still appear.
function isSelfProject(dir) {
  return path.resolve(dir) === path.resolve(SELF_DIR);
}

function scanProjects(root, maxDepth = 3, cap = 250) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  if (isMarker(root) && !isSelfProject(root)) {   // root itself is a project
    found.push(makeProject(root));
  }
  while (queue.length && found.length < cap) {
    const { dir, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (isMarker(full)) {
        if (full !== root && !isSelfProject(full)) found.push(makeProject(full));   // don't descend into projects
      } else {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  // de-dup by path, sort by most-recently modified
  const seen = new Set();
  return found
    .filter(p => (seen.has(p.path) ? false : seen.add(p.path)))
    .sort((a, b) => b.mtime - a.mtime);
}
function makeProject(dir) {
  let mtime = 0; try { mtime = fs.statSync(dir).mtimeMs; } catch {}
  return { name: path.basename(dir), path: dir, mtime, stats: null };
}

// ───────────────── sub-features (drill-in) ──────────────────
// A project can expose two kinds of launchable sub-feature, surfaced when you press ↵/→ to
// "enter" it: (1) app routes — pages of its OWN web server (e.g. Next.js app/replay → the
// /replay backtest studio), launched by starting the parent's dev server and opening
// localhost:PORT/route; and (2) nested projects — subfolders that are themselves runnable
// (their own package.json/Cargo.toml/…, e.g. Arbiter/bot), which run on their own server.
const PAGE_EXT = new Set(['tsx', 'jsx', 'ts', 'js', 'mjs']);
const isDirSafe = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const routeSeg = name => !name.startsWith('.') && !name.startsWith('[') &&   // no dynamic [param] segments
  !(name.startsWith('(') && name.endsWith(')')) && name !== 'api' && !IGNORE.has(name);
const baseNoExt = f => f.slice(0, f.lastIndexOf('.'));
const hasPageFile = (dir, names) => {
  let entries; try { entries = fs.readdirSync(dir); } catch { return false; }
  return entries.some(f => { const i = f.lastIndexOf('.'); return i > 0 && names.has(f.slice(0, i)) && PAGE_EXT.has(f.slice(i + 1)); });
};
// Next.js App Router: a folder is a route iff it contains page.<ext>; route groups "(x)" and
// src/app are folded away; dynamic "[param]" and /api are skipped (not directly launchable).
function collectAppRoutes(appDir, base, out, depth, cap) {
  if (depth > 4 || out.length >= cap) return;
  let entries; try { entries = fs.readdirSync(appDir, { withFileTypes: true }); } catch { return; }
  if (hasPageFile(appDir, new Set(['page']))) out.push(base || '/');
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || IGNORE.has(e.name)) continue;
    const grouped = e.name.startsWith('(') && e.name.endsWith(')');          // route group: folded, no path segment
    if (!grouped && !routeSeg(e.name)) continue;                             // skip [dynamic] and /api
    collectAppRoutes(path.join(appDir, e.name), grouped ? base : `${base}/${e.name}`, out, depth + 1, cap);
  }
}
// Next.js Pages Router: every file <name>.<ext> is a route (index → the folder's path); recurse dirs.
function collectPagesRoutes(pagesDir, base, out, depth, cap) {
  if (depth > 4 || out.length >= cap) return;
  let entries; try { entries = fs.readdirSync(pagesDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (routeSeg(e.name)) collectPagesRoutes(path.join(pagesDir, e.name), `${base}/${e.name}`, out, depth + 1, cap); continue; }
    const i = e.name.lastIndexOf('.'); if (i <= 0) continue;
    const stem = e.name.slice(0, i), ext = e.name.slice(i + 1);
    if (!PAGE_EXT.has(ext) || stem.startsWith('_') || stem.startsWith('[')) continue;
    out.push(stem === 'index' ? (base || '/') : `${base}/${stem}`);
  }
}
// discover the runnable routes of a project's own web server (Next.js app/ or pages/ router).
function detectRoutes(dir, pkg, cap = 40) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  if (!Object.keys(deps).some(d => d === 'next')) return [];        // only Next.js filesystem routing, for now
  const out = [];
  const appDir = ['app', 'src/app'].map(a => path.join(dir, a)).find(isDirSafe);
  if (appDir) collectAppRoutes(appDir, '', out, 0, cap);
  const pagesDir = ['pages', 'src/pages'].map(a => path.join(dir, a)).find(isDirSafe);
  if (pagesDir) collectPagesRoutes(pagesDir, '', out, 0, cap);
  // de-dup, drop '/' if it's the only route (entering to launch just the home page adds nothing),
  // and sort with the home route first, then alphabetical.
  const routes = [...new Set(out)];
  if (routes.length <= 1) return [];
  return routes.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
}
// subfolders that are themselves runnable projects (own marker file), e.g. Arbiter/bot.
function detectNestedProjects(dir) {
  const abs = path.resolve(dir);
  return scanProjects(dir, 3).filter(p => path.resolve(p.path) !== abs);
}
// build the sub-feature entries shown after you "enter" a project. `st` is the parent's stats
// (for its dev port). Route entries are launched via the parent's own dev server; nested-project
// entries are ordinary project objects that reuse every launch/stat/drill-in path recursively.
function subFeaturesOf(project, pkg, st) {
  const parent = { name: project.name, path: project.path };
  const routes = detectRoutes(project.path, pkg).map(route => ({
    name: route,
    path: project.path + '::route::' + route,     // synthetic identity key (never touched as a real path)
    isFeature: true, kind: 'route', route, parent,
    mtime: project.mtime,
    stats: { isFeature: true, kind: 'route', route, port: (st && st.port) || null,
             devName: (st && st.devName) || null, url: null,
             desc: `${project.name} route` },
  }));
  const nested = detectNestedProjects(project.path);
  return [...routes, ...nested];
}

// ───────────────────────── app config (~/.foldview.json) ──────────────
// schemaVersion 1 (frozen): { schemaVersion, roots, recentProjects, menubar:{refreshSeconds,
// showDiscoveredApps}, apps, hidden, aiClis }. ensureConfigDefaults never drops unknown fields —
// it only fills in what's missing, so every writer's read-merge-write preserves the rest.
function ensureConfigDefaults(cfg) {
  if (cfg.schemaVersion == null) cfg.schemaVersion = 1;
  if (!Array.isArray(cfg.roots)) cfg.roots = [];
  if (!Array.isArray(cfg.recentProjects)) cfg.recentProjects = [];
  if (!cfg.menubar || typeof cfg.menubar !== 'object') cfg.menubar = {};
  if (cfg.menubar.refreshSeconds == null) cfg.menubar.refreshSeconds = 60;
  if (cfg.menubar.showDiscoveredApps == null) cfg.menubar.showDiscoveredApps = true;
  if (!Array.isArray(cfg.apps)) cfg.apps = [];
  if (!Array.isArray(cfg.hidden)) cfg.hidden = [];
  if (!Array.isArray(cfg.aiClis)) cfg.aiClis = [];
  return cfg;
}
function readConfig() { return ensureConfigDefaults(readJSON(CONFIG_PATH) || {}); }
// atomic write: tmp file + rename, so a reader never observes a partial/invalid file.
function writeConfig(cfg) {
  try {
    ensureConfigDefaults(cfg);
    const tmp = CONFIG_PATH + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    fs.renameSync(tmp, CONFIG_PATH);
    return true;
  } catch { return false; }
}
// read-merge-write in one step: mutate a freshly-read config, then write it back atomically.
// Callers should only touch the fields they own, so unrelated concurrent settings survive.
function updateConfig(mutator) {
  const cfg = readConfig();
  mutator(cfg);
  return writeConfig(cfg);
}
// detectors + user-configured apps, de-duplicated by port|url (detectors win).
function loadExtraApps() {
  const detected = detectApps();
  const cfg = readConfig();
  const user = (Array.isArray(cfg.apps) ? cfg.apps : []).map(a => ({ ...a, user: true }));
  const seen = new Set();
  return [...detected, ...user].filter(a => {
    if (!a || !a.name || !(a.url || a.port)) return false;
    const k = String(a.port || a.url);
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
function addUserApp(app) {                       // persist a pinned app (idempotent by port|url)
  const cfg = readConfig();
  const k = String(app.port || app.url);
  cfg.apps = (Array.isArray(cfg.apps) ? cfg.apps : []).filter(a => String(a.port || a.url) !== k);
  cfg.apps.push(app);
  return writeConfig(cfg);
}
function removeUserApp(app) {                    // drop a pinned app
  const cfg = readConfig();
  if (!Array.isArray(cfg.apps)) return false;
  const k = String(app.port || app.url), before = cfg.apps.length;
  cfg.apps = cfg.apps.filter(a => String(a.port || a.url) !== k);
  return writeConfig(cfg) && cfg.apps.length < before;
}
function hideDiscovered(port) {                  // stop auto-surfacing this discovered port
  const cfg = readConfig();
  cfg.hidden = Array.isArray(cfg.hidden) ? cfg.hidden : [];
  if (!cfg.hidden.includes(port)) cfg.hidden.push(port);
  return writeConfig(cfg);
}

// ────────────────── managed runtime registry (dev servers Foldview starts) ─────────────────
// Records ONLY servers Foldview itself started (tui/menubar launchers), so `Stop` / `managed:true`
// can be offered across process lifetimes without ever touching a server Foldview didn't start.
const RUNTIME_DIR = path.join(HOME, 'Library', 'Application Support', 'Foldview');
const RUNTIME_PATH = path.join(RUNTIME_DIR, 'runtime-v1.json');
function loadRuntimeRegistry() {
  const data = readJSON(RUNTIME_PATH);
  return { entries: Array.isArray(data?.entries) ? data.entries : [] };
}
function writeRuntimeRegistry(reg) {                // atomic: tmp file + rename
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const tmp = RUNTIME_PATH + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
    fs.renameSync(tmp, RUNTIME_PATH);
    return true;
  } catch { return false; }
}
// entry: { project, pid, pgid, port, startedAt, command, logFile, launcher: 'tui'|'menubar' }
function recordRuntimeEntry(entry) {
  const reg = loadRuntimeRegistry();
  reg.entries = reg.entries.filter(e => path.resolve(e.project) !== path.resolve(entry.project));
  reg.entries.push(entry);
  return writeRuntimeRegistry(reg);
}
function removeRuntimeEntry(projectPath) {
  const reg = loadRuntimeRegistry();
  const before = reg.entries.length;
  reg.entries = reg.entries.filter(e => path.resolve(e.project) !== path.resolve(projectPath));
  writeRuntimeRegistry(reg);
  return reg.entries.length < before;
}
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
// loose match against exited/reused-PID risk: the recorded command's tokens must all appear in
// the live process's command line (guards against a *different* process now sitting on that PID).
function pidCommandMatches(pid, expectedCommand) {
  if (PLATFORM === 'win32') return true;
  const comm = sh(`ps -o command= -p ${pid} 2>/dev/null`).trim();
  if (!comm || !expectedCommand) return false;
  return expectedCommand.split(/\s+/).filter(Boolean).every(tok => comm.includes(tok));
}
function pidCwd(pid) {
  if (PLATFORM === 'win32') return '';
  const m = sh(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`).match(/^n(.*)$/m);
  return m ? m[1] : '';
}
// resolve symlinked ancestors (e.g. macOS /tmp -> /private/tmp) before comparing paths, so a
// legitimately-owned process isn't misclassified as external just because lsof/ps report the
// symlink-resolved form. Falls back to a plain path.resolve if the path no longer exists.
function realpathSafe(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
// PID alive + command matches + cwd is the project (or a child) + port (if any) owned by that
// tree. Any failure ⇒ not ours: caller must delete the stale record and leave the process alone.
function validateOwnership(entry) {
  if (!entry || !entry.pid) return false;
  if (!isPidAlive(entry.pid)) return false;
  if (!pidCommandMatches(entry.pid, entry.command)) return false;
  const cwd = pidCwd(entry.pid);
  if (!cwd) return false;                             // inconclusive ⇒ not validated as ours
  const projectReal = realpathSafe(entry.project), cwdReal = realpathSafe(cwd);
  if (cwdReal !== projectReal && !pathInside(cwdReal, projectReal)) return false;
  if (entry.port) {
    const owner = portCwd(entry.port);
    if (owner) {
      const ownerReal = realpathSafe(owner);
      if (ownerReal !== projectReal && !pathInside(ownerReal, projectReal)) return false;
    }
  }
  return true;
}
// look up + validate the registry entry for a project; deletes it first if validation fails
// (stale record / PID reuse / external listener), so it's never reported as managed again.
function findOwnedRegistryEntry(registry, projectPath) {
  const abs = path.resolve(projectPath);
  const entry = registry.entries.find(e => path.resolve(e.project) === abs);
  if (!entry) return null;
  if (validateOwnership(entry)) return entry;
  removeRuntimeEntry(entry.project);
  return null;
}

// parse "add app" input: "name @ 3000", "name @ http://host:port", or a bare port / url.
function parseAppInput(strIn) {
  const s = String(strIn || '').trim();
  if (!s) return null;
  let name, target;
  const at = s.indexOf('@');
  if (at >= 0) { name = s.slice(0, at).trim(); target = s.slice(at + 1).trim(); }
  else target = s;
  let url, port;
  if (/^\d{2,5}$/.test(target)) { port = Number(target); url = `http://localhost:${port}`; }
  else {
    url = /^https?:\/\//.test(target) ? target : `http://${target}`;
    const m = url.match(/:(\d{2,5})(?:\/|$)/); if (m) port = Number(m[1]);
  }
  if (!name) name = port ? `localhost:${port}` : url.replace(/^https?:\/\//, '');
  return { name, url, port: port || null };
}
function makeApp(app) {
  const dir = app.path && fs.existsSync(app.path) ? app.path : null;
  const key = dir || `app:${app.port || app.url || app.name}`; // list + cache key, unique per app
  let mtime = 0; if (dir) { try { mtime = fs.statSync(dir).mtimeMs; } catch {} }
  return { name: app.name, path: key, mtime, stats: null, app };
}
// the full dashboard list: pinned apps first, then scanned projects. (a scanned project sitting at
// an app's own path is dropped so it can't appear twice.) also (re)builds appIndex, which
// liveServerFor/scanPorts use to match an app by its PORT rather than a listening process's cwd.
function buildProjectList(root) {
  appIndex.clear();
  const apps = loadExtraApps().map(makeApp);
  for (const a of apps) appIndex.set(a.path, a.app);
  const appPaths = new Set(apps.map(a => a.path));
  const scanned = scanProjects(root).filter(p => !appPaths.has(p.path));
  return [...apps, ...scanned];
}
function appStats(p) {                                          // stats row for a pinned app (no LOC/git)
  const a = p.app;
  const dir = a.path && fs.existsSync(a.path) ? a.path : null;
  let dbBytes = null;
  if (a.dbFile) { try { dbBytes = fs.statSync(a.dbFile).size; } catch {} }
  return {
    isApp: true,
    url:  a.url || (a.port ? `http://localhost:${a.port}` : ''),
    desc: a.desc || '',
    dbBytes,
    total: dir ? duBytes(dir) : null,
    files: 0, srcBytes: 0, loc: 0, langs: [], nodeModules: 0,
    branch: '', dirty: 0, devName: null, devCmd: null,
    port: a.port || null, pkgName: null, mtime: p.mtime,
  };
}

// ───────────────────────── per-project stats ──────────────────────────
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function walkSource(root) {
  let files = 0, bytes = 0, scanned = 0;
  const lines = {};                    // ext -> line count
  const stack = [root];
  while (stack.length && scanned < 30000) {
    const dir = stack.pop();
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) stack.push(path.join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      scanned++;
      const full = path.join(dir, e.name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      files++; bytes += st.size;
      const ext = (e.name.split('.').pop() || '').toLowerCase();
      if (!LANG[ext] || st.size > 2 * 1024 * 1024 || SKIP_FILE.test(e.name)) continue;
      try {
        const txt = fs.readFileSync(full, 'utf8');
        let n = 0; for (let i = 0; i < txt.length; i++) if (txt.charCodeAt(i) === 10) n++;
        if (txt.length && txt[txt.length - 1] !== '\n') n++;
        lines[ext] = (lines[ext] || 0) + n;
      } catch {}
    }
  }
  // aggregate by language
  const byLang = {};
  for (const [ext, n] of Object.entries(lines)) byLang[LANG[ext]] = (byLang[LANG[ext]] || 0) + n;
  const total = Object.values(byLang).reduce((a, b) => a + b, 0);
  const langs = Object.entries(byLang)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name, lines: n, pct: total ? n / total : 0 }));
  return { files, srcBytes: bytes, loc: total, langs };
}

function dirSizeJS(root, cap = 200000) {        // recursive byte sum — fallback when `du` is unavailable (Windows)
  let bytes = 0, n = 0;
  const stack = [root];
  while (stack.length && n < cap) {
    const dir = stack.pop();
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      n++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      try { bytes += fs.statSync(full).size; } catch {}
    }
  }
  return bytes;
}
function duBytes(p) {
  if (PLATFORM !== 'win32') {                   // fast path: du(1) on macOS/linux/bsd
    const kb = parseInt(sh(`du -sk ${shq(p)} 2>/dev/null`, 6000), 10);
    if (Number.isFinite(kb)) return kb * 1024;
  }
  try { return dirSizeJS(p); } catch { return null; }   // Windows / du missing
}

function frameworkPort(pkg, devScript) {
  const m = (devScript || '').match(/(?:--port\s+|--port=|-p\s+|PORT=)(\d{2,5})/i);
  if (m) return parseInt(m[1], 10);
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const has = k => Object.keys(deps).some(d => d.includes(k));
  if (has('next') || has('nuxt') || has('remix') || has('docusaurus')) return 3000;
  if (has('vite') || has('sveltekit') || has('vitepress')) return 5173;
  if (has('astro')) return 4321;
  if (has('@angular')) return 4200;
  if (has('@vue/cli-service')) return 8080;
  if (has('gatsby')) return 8000;
  if (has('expo')) return 8081;
  if (has('react-scripts')) return 3000;
  return null;
}

// A static-site project has browsable HTML but no build/dev server we can run (e.g. a plain
// landing page, or Foldview's own site/index.html). Foldview serves it itself via `pm serve`
// (a zero-dependency Node static server), so ↵ still opens a real localhost. Only treated as
// static when there's NO real framework dev server to prefer — a Next.js/Vite/CRA app keeps
// running its own dev server as before. Returns the absolute dir to serve, or null.
const SITE_DIRS = ['site', 'public', 'dist', 'www', 'docs', '.'];
function staticSiteDir(dir, pkg, scripts) {
  scripts = scripts || pkg?.scripts || {};
  const hasRealServer =
    frameworkPort(pkg, scripts.dev || scripts.serve || scripts.preview || scripts.develop) != null ||
    ['dev', 'serve', 'preview', 'develop'].some(s => scripts[s]);
  if (hasRealServer) return null;
  for (const sub of SITE_DIRS) {
    const cand = sub === '.' ? dir : path.join(dir, sub);
    try { if (fs.statSync(path.join(cand, 'index.html')).isFile()) return cand; } catch {}
  }
  return null;
}

function computeStats(p) {
  if (p.isFeature) return p.stats;                 // route entries carry their own inline stats
  if (p.app) return appStats(p);
  const src = walkSource(p.path);
  const nm = path.join(p.path, 'node_modules');
  const nodeModules = fs.existsSync(nm) ? duBytes(nm) : 0;
  const total = duBytes(p.path);

  const pkg = readJSON(path.join(p.path, 'package.json'));
  const scripts = pkg?.scripts || {};
  const siteDir = staticSiteDir(p.path, pkg, scripts);   // static site we serve ourselves (no dev server)
  // A static site's `start`/`test` scripts aren't web servers, so don't present them as a launch
  // command — the site dir is the launch target instead.
  const devName = siteDir ? null : (['dev', 'start', 'serve', 'preview', 'develop'].find(s => scripts[s]) || null);
  const devCmd  = devName ? `npm run ${devName}` : null;

  let branch = '', dirty = 0;
  if (fs.existsSync(path.join(p.path, '.git'))) {
    branch = sh(`git -C ${shq(p.path)} rev-parse --abbrev-ref HEAD`, 1500).trim();
    dirty  = sh(`git -C ${shq(p.path)} status --porcelain`, 2000).trim().split('\n').filter(Boolean).length;
  }
  const st = {
    ...src,
    nodeModules,
    total,
    branch, dirty,
    devName, devCmd, siteDir,
    port: siteDir ? null : frameworkPort(pkg, scripts[devName]),
    pkgName: pkg?.name || null,
    mtime: p.mtime,
  };
  st.features = subFeaturesOf(p, pkg, st);         // routes + nested projects for drill-in (↵/→)
  return st;
}

// ───────────────────────────── port scan ──────────────────────────────
const COMMON_PORTS = [3000, 3001, 3002, 3003, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 1313, 9000, 3333, 4000, 5555];
// OS/background daemons that happen to bind common ports (e.g. macOS Control Center/AirPlay on :5000,
// :7000) — never surfaced as "discovered apps", so a fresh install shows real apps, not system noise.
const SYSTEM_PROCS = new Set(['ControlCenter', 'ControlCe', 'rapportd', 'sharingd', 'AirPlayXPCHelper',
  'identityservicesd', 'remoted', 'launchd', 'mDNSResponder', 'rapport']);
function checkPort(port) {
  return new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.setTimeout(350, () => { s.destroy(); res(false); });
  });
}
// map a live port to the working directory of the process listening on it, so a running
// server can be attributed to the project that actually owns it (not just "port 3000 is busy").
// returns '' when the owner can't be determined (Windows, or lsof unavailable).
function portCwd(port) {
  if (PLATFORM === 'win32') return '';
  const pid = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, 1500).trim().split('\n')[0];
  if (!pid) return '';
  const m = sh(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, 1500).match(/^n(.*)$/m);
  return m ? m[1] : '';
}
async function scanPorts() {
  const live = new Map();                          // port -> owner cwd ('' if unknown)
  const appPorts = [...appIndex.values()].map(a => a.port).filter(Boolean);   // include known-app ports
  const ports = [...new Set([...COMMON_PORTS, ...appPorts])];
  await Promise.all(ports.map(async p => { if (await checkPort(p)) live.set(p, portCwd(p)); }));
  return live;
}
function portComm(port) {                          // command name of the process listening on `port` ('' if unknown)
  if (PLATFORM === 'win32') return '';
  const pid = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, 1200).trim().split('\n')[0];
  if (!pid) return '';
  return sh(`ps -o comm= -p ${pid} 2>/dev/null`, 1200).trim().split('/').pop();
}
// surface any live localhost server that isn't already a known app and isn't a scanned project's own
// dev server — as its own "discovered" entry you can open (↵), pin (s), or hide (x). ephemeral: rebuilt
// each scan from state.livePorts, so it always reflects what's actually running right now.
function mergeDiscovered() {
  const cfg = readConfig();
  const hidden = new Set((cfg.hidden || []).map(Number));
  const known  = new Set([...appIndex.values()].map(a => a.port).filter(Boolean));
  const projPaths = state.projects.filter(p => !p.app).map(p => p.path);
  for (const [port, owner] of state.livePorts) {
    if (known.has(port) || hidden.has(port)) continue;
    if (projPaths.some(pp => pathInside(owner, pp))) continue;           // it's a scanned project's server → shown there
    const comm = portComm(port);
    if (comm && SYSTEM_PROCS.has(comm)) continue;                        // OS/background daemon, not a real app
    const named = owner && path.resolve(owner) !== path.resolve(HOME) ? path.basename(owner) : '';
    const name  = named || comm || `localhost:${port}`;
    const app = { name, desc: `discovered · live on :${port}`, url: `http://localhost:${port}`, port, discovered: true };
    const entry = makeApp(app);
    appIndex.set(entry.path, app);
    state.projects.push(entry);
    try { state.cache.set(entry.path, computeStats(entry)); } catch {}
  }
  applyFilter();
  sortProjects();
}

// is `childCwd` the same directory as, or nested inside, `parentDir`? (the trailing separator
// stops a sibling like "fantasy gov-old" from matching "fantasy gov".)
function pathInside(childCwd, parentDir) {
  if (!childCwd) return false;
  const a = path.resolve(parentDir), b = path.resolve(childCwd);
  return b === a || b.startsWith(a + path.sep);
}
// the port a project is actually serving on, matched by the listening process's working
// directory — independent of the guessed framework port. null if this project isn't running.
// this is what stops "launch project A" from opening project B just because they share a
// default port (every Next.js app guesses :3000, every Vite app :5173, …).
function liveServerFor(projPath) {
  const app = appIndex.get(projPath);              // pinned app — matched by PORT, not owner cwd
  if (app) return state.livePorts.has(app.port) ? app.port : null;
  const srv = state.servers.get(projPath);         // a server pm itself started for this project
  if (srv && srv.status === 'live') return srv.port;
  for (const [port, owner] of state.livePorts)     // an external server whose cwd is this project
    if (pathInside(owner, projPath)) return port;
  return null;
}
// the real port a dev server bound to, parsed from its own log output — handles frameworks that
// auto-increment when the guessed port is taken (e.g. Next.js falling back 3000 → 3001).
function readLogPort(logFile) {
  try {
    const m = [...fs.readFileSync(logFile, 'utf8').matchAll(/(?:localhost|127\.0\.0\.1):(\d{2,5})/gi)];
    if (m.length) return parseInt(m[m.length - 1][1], 10);   // last reported = final bound port
  } catch {}
  return null;
}

// ═══════════════════════════ non-TUI modes ════════════════════════════
function printList(root, asJson) {
  const projects = buildProjectList(root);
  process.stderr.write(`scanning ${projects.length} projects in ${root}…\n`);
  const rows = projects.map(p => ({ name: p.name, path: p.path, ...computeStats(p) }));
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }

  console.log('\n' + gradient('  foldview') + c(C.orange, ' 🚀') + c(C.dim, `  ${rows.length} projects · ${root}\n`));
  const head = `  ${'PROJECT'.padEnd(26)}${'LOC'.padStart(9)}${'SOURCE'.padStart(10)}${'NODE_MOD'.padStart(11)}${'TOTAL'.padStart(10)}  TOP LANG`;
  console.log(c(C.dim, head));
  console.log(c(C.border, '  ' + repeat('─', head.length)));
  for (const r of rows) {
    const lang = r.langs[0] ? `${r.langs[0].name} ${Math.round(r.langs[0].pct * 100)}%` : '';
    const git = r.branch ? c(C.faint, `  ${r.branch}${r.dirty ? ' ✱' + r.dirty : ''}`) : '';
    console.log(
      '  ' + c(C.text, trunc(r.name, 25).padEnd(26)) +
      c(C.amber, fmtK(r.loc).padStart(9)) +
      c(C.dim, fmtBytes(r.srcBytes).padStart(10)) +
      c(C.faint, fmtBytes(r.nodeModules).padStart(11)) +
      c(C.text, fmtBytes(r.total).padStart(10)) +
      '  ' + c(C.orange, lang) + git
    );
  }
  const totLoc = rows.reduce((a, r) => a + (r.loc || 0), 0);
  const totDisk = rows.reduce((a, r) => a + (r.total || 0), 0);
  console.log(c(C.border, '  ' + repeat('─', head.length)));
  console.log('  ' + c(C.dim, 'TOTAL'.padEnd(26)) + c(C.amber, fmtK(totLoc).padStart(9)) +
    ''.padStart(21) + c(C.text, fmtBytes(totDisk).padStart(10)) + '\n');
}

function printHelp() {
  console.log(`
${gradient('foldview')}${c(C.orange, ' 🚀')} — ${c(C.dim, 'Your projects and AI coding tools, ready in one terminal.')}
  A local-first terminal home for projects, local apps, and AI coding agents.

${c(C.dim, 'USAGE')}
  pm [path]                launch the interactive dashboard (default path: cwd)
  pm --list [path]         print a plain stats table and exit
  pm --json [path]         print stats as JSON and exit
  pm serve <dir> [port]    serve a static site dir on localhost (zero-dependency)
  pm --help                (command aliases: folderpreview, project-manager, foldview)

${c(C.dim, 'KEYS (in the dashboard)')}
  ↑ ↓          move
  ↵            🚦 launch — open the website (starts the dev server, or serves a static site, no exit)
  d  start dev (background)   x  stop / remove app   D  dev (foreground)   o  localhost
  e  editor    a  AI terminals    A  add app    /  find    r  rescan    ?  help    q  quit

  a opens AI terminals: pick a detected coding CLI (or + for a custom one), then how many
  windows (1-9) — each opens in the project directory, tiled so none of them overlap.

${c(C.dim, 'LOCAL APPS')}
  claude-mem (if installed) and any live localhost server appear alongside your projects; ↵ opens them.
  A adds one (name @ port, saved to ~/.foldview.json) · s pins a discovered app · x removes / hides it.

${c(C.dim, 'ADVANCED (menu-bar bridge — for scripts and the optional companion app)')}
  pm status --format menubar-json                  fast JSON status, no LOC/disk/git walks
  pm roots list [--json] | add <dir> | remove <dir> manage scanned project roots
  pm aiclis list [--json] | add <name|abs-path> | remove <name|abs-path>  manage custom AI CLIs
  pm action open|start|stop|editor --project <dir> [--open]
  pm action ai --project <dir> --cli <abs-executable> --count <1-9>
  pm menubar [--force-install]                      install/launch the menu-bar companion
`);
}

// ════════════════════════════ TUI state ═══════════════════════════════
const state = {
  mode: 'list',          // 'list' | 'help'
  root: process.cwd(),
  projects: [],
  view: [],              // filtered project list
  sel: 0, scroll: 0,
  search: '', searching: false,
  // AI-terminals prompt: null | { project, phase:'select-cli'|'custom-cli'|'select-count',
  // choices, cli, input } — see discoverAIClis()/onKey()/footer().
  ai: null,
  adding: false, addBuf: '',   // "add app" text input (A) → persists to ~/.foldview.json
  cache: new Map(),      // path -> stats
  pending: new Set(),    // paths whose stats are being computed (prevents re-entrant render)
  livePorts: new Map(),  // port -> owner cwd (the project dir the listening server runs from)
  spinner: 0, busy: false,
  status: '', statusUntil: 0,
  queue: [],
  servers: new Map(),    // project path -> { port, status:'starting'|'live'|'dead', logFile, pid }
  // drill-in navigation: `trail` is the breadcrumb of projects you've entered (root = empty);
  // `stack` holds a saved {projects,view,sel,scroll,search} snapshot per level so ← restores it.
  trail: [], stack: [],
};
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function out(s) { process.stdout.write(s); }
function setStatus(msg, ms = 2500) { state.status = msg; state.statusUntil = Date.now() + ms; }
function dims() {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}
function applyFilter() {
  const q = state.search.toLowerCase();
  state.view = q ? state.projects.filter(p => p.name.toLowerCase().includes(q)) : state.projects.slice();
  state.sel = Math.min(state.sel, Math.max(0, state.view.length - 1));
}
// list order: green ● live on top, then green ○ launchable-stopped, then red ● not-launchable;
// alphabetical (case-insensitive) within each group. re-runs whenever live state changes.
// keeps the current project selected by path so the list doesn't jump under you.
function sortProjects() {
  if (state.trail.length) return;                // inside a project: keep the sub-feature order stable
  const selPath = (state.view[state.sel] || {}).path;
  const rank = p => {
    const st = state.cache.get(p.path);
    if (liveServerFor(p.path) != null)                 return 0;   // green ● — live (owned by this project)
    if (st && (st.devName || st.port))                 return 1;   // green ○ — launchable, stopped
    return 2;                                                      // red ● — not launchable
  };
  state.projects.sort((a, b) =>
    rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  applyFilter();
  if (selPath) { const i = state.view.findIndex(p => p.path === selPath); if (i >= 0) state.sel = i; }
}
function statsFor(p) {
  if (p && p.stats) return p.stats;                // route entries carry inline stats (no fs work)
  if (state.cache.has(p.path)) return state.cache.get(p.path);
  return null;
}
function ensureStats(p, immediate = false) {
  // never render() synchronously here: ensureStats is called *from inside* detailPane()
  // during a render, so a synchronous render would recurse forever. Schedule the compute
  // off-stack and let the setTimeout callback trigger the single follow-up render.
  if (!p || state.cache.has(p.path) || state.pending.has(p.path)) return;
  if (!immediate) return;
  state.pending.add(p.path);
  setTimeout(() => {
    try { state.cache.set(p.path, computeStats(p)); } catch { state.cache.set(p.path, {}); }
    state.pending.delete(p.path);
    render();
  }, 0);
}
function pumpQueue() {
  if (!state.queue.length) return;
  const p = state.queue.shift();
  if (p && !state.cache.has(p.path)) {
    try { state.cache.set(p.path, computeStats(p)); } catch { state.cache.set(p.path, {}); }
    render();
  }
  if (state.queue.length) setTimeout(pumpQueue, 60);
  else { state.busy = false; sortProjects(); render(); }   // all stats in → re-sort (live on top, alphabetical)
}

// ──────────────────────────── rendering ───────────────────────────────
function buildTop(title, L, Rr) {
  const left = ('─ ' + title + ' ').slice(0, L + 2);
  return c(C.border, '┌') + gradient(padEnd2(left, L + 2, '─')) +
         c(C.border, '┬' + repeat('─', Rr + 2) + '┐');
}
function padEnd2(s, w, ch) { const l = visLen(s); return l >= w ? s : s + repeat(ch, w - l); }
function bottom(L, Rr) { return c(C.border, '└' + repeat('─', L + 2) + '┴' + repeat('─', Rr + 2) + '┘'); }
function rowLine(left, right, L, Rr) {
  return c(C.border, '│') + ' ' + padTo(left, L) + ' ' + c(C.border, '│') + ' ' + padTo(right, Rr) + ' ' + c(C.border, '│');
}
function launchMenu(cols) {                     // the Launch menu — pinned to the top, always shown
  const chip = bg(...C.selBg) + BOLD + rgb(...C.amber) + ' 🚦 Launch ' + R;
  const left = '  ' + chip;
  const hint = c(C.faint, '↵ launch — opens the site, starts the dev server if needed  ');
  return padTo(left, Math.max(0, cols - visLen(hint))) + hint;
}

function render() {
  if (state.mode === 'help') return renderHelp();
  const { cols, rows } = dims();
  if (cols < 64 || rows < 16) {
    out('\x1b[H\x1b[2J' + c(C.dim, 'terminal too small — resize to at least 64×16\n'));
    return;
  }
  const L = Math.max(22, Math.floor((cols - 7) * 0.42));
  const Rr = cols - 7 - L;
  const innerH = rows - 5;   // logo + launch menu + top + bottom + footer

  const left = listPane(L, innerH);
  const right = detailPane(Rr, innerH);

  const inSub = state.trail.length > 0;
  const title = inSub ? trunc(state.trail[state.trail.length - 1].name, 20) : 'Projects';

  const lines = [];
  // logo line — a breadcrumb (foldview › Arbiter › …) once you've entered a project
  const count = `${state.view.length} ${inSub ? 'features' : 'projects'}`;
  const livePorts = state.livePorts.size ? c(C.green, `● ${[...state.livePorts.keys()].slice(0, 6).join(' ')}`) : c(C.faint, 'no live servers');
  const here = inSub ? state.trail[state.trail.length - 1].path : state.root;
  const rootLabel = c(C.dim, trunc(here.replace(os.homedir(), '~'), 30));
  const brand = inSub
    ? gradient('foldview') + state.trail.map(t => c(C.faint, ' › ') + c(C.amber, trunc(t.name, 18))).join('')
    : `${gradient('foldview')}${c(C.orange, ' 🚀')}`;
  const head = `  ${brand}  ${c(C.faint, '·')}  ${c(C.dim, count)}   ${rootLabel}`;
  const headRight = `${livePorts}  `;
  lines.push(padTo(head, cols - visLen(headRight)) + headRight);
  lines.push(launchMenu(cols));   // always pinned to the top

  lines.push(buildTop(title, L, Rr));
  for (let i = 0; i < innerH; i++) lines.push(rowLine(left[i] || '', right[i] || '', L, Rr));
  lines.push(bottom(L, Rr));
  lines.push(footer(cols));

  out('\x1b[H' + lines.map(l => fit(l, cols) + '\x1b[K').join('\n') + '\x1b[J');
}

function keyhints(keys) {
  return keys.map(([k, v]) => c(C.amber, k) + ' ' + c(C.faint, v)).join(c(C.border, '  ·  '));
}
// footer for the AI-terminals prompt — same visual language as search/add-app. select-cli
// truncates the discovered CLI list to terminal width without wrapping, always keeping
// "+ custom" and "esc cancel" when there's room for them.
function footerAi(a, cols) {
  if (a.phase === 'custom-cli') {
    return ' ' + c(C.amber, `Custom AI CLI executable: ${a.input}▏`) + '   ' +
      keyhints([['↵', 'save'], ['esc', 'cancel']]);
  }
  if (a.phase === 'select-count') {
    return ' ' + c(C.amber, `${a.cli.name} — how many windows?`) + '   ' +
      keyhints([['1-9', 'count'], ['esc', 'cancel']]);
  }
  const prefix = ' ' + c(C.amber, `AI terminals → ${trunc(a.project.name, 20)}`) + '   ';
  const budget = cols - 1 - visLen(prefix);
  const tail = [['+', 'custom'], ['esc', 'cancel']];
  // build against keyhints' own separator width directly, rather than assuming its value —
  // the choice list is tiny, so re-measuring the real joined string on each step is cheap.
  const mid = [];
  for (const ch of a.choices) {
    if (!ch.key) continue;                       // no free shortcut → stays in config, off the menu
    const candidate = [...mid, [ch.key, ch.name.toLowerCase()]];
    if (visLen(keyhints([...candidate, ...tail])) > budget) break;
    mid.push([ch.key, ch.name.toLowerCase()]);
  }
  return prefix + keyhints([...mid, ...tail]);
}
// footer for the GitHub-push prompt (p) — confirm → working → done/error, same visual language.
function footerGh(g, cols) {
  const name = trunc(g.plan.name, 24);
  if (g.phase === 'working') {
    return ' ' + c(C.amber, `Pushing ${name}… `) + c(C.faint, trunc(g.log, 44)) + ' ' + c(C.orange, SPIN[state.spinner % SPIN.length]);
  }
  if (g.phase === 'done') {
    return ' ' + c(C.green, `✓ pushed → ${trunc(g.url || '', Math.max(12, cols - 34))}`) + '   ' + keyhints([['o', 'open'], ['↵/esc', 'dismiss']]);
  }
  if (g.phase === 'error') {
    return ' ' + c(C.notRun, `✗ ${trunc(g.log, Math.max(12, cols - 26))}`) + '   ' + keyhints([['↵/esc', 'dismiss']]);
  }
  const target = g.plan.mode === 'create'
    ? c(C.text, `github.com/${g.owner}/${g.plan.name}`) + ' ' + c(C.faint, '(public, new)')
    : c(C.text, trunc(webUrlFromRemote(g.plan.remoteUrl).replace(/^https?:\/\//, ''), 34)) + ' ' + c(C.faint, '(update)');
  return ' ' + c(C.amber, 'Push → ') + target + '   ' + c(C.faint, g.plan.steps.join(' · ')) + '   ' +
    keyhints([['↵', 'push'], ['esc', 'cancel']]);
}
function footer(cols) {
  if (state.status && Date.now() < state.statusUntil) return ' ' + c(C.amber, state.status);
  if (state.searching) {
    return ' ' + c(C.amber, 'find: ' + state.search + '▏') + '   ' +
      keyhints([['↑↓', 'move'], ['↵', 'launch'], ['esc', 'cancel']]);
  }
  if (state.ai) return footerAi(state.ai, cols);
  if (state.gh) return footerGh(state.gh, cols);
  if (state.adding) {
    return ' ' + c(C.amber, 'add app: ' + state.addBuf + '▏') + '   ' +
      keyhints([['↵', 'save'], ['esc', 'cancel']]) + c(C.faint, '   e.g.  grafana @ 3001');
  }
  // greedily include hints in priority order until we run out of width — so it never wraps
  const all = [['↑↓', 'move'], ['↵', 'launch'], ['→', 'enter'], ['←', 'back'], ['d', 'start'], ['x', 'stop'],
               ['a', 'AI'], ['p', 'push'], ['A', 'add app'], ['/', 'find'], ['?', 'help'], ['q', 'quit'], ['o', 'open'], ['e', 'editor']];
  const parts = []; let used = 1;                  // leading space
  for (const [k, v] of all) {
    const segVis = visLen(k) + 1 + v.length;
    const sepVis = parts.length ? 3 : 0;           // ' · '
    if (used + sepVis + segVis > cols - 1) break;
    parts.push(c(C.amber, k) + ' ' + c(C.faint, v));
    used += sepVis + segVis;
  }
  return ' ' + parts.join(c(C.border, ' · '));
}

function listPane(L, H) {
  const out = [];
  // keep selection visible
  if (state.sel < state.scroll) state.scroll = state.sel;
  if (state.sel >= state.scroll + H) state.scroll = state.sel - H + 1;
  const rightW = 7;
  const nameW = L - rightW - 4;            // marker(1) dot(1) space(1) … space(1) right(rightW)
  for (let i = 0; i < H; i++) {
    const idx = state.scroll + i;
    if (idx >= state.view.length) { out.push(''); continue; }
    const p = state.view[idx];
    const st = statsFor(p);
    const sel = idx === state.sel;
    const spin = SPIN[state.spinner % SPIN.length];
    const spath = serverPathOf(p);           // a route is served by its parent's server
    const livePort = liveServerFor(spath);   // the port THIS entry actually serves on (null if stopped)
    const live = livePort != null;
    let rstr, rcol;
    {                                        // Launch → show dev port + live status
      const srv = state.servers.get(spath);
      if (srv && srv.status === 'starting') { rstr = `${srv.port} ${spin}`; rcol = C.amber; }
      else if (live) { rstr = `${livePort} ●`; rcol = C.green; }
      else if (st && st.port) { rstr = `${st.port} ○`; rcol = C.faint; }
      else { rstr = st ? '—' : (state.cache.has(p.path) ? '·' : spin); rcol = C.faint; }
    }
    rstr = rstr.padStart(rightW);
    const marker = hasFeatures(p) ? ' ›' : '';    // this project can be entered (has sub-features)
    const name = trunc(p.name, nameW - marker.length);
    const pad = repeat(' ', Math.max(0, nameW - visLen(name) - marker.length));
    const launchable = !!(st && (st.devName || st.port || st.isFeature));
    let dot, dotCol;
    if (!st)             { dot = ' '; dotCol = C.faint; }     // stats not computed yet
    else if (live)       { dot = '●'; dotCol = C.green; }     // launchable + running
    else if (launchable) { dot = '○'; dotCol = C.green; }     // launchable, stopped
    else                 { dot = '●'; dotCol = C.notRun; }    // not launchable → red
    if (sel) {
      out.push(rgb(...C.amber) + '▌' + bg(...C.selBg) + rgb(...dotCol) + dot + ' ' +
        BOLD + rgb(...C.amber) + name + rgb(...C.dim) + marker + pad + ' ' + rgb(...rcol) + rstr + R);
    } else {
      out.push(' ' + c(dotCol, dot) + ' ' + c(C.text, name) + c(C.faint, marker) + pad + ' ' + c(rcol, rstr));
    }
  }
  return out;
}

function bar(pct, width, col = C.bar) {
  const fill = Math.round(pct * width);
  return rgb(...col) + repeat('█', fill) + rgb(...C.barBg) + repeat('░', width - fill) + R;
}

function detailPane(W, H) {
  const lines = [];
  const p = state.view[state.sel];
  if (!p) return [c(C.faint, 'no project selected')];
  const st = statsFor(p);
  const push = s => lines.push(s);
  const kv = (k, v, col = C.text) => `  ${c(C.dim, (k + ':').padEnd(15))}${c(col, v)}`;

  push(BOLD + gradient(trunc(p.name, W - 2)) + R);
  const subtitle = p.isFeature ? `${(p.parent || {}).name || ''}  ·  route` : p.path;
  push(c(C.faint, trunc(subtitle.replace(os.homedir(), '~'), W)));
  push(c(C.border, repeat('─', W)));
  if (!st) {
    push('');
    push('  ' + c(C.orange, SPIN[state.spinner % SPIN.length]) + c(C.dim, ' analyzing…'));
    ensureStats(p, true);
    return lines;
  }
  if (st.isFeature) {                        // a route of the parent project's own web server
    const parent = p.parent || {};
    const livePort = liveServerFor(parent.path);
    const port = livePort != null ? livePort : (st.port || '?');
    push('');
    if (livePort != null) push('  ' + c(C.green, `● localhost:${port}${p.route}`) + c(C.green, '   live') + c(C.faint, ' — ↵ opens'));
    else                  push('  ' + c(C.amber, `→ localhost:${port}${p.route}`) + c(C.faint, '   ↵ starts the app & opens this route'));
    push('');
    push(kv('Route', p.route, C.blue));
    push(kv('Served by', parent.name || '—'));
    push(kv('Dev server', st.devName ? `npm run ${st.devName}` : '—'));
    push('');
    push('  ' + c(C.faint, '↵ launch this route · ') + c(C.amber, '←') + c(C.faint, ' back'));
    return lines;
  }
  if (st.isApp) {                            // app entry — its own compact panel (no LOC/langs)
    const a = p.app || {};
    const live = liveServerFor(p.path) != null;
    const kind = a.discovered ? 'discovered' : a.builtin ? 'auto-detected' : 'pinned';
    push('');
    if (live) push('  ' + c(C.green, `● ${st.url}`) + c(C.green, '   live') + c(C.faint, ' — ↵ opens'));
    else       push('  ' + c(C.amber, `→ ${st.url}`) + c(C.faint, "   ↵ opens · start the app if it's down"));
    push('');
    if (st.desc) push(kv('What', st.desc));
    push(kv('Type', kind));
    push(kv('URL', st.url, C.blue));
    if (st.port) push(kv('Port', String(st.port) + (live ? c(C.green, '  ● live') : c(C.faint, '  ○ stopped'))));
    if (st.dbBytes != null) push(kv('Memory DB', fmtBytes(st.dbBytes), C.amber));
    if (st.total != null)   push(kv('Data on disk', fmtBytes(st.total)));
    if (p.mtime)            push(kv('Modified', ago(p.mtime)));
    push('');
    if (a.discovered)   push('  ' + c(C.faint, '↵ open · ') + c(C.amber, 's') + c(C.faint, ' pin to ~/.foldview.json · ') + c(C.amber, 'x') + c(C.faint, ' hide'));
    else if (a.builtin) push('  ' + c(C.faint, '↵ open · auto-detected, shows only while installed'));
    else                push('  ' + c(C.faint, '↵ open · ') + c(C.amber, 'x') + c(C.faint, ' remove from ~/.foldview.json'));
    return lines;
  }
  {                                          // headline the launch target (the project's website)
    const srv = state.servers.get(p.path);
    const livePort = liveServerFor(p.path);
    push('');
    if (srv && srv.status === 'starting')
      push('  ' + c(C.amber, SPIN[state.spinner % SPIN.length] + ` starting on :${srv.port}…`) + c(C.faint, '   opens when ready'));
    else if (livePort != null)
      push('  ' + c(C.green, `● localhost:${livePort}`) + c(C.green, '   live') + c(C.faint, ' — ↵ opens · x stops'));
    else if (st.siteDir)
      push('  ' + c(C.amber, `→ static · ${path.basename(st.siteDir)}/`) + c(C.faint, '   press enter to serve on localhost'));
    else if (st.port || st.devCmd)
      push('  ' + c(C.amber, '→ ' + (st.port ? `localhost:${st.port}` : st.devCmd)) + c(C.faint, '   press enter to launch'));
    else
      push('  ' + c(C.faint, '— no web server detected —'));
  }
  if (st.features && st.features.length) {   // drill-in affordance
    const nR = st.features.filter(f => f.isFeature).length, nP = st.features.length - nR;
    const bits = [];
    if (nR) bits.push(`${nR} route${nR > 1 ? 's' : ''}`);
    if (nP) bits.push(`${nP} nested project${nP > 1 ? 's' : ''}`);
    push('  ' + c(C.blue, `→ ${bits.join(' · ')}`) + c(C.faint, '   ↵ or → to enter · ') + c(C.amber, 'l') + c(C.faint, ' launches this'));
  }
  push('');
  push(kv('Lines of code', fmtN(st.loc), C.amber));
  push(kv('Files', fmtN(st.files)));
  push(kv('Source size', fmtBytes(st.srcBytes)));
  push(kv('node_modules', fmtBytes(st.nodeModules), C.faint));
  push(kv('Total on disk', fmtBytes(st.total)));
  if (st.branch) push(kv('Git', `${st.branch}${st.dirty ? c(C.orange, `  ✱${st.dirty} dirty`) : c(C.green, '  ✓ clean')}`));
  push(kv('Modified', ago(p.mtime)));
  push('');
  if (st.langs && st.langs.length) {
    push('  ' + c(C.dim, 'LANGUAGES'));
    const barW = Math.min(16, W - 26);
    for (const lg of st.langs.slice(0, Math.min(6, H - 14))) {
      push('  ' + c(C.text, trunc(lg.name, 11).padEnd(12)) + bar(lg.pct, barW) +
        c(C.dim, ('  ' + Math.round(lg.pct * 100) + '%').padStart(5)));
    }
    push('');
  }
  if (st.devCmd) {
    push('  ' + c(C.dim, 'DEV'));
    push(kv('command', st.devCmd, C.blue));
    if (st.port) {
      const lp = liveServerFor(p.path);
      push(kv('localhost', lp != null ? c(C.green, `:${lp}  ● live`) : `:${st.port}` + c(C.faint, '  ○ stopped')));
    }
  } else if (st.siteDir) {
    push('  ' + c(C.dim, 'STATIC SITE'));
    push(kv('serve', (path.relative(p.path, st.siteDir) || '.') + '/', C.blue));
    const lp = liveServerFor(p.path);
    push(kv('localhost', lp != null ? c(C.green, `:${lp}  ● live`) : c(C.faint, '○ stopped — ↵ to serve')));
  }
  return lines;
}

function renderHelp() {
  out('\x1b[H\x1b[2J');
  const L = [
    '', '  ' + gradient('foldview') + c(C.orange, ' 🚀') + c(C.dim, '  — a terminal home for projects, local apps, and AI coding agents'), '',
    c(C.dim, '  🚦 LAUNCH') + c(C.faint, '   the menu is pinned to the top of the dashboard'),
    '   ' + c(C.amber, '↵') + c(C.faint, '   opens the project in the browser (starts the dev server in the background if needed)'), '',
    c(C.dim, '  NAVIGATION'),
    '   ' + c(C.amber, '↑ ↓  j k') + c(C.faint, '   move up / down'),
    '   ' + c(C.amber, '→') + c(C.faint, '          enter a project — browse & launch its sub-features (routes like /replay, nested projects)'),
    '   ' + c(C.amber, '↵') + c(C.faint, '          enter if the project has sub-features, otherwise launch it'),
    '   ' + c(C.amber, '←  h  esc') + c(C.faint, '  go back up a level (esc at the top-level list quits)'),
    '   ' + c(C.amber, 'l') + c(C.faint, '          launch the selected entry directly (never enters)'),
    '   ' + c(C.amber, 'g  G') + c(C.faint, '       jump to top / bottom'), '',
    c(C.dim, '  ACTIONS'),
    '   ' + c(C.amber, '↵') + c(C.faint, '          launch — starts the dev server in the background, then opens the browser (pm stays open)'),
    '   ' + c(C.amber, 'd') + c(C.faint, '          start the dev server in the background (no browser; pm stays open)'),
    '   ' + c(C.amber, 'x') + c(C.faint, '          stop a dev server that pm started'),
    '   ' + c(C.amber, 'D') + c(C.faint, '          run the dev server in the foreground (quits pm, shows logs)'),
    '   ' + c(C.amber, 'o') + c(C.faint, '          open localhost in the browser without starting a server'),
    '   ' + c(C.amber, 'e') + c(C.faint, '          open the project / file in your editor'),
    '   ' + c(C.amber, 'a') + c(C.faint, '          AI terminals — open 1-9 Terminal windows running a detected or custom coding CLI'),
    '   ' + c(C.amber, 'p') + c(C.faint, '          push to GitHub — publish a new public repo (or push updates) via the gh CLI'),
    '   ' + c(C.amber, 'A') + c(C.faint, '          add a local app to the list (name @ port) — saved to ~/.foldview.json'),
    '   ' + c(C.amber, 's  x') + c(C.faint, '       on an app row: s pins a discovered app · x removes a pinned app / hides a discovered one'),
    '   ' + c(C.amber, 'c') + c(C.faint, '          copy the project path to the clipboard'),
    '   ' + c(C.amber, '/') + c(C.faint, '          search / filter projects by name'),
    '   ' + c(C.amber, 'r') + c(C.faint, '          rescan projects and ports'), '',
    '  ' + c(C.green, '●') + c(C.faint, ' = launchable + live   ') + c(C.green, '○') + c(C.faint, ' = launchable (stopped)   ') + c(C.notRun, '●') + c(C.faint, ' = not launchable'),
    '  ' + c(C.dim, 'apps') + c(C.faint, ' — detected (e.g. claude-mem, only if installed) · discovered (any live localhost server) · pinned (~/.foldview.json); ↵ opens them'), '',
    '  ' + c(C.amber, 'press any key to go back'),
  ];
  out(L.join('\n') + '\n');
}

// ───────────────────────────── actions ────────────────────────────────
function openUrl(url) {                          // platform-native "open in default app"
  const [cmd, args] =
    PLATFORM === 'darwin' ? ['open', [url]] :
    PLATFORM === 'win32'  ? ['cmd', ['/c', 'start', '', url]] :
                            ['xdg-open', [url]];   // linux / bsd
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch {}
}
function openEditor(p) {
  const ed = process.env.EDITOR || 'code';
  try { spawn(ed, [p], { stdio: 'ignore', detached: true }).unref(); setStatus(`opened in ${ed}`); }
  catch { setStatus('could not launch editor'); }
}
function copyPath(p) {                           // try platform clipboard tools in order
  const tools =
    PLATFORM === 'darwin' ? ['pbcopy'] :
    PLATFORM === 'win32'  ? ['clip'] :
                            ['wl-copy', 'xclip -selection clipboard', 'xsel --clipboard --input'];
  for (const t of tools) {
    try { execSync(t, { input: p, stdio: ['pipe', 'ignore', 'ignore'] }); setStatus('path copied'); return; }
    catch {}
  }
  setStatus('copy failed — no clipboard tool found');
}

// ─────────────────────────── GitHub push (p) ──────────────────────────
// Push the selected project to GitHub using the `gh` CLI. gh owns all auth (token in its own
// keyring) — Foldview never reads, stores, or transmits credentials. A fresh project is
// `git init`'d, given a safe .gitignore if it has none, committed, and published as a new public
// repo under the authenticated account; a project that already has an `origin` just gets pushed.
// Every mutation is spelled out in the confirm prompt before ↵.
const DEFAULT_GITIGNORE = [
  '# Added by Foldview before the first commit — trim to taste.',
  'node_modules/', '.env', '.env.*', '.DS_Store',
  'dist/', 'build/', '.next/', 'out/', 'coverage/',
  '*.log', '.venv/', '__pycache__/', 'target/', '',
].join('\n');

// run a command with no shell (args are passed literally — safe for paths with spaces/metachars);
// never throws — resolves { code, stdout, stderr } so callers branch on the exit code.
function run(file, args, opts = {}) {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout: opts.timeout || 120000, cwd: opts.cwd },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}
const firstLine = s => String(s || '').trim().split('\n').filter(Boolean)[0] || '';
function webUrlFromRemote(url) {                 // git@github.com:o/r.git | https://github.com/o/r.git → https URL
  const m = String(url || '').match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}` : String(url || '');
}
function sanitizeRepoName(s) {                   // fold a folder name into a valid GitHub repo name
  const out = String(s).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return out || 'project';
}
function repoNameFor(p) { return sanitizeRepoName(path.basename(p.path)); }

let _ghLogin;                                    // cache the authenticated account (one gh call per run)
function ghLogin() {
  if (_ghLogin !== undefined) return _ghLogin;
  _ghLogin = sh('gh api user --jq .login', 6000).trim() || null;
  return _ghLogin;
}
let _ghEmail;                                    // GitHub noreply email, so commits work even with no global git identity
function ghNoreplyEmail() {
  if (_ghEmail !== undefined) return _ghEmail;
  const login = ghLogin();
  if (!login) { _ghEmail = null; return null; }
  const id = sh('gh api user --jq .id', 6000).trim();
  _ghEmail = id ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
  return _ghEmail;
}

// pure-ish inspection of local git state → the exact plan we'll execute (no network, no mutation).
function planPush(p, owner) {
  const dir = p.path;
  const isRepo = fs.existsSync(path.join(dir, '.git'));
  let hasCommits = false, dirty = 0, branch = '', remoteUrl = '';
  if (isRepo) {
    hasCommits = !!sh(`git -C ${shq(dir)} rev-parse --verify HEAD`, 2000).trim();
    dirty = sh(`git -C ${shq(dir)} status --porcelain`, 3000).trim().split('\n').filter(Boolean).length;
    branch = sh(`git -C ${shq(dir)} rev-parse --abbrev-ref HEAD`, 1500).trim();
    remoteUrl = sh(`git -C ${shq(dir)} remote get-url origin`, 1500).trim();
  }
  if (!branch || branch === 'HEAD') branch = 'main';
  const name = repoNameFor(p);
  const mode = remoteUrl ? 'push' : 'create';
  const needsCommit = !hasCommits || dirty > 0;
  const needsGitignore = needsCommit && !fs.existsSync(path.join(dir, '.gitignore'));
  const steps = [];
  if (!isRepo) steps.push('git init');
  if (needsGitignore) steps.push('add .gitignore');
  if (needsCommit) steps.push(hasCommits ? `commit ${dirty} change${dirty === 1 ? '' : 's'}` : 'initial commit');
  steps.push(mode === 'create' ? 'create public repo' : 'push to origin');
  return { name, owner, isRepo, hasCommits, dirty, branch, remoteUrl, mode, needsCommit, needsGitignore, steps };
}

function openPushPrompt(p) {                     // p key → gate on gh, then open the confirm overlay
  if (!resolveExecutable('gh')) { setStatus('GitHub push needs the gh CLI — install: brew install gh'); return; }
  const owner = ghLogin();
  if (!owner) { setStatus('GitHub push needs auth — run: gh auth login'); return; }
  state.gh = { project: p, plan: planPush(p, owner), owner, phase: 'confirm', log: '', url: null };
}

// fire-and-forget executor (like launchAITerminals): drives state.gh through working→done/error,
// re-rendering on each step. Never rejects to the TUI — failures land in the error phase.
function startPush() {
  const g = state.gh; if (!g) return;
  g.phase = 'working'; g.log = 'starting…'; render();
  runPush(g.project, g.plan)
    .then(url => { if (state.gh !== g) return; g.phase = 'done'; g.url = url; g.log = `pushed → ${url}`; state.cache.delete(g.project.path); render(); })
    .catch(err => { if (state.gh !== g) return; g.phase = 'error'; g.log = firstLine(err && err.message) || 'push failed'; render(); });
}
async function runPush(project, plan) {
  const cwd = project.path;
  const setLog = m => { if (state.gh) { state.gh.log = m; render(); } };
  if (!plan.isRepo) {
    setLog('git init…');
    if ((await run('git', ['init'], { cwd })).code) throw new Error('git init failed');
  }
  if (plan.needsCommit && plan.needsGitignore) {
    try { fs.writeFileSync(path.join(cwd, '.gitignore'), DEFAULT_GITIGNORE); } catch {}
  }
  if (plan.needsCommit) {
    setLog('committing…');
    await run('git', ['add', '-A'], { cwd });
    const email = ghNoreplyEmail() || 'foldview@users.noreply.github.com';
    const msg = plan.hasCommits ? 'Update via Foldview' : 'Initial commit';
    const r = await run('git', ['-c', `user.name=${plan.owner}`, '-c', `user.email=${email}`, 'commit', '-m', msg], { cwd });
    if (r.code && !/nothing to commit/i.test(r.stdout + r.stderr)) throw new Error(firstLine(r.stderr || r.stdout) || 'commit failed');
  }
  const branch = plan.hasCommits ? plan.branch : 'main';
  if (!plan.hasCommits) await run('git', ['branch', '-M', branch], { cwd });
  if (plan.mode === 'create') {
    setLog('creating GitHub repo…');
    const repo = `${plan.owner}/${plan.name}`;
    const r = await run('gh', ['repo', 'create', repo, '--source', '.', '--public', '--push', '--remote', 'origin'], { cwd, timeout: 180000 });
    if (r.code) throw new Error(firstLine(r.stderr || r.stdout) || 'gh repo create failed');
    return `https://github.com/${repo}`;
  }
  setLog('pushing…');
  const r = await run('git', ['push', '-u', 'origin', branch], { cwd, timeout: 180000 });
  if (r.code) throw new Error(firstLine(r.stderr || r.stdout) || 'git push failed');
  return webUrlFromRemote(plan.remoteUrl);
}

// TUI entrypoint — fire-and-forget (never awaited, never crashes the TUI); updates the status
// line once the single detached osascript settles. See spawnAITerminals for the actual launch.
function launchAITerminals(p, cliEntry, n) {
  spawnAITerminals(p, cliEntry, n)
    .then(r => { setStatus(r.message); render(); })
    .catch(() => { setStatus('could not open Terminal windows'); render(); });
}
function openLocalhost() {
  const p = state.view[state.sel]; if (!p) return;
  const port = liveServerFor(serverPathOf(p));   // this entry's server (a route uses its parent's)
  if (port == null) { setStatus('no live server for this — press ↵ or d to start one'); return; }
  const route = p.isFeature ? (p.route || '') : '';
  openUrl(`http://localhost:${port}${route}`);
  setStatus(`opening http://localhost:${port}${route}`);
}
function openWebsite(p) {                       // 🚦 Launch ↵ — open the site WITHOUT exiting
  if (p.app) {                                 // pinned app — just open its URL (external daemon, not npm)
    const url = p.app.url || `http://localhost:${p.app.port}`;
    checkPort(p.app.port).then(live => {
      if (live) {
        if (!state.livePorts.has(p.app.port)) { state.livePorts.set(p.app.port, portCwd(p.app.port)); sortProjects(); }
        openUrl(url); setStatus(`opening ${url}`);
      } else setStatus(`${p.app.name} isn't running — ${url} is down`);
      render();
    });
    return;
  }
  let st = statsFor(p); if (!st) { st = computeStats(p); state.cache.set(p.path, st); }
  const srv = state.servers.get(p.path);
  if (srv && srv.status === 'starting') { setStatus(`still starting on :${srv.port}… opens when ready`); return; }
  const livePort = liveServerFor(p.path);              // a server THIS project is actually serving on
  if (livePort != null) {
    openUrl(`http://localhost:${livePort}`); setStatus(`opening localhost:${livePort}`); return;
  }
  if (st.siteDir) { startStaticBg(p, true); return; }  // static site — serve it ourselves, open localhost
  if (st.devName) { startDevBg(p, true); return; }     // not running — start ITS OWN dev server, open the real port
  setStatus('no dev server / website for this project');
}
function startStaticBg(p, openAfter) {          // serve a static-site dir via our own zero-dep server, detached
  let st = statsFor(p); if (!st) { st = computeStats(p); state.cache.set(p.path, st); }
  if (!st.siteDir) { setStatus('no static site to serve for this project'); return; }
  const existing = state.servers.get(p.path);
  if (existing && existing.status !== 'dead') {
    if (existing.status === 'live' && openAfter) { openUrl(`http://localhost:${existing.port}`); setStatus(`opening localhost:${existing.port}`); }
    else setStatus(`server already ${existing.status} on :${existing.port}`);
    return;
  }
  const port = STATIC_PORT_BASE;                        // a first guess; the child announces the real bound port
  const logFile = path.join(os.tmpdir(), `pm-${p.name.replace(/[^\w.-]+/g, '_')}.log`);
  let stdout = 'ignore';
  try { stdout = fs.openSync(logFile, 'w'); } catch {}   // truncate: readLogPort must only see THIS run's port
  let child;
  try { child = spawn(process.execPath, [SELF_FILE, 'serve', st.siteDir, String(port)], { cwd: p.path, detached: true, stdio: ['ignore', stdout, stdout] }); }
  catch { setStatus('failed to start static server'); return; }
  child.unref();
  state.servers.set(p.path, { port, status: 'starting', logFile, pid: child.pid, static: true });
  setStatus(`serving ${path.basename(st.siteDir)}/ on :${port}…`, 4000);
  pollServer(p.path, port, openAfter, 0);
}
function startDevBg(p, openAfter) {             // run `npm run <dev>` detached; pm keeps running
  if (p.app) { setStatus('pinned app — press ↵ to open it in the browser'); return; }
  let st = statsFor(p); if (!st) { st = computeStats(p); state.cache.set(p.path, st); }
  if (st.siteDir) { startStaticBg(p, openAfter); return; }   // static site — no npm script, serve it ourselves
  if (!st.devName) { setStatus('no dev/start script in package.json'); return; }
  const existing = state.servers.get(p.path);
  if (existing && existing.status !== 'dead') {
    if (existing.status === 'live' && openAfter) { const rp = typeof openAfter === 'string' ? openAfter : ''; openUrl(`http://localhost:${existing.port}${rp}`); setStatus(`opening localhost:${existing.port}${rp}`); }
    else setStatus(`server already ${existing.status} on :${existing.port}`);
    return;
  }
  const port = st.port || 3000;
  const logFile = path.join(os.tmpdir(), `pm-${p.name.replace(/[^\w.-]+/g, '_')}.log`);
  let stdout = 'ignore';
  try { stdout = fs.openSync(logFile, 'w'); } catch {}   // truncate: readLogPort must only see THIS run's port
  let child;
  try { child = spawn('npm', ['run', st.devName], { cwd: p.path, detached: true, stdio: ['ignore', stdout, stdout] }); }
  catch { setStatus('failed to start dev server'); return; }
  child.unref();
  state.servers.set(p.path, { port, status: 'starting', logFile, pid: child.pid });
  setStatus(`starting "${st.devName}" on :${port}…`, 4000);
  pollServer(p.path, port, openAfter, 0);
}
function pollServer(key, port, openAfter, tries) {
  const s = state.servers.get(key);
  if (!s || s.status === 'dead') return;
  const detected = readLogPort(s.logFile);      // the real port the dev server announced in its log
  const probe = detected || s.port;             // prefer the announced port; else the framework guess
  checkPort(probe).then(live => {
    const cur = state.servers.get(key);
    if (!cur || cur.status === 'dead') return;
    // A listener exists on `probe` — but make sure it's OURS, not a pre-existing server sitting on
    // the guessed port (e.g. another Next.js app already on :3000). Trust it only if our dev server
    // announced this port itself, or if the listener's working dir is inside this project.
    const ours = live && (detected != null || pathInside(portCwd(probe), key));
    if (ours) {
      cur.status = 'live'; cur.port = probe; state.livePorts.set(probe, key);   // record the owner
      if (openAfter) { const rp = typeof openAfter === 'string' ? openAfter : ''; openUrl(`http://localhost:${probe}${rp}`); setStatus(`● live — opened localhost:${probe}${rp}`, 4000); }
      else setStatus(`● live on :${probe}`, 3000);
      sortProjects(); render();   // it just went green ● — float it to the top
    } else if (tries > 60) {                    // ~30s with no listener of our own
      cur.status = 'dead';
      setStatus(`server didn't come up on :${probe} — log: ${cur.logFile}`, 6000);
      render();
    } else {
      setTimeout(() => pollServer(key, probe, openAfter, tries + 1), 500);
    }
  });
}
function stopServer(p) {                        // stop a server pm started
  if (p.app) { setStatus("pinned app — pm can't stop external daemons"); return; }
  const s = state.servers.get(p.path);
  if (!s) { setStatus('no server started here (pm only stops servers it launched)'); return; }
  try { process.kill(-s.pid, 'SIGTERM'); } catch { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  state.livePorts.delete(s.port);
  state.servers.delete(p.path);
  sortProjects();                 // no longer green ● — drop it back into alphabetical order
  setStatus(`stopped server on :${s.port}`);
}
function runDev() {                             // foreground (quits pm, shows live logs)
  const p = state.view[state.sel]; if (!p) return;
  if (p.app) { setStatus('pinned app — press ↵ to open it in the browser'); return; }
  const st = statsFor(p) || computeStats(p);
  if (!st.devName && !st.siteDir) { setStatus('no dev/start script in package.json'); return; }
  cleanup();
  const [cmd, cmdArgs, label] = st.siteDir
    ? [process.execPath, [SELF_FILE, 'serve', st.siteDir], `serve ${path.basename(st.siteDir)}/`]
    : ['npm', ['run', st.devName], `npm run ${st.devName}`];
  console.log('\n' + gradient('foldview') + c(C.orange, ' 🚀') + c(C.dim, `  running `) + c(C.blue, label) +
    c(C.dim, `  in `) + c(C.amber, p.name) + '\n');
  const child = spawn(cmd, cmdArgs, { cwd: p.path, stdio: 'inherit' });
  child.on('exit', code => process.exit(code || 0));
  child.on('error', () => { console.log('failed to start'); process.exit(1); });
}
// ── app editing (add / remove / pin) — all persist to ~/.foldview.json ──
function removeOrStop(p) {                      // x — context-sensitive per entry type
  if (!p.app) return stopServer(p);             // a real project → stop its dev server
  const a = p.app;
  if (a.discovered) { hideDiscovered(a.port); setStatus(`hidden :${a.port} — see ~/.foldview.json`); rescan(); return; }
  if (a.builtin)    { setStatus(`${a.name} is auto-detected — it shows only while installed`); return; }
  if (removeUserApp(a)) { setStatus(`removed "${a.name}" from ~/.foldview.json`); rescan(); }
  else setStatus('could not update ~/.foldview.json');
}
function saveDiscovered(p) {                    // s — pin a discovered app so it persists across restarts
  if (!p.app) { setStatus('select a discovered app, then press s to pin it'); return; }
  const a = p.app;
  if (a.user)    { setStatus('already pinned'); return; }
  if (a.builtin) { setStatus('auto-detected — no need to pin'); return; }
  if (addUserApp({ name: a.name, url: a.url, port: a.port })) { setStatus(`pinned "${a.name}" → ~/.foldview.json`); rescan(); }
  else setStatus('could not write ~/.foldview.json');
}
function commitAddApp() {                        // ↵ from the add-app input
  const parsed = parseAppInput(state.addBuf);
  state.adding = false; state.addBuf = '';
  if (!parsed) { setStatus('add: type e.g.  grafana @ 3001'); return; }
  if (addUserApp(parsed)) { setStatus(`added "${parsed.name}" → ~/.foldview.json`); rescan(); }
  else setStatus('could not write ~/.foldview.json');
}

// ─────────────────────── drill-in navigation ──────────────────────────
// the server that backs an entry: a route is served by its PARENT's dev server; everything else
// serves itself. Used for all liveness/port lookups so routes light up when their parent is up.
function serverPathOf(p) { return (p && p.parent && p.parent.path) || (p && p.path); }
// the real directory-bearing entry behind a row: a route's parent, otherwise the row itself.
// Used by secondary actions (start / stop / editor / copy / AI) which need a real folder.
function dirEntry(p) { return p && p.isFeature ? { name: (p.parent || {}).name, path: (p.parent || {}).path } : p; }
// does this entry have sub-features to enter? (apps and routes are leaves)
function hasFeatures(p) {
  if (!p || p.app || p.isFeature) return false;
  const st = statsFor(p);
  return !!(st && st.features && st.features.length);
}
function isDescendable(p) { return hasFeatures(p); }
// compute stats synchronously if not cached — needed the instant ↵/→ is pressed, before the
// lazy background pass has reached this row.
function statsNow(p) {
  let st = statsFor(p);
  if (!st && !p.app && !p.isFeature) { st = computeStats(p); state.cache.set(p.path, st); }
  return st;
}
// enter a project: push a snapshot, swap the list to its sub-features, warm their stats.
function enterProject(p) {
  if (!p || p.app || p.isFeature) return false;
  const st = statsNow(p);
  const feats = (st && st.features) || [];
  if (!feats.length) return false;
  state.stack.push({ projects: state.projects, view: state.view, sel: state.sel, scroll: state.scroll, search: state.search });
  state.trail.push({ name: p.name, path: p.path });
  state.projects = feats.slice();
  state.search = ''; state.sel = 0; state.scroll = 0;
  applyFilter();
  state.queue = state.projects.filter(x => !x.isFeature && !x.app);   // warm nested-project stats
  state.busy = state.queue.length > 0; pumpQueue();
  return true;
}
// go back up one level, restoring the exact list/selection we left.
function goBack() {
  if (!state.stack.length) return false;
  const snap = state.stack.pop(); state.trail.pop();
  state.projects = snap.projects; state.view = snap.view;
  state.sel = snap.sel; state.scroll = snap.scroll; state.search = snap.search;
  return true;
}
// launch the selected entry itself (never descend): a route opens on its parent's server; a
// project/app opens its own website.
function launchSelected() {
  const p = state.view[state.sel]; if (!p) return;
  if (p.isFeature) launchFeature(p); else openWebsite(p);
}
// launch a route: if the parent's server is live, open the path on it; otherwise start the
// parent's dev server and open the route once it comes up.
function launchFeature(p) {
  const route = p.route || '/';
  const parent = p.parent || {};
  const livePort = liveServerFor(parent.path);
  if (livePort != null) { openUrl(`http://localhost:${livePort}${route}`); setStatus(`opening localhost:${livePort}${route}`); return; }
  startDevBg({ name: parent.name, path: parent.path }, route);   // openAfter = the route to open when live
}
// → key: descend into the selected project's sub-features, or say why we can't.
function descendSelected() {
  const p = state.view[state.sel]; if (!p) return;
  if (p.app || p.isFeature) { setStatus('nothing to enter here'); return; }
  if (!enterProject(p)) setStatus('no sub-features to enter');
}

// ────────────────────────────── input ─────────────────────────────────
function move(delta) {
  state.sel = Math.max(0, Math.min(state.view.length - 1, state.sel + delta));
  const p = state.view[state.sel]; if (p) ensureStats(p, true);
}
// ↵ — descend if the selected project has sub-features, otherwise launch it.
function activate() {
  const p = state.view[state.sel]; if (!p) return;
  if (!p.app && !p.isFeature) {
    const st = statsNow(p);
    if (st && st.features && st.features.length) { enterProject(p); return; }
  }
  launchSelected();
}
function onKey(str, key) {
  if (state.mode === 'help') { state.mode = 'list'; render(); return; }

  if (state.searching) {                       // list-mode type-ahead filter
    const n = key.name;
    if (n === 'return') { state.searching = false; activate(); }
    else if (n === 'escape') { state.searching = false; state.search = ''; applyFilter(); }
    else if (n === 'backspace') { state.search = state.search.slice(0, -1); applyFilter(); }
    else if (n === 'up') move(-1);
    else if (n === 'down') move(1);
    else if (str && str.length === 1 && !key.ctrl && !key.meta && str >= ' ') { state.search += str; applyFilter(); }
    render(); return;
  }

  if (state.ai) {                              // AI-terminals prompt: select-cli → [custom-cli] → select-count
    const a = state.ai;
    if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }        // Ctrl-C: existing quit behavior
    else if (key.name === 'escape') { state.ai = null; }                     // escape works at every phase
    else if (a.phase === 'select-cli') {                                    // only shortcuts shown, '+', escape
      if (str === '+') { a.phase = 'custom-cli'; a.input = ''; }
      else if (str) { const found = a.choices.find(ch => ch.key === str); if (found) { a.cli = found; a.phase = 'select-count'; } }
    } else if (a.phase === 'custom-cli') {                                  // printable text, backspace, return, escape
      const n = key.name;
      if (n === 'return') {
        const result = resolveCustomCli(a.input);
        if (!result.ok) { setStatus(`AI terminals: ${result.error}`); state.ai = null; }
        else {
          saveCustomCli({ name: result.name, executable: result.executable });
          const choices = discoverAIClis();
          a.choices = choices;
          a.cli = choices.find(ch => ch.executable === result.executable) || { name: result.name, executable: result.executable, key: null };
          a.phase = 'select-count';
        }
      }
      else if (n === 'backspace') a.input = a.input.slice(0, -1);
      else if (str && str.length === 1 && !key.ctrl && !key.meta && str >= ' ') a.input += str;
    } else if (a.phase === 'select-count') {                                // only digits 1-9, escape
      if (str >= '1' && str <= '9') {
        const cli = a.cli, project = a.project;
        state.ai = null;
        launchAITerminals(project, cli, Number(str));
      }
    }
    render(); return;
  }

  if (state.gh) {                              // GitHub-push prompt: confirm → working → done/error
    const g = state.gh;
    if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
    else if (g.phase === 'working') { /* push in flight — ignore keys until it settles */ }
    else if (g.phase === 'confirm') {
      if (key.name === 'return') startPush();
      else if (key.name === 'escape') { state.gh = null; setStatus('push cancelled'); }
    } else {                                   // done | error — any key dismisses; o opens the repo
      if (g.phase === 'done' && str === 'o' && g.url) openUrl(g.url);
      state.gh = null;
    }
    render(); return;
  }

  if (state.adding) {                          // "add app" text input → persists to ~/.foldview.json
    const n = key.name;
    if (n === 'return') commitAddApp();
    else if (n === 'escape') { state.adding = false; state.addBuf = ''; setStatus('add cancelled'); }
    else if (n === 'backspace') state.addBuf = state.addBuf.slice(0, -1);
    else if (str && str.length === 1 && !key.ctrl && !key.meta && str >= ' ') state.addBuf += str;
    render(); return;
  }

  const name = key.name;
  if (key.ctrl && name === 'c') { cleanup(); process.exit(0); }

  switch (name) {                               // ── project list (🚦 Launch) ──
    case 'up': move(-1); break;
    case 'down': move(1); break;
    case 'pageup': move(-8); break;
    case 'pagedown': move(8); break;
    case 'return': activate(); break;
    case 'right': descendSelected(); break;                        // → enter sub-features
    case 'left': if (!goBack()) return; break;                     // ← back up a level (root: no-op)
    case 'escape': if (goBack()) break; cleanup(); process.exit(0); break;
    default:
      switch (str) {
        case 'q': cleanup(); process.exit(0); break;
        case 'g': state.sel = 0; move(0); break;
        case 'G': state.sel = state.view.length - 1; move(0); break;
        case 'j': move(1); break;
        case 'k': move(-1); break;
        case 'h': if (!goBack()) return; break;                    // vim: back up a level
        case 'l': launchSelected(); break;                         // launch this entry (never descend)
        case 'd': { const p = dirEntry(state.view[state.sel]); if (p) startDevBg(p, false); break; }
        case 'D': runDev(); break;
        case 'x': { const p = state.view[state.sel]; if (p) removeOrStop(dirEntry(p)); break; }
        case 'o': openLocalhost(); break;
        case 'e': { const p = dirEntry(state.view[state.sel]); if (p) openEditor(p.path); break; }
        case 'a': {
          const p = dirEntry(state.view[state.sel]);
          if (p) state.ai = { project: p, phase: 'select-cli', choices: discoverAIClis(), cli: null, input: '' };
          break;
        }
        case 'p': { const p = dirEntry(state.view[state.sel]); if (p) openPushPrompt(p); break; }
        case 'A': state.adding = true; state.addBuf = ''; break;
        case 's': { const p = state.view[state.sel]; if (p) saveDiscovered(p); break; }
        case 'c': { const p = dirEntry(state.view[state.sel]); if (p) copyPath(p.path); break; }
        case 'r': rescan(); break;
        case '/': state.searching = true; state.search = ''; break;
        case '?': state.mode = 'help'; break;
        default: return;
      }
  }
  render();
}

function rescan() {
  setStatus('rescanning…');
  state.trail = []; state.stack = [];            // a rescan returns to the top-level root list
  state.projects = buildProjectList(state.root);
  state.cache.clear();
  applyFilter();
  state.queue = state.projects.slice();
  state.busy = true; pumpQueue();
  scanPorts().then(s => { state.livePorts = s; mergeDiscovered(); render(); });
  render();
}

// ───────────────────────────── lifecycle ──────────────────────────────
let spinTimer = null, rawWasSet = false;
function cleanup() {
  if (spinTimer) clearInterval(spinTimer);
  try { if (rawWasSet && process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
  out('\x1b[?25h\x1b[?1049l');             // show cursor, leave alt screen
}
function startTUI() {
  if (!process.stdin.isTTY) {
    console.error('project-manager: not a TTY. Try `pm --list` for non-interactive output.');
    process.exit(1);
  }
  state.projects = buildProjectList(state.root);
  applyFilter();
  state.queue = state.projects.slice();

  out('\x1b[?1049h\x1b[?25l\x1b[2J');      // alt screen, hide cursor, clear
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); rawWasSet = true;
  process.stdin.resume();
  process.stdin.on('keypress', (s, k) => { try { onKey(s, k || {}); } catch (e) { /* keep running */ } });
  process.stdout.on('resize', render);
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  spinTimer = setInterval(() => {
    state.spinner++;
    const starting = [...state.servers.values()].some(s => s.status === 'starting');
    if (state.busy || starting || (state.status && Date.now() < state.statusUntil) || !state.cache.has((state.view[state.sel] || {}).path))
      render();
    else if (state.status && Date.now() >= state.statusUntil) { state.status = ''; render(); }
  }, 90);

  // analyze the selected project first, then the rest in the background
  if (state.view[0]) state.cache.set(state.view[0].path, computeStats(state.view[0]));
  state.busy = true; pumpQueue();
  scanPorts().then(s => { state.livePorts = s; mergeDiscovered(); render(); });
  render();
}

// ──────────────────────── CLI bridge (subcommands) ─────────────────────
// Explicit, machine-testable, TTY-independent subcommands for the menu-bar companion / scripts.
// Preserves `pm [path]`, `--list`, `--json`, `--help` exactly — see main() below.
function parseFlagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
// cheap per-project probe for the fast status path: package.json + mtime only — no LOC/disk/git walk.
function lightProjectInfo(dir) {
  const pkg = readJSON(path.join(dir, 'package.json'));
  const scripts = pkg?.scripts || {};
  const siteDir = staticSiteDir(dir, pkg, scripts);
  const devName = siteDir ? null : (['dev', 'start', 'serve', 'preview', 'develop'].find(s => scripts[s]) || null);
  let mtime = 0; try { mtime = fs.statSync(dir).mtimeMs; } catch {}
  return { name: pkg?.name || path.basename(dir), devName, siteDir, port: siteDir ? null : frameworkPort(pkg, scripts[devName]), mtime };
}
// `pm status --format menubar-json` payload (schemaVersion 1). Fast path only: project markers,
// package.json, mtimes, configured apps, live ports, and the runtime registry — no LOC/disk/git.
async function buildMenubarStatus() {
  const cfg = readConfig();
  const roots = cfg.roots.length ? cfg.roots : [process.cwd()];
  const seen = new Set();
  const projects = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const p of scanProjects(root)) { if (!seen.has(p.path)) { seen.add(p.path); projects.push(p); } }
  }
  const apps = loadExtraApps();
  const registry = loadRuntimeRegistry();

  const candidatePorts = new Set();
  const infos = projects.map(p => ({ p, info: lightProjectInfo(p.path) }));
  for (const { info } of infos) if (info.port) candidatePorts.add(info.port);
  for (const a of apps) if (a.port) candidatePorts.add(a.port);
  const liveResults = await Promise.all([...candidatePorts].map(async port => [port, await checkPort(port)]));
  const live = new Set(liveResults.filter(([, ok]) => ok).map(([port]) => port));

  const outProjects = infos.map(({ p, info }) => {
    const managedEntry = findOwnedRegistryEntry(registry, p.path);
    const port = (info.port && live.has(info.port)) ? info.port : (managedEntry ? managedEntry.port : info.port);
    return {
      id: p.path, name: info.name, path: p.path, kind: 'project',
      live: !!((info.port && live.has(info.port)) || managedEntry),
      port: port || null, launchable: !!(info.devName || info.port),
      managed: !!managedEntry, modifiedAt: info.mtime,
    };
  });
  for (const a of apps) {
    const dir = a.path && fs.existsSync(a.path) ? a.path : null;
    const id = dir || `app:${a.port || a.url || a.name}`;
    if (seen.has(id)) continue; seen.add(id);
    let mtime = 0; if (dir) { try { mtime = fs.statSync(dir).mtimeMs; } catch {} }
    outProjects.push({
      id, name: a.name, path: dir || id, kind: 'app',
      live: a.port ? live.has(a.port) : false, port: a.port || null,
      launchable: true, managed: false, modifiedAt: mtime,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: { projectCount: outProjects.length, liveCount: outProjects.filter(p => p.live).length },
    projects: outProjects,
    aiClis: discoverAIClis().map(c => ({ name: c.name, executable: c.executable })),
  };
}
async function cmdStatus(rest) {
  const format = parseFlagValue(rest, '--format');
  if (format !== 'menubar-json') { console.error('pm status: supported format is --format menubar-json'); process.exitCode = 1; return; }
  console.log(JSON.stringify(await buildMenubarStatus()));
}
function cmdRoots(rest) {
  const sub = rest[0];
  if (sub === 'list') {
    const cfg = readConfig();
    if (rest.includes('--json')) { console.log(JSON.stringify(cfg.roots)); return; }
    if (!cfg.roots.length) { console.log('no roots configured'); return; }
    cfg.roots.forEach(r => console.log(r));
    return;
  }
  if (sub === 'add') {
    const dir = rest[1];
    if (!dir || !path.isAbsolute(dir)) { console.error('pm roots add: requires an absolute directory path'); process.exitCode = 1; return; }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`pm roots add: not a directory: ${dir}`); process.exitCode = 1; return; }
    const ok = updateConfig(cfg => { if (!cfg.roots.includes(dir)) cfg.roots.push(dir); });
    if (ok) console.log(`added root: ${dir}`); else { console.error('pm roots add: could not write config'); process.exitCode = 1; }
    return;
  }
  if (sub === 'remove') {
    const dir = rest[1];
    if (!dir) { console.error('pm roots remove: requires a directory path'); process.exitCode = 1; return; }
    const ok = updateConfig(cfg => { cfg.roots = cfg.roots.filter(r => r !== dir); });
    if (ok) console.log(`removed root: ${dir}`); else { console.error('pm roots remove: could not write config'); process.exitCode = 1; }
    return;
  }
  console.error('pm roots: expected list, add, or remove');
  process.exitCode = 1;
}
// Manage custom AI CLIs saved in ~/.foldview.json → aiClis. This is the CLI counterpart to the
// TUI's `a` → `+` custom-CLI prompt, so the menu-bar companion (Settings → CLI) can add/remove
// entries too instead of only mirroring `pm status`.
function cmdAiclis(rest) {
  const sub = rest[0];
  if (!sub || sub === 'list') {
    const discovered = discoverAIClis();
    if (rest.includes('--json')) { console.log(JSON.stringify(discovered.map(c => ({ name: c.name, executable: c.executable, key: c.key })))); return; }
    if (!discovered.length) { console.log('no AI CLIs found'); return; }
    const known = new Set(KNOWN_AI_CLIS.map(k => k.name));
    discovered.forEach(c => console.log(`${c.key ? `[${c.key}] ` : '    '}${c.name}${known.has(c.name) ? '' : ' (custom)'} → ${c.executable}`));
    return;
  }
  if (sub === 'add') {
    const value = rest[1];
    if (!value) { console.error('pm aiclis add: requires an executable name or absolute path'); process.exitCode = 1; return; }
    const result = resolveCustomCli(value);
    if (!result.ok) { console.error(`pm aiclis add: ${result.error}`); process.exitCode = 1; return; }
    const already = (readConfig().aiClis || []).some(a => a && a.executable === result.executable);
    const ok = saveCustomCli({ name: result.name, executable: result.executable });
    if (!ok) { console.error('pm aiclis add: could not write config'); process.exitCode = 1; return; }
    console.log(already ? `already saved: ${result.name} → ${result.executable}` : `added AI CLI: ${result.name} → ${result.executable}`);
    return;
  }
  if (sub === 'remove') {
    const value = rest[1];
    if (!value) { console.error('pm aiclis remove: requires a saved name or executable path'); process.exitCode = 1; return; }
    const resolved = path.isAbsolute(value) ? value : (resolveExecutable(value) || null);
    let removed = 0;
    const ok = updateConfig(cfg => {
      const before = Array.isArray(cfg.aiClis) ? cfg.aiClis : [];
      cfg.aiClis = before.filter(a => !(a && (a.name === value || a.executable === value || (resolved && a.executable === resolved))));
      removed = before.length - cfg.aiClis.length;
    });
    if (!ok) { console.error('pm aiclis remove: could not write config'); process.exitCode = 1; return; }
    if (removed) console.log(`removed ${removed} AI CLI${removed === 1 ? '' : 's'} matching: ${value}`);
    else { console.error(`pm aiclis remove: no saved AI CLI matching: ${value}`); process.exitCode = 1; }
    return;
  }
  console.error('pm aiclis: expected list, add, or remove');
  process.exitCode = 1;
}
async function actionOpen(proj) {
  const info = lightProjectInfo(proj.path);
  if (info.port && await checkPort(info.port)) { openUrl(`http://localhost:${info.port}`); console.log(`opened http://localhost:${info.port}`); return; }
  const registry = loadRuntimeRegistry();
  const managed = findOwnedRegistryEntry(registry, proj.path);
  if (managed) { openUrl(`http://localhost:${managed.port}`); console.log(`opened http://localhost:${managed.port}`); return; }
  if (info.devName || info.siteDir) return actionStart(proj, true);
  console.error('pm action open: no web server detected for this project');
  process.exitCode = 1;
}
async function actionStart(proj, openAfter) {
  const info = lightProjectInfo(proj.path);
  if (!info.devName && !info.siteDir) { console.error('pm action start: no dev/start script or static site'); process.exitCode = 1; return; }
  const existing = findOwnedRegistryEntry(loadRuntimeRegistry(), proj.path);
  if (existing) {
    console.log(`server already running on :${existing.port} (pid ${existing.pid})`);
    if (openAfter) openUrl(`http://localhost:${existing.port}`);
    return;
  }
  const port = info.siteDir ? STATIC_PORT_BASE : (info.port || 3000);
  const logFile = path.join(os.tmpdir(), `pm-${proj.name.replace(/[^\w.-]+/g, '_')}.log`);
  let stdout = 'ignore';
  try { stdout = fs.openSync(logFile, 'w'); } catch {}
  // `label` is for humans; `regCommand` must be tokens that literally appear in the spawned
  // process's `ps` command line — validateOwnership() checks every token is a substring, so an
  // absolute siteDir (no trailing slash) is required, not the prettified basename.
  const [cmd, cmdArgs, label, regCommand] = info.siteDir
    ? [process.execPath, [SELF_FILE, 'serve', info.siteDir, String(port)], `serve ${path.basename(info.siteDir)}/`, `serve ${info.siteDir}`]
    : ['npm', ['run', info.devName], `npm run ${info.devName}`, `npm run ${info.devName}`];
  let child;
  try { child = spawn(cmd, cmdArgs, { cwd: proj.path, detached: true, stdio: ['ignore', stdout, stdout] }); }
  catch { console.error('pm action start: failed to start server'); process.exitCode = 1; return; }
  child.unref();
  recordRuntimeEntry({ project: proj.path, pid: child.pid, pgid: child.pid, port, startedAt: Date.now(),
    command: regCommand, logFile, launcher: 'tui' });
  console.log(`starting "${label}" on :${port}… (pid ${child.pid})`);
  if (openAfter) console.log(`log: ${logFile}`);
}
function actionStop(proj) {
  const entry = findOwnedRegistryEntry(loadRuntimeRegistry(), proj.path);
  if (!entry) { console.error('Foldview did not start this server'); process.exitCode = 1; return; }
  try { process.kill(-entry.pgid, 'SIGTERM'); } catch { try { process.kill(entry.pid, 'SIGTERM'); } catch {} }
  removeRuntimeEntry(entry.project);
  console.log(`stopped server on :${entry.port}`);
}
function actionEditor(proj) {
  const ed = process.env.EDITOR || 'code';
  try { spawn(ed, [proj.path], { stdio: 'ignore', detached: true }).unref(); console.log(`opened in ${ed}`); }
  catch { console.error('pm action editor: could not launch editor'); process.exitCode = 1; }
}
async function actionAi(proj, cliPath, count) {
  if (PLATFORM !== 'darwin') { console.error('AI terminals: macOS only for now'); process.exitCode = 1; return; }
  try { fs.accessSync(cliPath, fs.constants.X_OK); }
  catch { console.error(`pm action ai: could not resolve ${cliPath}`); process.exitCode = 1; return; }
  const result = await spawnAITerminals(proj, { name: path.basename(cliPath), executable: cliPath }, count);
  if (result.ok) console.log(result.message); else { console.error(result.message); process.exitCode = 1; }
}
async function cmdAction(rest) {
  const sub = rest[0];
  const projectArg = parseFlagValue(rest, '--project');
  if (!projectArg) { console.error('pm action: --project <absolute-directory> is required'); process.exitCode = 1; return; }
  const abs = path.resolve(projectArg);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) { console.error(`pm action: not a directory: ${abs}`); process.exitCode = 1; return; }
  const proj = makeProject(abs);
  switch (sub) {
    case 'open': return actionOpen(proj);
    case 'start': return actionStart(proj, rest.includes('--open'));
    case 'stop': return actionStop(proj);
    case 'editor': return actionEditor(proj);
    case 'ai': {
      const cliPath = parseFlagValue(rest, '--cli');
      const count = Number(parseFlagValue(rest, '--count'));
      if (!cliPath || !path.isAbsolute(cliPath)) { console.error('pm action ai: --cli <absolute-executable> is required'); process.exitCode = 1; return; }
      if (!Number.isInteger(count) || count < 1 || count > 9) { console.error('pm action ai: --count must be an integer 1-9'); process.exitCode = 1; return; }
      return actionAi(proj, cliPath, count);
    }
    default: console.error('pm action: expected open, start, stop, editor, or ai'); process.exitCode = 1;
  }
}
function cmdMenubar(rest) {
  const force = rest.includes('--force-install');
  console.log('pm menubar: the Foldview menu-bar companion is not installed yet.');
  console.log(force
    ? 'would install/launch FoldviewMenuBar.app in ~/Applications and record the CLI path.'
    : 'run `pm menubar --force-install` to simulate installing it, or build mac/ (Swift companion) to add it for real.');
}
// ───────────────── static site server (`pm serve <dir> [port]`) ─────────────────
// A zero-dependency file server so a project that is just static HTML (no dev server) still
// launches on a real localhost. Spawned detached by the TUI (startStaticBg) or run directly.
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
};
function startStaticServer(root, startPort) {
  return new Promise(() => {                      // never resolves — the server runs until killed
    const server = http.createServer((req, res) => {
      let urlPath;
      try { urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]); }
      catch { res.writeHead(400); res.end('bad request'); return; }
      let filePath = path.join(root, urlPath);
      const rel = path.relative(root, filePath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end('forbidden'); return; }  // no traversal outside root
      try {
        let stat = fs.statSync(filePath);
        if (stat.isDirectory()) { filePath = path.join(filePath, 'index.html'); stat = fs.statSync(filePath); }
        res.writeHead(200, { 'Content-Type': STATIC_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        fs.createReadStream(filePath).pipe(res);
      } catch {
        const idx = path.join(root, 'index.html');   // SPA-style fallback for extensionless routes
        if (!path.extname(filePath) && fs.existsSync(idx)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          fs.createReadStream(idx).pipe(res);
        } else { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); }
      }
    });
    let port = startPort, tries = 0;
    server.on('error', err => {
      if (err.code === 'EADDRINUSE' && tries++ < 40) server.listen(++port, '127.0.0.1');
      else { console.error(`pm serve: ${err.message}`); process.exit(1); }
    });
    server.on('listening', () => {
      console.log(`Foldview serving ${root}`);
      console.log(`  http://localhost:${port}`);      // startStaticBg/readLogPort key off this exact line
    });
    const shutdown = () => { try { server.close(); } catch {} process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    server.listen(port, '127.0.0.1');
  });
}
function cmdServe(rest) {
  const dir = rest[0] ? path.resolve(rest[0]) : process.cwd();
  const startPort = Number(rest[1]) || STATIC_PORT_BASE;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`pm serve: not a directory: ${dir}`); process.exitCode = 1; return; }
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) { console.error(`pm serve: invalid port: ${rest[1]}`); process.exitCode = 1; return; }
  return startStaticServer(dir, startPort);
}

const SUBCOMMANDS = new Set(['status', 'roots', 'action', 'menubar', 'serve', 'aiclis']);
function dispatchSubcommand(cmd, rest) {
  switch (cmd) {
    case 'status': return cmdStatus(rest);
    case 'roots': return cmdRoots(rest);
    case 'action': return cmdAction(rest);
    case 'menubar': return cmdMenubar(rest);
    case 'serve': return cmdServe(rest);
    case 'aiclis': return cmdAiclis(rest);
  }
}

// ────────────────────────────── main ──────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (SUBCOMMANDS.has(argv[0])) {
    return Promise.resolve(dispatchSubcommand(argv[0], argv.slice(1)))
      .catch(err => { console.error(String(err && err.message || err)); process.exitCode = 1; });
  }

  const flags = new Set(argv.filter(a => a.startsWith('-')));
  const pathArg = argv.find(a => !a.startsWith('-'));
  const root = path.resolve(pathArg || process.cwd());

  if (flags.has('-h') || flags.has('--help')) return printHelp();
  if (!fs.existsSync(root)) { console.error(`pm: path not found: ${root}`); process.exit(1); }
  state.root = root;

  if (flags.has('--json')) return printList(root, true);
  if (flags.has('-l') || flags.has('--list')) return printList(root, false);
  startTUI();
}
// PM_NO_MAIN lets tests import this module (for the pure helpers) without launching the TUI.
if (!process.env.PM_NO_MAIN) main();

export {
  liveServerFor, readLogPort, frameworkPort, portCwd, pathInside, state, buildProjectList, scanPorts, loadExtraApps,
  detectApps, parseAppInput, mergeDiscovered, readConfig, addUserApp, removeUserApp,
  // config
  writeConfig, updateConfig, ensureConfigDefaults, CONFIG_PATH,
  // AI terminals
  KNOWN_AI_CLIS, resolveExecutable, assignFreeKey, discoverAIClis, resolveCustomCli, saveCustomCli,
  computeGrid, getMainDisplayBounds, buildAITerminalsScript, spawnAITerminals, launchAITerminals,
  shq, asq,
  // GitHub push
  DEFAULT_GITIGNORE, sanitizeRepoName, repoNameFor, webUrlFromRemote, planPush, footerGh,
  // managed runtime registry
  RUNTIME_PATH, loadRuntimeRegistry, writeRuntimeRegistry, recordRuntimeEntry, removeRuntimeEntry,
  isPidAlive, pidCommandMatches, pidCwd, validateOwnership, findOwnedRegistryEntry, realpathSafe,
  // CLI bridge
  parseFlagValue, lightProjectInfo, buildMenubarStatus, cmdStatus, cmdRoots, cmdAction, cmdMenubar,
  dispatchSubcommand, actionOpen, actionStart, actionStop, actionEditor, actionAi, cmdAiclis,
  // static site serving
  staticSiteDir, cmdServe, startStaticServer, isSelfProject,
  // footer helper (for rendering assertions)
  footerAi, footer, keyhints, stripAnsi, onKey, computeStats, scanProjects,
  // sub-features / drill-in navigation
  detectRoutes, detectNestedProjects, subFeaturesOf, isDescendable, serverPathOf,
  enterProject, goBack, hasFeatures,
};
