#!/usr/bin/env node
// project manager 📁 — a terminal dashboard for browsing local projects.
// Zero dependencies. Arrow-key navigation, lines of code, disk/package size,
// language breakdown, git status, and live-localhost detection.
//
//   node folder.mjs [path]        launch the TUI (scans [path], default: cwd)
//   node folder.mjs --list [path] print a plain table and exit
//   node folder.mjs --json [path] print JSON and exit
//   node folder.mjs --help

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import readline from 'node:readline';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLATFORM = process.platform;               // 'darwin' | 'linux' | 'win32' | …
// this tool's own location + package name, so it never lists itself (see isSelfProject)
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF_PKG = 'project-manager-cli';

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
};
const c  = (col, s) => rgb(...col) + s + R;
const GRAD = [C.amber, C.orange, C.red];

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
function sh(cmd, timeout = 4000) {
  try { return execSync(cmd, { timeout, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch { return ''; }
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
// skip the tool's own project so it never appears in its own listing — matches both
// the dev source dir and any install location (by package.json name).
function isSelfProject(dir) {
  if (path.resolve(dir) === path.resolve(SELF_DIR)) return true;
  return readJSON(path.join(dir, 'package.json'))?.name === SELF_PKG;
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

function computeStats(p) {
  const src = walkSource(p.path);
  const nm = path.join(p.path, 'node_modules');
  const nodeModules = fs.existsSync(nm) ? duBytes(nm) : 0;
  const total = duBytes(p.path);

  const pkg = readJSON(path.join(p.path, 'package.json'));
  const scripts = pkg?.scripts || {};
  const devName = ['dev', 'start', 'serve', 'preview', 'develop'].find(s => scripts[s]) || null;
  const devCmd  = devName ? `npm run ${devName}` : null;

  let branch = '', dirty = 0;
  if (fs.existsSync(path.join(p.path, '.git'))) {
    branch = sh(`git -C ${shq(p.path)} rev-parse --abbrev-ref HEAD`, 1500).trim();
    dirty  = sh(`git -C ${shq(p.path)} status --porcelain`, 2000).trim().split('\n').filter(Boolean).length;
  }
  return {
    ...src,
    nodeModules,
    total,
    branch, dirty,
    devName, devCmd,
    port: frameworkPort(pkg, scripts[devName]),
    pkgName: pkg?.name || null,
    mtime: p.mtime,
  };
}

// ───────────────────────────── port scan ──────────────────────────────
const COMMON_PORTS = [3000, 3001, 3002, 3003, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 1313, 9000, 3333, 4000, 5555];
function checkPort(port) {
  return new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.setTimeout(350, () => { s.destroy(); res(false); });
  });
}
async function scanPorts() {
  const live = new Set();
  await Promise.all(COMMON_PORTS.map(async p => { if (await checkPort(p)) live.add(p); }));
  return live;
}

// ═══════════════════════════ non-TUI modes ════════════════════════════
function printList(root, asJson) {
  const projects = scanProjects(root);
  process.stderr.write(`scanning ${projects.length} projects in ${root}…\n`);
  const rows = projects.map(p => ({ name: p.name, path: p.path, ...computeStats(p) }));
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }

  console.log('\n' + gradient('  project manager 📁') + c(C.dim, `  ${rows.length} projects · ${root}\n`));
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
${gradient('project manager 📁')} — a terminal dashboard for your local projects

${c(C.dim, 'USAGE')}
  pm [path]                launch the interactive dashboard (default path: cwd)
  pm --list [path]         print a plain stats table and exit
  pm --json [path]         print stats as JSON and exit
  pm --help                (command aliases: project-manager, folder)

${c(C.dim, 'KEYS (in the dashboard)')}
  ↑ ↓          move
  ↵            🚀 launch — open the website (starts the dev server if needed, no exit)
  d  start dev (background)   x  stop   D  dev (foreground)   o  localhost
  e  editor    /  find    r  rescan    ?  help    q  quit
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
  cache: new Map(),      // path -> stats
  pending: new Set(),    // paths whose stats are being computed (prevents re-entrant render)
  livePorts: new Set(),
  spinner: 0, busy: false,
  status: '', statusUntil: 0,
  queue: [],
  servers: new Map(),    // project path -> { port, status:'starting'|'live'|'dead', logFile, pid }
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
// launchable (has a dev/start script or a guessed port) on top, the rest below; recent first within each.
// runs once stats are loaded; keeps the current project selected by path so the list doesn't jump under you.
function sortByLaunchable() {
  const selPath = (state.view[state.sel] || {}).path;
  const rank = p => { const st = state.cache.get(p.path); return st && (st.devName || st.port) ? 0 : 1; };
  state.projects.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
  applyFilter();
  if (selPath) { const i = state.view.findIndex(p => p.path === selPath); if (i >= 0) state.sel = i; }
}
function statsFor(p) {
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
  else { state.busy = false; sortByLaunchable(); render(); }   // all stats in → group launchable on top
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
  const chip = bg(...C.selBg) + BOLD + rgb(...C.amber) + ' 🚀 Launch ' + R;
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

  const title = 'Projects';

  const lines = [];
  // logo line
  const count = `${state.view.length} projects`;
  const livePorts = state.livePorts.size ? c(C.green, `● ${[...state.livePorts].slice(0, 6).join(' ')}`) : c(C.faint, 'no live servers');
  const rootLabel = c(C.dim, trunc(state.root.replace(os.homedir(), '~'), 30));
  const head = `  ${gradient('project manager')}${c(C.orange, ' 📁')}  ${c(C.faint, '·')}  ${c(C.dim, count)}   ${rootLabel}`;
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
function footer(cols) {
  if (state.status && Date.now() < state.statusUntil) return ' ' + c(C.amber, state.status);
  if (state.searching) {
    return ' ' + c(C.amber, 'find: ' + state.search + '▏') + '   ' +
      keyhints([['↑↓', 'move'], ['↵', 'launch'], ['esc', 'cancel']]);
  }
  // greedily include hints in priority order until we run out of width — so it never wraps
  const all = [['↑↓', 'move'], ['↵', 'launch'], ['d', 'start'], ['x', 'stop'],
               ['/', 'find'], ['?', 'help'], ['q', 'quit'], ['o', 'open'], ['e', 'editor']];
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
    const live = st && st.port && state.livePorts.has(st.port);
    let rstr, rcol;
    {                                        // Launch → show dev port + live status
      const srv = state.servers.get(p.path);
      if (srv && srv.status === 'starting') { rstr = `${srv.port} ${spin}`; rcol = C.amber; }
      else if (st && st.port) { rstr = `${st.port} ${live ? '●' : '○'}`; rcol = live ? C.green : C.faint; }
      else { rstr = st ? '—' : (state.cache.has(p.path) ? '·' : spin); rcol = C.faint; }
    }
    rstr = rstr.padStart(rightW);
    const name = trunc(p.name, nameW);
    const pad = repeat(' ', nameW - visLen(name));
    const launchable = !!(st && (st.devName || st.port));
    let dot, dotCol;
    if (!st)             { dot = ' '; dotCol = C.faint; }     // stats not computed yet
    else if (live)       { dot = '●'; dotCol = C.green; }     // launchable + running
    else if (launchable) { dot = '○'; dotCol = C.green; }     // launchable, stopped
    else                 { dot = '●'; dotCol = C.notRun; }    // not launchable → red
    if (sel) {
      out.push(rgb(...C.amber) + '▌' + bg(...C.selBg) + rgb(...dotCol) + dot + ' ' +
        BOLD + rgb(...C.amber) + name + pad + ' ' + rgb(...rcol) + rstr + R);
    } else {
      out.push(' ' + c(dotCol, dot) + ' ' + c(C.text, name) + pad + ' ' + c(rcol, rstr));
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
  push(c(C.faint, trunc(p.path.replace(os.homedir(), '~'), W)));
  push(c(C.border, repeat('─', W)));
  if (!st) {
    push('');
    push('  ' + c(C.orange, SPIN[state.spinner % SPIN.length]) + c(C.dim, ' analyzing…'));
    ensureStats(p, true);
    return lines;
  }
  {                                          // headline the launch target (the project's website)
    const srv = state.servers.get(p.path);
    const live = st.port && state.livePorts.has(st.port);
    push('');
    if (srv && srv.status === 'starting')
      push('  ' + c(C.amber, SPIN[state.spinner % SPIN.length] + ` starting on :${srv.port}…`) + c(C.faint, '   opens when ready'));
    else if (live)
      push('  ' + c(C.green, `● localhost:${st.port}`) + c(C.green, '   live') + c(C.faint, ' — ↵ opens · x stops'));
    else if (st.port || st.devCmd)
      push('  ' + c(C.amber, '→ ' + (st.port ? `localhost:${st.port}` : st.devCmd)) + c(C.faint, '   ↵ launch — starts it, then opens'));
    else
      push('  ' + c(C.faint, '— no web server detected —'));
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
      const live = state.livePorts.has(st.port);
      push(kv('localhost', `:${st.port}` + (live ? c(C.green, '  ● live') : c(C.faint, '  ○ stopped'))));
    }
  }
  return lines;
}

function renderHelp() {
  out('\x1b[H\x1b[2J');
  const L = [
    '', '  ' + gradient('project manager 📁') + c(C.dim, '  — terminal project dashboard'), '',
    c(C.dim, '  🚀 LAUNCH') + c(C.faint, '   the menu is pinned to the top of the dashboard'),
    '   ' + c(C.amber, '↵') + c(C.faint, '   opens the project in the browser (starts the dev server in the background if needed)'), '',
    c(C.dim, '  NAVIGATION'),
    '   ' + c(C.amber, '↑ ↓  j k') + c(C.faint, '   move up / down'),
    '   ' + c(C.amber, '↵  l') + c(C.faint, '       launch the selected project'),
    '   ' + c(C.amber, 'g  G') + c(C.faint, '       jump to top / bottom'), '',
    c(C.dim, '  ACTIONS'),
    '   ' + c(C.amber, '↵') + c(C.faint, '          launch — starts the dev server in the background, then opens the browser (pm stays open)'),
    '   ' + c(C.amber, 'd') + c(C.faint, '          start the dev server in the background (no browser; pm stays open)'),
    '   ' + c(C.amber, 'x') + c(C.faint, '          stop a dev server that pm started'),
    '   ' + c(C.amber, 'D') + c(C.faint, '          run the dev server in the foreground (quits pm, shows logs)'),
    '   ' + c(C.amber, 'o') + c(C.faint, '          open localhost in the browser without starting a server'),
    '   ' + c(C.amber, 'e') + c(C.faint, '          open the project / file in your editor'),
    '   ' + c(C.amber, 'c') + c(C.faint, '          copy the project path to the clipboard'),
    '   ' + c(C.amber, '/') + c(C.faint, '          search / filter projects by name'),
    '   ' + c(C.amber, 'r') + c(C.faint, '          rescan projects and ports'), '',
    '  ' + c(C.green, '●') + c(C.faint, ' = launchable + live   ') + c(C.green, '○') + c(C.faint, ' = launchable (stopped)   ') + c(C.notRun, '●') + c(C.faint, ' = not launchable'), '',
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
function openLocalhost() {
  const p = state.view[state.sel]; if (!p) return;
  const st = statsFor(p);
  let port = st && st.port && state.livePorts.has(st.port) ? st.port : [...state.livePorts][0];
  if (!port) { setStatus('no live server — press d to start one'); return; }
  openUrl(`http://localhost:${port}`);
  setStatus(`opening http://localhost:${port}`);
}
function openWebsite(p) {                       // 🚀 Launch ↵ — open the site WITHOUT exiting
  let st = statsFor(p); if (!st) { st = computeStats(p); state.cache.set(p.path, st); }
  if (st.port && state.livePorts.has(st.port)) {
    openUrl(`http://localhost:${st.port}`); setStatus(`opening localhost:${st.port}`); return;
  }
  if (st.devName) { startDevBg(p, true); return; }     // start in background + open when ready
  setStatus('no dev server / website for this project');
}
function startDevBg(p, openAfter) {             // run `npm run <dev>` detached; pm keeps running
  let st = statsFor(p); if (!st) { st = computeStats(p); state.cache.set(p.path, st); }
  if (!st.devName) { setStatus('no dev/start script in package.json'); return; }
  const existing = state.servers.get(p.path);
  if (existing && existing.status !== 'dead') {
    if (existing.status === 'live' && openAfter) { openUrl(`http://localhost:${existing.port}`); setStatus(`opening localhost:${existing.port}`); }
    else setStatus(`server already ${existing.status} on :${existing.port}`);
    return;
  }
  const port = st.port || 3000;
  const logFile = path.join(os.tmpdir(), `pm-${p.name.replace(/[^\w.-]+/g, '_')}.log`);
  let stdout = 'ignore';
  try { stdout = fs.openSync(logFile, 'a'); } catch {}
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
  checkPort(port).then(live => {
    const cur = state.servers.get(key);
    if (!cur || cur.status === 'dead') return;
    if (live) {
      cur.status = 'live'; state.livePorts.add(port);
      if (openAfter) { openUrl(`http://localhost:${port}`); setStatus(`● live — opened localhost:${port}`, 4000); }
      else setStatus(`● live on :${port}`, 3000);
      render();
    } else if (tries > 60) {                    // ~30s with no listener
      cur.status = 'dead';
      setStatus(`server didn't come up on :${port} — log: ${cur.logFile}`, 6000);
      render();
    } else {
      setTimeout(() => pollServer(key, port, openAfter, tries + 1), 500);
    }
  });
}
function stopServer(p) {                        // stop a server pm started
  const s = state.servers.get(p.path);
  if (!s) { setStatus('no server started here (pm only stops servers it launched)'); return; }
  try { process.kill(-s.pid, 'SIGTERM'); } catch { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  state.livePorts.delete(s.port);
  state.servers.delete(p.path);
  setStatus(`stopped server on :${s.port}`);
}
function runDev() {                             // foreground (quits pm, shows live logs)
  const p = state.view[state.sel]; if (!p) return;
  const st = statsFor(p) || computeStats(p);
  if (!st.devName) { setStatus('no dev/start script in package.json'); return; }
  cleanup();
  console.log('\n' + gradient('project manager 📁') + c(C.dim, `  running `) + c(C.blue, `npm run ${st.devName}`) +
    c(C.dim, `  in `) + c(C.amber, p.name) + '\n');
  const child = spawn('npm', ['run', st.devName], { cwd: p.path, stdio: 'inherit' });
  child.on('exit', code => process.exit(code || 0));
  child.on('error', () => { console.log('failed to start'); process.exit(1); });
}

// ────────────────────────────── input ─────────────────────────────────
function move(delta) {
  state.sel = Math.max(0, Math.min(state.view.length - 1, state.sel + delta));
  const p = state.view[state.sel]; if (p) ensureStats(p, true);
}
function activate() {
  const p = state.view[state.sel]; if (!p) return;
  openWebsite(p);
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

  const name = key.name;
  if (key.ctrl && name === 'c') { cleanup(); process.exit(0); }

  switch (name) {                               // ── project list (🚀 Launch) ──
    case 'up': move(-1); break;
    case 'down': move(1); break;
    case 'pageup': move(-8); break;
    case 'pagedown': move(8); break;
    case 'return': activate(); break;
    case 'escape': cleanup(); process.exit(0); break;
    default:
      switch (str) {
        case 'q': cleanup(); process.exit(0); break;
        case 'g': state.sel = 0; move(0); break;
        case 'G': state.sel = state.view.length - 1; move(0); break;
        case 'j': move(1); break;
        case 'k': move(-1); break;
        case 'l': activate(); break;
        case 'd': { const p = state.view[state.sel]; if (p) startDevBg(p, false); break; }
        case 'D': runDev(); break;
        case 'x': { const p = state.view[state.sel]; if (p) stopServer(p); break; }
        case 'o': openLocalhost(); break;
        case 'e': { const p = state.view[state.sel]; if (p) openEditor(p.path); break; }
        case 'c': { const p = state.view[state.sel]; if (p) copyPath(p.path); break; }
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
  state.projects = scanProjects(state.root);
  state.cache.clear();
  applyFilter();
  state.queue = state.projects.slice();
  state.busy = true; pumpQueue();
  scanPorts().then(s => { state.livePorts = s; render(); });
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
  state.projects = scanProjects(state.root);
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
  scanPorts().then(s => { state.livePorts = s; render(); });
  render();
}

// ────────────────────────────── main ──────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
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
main();
