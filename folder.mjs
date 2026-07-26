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
//   node folder.mjs config get --json | set <key> <value>
//   node folder.mjs aiclis add|remove [...]          manage custom AI CLIs safely

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import readline from 'node:readline';
import { execSync, execFileSync, execFile, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
  notRun: [228, 102, 102],   // hard error only (e.g. push failed) — a true red
  caution:[232, 154, 70],    // has a localhost / exists but foldview can't launch it — orange, not alarming red
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
const wordmark = text => gradient(text, BRAND_GRAD);   // light-orange foldview wordmark

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
const quoteEnv = ({ name, value }) => `${name}=${shq(value)}`;
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
  { key: 'x', name: 'Codex', executable: 'codex', provider: 'codex' },
  { key: 'k', name: 'Kimi Code', executable: 'kimi', provider: 'kimi' },
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
    out.push({ name: k.name, executable: exe, key, provider: k.provider || null });
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
    out.push({ name, executable: exe, key, provider: null });
  }
  return out;
}

// ─────────────────────── AI model provider adapters ───────────────────────
// These helpers are deliberately independent from the periodic status path. Catalog probing and
// provider-config reads happen only when an explicit `pm ai …` command (or a direct test) calls
// them. The menu-bar schema continues to project discovery entries down to {name, executable}.
const AI_PROVIDER_META = Object.freeze({
  codex: { name: 'Codex', executable: 'codex' },
  kimi: { name: 'Kimi Code', executable: 'kimi' },
});
const AI_MAX_INPUT_BYTES = 8 * 1024 * 1024;
const AI_MAX_MODELS = 256;
const AI_MAX_EFFORTS = 16;
const AI_MAX_RAW_STRING = 4096;
const AI_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const AI_BIDI_TEST = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const AI_FORBIDDEN_ID = /[\p{Cc}\p{Cf}\u007f]/u;
const AI_EFFORT = /^[A-Za-z0-9._-]{1,64}$/;

class AIProviderError extends Error {
  constructor(code, message, provider = null, fields = {}) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.provider = provider;
    this.retryable = !['invalid_arguments', 'unsupported_provider', 'provider_mismatch',
      'unsupported_model', 'unsupported_effort'].includes(code);
    Object.assign(this, fields);
  }
  toJSON() {
    const out = { code: this.code, message: sanitizeAIText(this.message, 240), retryable: this.retryable };
    if (this.provider && AI_PROVIDER_META[this.provider]) out.provider = this.provider;
    if (validAIID(this.model)) out.model = this.model;
    if (validAIEffort(this.effort)) out.effort = this.effort;
    return out;
  }
}
function aiError(code, message, provider = null, fields = {}) {
  return new AIProviderError(code, message, provider, fields);
}
function sanitizeAIText(value, limit) {
  if (typeof value !== 'string') return '';
  return [...value.replace(/[\p{Cc}\p{Cf}\u007f]/gu, ' ').replace(AI_BIDI, ' ')
    .replace(/\s+/gu, ' ').trim()].slice(0, limit).join('');
}
function validAIID(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 &&
    Buffer.byteLength(value, 'utf8') <= 256 && value.length <= AI_MAX_RAW_STRING &&
    !AI_FORBIDDEN_ID.test(value) && !AI_BIDI_TEST.test(value);
}
function validAIEffort(value) { return typeof value === 'string' && AI_EFFORT.test(value); }
function byteCompare(a, b) { return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
function decodeAIUTF8(bytes, provider, code = 'config_read_failed') {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw aiError(code, `${AI_PROVIDER_META[provider].name} returned data Foldview could not read safely.`, provider); }
}
function canonicalExecutable(value) {
  try {
    if (!path.isAbsolute(value)) return null;
    const stat = fs.statSync(value);
    if (!stat.isFile()) return null;
    fs.accessSync(value, fs.constants.X_OK);
    return fs.realpathSync(value);
  } catch { return null; }
}
function executableFile(value) { return typeof value === 'string' && path.isAbsolute(value) ? canonicalExecutable(value) : null; }
function classifyAIProvider(executable) {
  const target = canonicalExecutable(executable);
  if (!target) return null;
  const matches = discoverAIClis().filter(entry => entry.provider && canonicalExecutable(entry.executable) === target);
  return matches.length === 1 ? matches[0].provider : null;
}
function providerConfigPath(provider, options = {}) {
  const accountHome = options.home || os.userInfo().homedir;
  if (provider === 'codex') {
    const override = options.codexHome === undefined ? process.env.CODEX_HOME : options.codexHome;
    const root = typeof override === 'string' && override.length && path.isAbsolute(override)
      ? override : path.join(accountHome, '.codex');
    return path.join(root, 'config.toml');
  }
  if (provider === 'kimi') return path.join(accountHome, '.kimi-code', 'config.toml');
  throw aiError('unsupported_provider', `Provider ${sanitizeAIText(String(provider), 64)} is not supported.`);
}
function providerFailure(provider, executable, err) {
  const meta = AI_PROVIDER_META[provider];
  const safe = err instanceof AIProviderError ? err : aiError('malformed_catalog', `${meta.name} returned a model catalog Foldview could not read.`, provider);
  return { id: provider, name: meta.name, executable: executable || null, available: false,
    error: safe.toJSON(), defaultModel: null, defaultEffort: null, models: [] };
}

function normalizeEfforts(raw, provider = null) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(), out = [];
  for (const effort of raw) {
    if (!validAIEffort(effort) || seen.has(effort)) continue;
    seen.add(effort); out.push(effort);
    if (out.length > AI_MAX_EFFORTS) throw aiError('malformed_catalog', 'Provider reported too many effort levels.', provider);
  }
  return out;
}
function parseCodexCatalogPayload(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  if (bytes.length > AI_MAX_INPUT_BYTES) throw aiError('malformed_catalog', 'Codex returned a model catalog Foldview could not read.', 'codex');
  let root;
  try { root = JSON.parse(decodeAIUTF8(bytes, 'codex', 'malformed_catalog')); }
  catch { throw aiError('malformed_catalog', 'Codex returned a model catalog Foldview could not read.', 'codex'); }
  const entries = Array.isArray(root) ? root : (root && !Array.isArray(root) && Array.isArray(root.models) ? root.models : null);
  if (!entries) throw aiError('malformed_catalog', 'Codex returned a model catalog Foldview could not read.', 'codex');
  const seen = new Set(), rows = [];
  for (const entry of entries) {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') continue;
    if (entry.visibility !== undefined && entry.visibility !== 'list') continue;
    if (!validAIID(entry.slug) || seen.has(entry.slug)) continue;
    if (entry.slug.length > AI_MAX_RAW_STRING) continue;
    if (entry.supported_reasoning_levels !== undefined && !Array.isArray(entry.supported_reasoning_levels)) continue;
    const rawEfforts = (entry.supported_reasoning_levels || []).flatMap(level =>
      level && !Array.isArray(level) && typeof level === 'object' && typeof level.effort === 'string' ? [level.effort] : []);
    const efforts = normalizeEfforts(rawEfforts, 'codex');
    if (typeof entry.display_name === 'string' && Buffer.byteLength(entry.display_name, 'utf8') > AI_MAX_RAW_STRING ||
        typeof entry.description === 'string' && Buffer.byteLength(entry.description, 'utf8') > AI_MAX_RAW_STRING) continue;
    const rawLabel = typeof entry.display_name === 'string' ? entry.display_name : entry.slug;
    const rawDetail = typeof entry.description === 'string' ? entry.description : 'Codex model';
    const label = sanitizeAIText(rawLabel, 160) || entry.slug;
    const detail = sanitizeAIText(rawDetail, 512) || 'Codex model';
    const defaultEffort = validAIEffort(entry.default_reasoning_level) && efforts.includes(entry.default_reasoning_level)
      ? entry.default_reasoning_level : null;
    const priority = Number.isFinite(entry.priority) && Number.isInteger(entry.priority) ? entry.priority : 999;
    seen.add(entry.slug);
    rows.push({ id: entry.slug, label, detail, efforts, defaultEffort, priority });
    if (rows.length > AI_MAX_MODELS) throw aiError('malformed_catalog', 'Codex reported too many models.', 'codex');
  }
  rows.sort((a, b) => a.priority - b.priority || byteCompare(a.label, b.label) || byteCompare(a.id, b.id));
  return rows.map(({ priority, ...model }) => model);
}

function splitTomlLines(source) {
  const out = [];
  for (const match of source.matchAll(/([^\r\n]*)(\r\n|\n|$)/g)) {
    if (!match[0]) break;
    out.push({ body: match[1], eol: match[2] });
    if (!match[2]) break;
  }
  if (!out.length) out.push({ body: '', eol: '' });
  return out;
}
function tomlCommentIndex(line) {
  let quote = null, escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"') {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return i;
  }
  return line.length;
}
function parseTomlString(token) {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > AI_MAX_RAW_STRING || token.length < 2) return null;
  if (token[0] !== '"' || token.at(-1) !== '"') return null;
  let out = '';
  for (let i = 1; i < token.length - 1; i++) {
    const ch = token[i];
    if (ch !== '\\') { if (ch === '"' || /[\r\n]/.test(ch)) return null; out += ch; continue; }
    const next = token[++i];
    const mapped = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' }[next];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}
function quoteTomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}
function parseTomlStringArray(token) {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > AI_MAX_RAW_STRING || token[0] !== '[' || token.at(-1) !== ']') return null;
  const values = []; let start = 1, quote = null, escaped = false;
  for (let i = 1; i < token.length - 1; i++) {
    const ch = token[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = null;
    } else if (quote === "'") { if (ch === "'") quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') {
      const part = token.slice(start, i).trim();
      if (!part) return null;
      const value = parseTomlString(part); if (value === null) return null;
      values.push(value); start = i + 1;
    }
  }
  if (quote) return null;
  const tail = token.slice(start, -1).trim();
  if (tail) { const value = parseTomlString(tail); if (value === null) return null; values.push(value); }
  return values;
}
function validOpaqueScalar(token) {
  return /^(?:true|false|[+-]?(?:\d(?:_?\d)*)|[+-]?(?:\d(?:_?\d)*)?\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|[+-]?(?:inf|nan)|\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?)$/.test(token);
}
function parseTomlKeySegments(rawKey) {
  if (typeof rawKey !== 'string' || !rawKey.trim()) return null;
  const segments = []; let start = 0, quote = false, escaped = false;
  for (let i = 0; i <= rawKey.length; i++) {
    const ch = rawKey[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = false;
    } else if (ch === '"') quote = true;
    else if (ch === "'") return null;
    else if (ch === '.' || i === rawKey.length) {
      const raw = rawKey.slice(start, i).trim();
      if (!raw) return null;
      const value = /^[A-Za-z0-9_-]+$/.test(raw) ? raw : parseTomlString(raw);
      if (value === null) return null;
      segments.push(value); start = i + 1;
    }
  }
  return quote || escaped || !segments.length ? null : segments;
}
function splitTomlTopLevel(source, separator) {
  const out = []; let start = 0, quote = false, escaped = false, square = 0, curly = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') { quote = true; continue; }
    if (ch === "'") return null;
    if (ch === '[') square++;
    else if (ch === ']' && --square < 0) return null;
    else if (ch === '{') curly++;
    else if (ch === '}' && --curly < 0) return null;
    else if (ch === separator && square === 0 && curly === 0) {
      out.push(source.slice(start, i).trim()); start = i + 1;
    }
  }
  if (quote || escaped || square || curly) return null;
  out.push(source.slice(start).trim());
  return out;
}
function topLevelTomlEquals(source) {
  let quote = false, escaped = false, square = 0, curly = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') { quote = true; continue; }
    if (ch === '[') square++;
    else if (ch === ']') square--;
    else if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '=' && square === 0 && curly === 0) return i;
  }
  return -1;
}
function validOpaqueTomlValue(token, depth = 0) {
  if (!token || Buffer.byteLength(token, 'utf8') > AI_MAX_RAW_STRING || depth > 16) return false;
  if (token.startsWith('"')) return parseTomlString(token) !== null;
  if (token.startsWith("'")) return false;
  if (validOpaqueScalar(token)) return true;
  if (token.startsWith('[') && token.endsWith(']')) {
    const parts = splitTomlTopLevel(token.slice(1, -1), ',');
    if (!parts) return false;
    if (parts.length === 1 && parts[0] === '') return true;
    if (parts.at(-1) === '') parts.pop();
    return parts.length > 0 && parts.every(part => part && validOpaqueTomlValue(part, depth + 1));
  }
  if (token.startsWith('{') && token.endsWith('}')) {
    const parts = splitTomlTopLevel(token.slice(1, -1), ',');
    if (!parts) return false;
    if (parts.length === 1 && parts[0] === '') return true;
    if (parts.at(-1) === '') return false; // TOML inline tables do not permit a trailing comma.
    return parts.every(part => {
      const eq = topLevelTomlEquals(part);
      return eq > 0 && parseTomlKeySegments(part.slice(0, eq).trim()) !== null &&
        validOpaqueTomlValue(part.slice(eq + 1).trim(), depth + 1);
    });
  }
  return false;
}
function validSingleLineTomlValue(token) {
  return validOpaqueTomlValue(token);
}
function parseTomlTableSegments(code) {
  if (!code.startsWith('[') || !code.endsWith(']') || code.startsWith('[[') || code.endsWith(']]')) return null;
  const inner = code.slice(1, -1).trim();
  return inner ? parseTomlKeySegments(inner) : null;
}
function validTomlTableHeader(code) {
  return parseTomlTableSegments(code) !== null;
}
function parseTomlSubset(source, provider) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > AI_MAX_INPUT_BYTES || source.startsWith('\ufeff') || /\r(?!\n)/.test(source) || /'''|"""/.test(source))
    throw aiError('config_read_failed', `${AI_PROVIDER_META[provider].name} configuration could not be read safely.`, provider);
  const lines = splitTomlLines(source);
  const assignments = [], aliases = new Set(), modelAliases = [];
  let table = null, firstTable = lines.length, thinkingSeen = false;
  for (let index = 0; index < lines.length; index++) {
    const body = lines[index].body;
    const commentAt = tomlCommentIndex(body);
    const code = body.slice(0, commentAt).trim();
    if (!code) continue;
    if (code.startsWith('[')) {
      const tableSegments = parseTomlTableSegments(code);
      if (!tableSegments) throw aiError('config_read_failed', `${AI_PROVIDER_META[provider].name} configuration uses an unsupported multiline or table value.`, provider);
      if (firstTable === lines.length) firstTable = index;
      if (tableSegments[0] === 'thinking') {
        if (tableSegments.length !== 1 || code !== '[thinking]') throw aiError('config_read_failed', 'Kimi Code configuration contains an unsupported thinking table.', provider);
        if (thinkingSeen) throw aiError('config_read_failed', 'Kimi Code configuration contains duplicate thinking tables.', provider);
        thinkingSeen = true; table = { kind: 'thinking' }; continue;
      }
      if (tableSegments[0] === 'models') {
        if (tableSegments.length !== 2) throw aiError('config_read_failed', 'Kimi Code configuration uses an unsupported models table.', provider);
        const alias = tableSegments[1];
        if (code !== `[models.${quoteTomlString(alias)}]`) throw aiError('config_read_failed', 'Kimi Code configuration uses an unsupported models table.', provider);
        if (!validAIID(alias) || aliases.has(alias)) throw aiError('config_read_failed', 'Kimi Code configuration contains an invalid or duplicate model alias.', provider);
        aliases.add(alias); modelAliases.push(alias); table = { kind: 'model', alias }; continue;
      }
      table = { kind: 'unknown', name: tableSegments.join('.'), segments: tableSegments }; continue;
    }
    const eq = code.indexOf('=');
    if (eq <= 0) throw aiError('config_read_failed', `${AI_PROVIDER_META[provider].name} configuration contains an unsupported line.`, provider);
    const rawKey = code.slice(0, eq).trim();
    const keySegments = parseTomlKeySegments(rawKey);
    if (!keySegments)
      throw aiError('config_read_failed', `${AI_PROVIDER_META[provider].name} configuration contains an invalid key.`, provider);
    const exactTargets = new Set(provider === 'codex' ? ['model', 'model_reasoning_effort'] : ['default_model', 'effort', 'enabled']);
    if (keySegments.length > 1 && exactTargets.has(keySegments[0]))
      throw aiError('config_read_failed', `${AI_PROVIDER_META[provider].name} configuration contains an unsupported target key.`, provider);
    if (table?.kind === 'thinking' && keySegments.length > 1 && ['enabled', 'effort', 'default_effort'].includes(keySegments[0]))
      throw aiError('config_read_failed', 'Kimi Code configuration contains an unsupported thinking setting.', provider);
    const semanticKey = keySegments.length === 1 ? keySegments[0] : null;
    const topTarget = !table && (provider === 'codex'
      ? ['model', 'model_reasoning_effort'].includes(semanticKey)
      : semanticKey === 'default_model');
    const thinkingTarget = table?.kind === 'thinking' && ['enabled', 'effort', 'default_effort'].includes(semanticKey);
    const modelTargetKey = table?.kind === 'model' && ['model', 'display_name', 'capabilities', 'support_efforts', 'default_effort'].includes(semanticKey);
    if ((topTarget || thinkingTarget || modelTargetKey) && rawKey !== semanticKey)
      throw aiError('config_read_failed', `${AI_PROVIDER_META[provider].name} configuration contains a quoted target key outside Foldview's accepted subset.`, provider);
    const eqBody = body.indexOf('=');
    let valueStart = eqBody + 1;
    while (valueStart < commentAt && /\s/.test(body[valueStart])) valueStart++;
    let valueEnd = commentAt;
    while (valueEnd > valueStart && /\s/.test(body[valueEnd - 1])) valueEnd--;
    const token = body.slice(valueStart, valueEnd);
    if (!validSingleLineTomlValue(token)) throw aiError('config_read_failed', `${AI_PROVIDER_META[provider].name} configuration uses an unsupported multiline or value form.`, provider);
    const canonicalKey = semanticKey ?? rawKey;
    if (table?.kind === 'thinking' && canonicalKey === 'default_effort')
      throw aiError('config_read_failed', 'Kimi Code configuration contains an unsupported thinking setting.', provider);
    assignments.push({ index, key: canonicalKey, keySegments, token, valueStart, valueEnd, table });
  }
  const targetSeen = new Set();
  for (const a of assignments) {
    const target = provider === 'codex'
      ? (!a.table && ['model', 'model_reasoning_effort'].includes(a.key))
      : ((!a.table && a.key === 'default_model') || a.table?.kind === 'thinking' && ['enabled', 'effort'].includes(a.key));
    if (target) {
      const identity = `${a.table?.kind || 'top'}:${a.key}`;
      if (targetSeen.has(identity)) throw aiError('config_read_failed', `${AI_PROVIDER_META[provider].name} configuration contains a duplicate target setting.`, provider);
      targetSeen.add(identity);
    }
    const modelTarget = a.table?.kind === 'model' && ['model', 'display_name', 'capabilities', 'support_efforts', 'default_effort'].includes(a.key);
    if (modelTarget) {
      const identity = `model:${a.table.alias}:${a.key}`;
      if (targetSeen.has(identity)) throw aiError('config_read_failed', 'Kimi Code configuration contains a duplicate model setting.', provider);
      targetSeen.add(identity);
      const valid = ['capabilities', 'support_efforts'].includes(a.key)
        ? parseTomlStringArray(a.token) !== null : parseTomlString(a.token) !== null;
      if (!valid) throw aiError('config_read_failed', 'Kimi Code configuration contains an invalid model setting.', provider);
    }
    if (provider === 'codex' && !a.table && ['model', 'model_reasoning_effort'].includes(a.key) && parseTomlString(a.token) === null)
      throw aiError('config_read_failed', 'Codex configuration contains an invalid model setting.', provider);
    if (provider === 'kimi' && !a.table && a.key === 'default_model' && parseTomlString(a.token) === null)
      throw aiError('config_read_failed', 'Kimi Code configuration contains an invalid default model.', provider);
    if (provider === 'kimi' && a.table?.kind === 'thinking' && a.key === 'effort' && parseTomlString(a.token) === null)
      throw aiError('config_read_failed', 'Kimi Code configuration contains an invalid thinking effort.', provider);
    if (provider === 'kimi' && a.table?.kind === 'thinking' && a.key === 'enabled' && !['true', 'false'].includes(a.token))
      throw aiError('config_read_failed', 'Kimi Code configuration contains an invalid thinking state.', provider);
  }
  return { source, lines, assignments, modelAliases, firstTable, lineEnding: source.includes('\r\n') ? '\r\n' : '\n' };
}
function assignmentString(doc, key, tableKind = null) {
  const a = doc.assignments.find(row => row.key === key && (row.table?.kind || null) === tableKind);
  return a ? parseTomlString(a.token) : null;
}
function assignmentBool(doc, key, tableKind) {
  const a = doc.assignments.find(row => row.key === key && row.table?.kind === tableKind);
  return a?.token === 'true' ? true : a?.token === 'false' ? false : null;
}
function parseKimiCatalogSource(source) {
  let doc;
  try { doc = parseTomlSubset(source, 'kimi'); }
  catch (err) {
    if (err instanceof AIProviderError) { err.code = 'malformed_catalog'; throw err; }
    throw err;
  }
  const models = [];
  for (const alias of doc.modelAliases) {
    const rows = doc.assignments.filter(a => a.table?.kind === 'model' && a.table.alias === alias);
    const str = key => { const a = rows.find(r => r.key === key); return a ? parseTomlString(a.token) : null; };
    const arr = key => { const a = rows.find(r => r.key === key); return a ? parseTomlStringArray(a.token) : null; };
    const capabilities = arr('capabilities') || [];
    const efforts = normalizeEfforts(arr('support_efforts') || [], 'kimi');
    const rawLabel = str('display_name') || str('model') || alias;
    const label = sanitizeAIText(rawLabel, 160) || alias;
    const fixedThinking = capabilities.includes('thinking') && efforts.length === 0;
    const defaultRaw = str('default_effort');
    const defaultEffort = validAIEffort(defaultRaw) && efforts.includes(defaultRaw) ? defaultRaw : null;
    models.push({ id: alias, label, detail: fixedThinking ? 'Thinking is always on' : 'Kimi managed model', efforts, defaultEffort });
    if (models.length > AI_MAX_MODELS) throw aiError('malformed_catalog', 'Kimi Code configuration declares too many models.', 'kimi');
  }
  if (!models.length) throw aiError('malformed_catalog', 'Kimi Code configuration does not declare any usable models.', 'kimi');
  const rawDefault = assignmentString(doc, 'default_model');
  const defaultModel = models.some(m => m.id === rawDefault) ? rawDefault : null;
  const enabled = assignmentBool(doc, 'enabled', 'thinking') === true;
  const effortRaw = assignmentString(doc, 'effort', 'thinking');
  const defaultEntry = models.find(m => m.id === defaultModel);
  const defaultEffort = enabled && defaultEntry && validAIEffort(effortRaw) && defaultEntry.efforts.includes(effortRaw) ? effortRaw : null;
  return { doc, models, defaultModel, defaultEffort, thinkingEnabled: enabled, configuredEffort: effortRaw };
}

function safeConfigRead(file, provider, changed = false) {
  const fail = () => { throw aiError(changed ? 'config_changed' : 'config_read_failed',
    changed ? `${AI_PROVIDER_META[provider].name} configuration changed during the save.` : `${AI_PROVIDER_META[provider].name} configuration could not be read safely.`, provider); };
  let lst;
  try { lst = fs.lstatSync(file, { bigint: true }); }
  catch (err) { if (err?.code === 'ENOENT') return { missing: true, content: Buffer.alloc(0), identity: 'missing', mode: 0o600 }; fail(); }
  const uid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : lst.uid;
  if (!lst.isFile() || lst.nlink !== 1n || lst.uid !== uid || (Number(lst.mode) & 0o400) === 0 || (Number(lst.mode) & 0o077) !== 0 || lst.size > BigInt(AI_MAX_INPUT_BYTES)) fail();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== lst.dev || st.ino !== lst.ino || st.uid !== lst.uid || st.mode !== lst.mode || st.size !== lst.size || st.mtimeNs !== lst.mtimeNs) fail();
    const content = fs.readFileSync(fd);
    if (content.length > AI_MAX_INPUT_BYTES) fail();
    const identity = [st.dev, st.ino, st.uid, st.mode, st.size, st.mtimeNs, crypto.createHash('sha256').update(content).digest('hex')].join(':');
    return { missing: false, content, identity, mode: Number(st.mode) & 0o777, stat: st };
  } catch { fail(); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
function configSnapshotEqual(a, b) { return a.missing === b.missing && a.identity === b.identity; }
function readAIProviderDefaults(provider, options = {}) {
  if (!AI_PROVIDER_META[provider]) throw aiError('unsupported_provider', `Provider ${sanitizeAIText(String(provider), 64)} is not supported.`);
  const snap = options.snapshot || safeConfigRead(providerConfigPath(provider, options), provider);
  if (snap.missing) return { provider, defaultModel: null, defaultEffort: null };
  const source = decodeAIUTF8(snap.content, provider);
  try {
    if (provider === 'codex') {
      const doc = parseTomlSubset(source, provider);
      const model = assignmentString(doc, 'model');
      const effort = assignmentString(doc, 'model_reasoning_effort');
      return { provider, defaultModel: validAIID(model) ? model : null, defaultEffort: validAIEffort(effort) ? effort : null };
    }
    const parsed = parseKimiCatalogSource(source);
    return { provider, defaultModel: parsed.defaultModel, defaultEffort: parsed.defaultEffort };
  } catch (err) {
    if (err instanceof AIProviderError) { err.code = 'config_read_failed'; throw err; }
    throw aiError('config_read_failed', `${AI_PROVIDER_META[provider].name} configuration could not be read safely.`, provider);
  }
}

async function runBoundedCatalog(executable, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000, limit = options.limit ?? AI_MAX_INPUT_BYTES;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foldview-ai-'));
  fs.chmodSync(dir, 0o700);
  const outPath = path.join(dir, 'stdout'), errPath = path.join(dir, 'stderr');
  const outFd = fs.openSync(outPath, 'wx', 0o600), errFd = fs.openSync(errPath, 'wx', 0o600);
  let child, timer, poll, killedFor = null;
  try {
    child = spawn(executable, ['debug', 'models'], { stdio: ['ignore', outFd, errFd], detached: true });
    const closed = new Promise(resolve => { child.once('close', (code, signal) => resolve({ code, signal })); child.once('error', () => resolve({ code: null, signal: null })); });
    const killGroup = reason => {
      if (killedFor) return; killedFor = reason;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }, 250).unref?.();
    };
    timer = setTimeout(() => killGroup('timeout'), timeoutMs);
    poll = setInterval(() => {
      try { if (fs.fstatSync(outFd).size + fs.fstatSync(errFd).size > limit) killGroup('limit'); } catch {}
    }, 20);
    const result = await closed;
    clearTimeout(timer); clearInterval(poll);
    fs.closeSync(outFd); fs.closeSync(errFd);
    const total = fs.statSync(outPath).size + fs.statSync(errPath).size;
    if (killedFor === 'timeout') throw aiError('catalog_timeout', 'Codex model catalog probe timed out.', 'codex');
    if (killedFor === 'limit' || total > limit) throw aiError('malformed_catalog', 'Codex returned a model catalog Foldview could not read.', 'codex');
    if (result.code !== 0) throw aiError('provider_unavailable', 'Codex could not provide its model catalog.', 'codex');
    return fs.readFileSync(outPath);
  } finally {
    if (timer) clearTimeout(timer); if (poll) clearInterval(poll);
    try { fs.closeSync(outFd); } catch {} try { fs.closeSync(errFd); } catch {}
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
}
async function loadCodexCatalog(executable, options = {}) {
  const canonical = canonicalExecutable(executable);
  if (!canonical) throw aiError('provider_unavailable', 'Codex is not installed or executable.', 'codex');
  const models = parseCodexCatalogPayload(await runBoundedCatalog(canonical, options));
  if (!models.length) throw aiError('malformed_catalog', 'Codex returned no usable models.', 'codex');
  let defaults = { defaultModel: null, defaultEffort: null };
  try { defaults = readAIProviderDefaults('codex', options); }
  catch (err) { if (err.code !== 'config_read_failed') throw err; else throw err; }
  const defaultModel = models.some(m => m.id === defaults.defaultModel) ? defaults.defaultModel : null;
  const selected = models.find(m => m.id === defaultModel);
  const defaultEffort = selected && selected.efforts.includes(defaults.defaultEffort) ? defaults.defaultEffort : null;
  return { models, defaultModel, defaultEffort };
}
async function loadKimiCatalog(executable, options = {}) {
  const canonical = canonicalExecutable(executable);
  if (!canonical) throw aiError('provider_unavailable', 'Kimi Code is not installed or executable.', 'kimi');
  const snap = safeConfigRead(providerConfigPath('kimi', options), 'kimi');
  if (snap.missing) throw aiError('provider_unavailable', 'Kimi Code configuration is not available.', 'kimi');
  return parseKimiCatalogSource(decodeAIUTF8(snap.content, 'kimi', 'malformed_catalog'));
}
async function buildAIProviderCatalog(providerFilter = null, options = {}) {
  if (providerFilter !== null && !AI_PROVIDER_META[providerFilter]) throw aiError('unsupported_provider', `Provider ${sanitizeAIText(String(providerFilter), 64)} is not supported.`);
  const ids = providerFilter ? [providerFilter] : ['codex', 'kimi'];
  const discovered = discoverAIClis();
  const providers = [];
  for (const provider of ids) {
    const entry = discovered.find(item => item.provider === provider);
    const executable = entry?.executable || null;
    if (!executable) { providers.push(providerFailure(provider, null, aiError('provider_unavailable', `${AI_PROVIDER_META[provider].name} is not installed or executable.`, provider))); continue; }
    try {
      const loaded = provider === 'codex' ? await loadCodexCatalog(executable, options) : await loadKimiCatalog(executable, options);
      providers.push({ id: provider, name: AI_PROVIDER_META[provider].name, executable, available: true, error: null,
        defaultModel: loaded.defaultModel, defaultEffort: loaded.defaultEffort, models: loaded.models });
    } catch (err) { providers.push(providerFailure(provider, executable, err)); }
  }
  return { schemaVersion: 1, generatedAt: (options.now || new Date()).toISOString(), providers };
}
function validateAISelection(provider, catalog, model, effort) {
  if (!AI_PROVIDER_META[provider]) throw aiError('unsupported_provider', `Provider ${sanitizeAIText(String(provider), 64)} is not supported.`);
  const providerCatalog = Array.isArray(catalog?.providers) ? catalog.providers.find(p => p.id === provider) : catalog;
  if (providerCatalog?.available !== true) throw aiError('provider_unavailable', `${AI_PROVIDER_META[provider].name} is unavailable.`, provider);
  const models = providerCatalog.models || [];
  const effectiveModel = model ?? providerCatalog.defaultModel;
  const selected = models.find(m => m.id === effectiveModel);
  if (model !== null && model !== undefined && !selected) throw aiError('unsupported_model', `Model ${sanitizeAIText(String(model), 96)} is not available for ${AI_PROVIDER_META[provider].name}.`, provider, { model });
  if (effort !== null && effort !== undefined) {
    if (!selected || !selected.efforts.includes(effort)) throw aiError('unsupported_effort', `Effort ${sanitizeAIText(String(effort), 64)} is not supported by ${sanitizeAIText(String(effectiveModel || 'the selected model'), 96)}.`, provider, { model: effectiveModel, effort });
  }
  return { provider, model: model ?? null, effort: effort ?? null, selectedModel: selected || null };
}
function availableProviderCatalog(envelope, provider) {
  const entry = envelope?.providers?.find(item => item.id === provider);
  if (entry?.available === true) return entry;
  const reported = entry?.error;
  throw aiError(reported?.code || 'provider_unavailable',
    reported?.message || `${AI_PROVIDER_META[provider]?.name || 'Provider'} is unavailable.`, provider,
    { model: reported?.model, effort: reported?.effort });
}
async function prepareAIValidatedLaunch(cliPath, requestedProvider, model, effort, options = {}) {
  if (!executableFile(cliPath)) throw aiError('provider_unavailable', 'The selected AI CLI is not a regular executable file.', requestedProvider);
  const classify = options.classify || classifyAIProvider;
  const catalogBuilder = options.catalogBuilder || buildAIProviderCatalog;
  const classified = classify(cliPath);
  if (!classified || (requestedProvider && classified !== requestedProvider))
    throw aiError('provider_mismatch', 'The selected provider does not match the resolved executable.', requestedProvider);
  let providerCatalog = null;
  if (model !== null || effort !== null) {
    const envelope = await catalogBuilder(classified);
    providerCatalog = availableProviderCatalog(envelope, classified);
    try { validateAISelection(classified, providerCatalog, model, effort); }
    catch (err) { if (err instanceof AIProviderError) err.providerCatalog = providerCatalog; throw err; }
  }
  return { provider: classified, providerCatalog, launchSpec: { provider: classified, model, effort } };
}
function buildAIProviderLaunch(provider, executable, model = null, effort = null) {
  if (!provider) return { env: [], argv: [executable] };
  if (!AI_PROVIDER_META[provider]) throw aiError('unsupported_provider', `Provider ${sanitizeAIText(String(provider), 64)} is not supported.`);
  const argv = [executable], env = [];
  if (provider === 'codex') {
    if (model !== null) argv.push('--model', model);
    if (effort !== null) argv.push('--config', `model_reasoning_effort="${effort}"`);
  } else {
    if (effort !== null) env.push({ name: 'KIMI_MODEL_THINKING_EFFORT', value: effort });
    if (model !== null) argv.push('--model', model);
  }
  return { env, argv };
}
function insertTomlLines(lines, index, bodies, lineEnding) {
  if (!bodies.length) return;
  if (lines.length === 1 && lines[0].body === '' && lines[0].eol === '') {
    lines.splice(0, 1, ...bodies.map((body, offset) => ({
      body, eol: offset === bodies.length - 1 ? '' : lineEnding,
    })));
    return;
  }
  if (index > 0 && !lines[index - 1].eol) lines[index - 1].eol = lineEnding;
  const atEnd = index === lines.length;
  const additions = bodies.map((body, offset) => ({
    body,
    eol: atEnd && offset === bodies.length - 1 ? '' : lineEnding,
  }));
  lines.splice(index, 0, ...additions);
}
function mutateProviderDefaults(doc, provider, model, selectedModel, requestedEffort) {
  const explicitEffort = requestedEffort !== undefined && requestedEffort !== null;
  const configured = provider === 'codex'
    ? assignmentString(doc, 'model_reasoning_effort')
    : assignmentString(doc, 'effort', 'thinking');
  const effectiveEffort = explicitEffort ? requestedEffort
    : selectedModel.efforts.includes(configured) ? configured
      : selectedModel.defaultEffort && selectedModel.efforts.includes(selectedModel.defaultEffort) ? selectedModel.defaultEffort : null;
  const lines = doc.lines.map(line => ({ ...line }));
  const removals = new Set(), replacements = new Map();
  const find = (key, kind = null) => doc.assignments.find(a => a.key === key && (a.table?.kind || null) === kind);
  const replace = (a, value) => replacements.set(a.index,
    lines[a.index].body.slice(0, a.valueStart) + value + lines[a.index].body.slice(a.valueEnd));
  const setExisting = (key, kind, value, remove = false) => {
    const a = find(key, kind);
    if (a && remove) removals.add(a.index);
    else if (a) replace(a, value);
    return !!a;
  };
  if (provider === 'codex') {
    const additions = [];
    if (!setExisting('model', null, quoteTomlString(model))) additions.push(`model = ${quoteTomlString(model)}`);
    if (effectiveEffort === null) setExisting('model_reasoning_effort', null, '', true);
    else if (!setExisting('model_reasoning_effort', null, quoteTomlString(effectiveEffort))) additions.push(`model_reasoning_effort = ${quoteTomlString(effectiveEffort)}`);
    for (const [i, body] of replacements) lines[i].body = body;
    for (const i of [...removals].sort((a, b) => b - a)) lines.splice(i, 1);
    if (additions.length) {
      const firstTable = lines.findIndex(line => line.body.trimStart().startsWith('['));
      insertTomlLines(lines, firstTable < 0 ? lines.length : firstTable, additions, doc.lineEnding);
    }
  } else {
    const topAdditions = [];
    if (!setExisting('default_model', null, quoteTomlString(model))) topAdditions.push(`default_model = ${quoteTomlString(model)}`);
    if (effectiveEffort === null) setExisting('effort', 'thinking', '', true);
    else setExisting('effort', 'thinking', quoteTomlString(effectiveEffort));
    if (explicitEffort) setExisting('enabled', 'thinking', 'true');
    for (const [i, body] of replacements) lines[i].body = body;
    for (const i of [...removals].sort((a, b) => b - a)) lines.splice(i, 1);
    if (topAdditions.length) {
      const firstTable = lines.findIndex(line => line.body.trimStart().startsWith('['));
      insertTomlLines(lines, firstTable < 0 ? lines.length : firstTable, topAdditions, doc.lineEnding);
    }
    if (effectiveEffort !== null && !find('effort', 'thinking') || explicitEffort && !find('enabled', 'thinking')) {
      let header = lines.findIndex(line => line.body.trim() === '[thinking]');
      const missing = [];
      if (effectiveEffort !== null && !find('effort', 'thinking')) missing.push(`effort = ${quoteTomlString(effectiveEffort)}`);
      if (explicitEffort && !find('enabled', 'thinking')) missing.unshift('enabled = true');
      if (header < 0) {
        if (lines.length && lines.at(-1).body !== '') {
          if (!lines.at(-1).eol) lines.at(-1).eol = doc.lineEnding;
          lines.push({ body: '', eol: doc.lineEnding });
        }
        insertTomlLines(lines, lines.length, ['[thinking]', ...missing], doc.lineEnding);
      } else {
        let end = header + 1;
        while (end < lines.length && !lines[end].body.trimStart().startsWith('[')) end++;
        insertTomlLines(lines, end, missing, doc.lineEnding);
      }
    }
  }
  return { source: lines.map(line => line.body + line.eol).join(''), effectiveEffort };
}
function verifyWritableParent(file, provider) {
  const parent = path.dirname(file);
  let st;
  try { st = fs.lstatSync(parent, { bigint: true }); } catch { throw aiError('config_write_failed', `${AI_PROVIDER_META[provider].name} configuration directory is not writable safely.`, provider); }
  const uid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : st.uid;
  const mode = Number(st.mode);
  if (!st.isDirectory() || st.uid !== uid || (mode & 0o300) !== 0o300 || (mode & 0o022) !== 0)
    throw aiError('config_write_failed', `${AI_PROVIDER_META[provider].name} configuration directory is not writable safely.`, provider);
  return parent;
}
function inspectBreakableStaleLock(lockPath) {
  let fd;
  try {
    const lst = fs.lstatSync(lockPath, { bigint: true });
    const uid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : lst.uid;
    if (!lst.isFile() || lst.nlink !== 1n || lst.uid !== uid || lst.size > 1024n) return false;
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = fs.fstatSync(fd, { bigint: true });
    if (st.dev !== lst.dev || st.ino !== lst.ino) return false;
    const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.createdAt !== 'string') return false;
    const created = Date.parse(parsed.createdAt);
    if (!Number.isFinite(created) || Date.now() - created < 10 * 60 * 1000) return false;
    try { process.kill(parsed.pid, 0); return null; }
    catch (err) { return err?.code === 'ESRCH' ? { dev: st.dev, ino: st.ino } : null; }
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
function createProviderLockFile(lockPath) {
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n');
    fs.fsyncSync(fd);
    const st = fs.fstatSync(fd, { bigint: true });
    return { path: lockPath, fd, dev: st.dev, ino: st.ino };
  } catch (err) {
    let owned = null; try { owned = fs.fstatSync(fd, { bigint: true }); } catch {}
    try { fs.closeSync(fd); } catch {}
    try { const at = fs.lstatSync(lockPath, { bigint: true }); if (owned && at.dev === owned.dev && at.ino === owned.ino) fs.unlinkSync(lockPath); } catch {}
    throw err;
  }
}
function safeExistingReaperGuard(guardPath) {
  try {
    const st = fs.lstatSync(guardPath, { bigint: true });
    const uid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : st.uid;
    return st.isFile() && st.nlink === 1n && st.uid === uid && st.size <= 1024n;
  } catch (err) { return err?.code === 'ENOENT'; }
}
function acquireReaperGuard(guardPath, options = {}) {
  // shlock's dot-lock algorithm atomically replaces only dead-PID guards. Without it, Foldview
  // waits for the bounded main-lock deadline rather than deleting an orphan unsafely.
  const shlockPath = options.shlockPath === undefined ? '/usr/bin/shlock' : options.shlockPath;
  if (process.platform !== 'darwin' || !shlockPath || !safeExistingReaperGuard(guardPath)) return null;
  let acquired = null;
  try {
    fs.accessSync(shlockPath, fs.constants.X_OK);
    execFileSync(shlockPath, ['-f', guardPath, '-p', String(process.pid)], {
      timeout: 500, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const st = fs.lstatSync(guardPath, { bigint: true });
    const uid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : st.uid;
    acquired = { path: guardPath, dev: st.dev, ino: st.ino, uid: st.uid };
    if (!st.isFile() || st.nlink !== 1n || st.uid !== uid || st.size > 1024n) { releaseReaperGuard(acquired); return null; }
    fs.chmodSync(guardPath, 0o600);
    const content = fs.readFileSync(guardPath, 'utf8').trim();
    if (content !== String(process.pid)) { releaseReaperGuard(acquired); return null; }
    return acquired;
  } catch { releaseReaperGuard(acquired); return null; }
}
function releaseReaperGuard(guard) {
  if (!guard) return;
  try {
    const at = fs.lstatSync(guard.path, { bigint: true });
    if (at.isFile() && at.dev === guard.dev && at.ino === guard.ino && at.uid === guard.uid) fs.unlinkSync(guard.path);
  } catch {}
}
function reapStaleLockAndAcquire(lockPath, options = {}) {
  const guardPath = lockPath + '.reap';
  let guard;
  try {
    guard = acquireReaperGuard(guardPath, options);
    if (!guard) return null;
    if (typeof options.onReaperGuardAcquired === 'function') options.onReaperGuardAcquired(guardPath);
    const owned = fs.lstatSync(guardPath, { bigint: true });
    if (owned.dev !== guard.dev || owned.ino !== guard.ino || owned.uid !== guard.uid) return null;
    const stale = inspectBreakableStaleLock(lockPath);
    if (!stale) return null;
    if (typeof options.onStaleLockVerified === 'function') options.onStaleLockVerified(lockPath);
    const current = fs.lstatSync(lockPath, { bigint: true });
    if (current.dev !== stale.dev || current.ino !== stale.ino) return null;
    fs.unlinkSync(lockPath);
    // Keep the reaper guard until this process has exclusively installed its own lock. Every
    // Foldview writer checks the guard, so a cooperating contender cannot steal the gap.
    return createProviderLockFile(lockPath);
  } catch { return null; }
  finally { releaseReaperGuard(guard); }
}
async function acquireProviderLock(file, provider, options = {}) {
  const lockPath = file + '.foldview.lock', guardPath = lockPath + '.reap';
  const started = Date.now(), timeoutMs = options.lockTimeoutMs ?? 2000;
  while (Date.now() - started <= timeoutMs) {
    try {
      // A reaper owns the creation gap. Checking first plus the reaper's post-guard identity check
      // ensures either this writer wins before inspection or waits until the stale lock is replaced.
      if (fs.existsSync(guardPath)) throw Object.assign(new Error('reaper active'), { code: 'EEXIST' });
      return createProviderLockFile(lockPath);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw aiError('config_write_failed', `${AI_PROVIDER_META[provider].name} configuration lock could not be created.`, provider);
      const reaped = reapStaleLockAndAcquire(lockPath, options);
      if (reaped) return reaped;
      if (Date.now() - started >= timeoutMs) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(40, Math.max(1, timeoutMs - (Date.now() - started)))));
    }
  }
  throw aiError('config_locked', `${AI_PROVIDER_META[provider].name} configuration is being changed by another Foldview process.`, provider);
}
function releaseProviderLock(lock) {
  try { fs.closeSync(lock.fd); } catch {}
  try {
    const st = fs.lstatSync(lock.path, { bigint: true });
    if (st.dev === lock.dev && st.ino === lock.ino) fs.unlinkSync(lock.path);
  } catch {}
}
function exclusiveSibling(file, stem, mode, content, provider, max = 1) {
  for (let i = 0; i < max; i++) {
    const candidate = file + stem + (i ? `-${i}` : '');
    let fd, created = false;
    try {
      fd = fs.openSync(candidate, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), mode);
      created = true;
      fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd);
      return candidate;
    } catch (err) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      if (created) try { fs.unlinkSync(candidate); } catch {}
      if (err?.code === 'EEXIST' && i + 1 < max) continue;
      throw aiError('config_write_failed', `${AI_PROVIDER_META[provider].name} configuration could not be saved safely.`, provider);
    }
  }
  throw aiError('config_write_failed', `${AI_PROVIDER_META[provider].name} configuration could not be saved safely.`, provider);
}
async function writeAIProviderDefaults(provider, model, effort, options = {}) {
  if (!AI_PROVIDER_META[provider]) throw aiError('unsupported_provider', `Provider ${sanitizeAIText(String(provider), 64)} is not supported.`);
  if (!validAIID(model)) throw aiError('unsupported_model', 'The selected model ID is invalid.', provider);
  if (effort !== undefined && effort !== null && !validAIEffort(effort)) throw aiError('unsupported_effort', 'The selected effort is invalid.', provider, { model, effort });
  const file = providerConfigPath(provider, options);
  const initial = safeConfigRead(file, provider);
  if (!initial.missing) readAIProviderDefaults(provider, { ...options, snapshot: initial });
  if (provider === 'kimi' && initial.missing) throw aiError('provider_unavailable', 'Kimi Code configuration is not available.', provider);
  verifyWritableParent(file, provider);
  const lock = await acquireProviderLock(file, provider, options);
  let tempPath = null, renamed = false;
  try {
    const locked = safeConfigRead(file, provider, true);
    if (!configSnapshotEqual(initial, locked)) throw aiError('config_changed', `${AI_PROVIDER_META[provider].name} configuration changed during the save.`, provider);
    let parsed, providerCatalog;
    if (provider === 'kimi') {
      try { parsed = parseKimiCatalogSource(decodeAIUTF8(locked.content, 'kimi', 'config_changed')); }
      catch (err) { if (err instanceof AIProviderError) err.code = 'config_changed'; throw err; }
      providerCatalog = { available: true, defaultModel: parsed.defaultModel, defaultEffort: parsed.defaultEffort, models: parsed.models };
    } else {
      const source = locked.missing ? '' : decodeAIUTF8(locked.content, 'codex', 'config_changed');
      try { parsed = { doc: parseTomlSubset(source, provider) }; }
      catch (err) { if (err instanceof AIProviderError) err.code = 'config_changed'; throw err; }
      const loader = typeof options.loadCatalog === 'function' ? options.loadCatalog : async () => {
        const entry = discoverAIClis().find(item => item.provider === 'codex');
        if (!entry) throw aiError('provider_unavailable', 'Codex is not installed or executable.', provider);
        return loadCodexCatalog(entry.executable, options);
      };
      const externalCatalog = await loader();
      providerCatalog = { available: true, defaultModel: externalCatalog.defaultModel, defaultEffort: externalCatalog.defaultEffort, models: externalCatalog.models };
    }
    const selection = validateAISelection(provider, providerCatalog, model, effort);
    const transformed = mutateProviderDefaults(parsed.doc, provider, model, selection.selectedModel, effort);
    const target = Buffer.from(transformed.source, 'utf8');
    const mode = locked.missing ? 0o600 : locked.mode & 0o700;
    if (!locked.missing) {
      const stamp = (options.now || new Date()).toISOString().replace(/[:]/g, '-');
      exclusiveSibling(file, `.foldview-backup-${stamp}`, mode, locked.content, provider, 1000);
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    tempPath = exclusiveSibling(file, `.foldview-tmp-${process.pid}-${nonce}`, mode, target, provider, 1);
    if (typeof options.beforeFinalCheck === 'function') options.beforeFinalCheck(file);
    const finalSnapshot = safeConfigRead(file, provider, true);
    if (!configSnapshotEqual(locked, finalSnapshot)) throw aiError('config_changed', `${AI_PROVIDER_META[provider].name} configuration changed during the save.`, provider);
    fs.renameSync(tempPath, file); tempPath = null; renamed = true;
    fs.chmodSync(file, mode);
    const installed = fs.statSync(file);
    const uid = typeof process.geteuid === 'function' ? process.geteuid() : installed.uid;
    if (installed.uid !== uid && typeof fs.chownSync === 'function') fs.chownSync(file, uid, installed.gid);
    try {
      const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (err) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(err?.code)) throw err;
    }
    if (typeof options.afterRename === 'function') options.afterRename(file);
    const defaults = readAIProviderDefaults(provider, options);
    return { schemaVersion: 1, provider, defaultModel: defaults.defaultModel, defaultEffort: defaults.defaultEffort, saved: true };
  } catch (err) {
    if (renamed) throw aiError('config_write_failed', `${AI_PROVIDER_META[provider].name} configuration was installed but final verification failed.`, provider);
    if (err instanceof AIProviderError) throw err;
    throw aiError('config_write_failed', `${AI_PROVIDER_META[provider].name} configuration could not be saved safely.`, provider);
  } finally {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch {}
    releaseProviderLock(lock);
  }
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
function buildAITerminalCommand(projectPath, cliEntry, launchSpec = null) {
  const invocation = launchSpec
    ? buildAIProviderLaunch(launchSpec.provider, cliEntry.executable, launchSpec.model, launchSpec.effort)
    : { env: [], argv: [cliEntry.executable] };
  const tokens = invocation.env.map(quoteEnv).concat(invocation.argv.map(shq));
  return `cd ${shq(projectPath)} && ${tokens.join(' ')}`;
}
function spawnAITerminals(p, cliEntry, n, launchSpec = null) {
  return new Promise(resolve => {
    if (PLATFORM !== 'darwin') { resolve({ ok: false, message: 'AI terminals: macOS only for now' }); return; }
    try { if (!p || !p.path || !fs.statSync(p.path).isDirectory()) throw new Error('missing'); }
    catch { resolve({ ok: false, message: 'no local directory for this entry' }); return; }
    const exe = cliEntry && cliEntry.executable;
    try { if (!executableFile(exe)) throw new Error('missing'); }
    catch { resolve({ ok: false, message: `AI terminals: could not resolve ${(cliEntry && cliEntry.name) || 'CLI'}` }); return; }

    let cmd;
    try { cmd = buildAITerminalCommand(p.path, cliEntry, launchSpec); }
    catch { resolve({ ok: false, message: 'AI terminals: invalid provider launch selection' }); return; }
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
    // Keep the short-lived Automation process referenced until its exit status is known. The
    // machine-facing CLI must not terminate before it can emit its single success/failure JSON.
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
// showDiscoveredApps}, apps, hidden, aiClis }. Only these recognized fields cross the storage
// boundary. Invalid types are rejected instead of being silently interpreted as defaults.
const CONFIG_LOCK_PATH = CONFIG_PATH + '.lock';
const CONFIG_KEYS = ['schemaVersion', 'roots', 'recentProjects', 'menubar', 'apps', 'hidden', 'aiClis'];
function configError(message) { return new Error(`unsafe Foldview config: ${message}`); }
function requireArray(value, name, fallback = []) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw configError(`${name} must be an array`);
  return value;
}
function normalizeAbsolutePaths(value, name) {
  return requireArray(value, name).map((item, index) => {
    if (typeof item !== 'string' || !path.isAbsolute(item) || item.includes('\0'))
      throw configError(`${name}[${index}] must be an absolute path`);
    return path.normalize(item);
  });
}
function normalizeApp(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw configError(`apps[${index}] must be an object`);
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120)
    throw configError(`apps[${index}].name must be 1-120 characters`);
  const out = { name: item.name };
  if (item.desc !== undefined) {
    if (typeof item.desc !== 'string' || item.desc.length > 500) throw configError(`apps[${index}].desc must be a string`);
    out.desc = item.desc;
  }
  if (item.url !== undefined) {
    if (typeof item.url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(item.url)) throw configError(`apps[${index}].url is invalid`);
    out.url = item.url;
  }
  if (item.port !== undefined) {
    if (!Number.isInteger(item.port) || item.port < 1 || item.port > 65535) throw configError(`apps[${index}].port is invalid`);
    out.port = item.port;
  }
  if (item.path !== undefined) {
    if (typeof item.path !== 'string' || !path.isAbsolute(item.path)) throw configError(`apps[${index}].path must be absolute`);
    out.path = path.normalize(item.path);
  }
  if (out.url === undefined && out.port === undefined) throw configError(`apps[${index}] requires url or port`);
  return out;
}
function normalizeAICli(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.name !== 'string' ||
      !item.name.trim() || item.name.length > 80 || sanitizeAIText(item.name, 80) !== item.name)
    throw configError(`aiClis[${index}].name is invalid`);
  if (typeof item.executable !== 'string' || !path.isAbsolute(item.executable) || item.executable.includes('\0'))
    throw configError(`aiClis[${index}].executable must be absolute`);
  return { name: item.name, executable: path.normalize(item.executable) };
}
function ensureConfigDefaults(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw configError('top level must be an object');
  const schemaVersion = input.schemaVersion === undefined ? 1 : input.schemaVersion;
  if (schemaVersion !== 1) throw configError(`unsupported schemaVersion ${String(schemaVersion)}`);
  const menubar = input.menubar === undefined ? {} : input.menubar;
  if (!menubar || typeof menubar !== 'object' || Array.isArray(menubar)) throw configError('menubar must be an object');
  const refreshSeconds = menubar.refreshSeconds === undefined ? 60 : menubar.refreshSeconds;
  const showDiscoveredApps = menubar.showDiscoveredApps === undefined ? true : menubar.showDiscoveredApps;
  if (!Number.isInteger(refreshSeconds) || refreshSeconds < 15 || refreshSeconds > 600)
    throw configError('menubar.refreshSeconds must be an integer from 15 to 600');
  if (typeof showDiscoveredApps !== 'boolean') throw configError('menubar.showDiscoveredApps must be boolean');
  const hidden = requireArray(input.hidden, 'hidden').map((port, index) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw configError(`hidden[${index}] is invalid`);
    return port;
  });
  return {
    schemaVersion: 1,
    roots: normalizeAbsolutePaths(input.roots, 'roots'),
    recentProjects: normalizeAbsolutePaths(input.recentProjects, 'recentProjects'),
    menubar: { refreshSeconds, showDiscoveredApps },
    apps: requireArray(input.apps, 'apps').map(normalizeApp),
    hidden,
    aiClis: requireArray(input.aiClis, 'aiClis').map(normalizeAICli),
  };
}
function assertSecureConfigParent() {
  const st = fs.lstatSync(HOME);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.geteuid() || (st.mode & 0o022) !== 0)
    throw configError('home directory has unsafe ownership or permissions');
}
function assertSafeConfigFile(file = CONFIG_PATH, allowMissing = true) {
  let st;
  try { st = fs.lstatSync(file); }
  catch (err) { if (allowMissing && err?.code === 'ENOENT') return null; throw err; }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.geteuid() || (st.mode & 0o077) !== 0)
    throw configError(`${path.basename(file)} must be a current-user-owned 0600 regular file`);
  return st;
}
function readConfig() {
  assertSecureConfigParent();
  if (!assertSafeConfigFile()) return ensureConfigDefaults({});
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { throw configError('file is corrupt JSON'); }
  return ensureConfigDefaults(parsed);
}
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function acquireConfigLock(timeoutMs = 3000) {
  assertSecureConfigParent();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    assertSafeConfigFile(CONFIG_LOCK_PATH, true);
    const oldUmask = process.umask(0o077);
    try {
      execFileSync('/usr/bin/shlock', ['-p', String(process.pid), '-f', CONFIG_LOCK_PATH], { stdio: 'ignore', timeout: 1000 });
      assertSafeConfigFile(CONFIG_LOCK_PATH, false);
      return () => {
        try {
          const owner = fs.readFileSync(CONFIG_LOCK_PATH, 'utf8').trim();
          if (owner === String(process.pid)) fs.unlinkSync(CONFIG_LOCK_PATH);
        } catch {}
      };
    } catch (err) {
      if (Date.now() >= deadline) throw configError('timed out waiting for the config lock');
    } finally { process.umask(oldUmask); }
    sleepSync(25);
  }
}
function writeConfigUnlocked(cfg) {
  const normalized = ensureConfigDefaults(cfg);
  assertSafeConfigFile();
  let tmp = CONFIG_PATH + '.tmp-' + process.pid + '-' + crypto.randomBytes(12).toString('hex');
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(normalized, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, CONFIG_PATH);
    tmp = null;
    const parentFd = fs.openSync(HOME, fs.constants.O_RDONLY);
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    return true;
  } finally { if (tmp) try { fs.unlinkSync(tmp); } catch {} }
}
function writeConfig(cfg) {
  let release;
  try { release = acquireConfigLock(); return writeConfigUnlocked(cfg); }
  catch { return false; }
  finally { release?.(); }
}
function updateConfig(mutator) {
  let release;
  try {
    release = acquireConfigLock();
    const cfg = readConfig();
    mutator(cfg);
    return writeConfigUnlocked(cfg);
  } catch { return false; }
  finally { release?.(); }
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
  const k = String(app.port || app.url);
  return updateConfig(cfg => {
    cfg.apps = cfg.apps.filter(a => String(a.port || a.url) !== k);
    cfg.apps.push(app);
  });
}
function removeUserApp(app) {                    // drop a pinned app
  const k = String(app.port || app.url); let removed = false;
  const ok = updateConfig(cfg => {
    const before = cfg.apps.length;
    cfg.apps = cfg.apps.filter(a => String(a.port || a.url) !== k);
    removed = cfg.apps.length < before;
  });
  return ok && removed;
}
function hideDiscovered(port) {                  // stop auto-surfacing this discovered port
  return updateConfig(cfg => { if (!cfg.hidden.includes(port)) cfg.hidden.push(port); });
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
  'identityservicesd', 'remoted', 'launchd', 'mDNSResponder', 'rapport',
  'AirPlayUIAgent', 'assistantd', 'bluetoothd', 'commerced', 'ContinuityCaptur', 'universalcontrol']);
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
// parse `lsof -nP -iTCP -sTCP:LISTEN -F pcn` field output (p<pid> / c<comm> / n<addr:port> lines)
// into one {port, pid, comm} per listening port. only loopback-reachable binds count (127.0.0.1,
// ::1, and the v4/v6 wildcards); a server dual-bound v4+v6 folds to one entry per port (first pid
// wins). pure — the shell-out lives in sweepPorts, so this parses canned transcripts in tests.
function parseLsofListeners(text) {
  const byPort = new Map();
  let pid = 0, comm = '';
  for (const line of String(text || '').split('\n')) {
    const tag = line[0], rest = line.slice(1);
    if (tag === 'p') { pid = Number(rest) || 0; comm = ''; }
    else if (tag === 'c') comm = rest;
    else if (tag === 'n') {
      const m = rest.match(/^(?:\*|0\.0\.0\.0|127\.0\.0\.1|\[::\]|\[::1\]):(\d{1,5})$/);
      if (!m) continue;                            // LAN-only bind (192.168.…) or junk — not reachable via localhost
      const port = Number(m[1]);
      if (port && !byPort.has(port)) byPort.set(port, { port, pid, comm });
    }
  }
  return [...byPort.values()];
}
// comm name per live port, refreshed by every successful sweep — lets mergeDiscovered classify
// system daemons without shelling out once per discovered port.
const portCommCache = new Map();
// enumerate EVERY listening TCP port in one lsof sweep (finds servers on any port — the old probe
// list missed unlisted ports and ::1-only binds entirely), then resolve all owners with one
// batched cwd lookup: 2 subprocesses per scan total, vs 2 per live port before.
function sweepPorts() {
  const listeners = parseLsofListeners(sh('lsof -nP -iTCP -sTCP:LISTEN -F pcn 2>/dev/null', 2500));
  if (!listeners.length) return null;              // lsof missing/broken → caller falls back to the probe list
  const cwdOf = new Map();                         // pid -> cwd, from one batched lookup for all owners
  const pids = [...new Set(listeners.map(l => l.pid).filter(Boolean))];
  if (pids.length) {
    let pid = 0;
    for (const line of sh(`lsof -a -p ${pids.join(',')} -d cwd -Fn 2>/dev/null`, 2500).split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1)) || 0;
      else if (line[0] === 'n' && pid) cwdOf.set(pid, line.slice(1));
    }
  }
  const live = new Map();                          // port -> owner cwd ('' if unknown) — shape consumers rely on
  portCommCache.clear();
  for (const l of listeners) {
    live.set(l.port, cwdOf.get(l.pid) || '');
    portCommCache.set(l.port, l.comm || '');
  }
  return live;
}
async function scanPorts() {
  if (PLATFORM !== 'win32') {
    const swept = sweepPorts();
    if (swept) return swept;
  }
  // fallback (win32 / no lsof): probe the guess list like before — misses unlisted ports, but
  // degrades to exactly the old behavior instead of going blind.
  portCommCache.clear();                           // sweep data is stale here; portComm() re-resolves per port
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
    // privileged ports are OS services (smb, kerberos, cups, …), never someone's dev server —
    // project attribution still sees them; they're just not surfaced as discovered apps.
    if (port < 1024) continue;
    if (projPaths.some(pp => pathInside(owner, pp))) continue;           // it's a scanned project's server → shown there
    const comm = portCommCache.has(port) ? portCommCache.get(port) : portComm(port);
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
  // A port a known app owns (e.g. claude-mem on :37701) is that app's server — never credit it to a
  // project just because the app's worker happens to run with a cwd inside the project's folder.
  const appPorts = new Set([...appIndex.values()].map(a => a.port).filter(Boolean));
  for (const [port, owner] of state.livePorts)     // an external server whose cwd is this project
    if (!appPorts.has(port) && pathInside(owner, projPath)) return port;
  return null;
}
// the real port a dev server bound to, parsed from its own log output — handles frameworks that
// auto-increment when the guessed port is taken (e.g. Next.js falling back 3000 → 3001).
function readLogPort(logFile) {
  try {
    // servers announce their address many ways: localhost:3000, 127.0.0.1:3000, 0.0.0.0:4321,
    // [::]:8080, or a full http://<host>:port url — accept them all.
    const re = /(?:https?:\/\/(?:\[[^\]\s]*\]|[^\s:/]+)|localhost|127\.0\.0\.1|0\.0\.0\.0|\[[0-9a-f:]*\]):(\d{2,5})/gi;
    const m = [...fs.readFileSync(logFile, 'utf8').matchAll(re)];
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

  console.log('\n' + wordmark('  foldview') + c(C.brand, ' 🚀') + c(C.dim, `  ${rows.length} projects · ${root}\n`));
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
${wordmark('foldview')}${c(C.brand, ' 🚀')} — ${c(C.dim, 'Your projects and AI coding tools, ready in one terminal.')}
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
  pm action open|start|stop|editor --project <dir> [--open]
  pm ai catalog [--provider <codex|kimi>] --json
  pm ai defaults get --provider <codex|kimi> --json
  pm ai defaults set --provider <codex|kimi> --model <id> [--effort <value>] --json
  pm action ai --project <dir> --cli <abs-executable> --count <1-9>
               [--provider <codex|kimi>] [--model <id>] [--effort <value>] [--json]
  pm config get --json | set menubar.<setting> <value>
  pm aiclis add --name <name> --executable <path> | remove --executable <path>
  pm menubar [--status|--force-install]             inspect or install/launch the companion
  pm agents --json                                  live AI agents (claude/kimi/codex/claude-flow)
  pm burn --json [--days N] [--refresh]             token usage, cost, coding time, GitHub commits
  pm hooks install|uninstall|status                 manage notch-bridge hooks in CLI configs
  pm hook-bridge <claude|kimi> <EventName>          stdin shim invoked by CLI hooks (fail-open)
`);
}

// ════════════════════════════ TUI state ═══════════════════════════════
const state = {
  mode: 'list',          // 'list' | 'help'
  tab: 'launch',         // top-bar tab: 'launch' (↵ launches) | 'ai' (↵ opens AI swarm terminals)
  root: process.cwd(),
  projects: [],
  view: [],              // filtered project list
  sel: 0, scroll: 0,
  search: '', searching: false,
  // AI-terminals prompt: null | CLI/catalog/model/effort/count draft — see onKey()/footerAi().
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
// list order: green ● live on top, then green ○ launchable-stopped, then orange ● not-launchable;
// alphabetical (case-insensitive) within each group. re-runs whenever live state changes.
// keeps the current project selected by path so the list doesn't jump under you.
function sortProjects() {
  if (state.trail.length) return;                // inside a project: keep the sub-feature order stable
  const selPath = (state.view[state.sel] || {}).path;
  const rank = p => {
    const st = state.cache.get(p.path);
    if (liveServerFor(p.path) != null)                 return 0;   // ● live (owned by this project)
    if (st && (st.devName || st.port || st.siteDir))   return 1;   // ○ launchable, stopped (dev server or static site)
    return 2;                                                      // ● not launchable
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
function launchMenu(cols) {                     // the tab bar — pinned to the top, always shown
  // two tabs: 🚦 Launch and 🤖 AI Swarm. The active one is highlighted; ⇥ switches between them,
  // which changes what ↵ does on the selected project (launch its site vs. open AI terminals).
  const activeChip  = (label) => bg(...C.selBg) + BOLD + rgb(...C.amber) + ` ${label} ` + R;
  const idleChip    = (label) => c(C.faint, ` ${label} `);
  const isAi = state.tab === 'ai';
  const launchTab = isAi ? idleChip('🚦 Launch')   : activeChip('🚦 Launch');
  const aiTab     = isAi ? activeChip('🤖 AI Swarm') : idleChip('🤖 AI Swarm');
  const left = '  ' + launchTab + c(C.border, '│') + aiTab + c(C.faint, '  ⇥ switch');
  const hint = c(C.faint, isAi
    ? '↵ open AI terminals for this project  '
    : '↵ launch — opens the site, starts the dev server if needed  ');
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
    ? wordmark('foldview') + state.trail.map(t => c(C.faint, ' › ') + c(C.amber, trunc(t.name, 18))).join('')
    : `${wordmark('foldview')}${c(C.brand, ' 🚀')}`;
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
    const picked = [a.cli.name, a.model?.label || a.model?.id, a.effort].filter(Boolean).join(' · ');
    return fit(' ' + c(C.amber, `${picked} — how many windows?`) + '   ' +
      keyhints([['1-9', 'count'], ['esc', 'back']]), cols);
  }
  if (a.phase === 'loading-catalog') {
    return fit(' ' + c(C.amber, `Loading ${a.cli.name} models…`) + '   ' + keyhints([['esc', 'back']]), cols);
  }
  if (a.phase === 'validating-selection') {
    const picked = [a.cli.name, a.model?.label || a.model?.id, a.effort].filter(Boolean).join(' · ');
    return fit(' ' + c(C.amber, `Validating ${picked}…`) + '   ' + keyhints([['esc', 'back']]), cols);
  }
  if (a.phase === 'catalog-error') {
    const prefix = a.stale ? 'Selection changed: ' : '';
    return fit(' ' + c(C.notRun, trunc(prefix + (a.error || 'model catalog unavailable'), Math.max(12, cols - 30))) + '   ' +
      keyhints([['r', 'retry'], ['esc', 'back']]), cols);
  }
  if (a.phase === 'select-model') {
    const models = a.providerCatalog?.models || [];
    const pos = Math.max(0, models.findIndex(model => model.id === a.model?.id));
    const chosen = models[pos];
    return fit(' ' + c(C.amber, `${a.cli.name} model ${pos + 1}/${models.length}: ${chosen?.label || chosen?.id || '—'}`) + '   ' +
      keyhints([['←→', 'choose'], ['↵', 'next'], ['esc', 'back']]), cols);
  }
  if (a.phase === 'select-effort') {
    const efforts = a.model?.efforts || [];
    const pos = Math.max(0, efforts.indexOf(a.effort));
    const fixed = efforts.length === 1;
    return fit(' ' + c(C.amber, `${a.model?.label || a.model?.id} · effort ${a.effort || '—'}${fixed ? ' (fixed)' : ` ${pos + 1}/${efforts.length}`}`) + '   ' +
      keyhints(fixed ? [['↵', 'next'], ['esc', 'back']] : [['←→', 'choose'], ['↵', 'next'], ['esc', 'back']]), cols);
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
  const launchOrOpen = state.tab === 'ai' ? 'AI swarm' : 'launch';
  const all = [['↑↓', 'move'], ['↵', launchOrOpen], ['⇥', 'tab'], ['→', 'enter'], ['←', 'back'], ['d', 'start'], ['x', 'stop'],
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
      else if (st && (st.port || st.siteDir)) { rstr = `${st.port || STATIC_PORT_BASE} ○`; rcol = C.faint; }
      else { rstr = st ? '—' : (state.cache.has(p.path) ? '·' : spin); rcol = C.faint; }
    }
    rstr = rstr.padStart(rightW);
    const marker = hasFeatures(p) ? ' ›' : '';    // this project can be entered (has sub-features)
    const name = trunc(p.name, nameW - marker.length);
    const pad = repeat(' ', Math.max(0, nameW - visLen(name) - marker.length));
    const launchable = !!(st && (st.devName || st.port || st.isFeature || st.siteDir));
    let dot, dotCol;
    if (!st)                     { dot = ' '; dotCol = C.faint; }   // stats not computed yet
    else if (live && launchable) { dot = '●'; dotCol = C.green; }   // live & foldview can (re)launch it
    else if (live)               { dot = '●'; dotCol = C.caution; } // live but foldview can't launch → orange
    else if (launchable)         { dot = '○'; dotCol = C.green; }   // launchable, stopped
    else                         { dot = '●'; dotCol = C.caution; } // exists but not launchable → orange, not red
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
    '', '  ' + wordmark('foldview') + c(C.brand, ' 🚀') + c(C.dim, '  — a terminal home for projects, local apps, and AI coding agents'), '',
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
function launchAITerminals(p, cliEntry, n, launchSpec = null) {
  spawnAITerminals(p, cliEntry, n, launchSpec)
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
  console.log('\n' + wordmark('foldview') + c(C.brand, ' 🚀') + c(C.dim, `  running `) + c(C.blue, label) +
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
  if (state.tab === 'ai') { openAiPrompt(); return; }   // AI Swarm tab: ↵ opens AI terminals
  if (!p.app && !p.isFeature) {
    const st = statsNow(p);
    if (st && st.features && st.features.length) { enterProject(p); return; }
  }
  launchSelected();
}
// open the AI-terminals prompt for the currently selected project (shared by the `a` key and by
// ↵ while the AI Swarm tab is active). Apps/features resolve to their owning project directory.
function openAiPrompt() {
  const p = dirEntry(state.view[state.sel]);
  if (p) state.ai = { project: p, phase: 'select-cli', choices: discoverAIClis(), cli: null, input: '',
    providerCatalog: null, model: null, effort: null, error: null, loadToken: 0 };
}
function resetAIEffort(a, model) {
  const efforts = model?.efforts || [];
  if (!efforts.length) return null;
  if (efforts.includes(a.effort)) return a.effort;
  if (model.defaultEffort && efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return efforts[0];
}
function initialAIEffort(providerCatalog, model) {
  const efforts = model?.efforts || [];
  if (!efforts.length) return null;
  if (providerCatalog?.defaultEffort && efforts.includes(providerCatalog.defaultEffort)) return providerCatalog.defaultEffort;
  if (model.defaultEffort && efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return efforts[0];
}
function moveAIChoice(a, field, choices, delta) {
  if (!choices.length) return;
  const current = field === 'model' ? a.model?.id : a.effort;
  let index = choices.findIndex(choice => (field === 'model' ? choice.id : choice) === current);
  index = (Math.max(0, index) + delta + choices.length) % choices.length;
  if (field === 'model') { a.model = choices[index]; a.effort = resetAIEffort(a, a.model); }
  else a.effort = choices[index];
}
function backAIPhase(a) {
  if (a.phase === 'select-cli') return 'cancel';
  if (a.phase === 'custom-cli') { a.phase = 'select-cli'; return 'back'; }
  if (a.phase === 'loading-catalog' || a.phase === 'catalog-error' || a.phase === 'select-model') {
    a.loadToken++; a.phase = 'select-cli'; a.providerCatalog = null; a.model = null; a.effort = null; return 'back';
  }
  if (a.phase === 'validating-selection') { a.loadToken++; a.phase = 'select-count'; return 'back'; }
  if (a.phase === 'select-effort') { a.phase = 'select-model'; return 'back'; }
  if (a.phase === 'select-count') {
    if (!a.cli?.provider) a.phase = 'select-cli';
    else if ((a.model?.efforts || []).length) a.phase = 'select-effort';
    else a.phase = 'select-model';
    return 'back';
  }
  return 'back';
}
function beginAICatalogLoad(a) {
  const provider = a.cli?.provider || null;
  if (!provider) { a.phase = 'select-count'; return; }
  const token = ++a.loadToken;
  a.phase = 'loading-catalog'; a.error = null; a.stale = false;
  buildAIProviderCatalog(provider).then(envelope => {
    if (state.ai !== a || a.loadToken !== token) return;
    const catalog = envelope.providers[0];
    if (!catalog?.available || !catalog.models.length) {
      a.phase = 'catalog-error'; a.error = catalog?.error?.message || `${a.cli.name} models are unavailable`;
    } else {
      a.providerCatalog = catalog;
      a.model = catalog.models.find(model => model.id === catalog.defaultModel) || catalog.models[0];
      a.effort = initialAIEffort(catalog, a.model);
      a.phase = 'select-model';
    }
    render();
  }).catch(err => {
    if (state.ai !== a || a.loadToken !== token) return;
    a.phase = 'catalog-error'; a.error = err instanceof AIProviderError ? err.message : 'model catalog unavailable'; render();
  });
}
async function submitAILaunch(a, count, options = {}) {
  const launch = options.launch || launchAITerminals;
  if (!a.cli?.provider) {
    if (state.ai === a) state.ai = null;
    launch(a.project, a.cli, count, null);
    return;
  }
  const token = ++a.loadToken;
  a.phase = 'validating-selection'; a.error = null; a.stale = false;
  try {
    const prepared = await (options.prepare || prepareAIValidatedLaunch)(
      a.cli.executable, a.cli.provider, a.model?.id || null, a.effort || null
    );
    if (state.ai !== a || a.loadToken !== token) return;
    state.ai = null;
    launch(a.project, a.cli, count, prepared.launchSpec);
  } catch (err) {
    if (state.ai !== a || a.loadToken !== token) return;
    if (err instanceof AIProviderError && err.providerCatalog) a.providerCatalog = err.providerCatalog;
    a.stale = err?.code === 'unsupported_model' || err?.code === 'unsupported_effort';
    a.error = err instanceof AIProviderError ? err.message : 'The model selection could not be validated.';
    a.phase = 'catalog-error';
    if (options.render) options.render(); else render();
  }
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

  if (state.ai) {                              // AI-terminals prompt: CLI → catalog → model → effort → count
    const a = state.ai;
    if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }        // Ctrl-C: existing quit behavior
    else if (key.name === 'escape') {
      if (backAIPhase(a) === 'cancel') state.ai = null;
    }
    else if (a.phase === 'select-cli') {                                    // only shortcuts shown, '+', escape
      if (str === '+') { a.phase = 'custom-cli'; a.input = ''; }
      else if (str) { const found = a.choices.find(ch => ch.key === str); if (found) { a.cli = found; beginAICatalogLoad(a); } }
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
          beginAICatalogLoad(a);
        }
      }
      else if (n === 'backspace') a.input = a.input.slice(0, -1);
      else if (str && str.length === 1 && !key.ctrl && !key.meta && str >= ' ') a.input += str;
    } else if (a.phase === 'loading-catalog' || a.phase === 'validating-selection') { /* wait for validation */ }
    else if (a.phase === 'catalog-error') { if (str === 'r') beginAICatalogLoad(a); }
    else if (a.phase === 'select-model') {
      const models = a.providerCatalog?.models || [];
      if (key.name === 'left' || key.name === 'up') moveAIChoice(a, 'model', models, -1);
      else if (key.name === 'right' || key.name === 'down') moveAIChoice(a, 'model', models, 1);
      else if (key.name === 'return' && a.model) a.phase = a.model.efforts.length ? 'select-effort' : 'select-count';
    } else if (a.phase === 'select-effort') {
      const efforts = a.model?.efforts || [];
      if (efforts.length > 1 && (key.name === 'left' || key.name === 'up')) moveAIChoice(a, 'effort', efforts, -1);
      else if (efforts.length > 1 && (key.name === 'right' || key.name === 'down')) moveAIChoice(a, 'effort', efforts, 1);
      else if (key.name === 'return') a.phase = 'select-count';
    } else if (a.phase === 'select-count') {                                // only digits 1-9, escape
      if (str >= '1' && str <= '9') {
        void submitAILaunch(a, Number(str));
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
    case 'tab': state.tab = state.tab === 'ai' ? 'launch' : 'ai'; break;   // ⇥ switch top tab
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
        case 'a': openAiPrompt(); break;
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
function parseStrictFlags(argv, valueFlags, booleanFlags = new Set()) {
  const values = {}, seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!valueFlags.has(flag) && !booleanFlags.has(flag))
      throw aiError('invalid_arguments', `Unknown or misplaced argument: ${sanitizeAIText(String(flag), 80)}.`);
    if (seen.has(flag)) throw aiError('invalid_arguments', `Argument ${flag} may be supplied only once.`);
    seen.add(flag);
    if (booleanFlags.has(flag)) { values[flag] = true; continue; }
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--'))
      throw aiError('invalid_arguments', `Argument ${flag} requires a value.`);
    values[flag] = argv[++i];
  }
  return values;
}
function emitAIJSONFailure(err) {
  const safe = err instanceof AIProviderError ? err : aiError('invalid_arguments', 'The command could not be completed safely.');
  console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: safe.toJSON() }));
  process.exitCode = 1;
}
function requireAIProvider(value) {
  if (value !== 'codex' && value !== 'kimi')
    throw aiError('unsupported_provider', `Provider ${sanitizeAIText(String(value || ''), 64)} is not supported.`);
  return value;
}
async function cmdAI(rest) {
  const wantsJSON = rest.includes('--json');
  try {
    const sub = rest[0];
    if (sub === 'catalog') {
      const flags = parseStrictFlags(rest.slice(1), new Set(['--provider']), new Set(['--json']));
      if (!flags['--json']) throw aiError('invalid_arguments', 'pm ai catalog requires --json.');
      const provider = flags['--provider'] === undefined ? null : requireAIProvider(flags['--provider']);
      const envelope = await buildAIProviderCatalog(provider);
      console.log(JSON.stringify(envelope));
      if (!envelope.providers.some(item => item.available)) process.exitCode = 1;
      return;
    }
    if (sub === 'defaults' && (rest[1] === 'get' || rest[1] === 'set')) {
      const operation = rest[1];
      const flags = parseStrictFlags(rest.slice(2), new Set(['--provider', '--model', '--effort']), new Set(['--json']));
      if (!flags['--json']) throw aiError('invalid_arguments', `pm ai defaults ${operation} requires --json.`);
      if (flags['--provider'] === undefined) throw aiError('invalid_arguments', `pm ai defaults ${operation} requires --provider.`);
      const provider = requireAIProvider(flags['--provider']);
      if (operation === 'get') {
        if (flags['--model'] !== undefined || flags['--effort'] !== undefined)
          throw aiError('invalid_arguments', 'pm ai defaults get does not accept model or effort values.');
        const catalog = availableProviderCatalog(await buildAIProviderCatalog(provider), provider);
        console.log(JSON.stringify({ schemaVersion: 1, provider,
          defaultModel: catalog.defaultModel, defaultEffort: catalog.defaultEffort }));
        return;
      }
      const model = flags['--model'];
      if (model === undefined || !validAIID(model)) throw aiError('invalid_arguments', 'pm ai defaults set requires a valid --model value.', provider);
      const effort = flags['--effort'];
      if (effort !== undefined && !validAIEffort(effort)) throw aiError('invalid_arguments', 'pm ai defaults set received an invalid --effort value.', provider);
      console.log(JSON.stringify(await writeAIProviderDefaults(provider, model, effort)));
      return;
    }
    throw aiError('invalid_arguments', 'pm ai: expected catalog or defaults get/set.');
  } catch (err) {
    if (wantsJSON) emitAIJSONFailure(err);
    else { console.error(err instanceof AIProviderError ? err.message : 'pm ai: command failed'); process.exitCode = 1; }
  }
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
  const apps = cfg.menubar.showDiscoveredApps ? loadExtraApps() : [];
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
function cmdConfig(rest) {
  const sub = rest[0];
  if (sub === 'get') {
    if (rest.length !== 2 || rest[1] !== '--json') {
      console.error('pm config get: expected --json'); process.exitCode = 1; return;
    }
    console.log(JSON.stringify(readConfig()));
    return;
  }
  if (sub !== 'set' || rest.length !== 3) {
    console.error('pm config: expected get --json or set <key> <value>'); process.exitCode = 1; return;
  }
  const key = rest[1], raw = rest[2];
  let value;
  if (key === 'menubar.refreshSeconds') {
    if (!/^\d+$/.test(raw)) { console.error('pm config set: refreshSeconds must be an integer from 15 to 600'); process.exitCode = 1; return; }
    value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 15 || value > 600) {
      console.error('pm config set: refreshSeconds must be an integer from 15 to 600'); process.exitCode = 1; return;
    }
  } else if (key === 'menubar.showDiscoveredApps') {
    if (raw !== 'true' && raw !== 'false') {
      console.error('pm config set: showDiscoveredApps must be true or false'); process.exitCode = 1; return;
    }
    value = raw === 'true';
  } else {
    console.error(`pm config set: unsupported key: ${key}`); process.exitCode = 1; return;
  }
  const ok = updateConfig(cfg => { cfg.menubar[key.split('.')[1]] = value; });
  if (!ok) { console.error('pm config set: could not write config'); process.exitCode = 1; return; }
  console.log(`${key}=${String(value)}`);
}
function cmdAIClis(rest) {
  const sub = rest[0];
  if (sub === 'add') {
    let flags;
    try { flags = parseStrictFlags(rest.slice(1), new Set(['--name', '--executable'])); }
    catch (err) { console.error(err.message); process.exitCode = 1; return; }
    const name = String(flags['--name'] || '').trim();
    if (!name || name.length > 80 || sanitizeAIText(name, 80) !== name) {
      console.error('pm aiclis add: --name must be 1-80 printable characters'); process.exitCode = 1; return;
    }
    if (flags['--executable'] === undefined) {
      console.error('pm aiclis add: --executable is required'); process.exitCode = 1; return;
    }
    const resolved = resolveCustomCli(flags['--executable']);
    if (!resolved.ok) { console.error(`pm aiclis add: ${resolved.error}`); process.exitCode = 1; return; }
    const ok = updateConfig(cfg => {
      cfg.aiClis = cfg.aiClis.filter(item => item && item.executable !== resolved.executable);
      cfg.aiClis.push({ name, executable: resolved.executable });
    });
    if (!ok) { console.error('pm aiclis add: could not write config'); process.exitCode = 1; return; }
    console.log(`added AI CLI: ${name} — ${resolved.executable}`);
    return;
  }
  if (sub === 'remove') {
    let flags;
    try { flags = parseStrictFlags(rest.slice(1), new Set(['--executable'])); }
    catch (err) { console.error(err.message); process.exitCode = 1; return; }
    const raw = String(flags['--executable'] || '').trim();
    if (!raw || FORBIDDEN_CLI_CHARS.test(raw) || (raw.includes('/') && !path.isAbsolute(raw))) {
      console.error('pm aiclis remove: --executable must be a plain executable name or absolute path'); process.exitCode = 1; return;
    }
    const executable = path.isAbsolute(raw) ? path.normalize(raw) : resolveExecutable(raw);
    if (!executable) { console.error(`pm aiclis remove: executable was not found: ${raw}`); process.exitCode = 1; return; }
    let removed = false;
    const ok = updateConfig(cfg => {
      const before = cfg.aiClis.length;
      cfg.aiClis = cfg.aiClis.filter(item => item && item.executable !== executable);
      removed = cfg.aiClis.length !== before;
    });
    if (!ok) { console.error('pm aiclis remove: could not write config'); process.exitCode = 1; return; }
    console.log(removed ? `removed AI CLI: ${executable}` : `AI CLI was not configured: ${executable}`);
    return;
  }
  console.error('pm aiclis: expected add or remove'); process.exitCode = 1;
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
async function actionAi(proj, cliPath, count, options = {}) {
  const { json = false, provider = null, model = null, effort = null,
    spawnTerminals = spawnAITerminals, prepare = prepareAIValidatedLaunch } = options;
  const fail = err => {
    if (json) emitAIJSONFailure(err);
    else { console.error(err.message); process.exitCode = 1; }
  };
  if (PLATFORM !== 'darwin') { fail(aiError('launch_failed', 'AI terminals are available on macOS only.', provider)); return; }
  try { if (!executableFile(cliPath)) throw new Error('not executable'); }
  catch { fail(aiError('provider_unavailable', `Foldview could not resolve ${path.basename(cliPath)}.`, provider)); return; }
  let classified = null, launchSpec = null;
  try {
    if (provider || model !== null || effort !== null) {
      const prepared = await prepare(cliPath, provider, model, effort);
      classified = prepared.provider; launchSpec = prepared.launchSpec;
    } else if (json) classified = classifyAIProvider(cliPath);
  } catch (err) { fail(err); return; }
  let result;
  try { result = await spawnTerminals(proj, { name: path.basename(cliPath), executable: cliPath }, count, launchSpec); }
  catch { fail(aiError('launch_failed', 'Terminal Automation could not complete the requested launch.', classified)); return; }
  if (result.ok) {
    if (json) console.log(JSON.stringify({ schemaVersion: 1, ok: true, launched: count,
      provider: classified, model, effort }));
    else console.log(result.message);
  } else fail(aiError('launch_failed', result.message, classified));
}
async function cmdActionAI(rest) {
  const wantsJSON = rest.includes('--json');
  try {
    const flags = parseStrictFlags(rest.slice(1), new Set(['--project', '--cli', '--count', '--provider', '--model', '--effort']), new Set(['--json']));
    const projectArg = flags['--project'], cliPath = flags['--cli'];
    const countRaw = flags['--count'], count = Number(countRaw);
    if (!projectArg || !path.isAbsolute(projectArg)) throw aiError('invalid_arguments', 'pm action ai requires --project <absolute-directory>.');
    try { if (!fs.statSync(projectArg).isDirectory()) throw new Error('not directory'); }
    catch { throw aiError('invalid_arguments', 'pm action ai project is not a directory.'); }
    if (!cliPath || !path.isAbsolute(cliPath)) throw aiError('invalid_arguments', 'pm action ai requires --cli <absolute-executable>.');
    if (countRaw === undefined || !/^\d+$/.test(countRaw) || !Number.isInteger(count) || count < 1 || count > 9)
      throw aiError('invalid_arguments', 'pm action ai --count must be an integer 1-9.');
    const provider = flags['--provider'] === undefined ? null : requireAIProvider(flags['--provider']);
    const model = flags['--model'] ?? null, effort = flags['--effort'] ?? null;
    if (model !== null && !validAIID(model)) throw aiError('invalid_arguments', 'pm action ai received an invalid --model value.', provider);
    if (effort !== null && !validAIEffort(effort)) throw aiError('invalid_arguments', 'pm action ai received an invalid --effort value.', provider);
    return await actionAi(makeProject(projectArg), cliPath, count, { json: !!flags['--json'], provider, model, effort });
  } catch (err) {
    if (wantsJSON) emitAIJSONFailure(err);
    else { console.error(err instanceof AIProviderError ? err.message : 'pm action ai: command failed'); process.exitCode = 1; }
  }
}
async function cmdAction(rest) {
  const sub = rest[0];
  if (sub === 'ai') return cmdActionAI(rest);
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
    default: console.error('pm action: expected open, start, stop, editor, or ai'); process.exitCode = 1;
  }
}
const MENUBAR_APP_PATH = path.join(HOME, 'Applications', 'Foldview.app');
const CLI_PATH_RECORD = path.join(HOME, 'Library', 'Application Support', 'Foldview', 'cli-path-v1');
function packageVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(SELF_DIR, 'package.json'), 'utf8')).version || ''); }
  catch { return ''; }
}
function plistValue(plist, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist],
    { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function inspectMenubarInstallation(appPath = MENUBAR_APP_PATH) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const executable = path.join(appPath, 'Contents', 'MacOS', 'FoldviewMenuBar');
  try {
    const appStat = fs.lstatSync(appPath), plistStat = fs.lstatSync(plist), executableStat = fs.lstatSync(executable);
    if (!appStat.isDirectory() || appStat.isSymbolicLink() || !plistStat.isFile() || plistStat.isSymbolicLink() ||
        !executableStat.isFile() || executableStat.isSymbolicLink()) throw new Error('unsafe bundle shape');
    const bundleID = plistValue(plist, 'CFBundleIdentifier');
    const executableName = plistValue(plist, 'CFBundleExecutable');
    const version = plistValue(plist, 'CFBundleShortVersionString');
    if (bundleID !== 'com.foldview.menubar' || executableName !== 'FoldviewMenuBar' || !version)
      throw new Error('unexpected bundle identity');
    fs.accessSync(executable, fs.constants.X_OK);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath],
      { stdio: 'ignore', timeout: 5000 });
    const detail = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (detail.status !== 0 || !/Signature=adhoc(?:\s|$)/.test(detail.stderr || ''))
      throw new Error('bundle is not ad-hoc signed');
    return { installed: true, version, executable };
  } catch { return { installed: false, version: null, executable }; }
}
function installedMenubarVersion(appPath = MENUBAR_APP_PATH) {
  return inspectMenubarInstallation(appPath).version;
}
function menubarIsRunning(appPath = MENUBAR_APP_PATH, processList = null) {
  const executable = path.join(appPath, 'Contents', 'MacOS', 'FoldviewMenuBar');
  try {
    const output = processList ?? execFileSync('/bin/ps', ['-axo', 'command='],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(output).split('\n').some(line => {
      const command = line.trimStart();
      return command === executable || command.startsWith(executable + ' ');
    });
  } catch { return false; }
}
function writeCLIPathRecord() {
  const dir = path.dirname(CLI_PATH_RECORD);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.cli-path-v1.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, SELF_FILE + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, CLI_PATH_RECORD);
    fs.chmodSync(CLI_PATH_RECORD, 0o600);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function cmdMenubar(rest) {
  const allowed = new Set(['--force-install', '--status']);
  if (rest.some(flag => !allowed.has(flag)) || new Set(rest).size !== rest.length ||
      (rest.includes('--force-install') && rest.includes('--status'))) {
    console.error('pm menubar: expected --status or --force-install'); process.exitCode = 1; return;
  }
  if (PLATFORM !== 'darwin') { console.error('pm menubar: the native companion requires macOS'); process.exitCode = 1; return; }
  const inspection = inspectMenubarInstallation();
  const installedVersion = inspection.version;
  const currentVersion = packageVersion();
  if (rest.includes('--status')) {
    console.log(JSON.stringify({ installed: inspection.installed, running: menubarIsRunning(),
      current: inspection.installed && installedVersion === currentVersion,
      version: installedVersion, expectedVersion: currentVersion, appPath: MENUBAR_APP_PATH,
      cliPathRecord: CLI_PATH_RECORD }));
    return;
  }
  const force = rest.includes('--force-install');
  if (force || !inspection.installed || installedVersion !== currentVersion) {
    const packager = path.join(SELF_DIR, 'mac', 'Packaging', 'package-app.sh');
    if (!fs.existsSync(packager)) { console.error(`pm menubar: missing packager: ${packager}`); process.exitCode = 1; return; }
    try { execFileSync(packager, [], { cwd: path.join(SELF_DIR, 'mac'), stdio: 'inherit', timeout: 10 * 60 * 1000 }); }
    catch { console.error('pm menubar: package/install failed'); process.exitCode = 1; return; }
  }
  try {
    writeCLIPathRecord();
    execFileSync('/usr/bin/open', [MENUBAR_APP_PATH], { stdio: 'ignore', timeout: 15000 });
    console.log(`Foldview is installed and launched: ${MENUBAR_APP_PATH}`);
  } catch (err) {
    console.error(`pm menubar: could not record or launch Foldview: ${err?.message || err}`); process.exitCode = 1;
  }
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

// ─────────────── telemetry subcommands: agents / burn / hooks ───────────────
// Machine-readable JSON subcommands for the menu-bar companion: live agent discovery
// (`pm agents --json`), token usage + spend report (`pm burn --json`), the stdin hook
// shim the CLI hooks call (`pm hook-bridge`), and hook config management
// (`pm hooks install|uninstall|status`). Everything here degrades gracefully: missing
// dirs or files mean empty sections, never a throw.

const AGENT_RECENCY_MS = 30 * 60_000;   // a transcript counts as "live" if touched < 30 min ago
const AGENT_ACTIVE_MS = 2 * 60_000;     // ...and "active" if its last event is < 2 min old

// read only the TAIL of a (potentially 100+ MB) JSONL transcript: the last `maxLines`
// lines out of at most the last `maxBytes` bytes. Sync on purpose — one bounded chunk.
function readFileTailLines(filePath, maxLines = 200, maxBytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';   // drop the partial first line
    }
    return text.split('\n').filter(l => l.trim()).slice(-maxLines);
  } catch { return []; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// parse the tail of a Claude Code transcript: session id, project cwd, and the action
// implied by the LAST record (tool_use → "Using X", assistant text → "Writing",
// user → "Waiting for model", anything else → null).
function parseTranscriptTail(lines) {
  let sessionId = null, cwd = null, startedAt = null, lastTimestamp = null, currentAction = null;
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.sessionId === 'string' && rec.sessionId) sessionId = rec.sessionId;
    if (typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd;
    if (typeof rec.timestamp === 'string' && rec.timestamp) {
      if (!startedAt) startedAt = rec.timestamp;
      lastTimestamp = rec.timestamp;
    }
    if (rec.type === 'assistant') {
      const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
      const tool = content.find(c => c && c.type === 'tool_use' && typeof c.name === 'string' && c.name);
      currentAction = tool ? `Using ${tool.name}` : 'Writing';
    } else if (rec.type === 'user') currentAction = 'Waiting for model';
    else currentAction = null;
  }
  return { sessionId, cwd, startedAt, lastTimestamp, currentAction };
}

// Claude Code live agents: newest transcript per project slug, kept only if recently touched.
function collectClaudeAgents(projectsDir, now = new Date()) {
  const agents = [];
  let slugs;
  try { slugs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return agents; }
  for (const d of slugs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    let newest = null, newestM = 0;
    for (const f of files) {
      let st;
      try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
      if (st.mtimeMs > newestM) { newestM = st.mtimeMs; newest = f; }
    }
    if (!newest || now.getTime() - newestM > AGENT_RECENCY_MS) continue;
    const info = parseTranscriptTail(readFileTailLines(path.join(dir, newest)));
    const sessionId = info.sessionId || newest.replace(/\.jsonl$/, '');
    const lastActivityAt = info.lastTimestamp || new Date(newestM).toISOString();
    const lastMs = Date.parse(lastActivityAt);
    agents.push({
      id: `claude:${sessionId}`, _session: `claude:${sessionId}`, cli: 'claude', roles: ['interactive'],
      project: info.cwd, pid: null,
      status: !Number.isNaN(lastMs) && now.getTime() - lastMs < AGENT_ACTIVE_MS ? 'active' : 'idle',
      currentAction: info.currentAction, startedAt: info.startedAt, lastActivityAt,
    });
  }
  return agents;
}

// Kimi Code wire.jsonl tail: turn.prompt → "Waiting for model"; context.append_loop_event
// keeps the last step/tool name; permission.record_approval_result → "Approval approved|denied".
function parseKimiWireTail(lines) {
  let currentAction = null, firstTime = null, lastTime = null;
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const t = typeof rec.time === 'number' && Number.isFinite(rec.time) ? rec.time : NaN;
    if (!Number.isNaN(t)) { if (firstTime === null) firstTime = t; lastTime = t; }
    if (rec.type === 'turn.prompt') currentAction = 'Waiting for model';
    else if (rec.type === 'context.append_loop_event') {
      const ev = rec.event && typeof rec.event === 'object' ? rec.event
        : (rec.payload && typeof rec.payload === 'object' ? rec.payload : {});
      const name = [ev.name, ev.tool, ev.toolName, rec.name, rec.tool]
        .find(v => typeof v === 'string' && v);
      currentAction = name ? `Using ${name}` : 'Working';
    } else if (rec.type === 'permission.record_approval_result') {
      const approved = rec.approved === true || rec.result === 'approved' || rec.decision === 'approved';
      currentAction = `Approval ${approved ? 'approved' : 'denied'}`;
    }
  }
  return { currentAction, firstTime, lastTime };
}

// Kimi Code live agents from the session index + per-session wire tails.
function collectKimiAgents(homeDir, now = new Date()) {
  const agents = [];
  let lines;
  try {
    lines = fs.readFileSync(path.join(homeDir, '.kimi-code', 'session_index.jsonl'), 'utf8')
      .split('\n').filter(l => l.trim());
  } catch { return agents; }
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const sessionDir = rec?.sessionDir, sessionId = rec?.sessionId;
    if (typeof sessionDir !== 'string' || !sessionDir || typeof sessionId !== 'string' || !sessionId) continue;
    let refMs = null;                       // recency: state.json updatedAt, else dir mtime
    const st = readJSON(path.join(sessionDir, 'state.json'));
    if (st && typeof st.updatedAt === 'string') {
      const t = Date.parse(st.updatedAt);
      if (!Number.isNaN(t)) refMs = t;
    }
    if (refMs === null) { try { refMs = fs.statSync(sessionDir).mtimeMs; } catch { continue; } }
    if (now.getTime() - refMs > AGENT_RECENCY_MS) continue;
    let wirePath = null, wireM = 0;         // newest agents/*/wire.jsonl under the session dir
    try {
      for (const a of fs.readdirSync(path.join(sessionDir, 'agents'), { withFileTypes: true })) {
        if (!a.isDirectory()) continue;
        const p = path.join(sessionDir, 'agents', a.name, 'wire.jsonl');
        try {
          const s = fs.statSync(p);
          if (s.mtimeMs > wireM) { wireM = s.mtimeMs; wirePath = p; }
        } catch {}
      }
    } catch {}
    let currentAction = null, startedAt = null, lastMs = refMs;
    if (wirePath) {
      const info = parseKimiWireTail(readFileTailLines(wirePath));
      currentAction = info.currentAction;
      if (info.lastTime !== null) lastMs = info.lastTime;
      if (info.firstTime !== null) startedAt = new Date(info.firstTime).toISOString();
    }
    agents.push({
      id: `kimi:${sessionId}`, _session: `kimi:${sessionId}`, cli: 'kimi', roles: ['interactive'],
      project: typeof rec.workDir === 'string' && rec.workDir ? rec.workDir : null, pid: null,
      status: now.getTime() - lastMs < AGENT_ACTIVE_MS ? 'active' : 'idle',
      currentAction, startedAt, lastActivityAt: new Date(lastMs).toISOString(),
    });
  }
  return agents;
}

// Codex rollout tail: project from session_meta cwd; last event_msg decides the action
// (task_started → "Working", task_complete → "Idle"; token_count leaves it untouched).
function parseCodexRolloutTail(lines) {
  let cwd = null, currentAction = null, startedAt = null, lastTimestamp = null;
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.timestamp === 'string' && rec.timestamp) {
      if (!startedAt) startedAt = rec.timestamp;
      lastTimestamp = rec.timestamp;
    }
    if (rec.type === 'session_meta') {
      const c = rec.payload && typeof rec.payload === 'object' ? rec.payload.cwd : rec.cwd;
      if (typeof c === 'string' && c) cwd = c;
    } else if (rec.type === 'event_msg') {
      const pt = rec.payload && typeof rec.payload === 'object' ? rec.payload.type : null;
      if (pt === 'task_started') currentAction = 'Working';
      else if (pt === 'task_complete') currentAction = 'Idle';
    }
  }
  return { cwd, currentAction, startedAt, lastTimestamp };
}

// every ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, optionally only those naming `id`.
function* walkCodexRollouts(homeDir, id = null) {
  const root = path.join(homeDir, '.codex', 'sessions');
  let years;
  try { years = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const y of years) {
    if (!y.isDirectory()) continue;
    let months;
    try { months = fs.readdirSync(path.join(root, y.name), { withFileTypes: true }); } catch { continue; }
    for (const m of months) {
      if (!m.isDirectory()) continue;
      let days;
      try { days = fs.readdirSync(path.join(root, y.name, m.name), { withFileTypes: true }); } catch { continue; }
      for (const d of days) {
        if (!d.isDirectory()) continue;
        let files;
        try { files = fs.readdirSync(path.join(root, y.name, m.name, d.name)); } catch { continue; }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          if (id && !f.includes(id)) continue;
          yield path.join(root, y.name, m.name, d.name, f);
        }
      }
    }
  }
}

// Codex live agents: index entries touched recently, matched to their newest rollout file.
function collectCodexAgents(homeDir, now = new Date()) {
  const agents = [];
  let lines;
  try {
    lines = fs.readFileSync(path.join(homeDir, '.codex', 'session_index.jsonl'), 'utf8')
      .split('\n').filter(l => l.trim());
  } catch { return agents; }
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const id = rec?.id;
    if (typeof id !== 'string' || !id) continue;
    const upMs = typeof rec.updated_at === 'string' ? Date.parse(rec.updated_at) : NaN;
    if (Number.isNaN(upMs) || now.getTime() - upMs > AGENT_RECENCY_MS) continue;
    let rollout = null, rolloutM = 0;       // newest rollout file for this session, if also recent
    for (const p of walkCodexRollouts(homeDir, id)) {
      try {
        const st = fs.statSync(p);
        if (now.getTime() - st.mtimeMs <= AGENT_RECENCY_MS && st.mtimeMs > rolloutM) { rolloutM = st.mtimeMs; rollout = p; }
      } catch {}
    }
    if (!rollout) continue;
    const info = parseCodexRolloutTail(readFileTailLines(rollout));
    const lastActivityAt = info.lastTimestamp || new Date(rolloutM).toISOString();
    const lastMs = Date.parse(lastActivityAt);
    agents.push({
      id: `codex:${id}`, _session: `codex:${id}`, cli: 'codex', roles: ['interactive'],
      project: info.cwd, pid: null,
      status: !Number.isNaN(lastMs) && now.getTime() - lastMs < AGENT_ACTIVE_MS ? 'active' : 'idle',
      currentAction: info.currentAction, startedAt: info.startedAt, lastActivityAt,
    });
  }
  return agents;
}

// one `ps -axo pid=,comm=,args=` snapshot shared by pid attribution + daemon detection.
function parsePsTable(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), comm: m[2], args: (m[3] || '').trim() });
  }
  return rows;
}
function snapshotProcesses() {
  return new Promise(resolve => {
    try {
      execFile('ps', ['-axo', 'pid=,comm=,args='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => resolve(err ? [] : parsePsTable(stdout)));
    } catch { resolve([]); }
  });
}
function isObserverRow(row) {
  return row.args.includes('--output-format') && row.args.includes('stream-json');
}

// claude-flow daemons: the shared daemon-state.json (+ sibling daemon.pid), plus any
// per-workspace daemons and stream-json observers visible in the ps snapshot.
function collectClaudeFlowAgents(homeDir, psRows, now = new Date()) {
  const agents = [];
  const nowISO = now.toISOString();
  const stateDir = path.join(homeDir, '.claude-flow');
  const st = readJSON(path.join(stateDir, 'daemon-state.json'));
  if (st && st.running === true) {
    let pid = null;
    try {
      const n = Number(fs.readFileSync(path.join(stateDir, 'daemon.pid'), 'utf8').trim());
      if (Number.isInteger(n) && n > 0) pid = n;
    } catch {}
    const project = typeof st.workspace === 'string' && st.workspace ? st.workspace
      : (typeof st.cwd === 'string' && st.cwd ? st.cwd : null);
    agents.push({
      id: `claude-flow:daemon:${pid ?? 'state'}`, _session: null, cli: 'claude-flow', roles: ['daemon'],
      project, pid, status: 'active', currentAction: null,
      startedAt: typeof st.launchedAt === 'string' ? st.launchedAt : null, lastActivityAt: nowISO,
    });
  }
  for (const row of psRows) {
    if (row.args.includes('@claude-flow/cli') && /(^|\s)daemon(\s|$)/.test(row.args)) {
      const m = row.args.match(/--workspace(?:=|\s+)(\S+)/);
      agents.push({
        id: `claude-flow:daemon:pid-${row.pid}`, _session: null, cli: 'claude-flow', roles: ['daemon'],
        project: m ? m[1] : null, pid: row.pid, status: 'active', currentAction: null,
        startedAt: null, lastActivityAt: nowISO,
      });
    } else if (isObserverRow(row)) {
      agents.push({
        id: `claude:observer:pid-${row.pid}`, _session: null, cli: 'claude', roles: ['observer'],
        project: null, pid: row.pid, status: 'active', currentAction: null,
        startedAt: null, lastActivityAt: nowISO,
      });
    }
  }
  return agents;
}

// mark pids on interactive agents by exact executable-basename match — only when the
// mapping is unambiguous (exactly one live process for exactly one agent of that cli).
function assignInteractivePids(agents, psRows) {
  const pool = psRows.filter(r => !isObserverRow(r));   // stream-json observers are their own entries
  for (const cli of ['claude', 'kimi', 'codex']) {
    const pids = [...new Set(pool.filter(r => path.basename(r.comm) === cli).map(r => r.pid))];
    const targets = agents.filter(a => a.cli === cli && a.roles.includes('interactive') && a.pid === null);
    if (pids.length === 1 && targets.length === 1) targets[0].pid = pids[0];
  }
}

// one logical agent seen from several sources (same session id, or same pid) becomes one
// entry with the union of roles; null fields are filled from the other sightings.
function mergeAgentEntries(entries) {
  const merged = [];
  for (const e of entries) {
    const dup = merged.find(o =>
      (e._session && o._session === e._session) ||
      (e.pid !== null && o.pid === e.pid));
    if (!dup) { merged.push(e); continue; }
    dup.roles = [...new Set([...dup.roles, ...e.roles])];
    for (const k of ['project', 'currentAction', 'startedAt']) if (dup[k] === null && e[k] !== null) dup[k] = e[k];
    if (dup.pid === null) dup.pid = e.pid;
    if (e.status === 'active') dup.status = 'active';
    if (e.lastActivityAt > dup.lastActivityAt) dup.lastActivityAt = e.lastActivityAt;
  }
  return merged;
}

async function buildAgentsEnvelope() {
  const now = new Date();
  const psRows = await snapshotProcesses();
  const agents = mergeAgentEntries([
    ...collectClaudeAgents(path.join(HOME, '.claude', 'projects'), now),
    ...collectKimiAgents(HOME, now),
    ...collectCodexAgents(HOME, now),
    ...collectClaudeFlowAgents(HOME, psRows, now),
  ]);
  assignInteractivePids(agents, psRows);
  return {
    schemaVersion: 1, ok: true, generatedAt: now.toISOString(),
    agents: agents.map(({ _session, ...pub }) => pub),
  };
}
async function cmdAgents(rest) {
  const wantsJSON = rest.includes('--json');
  try {
    const flags = parseStrictFlags(rest, new Set(), new Set(['--json']));
    if (!flags['--json']) throw aiError('invalid_arguments', 'pm agents requires --json.');
    console.log(JSON.stringify(await buildAgentsEnvelope()));
  } catch (err) {
    if (wantsJSON) emitAIJSONFailure(err);
    else { console.error(err instanceof AIProviderError ? err.message : 'pm agents: command failed'); process.exitCode = 1; }
  }
}

// ── pm burn: token usage + spend across claude / kimi / codex, plus coding time ──

const BURN_CACHE_PATH = path.join(RUNTIME_DIR, 'burn-cache-v1.json');
const BURN_CACHE_MAX_AGE_MS = 60_000;

// USD per 1M tokens, matched by model-id prefix (first match wins). Unknown models fall
// back to the sonnet row and are reported under `unpricedModels`.
const CLAUDE_PRICE_TABLE = [
  ['claude-opus-4', { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 }],
  ['claude-3-5-sonnet', { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 }],
  ['claude-3.5', { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 }],
  ['claude-haiku-4', { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 }],
  ['claude-3-5-haiku', { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 }],
  ['claude-3-haiku', { input: 0.25, output: 1.25, cacheWrite: 0.30, cacheRead: 0.03 }],
];
const CLAUDE_PRICE_FALLBACK = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };
function priceRowForModel(model) {
  const m = String(model || '');
  for (const [prefix, row] of CLAUDE_PRICE_TABLE) if (m.startsWith(prefix)) return { row, priced: true };
  return { row: CLAUDE_PRICE_FALLBACK, priced: false };
}
function costForUsage(model, usage) {
  const { row, priced } = priceRowForModel(model);
  const costUsd = (numOr(usage?.input) * row.input + numOr(usage?.output) * row.output +
    numOr(usage?.cacheWrite) * row.cacheWrite + numOr(usage?.cacheRead) * row.cacheRead) / 1e6;
  return { costUsd, priced };
}
function numOr(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
const round6 = n => Math.round(n * 1e6) / 1e6;
const round1 = n => Math.round(n * 10) / 10;

// local-timezone calendar day key — all burn bucketing is by local day.
function localDayKey(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// date keys for the last `n` local calendar days including today, oldest first.
function dayKeysForWindow(now, n) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--)
    keys.push(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12).getTime()));
  return keys;
}

function emptyTokenBucket() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; }
// bucket usage records ({ms, input, output, cacheRead, cacheWrite, cost?}) by local day.
// today/week/month are TOTAL token counts (all four components summed) as plain ints;
// byDay lists the 4-component breakdown for days with data inside the `days` window,
// oldest first. (Shape frozen by mac/Sources/FoldviewMenuBar/Data/BurnPayload.swift.)
function bucketByDay(records, now = new Date(), days = 30) {
  const buckets = new Map(), costByDay = new Map();
  for (const r of records) {
    if (!r || typeof r.ms !== 'number' || Number.isNaN(r.ms)) continue;
    const key = localDayKey(r.ms);
    const b = buckets.get(key) || emptyTokenBucket();
    b.input += numOr(r.input); b.output += numOr(r.output);
    b.cacheRead += numOr(r.cacheRead); b.cacheWrite += numOr(r.cacheWrite);
    buckets.set(key, b);
    if (typeof r.cost === 'number') costByDay.set(key, (costByDay.get(key) || 0) + r.cost);
  }
  const inWindow = new Set(dayKeysForWindow(now, days));
  const byDay = [...buckets.keys()].filter(k => inWindow.has(k)).sort()
    .map(date => ({ date, ...buckets.get(date) }));
  const sumKeys = keys => {
    let total = 0;
    for (const k of keys) {
      const b = buckets.get(k);
      if (b) total += b.input + b.output + b.cacheRead + b.cacheWrite;
    }
    return total;
  };
  const sumCost = keys => round6(keys.reduce((acc, k) => acc + (costByDay.get(k) || 0), 0));
  return {
    today: sumKeys(dayKeysForWindow(now, 1)),
    week: sumKeys(dayKeysForWindow(now, 7)),
    month: sumKeys(dayKeysForWindow(now, 30)),
    costToday: sumCost(dayKeysForWindow(now, 1)),
    costWeek: sumCost(dayKeysForWindow(now, 7)),
    costMonth: sumCost(dayKeysForWindow(now, 30)),
    byDay,
  };
}

// stream a JSONL file line-by-line — transcripts can be 100+ MB, never load them whole.
function streamJsonLines(filePath, onLine) {
  return new Promise(resolve => {
    let input;
    try { input = fs.createReadStream(filePath, 'utf8'); } catch { resolve(); return; }
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', line => { try { onLine(line); } catch {} });
    rl.on('close', resolve);
    input.on('error', () => { try { rl.close(); } catch {} resolve(); });
  });
}
// cheap "timestamp" scrape from a raw line — avoids JSON.parse on lines we only need
// for the coding-time union. Returns epoch ms or null.
function rawTimestampMs(line) {
  if (!line.includes('"timestamp"')) return null;
  const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}

// one Claude Code assistant usage line → normalized {model, ms, usage}, or null.
function parseClaudeUsageLine(line) {
  if (!line.includes('"usage"')) return null;
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  const usage = rec?.message?.usage, model = rec?.message?.model;
  if (!usage || typeof usage !== 'object' || typeof model !== 'string' || !model) return null;
  const ms = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  return {
    model, ms: Number.isNaN(ms) ? null : ms,
    usage: {
      input: numOr(usage.input_tokens), output: numOr(usage.output_tokens),
      cacheRead: numOr(usage.cache_read_input_tokens), cacheWrite: numOr(usage.cache_creation_input_tokens),
    },
  };
}

async function scanClaudeUsage(homeDir, now, days) {
  const records = [], timestamps = [], byModel = new Map(), unpriced = new Set();
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  let slugs = [];
  try { slugs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch {}
  for (const d of slugs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      await streamJsonLines(path.join(dir, f), line => {
        const ts = rawTimestampMs(line);           // every record feeds the coding-time union
        if (ts !== null) timestamps.push(ts);
        const u = parseClaudeUsageLine(line);      // cheap substring gate inside
        if (!u) return;
        const { costUsd, priced } = costForUsage(u.model, u.usage);
        const bm = byModel.get(u.model) || { ...emptyTokenBucket(), costUsd: 0 };
        bm.input += u.usage.input; bm.output += u.usage.output;
        bm.cacheRead += u.usage.cacheRead; bm.cacheWrite += u.usage.cacheWrite;
        bm.costUsd += costUsd;
        byModel.set(u.model, bm);
        if (!priced) unpriced.add(u.model);
        if (u.ms !== null) records.push({ ms: u.ms, ...u.usage, cost: costUsd });
      });
    }
  }
  const buckets = bucketByDay(records, now, days);
  const byModelOut = {};
  let totalInput = 0, totalCacheRead = 0;
  for (const model of [...byModel.keys()].sort()) {
    const bm = byModel.get(model);
    byModelOut[model] = { input: bm.input, output: bm.output, cacheRead: bm.cacheRead, cacheWrite: bm.cacheWrite, costUsd: round6(bm.costUsd) };
    totalInput += bm.input; totalCacheRead += bm.cacheRead;
  }
  return {
    section: {
      tokens: { today: buckets.today, week: buckets.week, month: buckets.month, byDay: buckets.byDay },
      byModel: byModelOut,
      costUsd: { today: buckets.costToday, week: buckets.costWeek, month: buckets.costMonth },
      cacheHitPct: totalInput + totalCacheRead > 0 ? round1(100 * totalCacheRead / (totalInput + totalCacheRead)) : 0,
      unpricedModels: [...unpriced].sort(),
    },
    timestamps,
  };
}

// one Kimi Code usage.record line → normalized {ms, input, output, cacheRead, cacheWrite}, or null.
function parseKimiUsageLine(line) {
  if (!line.includes('"usage.record"')) return null;
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec?.type !== 'usage.record') return null;
  const u = rec.usage && typeof rec.usage === 'object' ? rec.usage : {};
  return {
    ms: typeof rec.time === 'number' && Number.isFinite(rec.time) ? rec.time : null,
    input: numOr(u.inputOther), output: numOr(u.output),
    cacheRead: numOr(u.inputCacheRead), cacheWrite: numOr(u.inputCacheCreation),
  };
}
// every ~/.kimi-code/sessions/<a>/<b>/agents/<agent>/wire.jsonl
function* walkKimiWireFiles(homeDir) {
  const root = path.join(homeDir, '.kimi-code', 'sessions');
  let lvl1;
  try { lvl1 = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const a of lvl1) {
    if (!a.isDirectory()) continue;
    let lvl2;
    try { lvl2 = fs.readdirSync(path.join(root, a.name), { withFileTypes: true }); } catch { continue; }
    for (const b of lvl2) {
      if (!b.isDirectory()) continue;
      const agentsDir = path.join(root, a.name, b.name, 'agents');
      let ags;
      try { ags = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { continue; }
      for (const ag of ags) {
        if (!ag.isDirectory()) continue;
        const p = path.join(agentsDir, ag.name, 'wire.jsonl');
        if (fs.existsSync(p)) yield p;
      }
    }
  }
}

async function scanKimiUsage(homeDir, now, days) {
  const records = [], timestamps = [];
  for (const file of walkKimiWireFiles(homeDir)) {
    await streamJsonLines(file, line => {
      if (line.includes('"time"')) {               // every timed record feeds the coding-time union
        const m = /"time"\s*:\s*(\d{9,})/.exec(line);
        if (m) timestamps.push(Number(m[1]));
      }
      const u = parseKimiUsageLine(line);
      if (u && u.ms !== null) records.push(u);
    });
  }
  const buckets = bucketByDay(records, now, days);
  return {
    section: {
      tokens: { today: buckets.today, week: buckets.week, month: buckets.month, byDay: buckets.byDay },
      note: 'subscription',
    },
    timestamps,
  };
}

// one Codex event_msg token_count line → {ms, usage, rateLimits}, or null.
function parseCodexTokenCountLine(line) {
  if (!line.includes('"token_count"')) return null;
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec?.type !== 'event_msg' || rec?.payload?.type !== 'token_count') return null;
  const t = rec.payload.info?.total_token_usage;
  if (!t || typeof t !== 'object') return null;
  const ms = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  return {
    ms: Number.isNaN(ms) ? null : ms,
    rateLimits: rec.payload.rate_limits && typeof rec.payload.rate_limits === 'object' ? rec.payload.rate_limits : null,
    usage: {
      input: numOr(t.input_tokens), output: numOr(t.output_tokens),
      cached: numOr(t.cached_input_tokens), total: numOr(t.total_tokens),
    },
  };
}
function codexQuotaFromRateLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const first = (...vals) => vals.find(v => v && typeof v === 'object') || {};
  const primary = first(rl.primary_rate_limit, rl.primary, rl);
  const rawResets = numOr(primary.resets_at ?? primary.resetsAt);
  let resetsAt = null;
  if (rawResets > 0) {
    const ms = rawResets < 1e12 ? rawResets * 1000 : rawResets;   // epoch seconds or ms
    resetsAt = new Date(ms).toISOString();
  }
  const credits = rl.credits && typeof rl.credits === 'object' ? rl.credits : {};
  return {
    usedPercent: numOr(primary.used_percent ?? primary.usedPercent),
    windowMinutes: numOr(primary.window_minutes ?? primary.windowMinutes),
    resetsAt,
    creditBalance: credits.balance != null && Number.isFinite(Number(credits.balance)) ? Number(credits.balance) : null,
    planType: typeof rl.plan_type === 'string' ? rl.plan_type : (typeof rl.planType === 'string' ? rl.planType : null),
  };
}

async function scanCodexUsage(homeDir) {
  const totals = { input: 0, output: 0, cached: 0, total: 0 };
  const timestamps = [];
  let newest = null;                               // newest token_count record overall (for rate limits)
  for (const file of walkCodexRollouts(homeDir)) {
    let last = null;                               // codex usage is cumulative — latest per rollout wins
    await streamJsonLines(file, line => {
      const ts = rawTimestampMs(line);
      if (ts !== null) timestamps.push(ts);
      const u = parseCodexTokenCountLine(line);
      if (u) last = u;
    });
    if (!last) continue;
    totals.input += last.usage.input; totals.output += last.usage.output;
    totals.cached += last.usage.cached; totals.total += last.usage.total;
    if (!newest || (last.ms !== null && (newest.ms === null || last.ms > newest.ms))) newest = last;
  }
  return { section: { tokens: { total: totals }, quota: codexQuotaFromRateLimits(newest?.rateLimits) }, timestamps };
}

// coding time: per local day, sort unique event timestamps; each event counts >= 30s,
// and gaps of <= 5 min to the next event count in full. Sessions break on longer gaps.
function codingMinutesByDay(timestamps) {
  const groups = new Map();
  for (const ms of timestamps) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
    const key = localDayKey(ms);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(ms);
  }
  // Wall-clock segments: merge events separated by ≤5 min gaps into one span, then
  // credit a small tail per segment for work after the last event. Per-event floors
  // would let dense agent days exceed 24h, which reads as nonsense in the UI.
  const GAP = 5 * 60_000;
  const TAIL = 2 * 60_000;
  const out = new Map();
  for (const [key, set] of groups) {
    const sorted = [...set].sort((a, b) => a - b);
    let totalMs = 0;
    let segStart = null;
    let segEnd = null;
    for (const t of sorted) {
      if (segStart === null) { segStart = t; segEnd = t; continue; }
      if (t - segEnd <= GAP) { segEnd = t; continue; }
      totalMs += (segEnd - segStart) + TAIL;
      segStart = t;
      segEnd = t;
    }
    if (segStart !== null) totalMs += (segEnd - segStart) + TAIL;
    out.set(key, Math.min(totalMs / 60_000, 24 * 60));
  }
  return out;
}
// coding minutes per local day as INTEGERS (the BurnPayload.swift CodingTime contract):
// each day's raw minutes are rounded, and the rollups sum the rounded day values so the
// envelope is internally consistent.
function buildCodingTimeSection(timestamps, now, days) {
  const byDayMap = codingMinutesByDay(timestamps);
  const rounded = new Map([...byDayMap].map(([k, v]) => [k, Math.round(v)]));
  const inWindow = new Set(dayKeysForWindow(now, days));
  const byDay = [...rounded.keys()].filter(k => inWindow.has(k)).sort()
    .map(date => ({ date, minutes: rounded.get(date) }));
  const sumKeys = keys => keys.reduce((acc, k) => acc + (rounded.get(k) || 0), 0);
  let total = 0;
  for (const v of rounded.values()) total += v;
  return {
    todayMin: sumKeys(dayKeysForWindow(now, 1)),
    weekMin: sumKeys(dayKeysForWindow(now, 7)),
    monthMin: sumKeys(dayKeysForWindow(now, 30)),
    totalMin: total,
    byDay,
  };
}

// one `gh api graphql` call for the last `days` of commit contributions. Any failure
// (gh missing, not logged in, network) is reported as a typed section error upstream.
function fetchGithubContributions(now, days = 30) {
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const query = 'query { viewer { login contributionsCollection(from:"' + from + '",to:"' + now.toISOString() + '") { ' +
    'totalCommitContributions commitContributionsByRepository(maxRepositories:25) { repository { nameWithOwner } contributions { totalCount } } } } }';
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', 'graphql', '-f', `query=${query}`], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(stderr?.trim() || err.message)); return; }
        try {
          const viewer = JSON.parse(stdout)?.data?.viewer;
          if (!viewer || typeof viewer !== 'object') throw new Error('unexpected gh response');
          const cc = viewer.contributionsCollection || {};
          resolve({
            login: typeof viewer.login === 'string' ? viewer.login : null,
            commits30d: numOr(cc.totalCommitContributions),
            byRepo: (Array.isArray(cc.commitContributionsByRepository) ? cc.commitContributionsByRepository : [])
              .map(r => ({ repo: r?.repository?.nameWithOwner || '', commits: numOr(r?.contributions?.totalCount) })),
          });
        } catch (e) { reject(e); }
      });
  });
}

function burnErrorSection(code, err) {
  return { error: { code, message: sanitizeAIText(String(err && err.message || err), 200) } };
}
async function buildBurnEnvelope(homeDir, now = new Date(), days = 30) {
  const sections = {};
  const timestamps = [];
  let sources = 0;
  const scans = [
    ['claude', () => scanClaudeUsage(homeDir, now, days)],
    ['kimi', () => scanKimiUsage(homeDir, now, days)],
    ['codex', () => scanCodexUsage(homeDir)],
  ];
  for (const [name, scan] of scans) {
    try {
      const { section, timestamps: ts } = await scan();
      sections[name] = section;
      timestamps.push(...ts);
      sources++;
    } catch (err) { sections[name] = burnErrorSection(`${name}-scan-failed`, err); }
  }
  sections.codingTime = sources > 0
    ? buildCodingTimeSection(timestamps, now, days)
    : burnErrorSection('no-sources', 'All usage sources failed.');
  try { sections.github = await fetchGithubContributions(now, days); }
  catch (err) { sections.github = burnErrorSection('gh-unavailable', err); }
  const anyOk = ['claude', 'kimi', 'codex', 'codingTime', 'github'].some(k => !sections[k]?.error);
  return { schemaVersion: 1, ok: anyOk, generatedAt: now.toISOString(), days, ...sections };
}
async function cmdBurn(rest) {
  const wantsJSON = rest.includes('--json');
  try {
    const flags = parseStrictFlags(rest, new Set(['--days']), new Set(['--json', '--refresh']));
    if (!flags['--json']) throw aiError('invalid_arguments', 'pm burn requires --json.');
    let days = 30;
    if (flags['--days'] !== undefined) {
      if (!/^\d+$/.test(flags['--days'])) throw aiError('invalid_arguments', 'pm burn: --days must be a positive integer.');
      days = Number(flags['--days']);
      if (days < 1 || days > 365) throw aiError('invalid_arguments', 'pm burn: --days must be between 1 and 365.');
    }
    if (!flags['--refresh']) {                   // fresh cache (< 60s) wins over recomputing
      try {
        if (Date.now() - fs.statSync(BURN_CACHE_PATH).mtimeMs < BURN_CACHE_MAX_AGE_MS) {
          console.log(fs.readFileSync(BURN_CACHE_PATH, 'utf8'));
          return;
        }
      } catch {}
    }
    const envelope = await buildBurnEnvelope(HOME, new Date(), days);
    const text = JSON.stringify(envelope);
    try {                                        // atomic cache write: tmp file + rename
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      const tmp = BURN_CACHE_PATH + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, BURN_CACHE_PATH);
    } catch {}
    console.log(text);
  } catch (err) {
    if (wantsJSON) emitAIJSONFailure(err);
    else { console.error(err instanceof AIProviderError ? err.message : 'pm burn: command failed'); process.exitCode = 1; }
  }
}

// ── pm hook-bridge: stdin shim called by Claude Code / Kimi Code hooks ──
// Fail-open by design: a hook shim must NEVER break the user's tool call, so every
// failure path (bad stdin, missing bridge, refused connection, timeout) exits 0 silently.

const NOTCH_BRIDGE_PATH = path.join(RUNTIME_DIR, 'notch-bridge-v1.json');
const HOOK_BRIDGE_EVENT_TIMEOUT_MS = 5_000;
const HOOK_BRIDGE_APPROVE_TIMEOUT_MS = 250_000;

function readStdinText() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
      if (data.length > AI_MAX_INPUT_BYTES) { try { process.stdin.destroy(); } catch {} resolve(data); }
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}
// POST the hook payload to the running notch bridge. Returns 0 always; prints the bridge's
// response verbatim ONLY for claude PreToolUse when it is valid JSON carrying
// hookSpecificOutput (the contract Claude Code reads back from a permission hook).
async function runHookBridge({ cli, event, stdin, stdout, statePath = NOTCH_BRIDGE_PATH, fetchImpl = globalThis.fetch }) {
  const out = stdout || process.stdout;
  try {
    if (cli !== 'claude' && cli !== 'kimi') return 0;
    if (typeof event !== 'string' || !event || typeof fetchImpl !== 'function') return 0;
    const raw = stdin === undefined || stdin === null ? await readStdinText() : String(stdin);
    let payload;
    try { payload = JSON.parse(raw); } catch { return 0; }
    const state = readJSON(statePath);
    const port = Number(state?.port);
    const token = typeof state?.token === 'string' ? state.token : '';
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) return 0;
    const isApprove = cli === 'claude' && event === 'PreToolUse';
    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}${isApprove ? '/approve' : '/event'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ cli, event, payload }),
        signal: AbortSignal.timeout(isApprove ? HOOK_BRIDGE_APPROVE_TIMEOUT_MS : HOOK_BRIDGE_EVENT_TIMEOUT_MS),
      });
    } catch { return 0; }                        // refused / timeout / aborted — silent
    if (!isApprove) { try { await res.arrayBuffer(); } catch {} return 0; }   // drain + ignore
    if (res.status !== 200) { try { await res.arrayBuffer(); } catch {} return 0; }
    let text;
    try { text = await res.text(); } catch { return 0; }
    let parsed;
    try { parsed = JSON.parse(text); } catch { return 0; }
    if (parsed && typeof parsed === 'object' && 'hookSpecificOutput' in parsed) out.write(text);
    return 0;
  } catch { return 0; }
}
function cmdHookBridge(rest) {
  return runHookBridge({ cli: rest[0], event: rest[1] });
}

// ── pm hooks: install / uninstall / status for the two CLI hook configs ──

const CLAUDE_HOOK_EVENTS = [
  { event: 'PreToolUse', timeout: 300, matcher: '' },
  { event: 'SessionStart', timeout: 10 },
  { event: 'SessionEnd', timeout: 10 },
  { event: 'Stop', timeout: 10 },
  { event: 'SubagentStart', timeout: 10 },
  { event: 'SubagentStop', timeout: 10 },
  { event: 'Notification', timeout: 10 },
];
const KIMI_HOOK_EVENTS = [
  { event: 'PreToolUse', timeout: 300, matcher: '' },
  { event: 'PermissionRequest', timeout: 10 },
  { event: 'PermissionResult', timeout: 10 },
  { event: 'SessionStart', timeout: 10 },
  { event: 'SessionEnd', timeout: 10 },
  { event: 'SubagentStart', timeout: 10 },
  { event: 'SubagentStop', timeout: 10 },
];
const HOOK_MARKER = '# foldview-notch-hook';

// absolute path of the running pm/folder.mjs — hooks spawn `node <this> hook-bridge …`,
// so PATH doesn't matter inside the hook. Falls back to this module's own file when
// argv[1] isn't us (e.g. imported under node --test).
function pmScriptPath() {
  const fromArgv = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (fromArgv) {
    try { if (fs.realpathSync(fromArgv) === fs.realpathSync(SELF_FILE)) return fromArgv; } catch {}
  }
  return SELF_FILE;
}
function hookBridgeCommand(absPm, cli, event) {
  const pm = /\s/.test(absPm) ? `"${absPm}"` : absPm;
  return `node ${pm} hook-bridge ${cli} ${event}`;
}

// add our entries to a parsed Claude settings object (idempotent, existing hooks preserved).
// Returns the events added this run.
function installClaudeHookEntries(settings, absPm) {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  const added = [];
  for (const { event, timeout, matcher } of CLAUDE_HOOK_EVENTS) {
    const command = hookBridgeCommand(absPm, 'claude', event);
    const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : (settings.hooks[event] = []);
    const exists = list.some(entry => Array.isArray(entry?.hooks) &&
      entry.hooks.some(h => h?.command === command));
    if (exists) continue;
    const entry = {};
    if (matcher !== undefined) entry.matcher = matcher;
    entry.hooks = [{ type: 'command', command, timeout }];
    list.push(entry);
    added.push(event);
  }
  return added;
}
// remove exactly our entries (matched by `hook-bridge` in the command string), keeping
// any other hooks on the same event entry. Returns the events we removed something from.
function uninstallClaudeHookEntries(settings) {
  const removed = [];
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return removed;
  for (const event of Object.keys(hooks)) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = [];
    for (const entry of list) {
      if (Array.isArray(entry?.hooks)) {
        entry.hooks = entry.hooks.filter(h => !(typeof h?.command === 'string' && h.command.includes('hook-bridge')));
        if (entry.hooks.length === 0) { removed.push(event); continue; }
      }
      kept.push(entry);
    }
    if (kept.length) hooks[event] = kept;
    else if (list.length) delete hooks[event];
  }
  return removed;
}
// events (of ours) currently present in a parsed Claude settings object.
function claudeHookEventsInstalled(settings) {
  const events = [];
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return events;
  for (const { event } of CLAUDE_HOOK_EVENTS) {
    const list = hooks[event];
    if (Array.isArray(list) && list.some(entry => Array.isArray(entry?.hooks) &&
      entry.hooks.some(h => typeof h?.command === 'string' && h.command.includes(`hook-bridge claude ${event}`))))
      events.push(event);
  }
  return events;
}

function kimiHookBlock(absPm, { event, timeout, matcher }) {
  const lines = [HOOK_MARKER, '[[hooks]]', `event = "${event}"`];
  if (matcher !== undefined) lines.push(`matcher = "${matcher}"`);
  lines.push(`command = "${hookBridgeCommand(absPm, 'kimi', event).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    `timeout = ${timeout}`);
  return lines.join('\n');
}
// events already installed inside marked foldview blocks (line-based, no TOML parse).
function kimiHookEventsPresent(tomlText) {
  const events = [];
  let marked = false;
  for (const line of String(tomlText).split('\n')) {
    if (line.trim() === HOOK_MARKER) { marked = true; continue; }
    if (marked) {
      const m = line.match(/^\s*event\s*=\s*"([^"]+)"/);
      if (m) { events.push(m[1]); marked = false; }
    }
  }
  return events;
}
// append marked [[hooks]] blocks for any missing event; everything else stays byte-identical.
function installKimiHookBlocks(tomlText, absPm) {
  let out = String(tomlText);
  const added = [];
  for (const spec of KIMI_HOOK_EVENTS) {
    if (kimiHookEventsPresent(out).includes(spec.event)) continue;
    if (out.length && !out.endsWith('\n')) out += '\n';
    out += '\n' + kimiHookBlock(absPm, spec) + '\n';
    added.push(spec.event);
  }
  return { text: out, added };
}
// remove each marked block: the marker comment line plus the contiguous non-blank lines
// of its [[hooks]] table, and the single blank separator line install put before the
// marker. Unmarked content is never touched or reordered (uninstall after install is a
// byte-identical restore).
function uninstallKimiHookBlocks(tomlText) {
  const lines = String(tomlText).split('\n');
  const kept = [], removed = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === HOOK_MARKER) {
      if (kept.length && kept[kept.length - 1].trim() === '' &&
          (kept.length < 2 || kept[kept.length - 2].trim() !== ''))
        kept.pop();
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '') {
        const m = lines[j].match(/^\s*event\s*=\s*"([^"]+)"/);
        if (m) removed.push(m[1]);
        j++;
      }
      i = j;                                   // skip marker + its block lines
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  return { text: kept.join('\n'), removed };
}

// one-time backup next to the original, created before our first mutation only.
function backupOnce(filePath) {
  try {
    const bak = filePath + '.foldview-bak';
    if (!fs.existsSync(bak) && fs.existsSync(filePath)) fs.copyFileSync(filePath, bak);
  } catch {}
}
function bridgeStatus() {
  const st = readJSON(NOTCH_BRIDGE_PATH);
  const pid = Number(st?.pid);
  if (st && Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
    const out = { running: true };
    if (Number.isInteger(Number(st.port))) out.port = Number(st.port);
    return out;
  }
  return { running: false };
}
function hooksStatus() {
  const claudeEvents = claudeHookEventsInstalled(readJSON(path.join(HOME, '.claude', 'settings.json')));
  const kimiEvents = kimiHookEventsPresent(
    fs.existsSync(path.join(HOME, '.kimi-code', 'config.toml'))
      ? fs.readFileSync(path.join(HOME, '.kimi-code', 'config.toml'), 'utf8') : '');
  return {
    schemaVersion: 1, ok: true,
    claude: { installed: claudeEvents.length === CLAUDE_HOOK_EVENTS.length, events: claudeEvents },
    kimi: { installed: kimiEvents.length === KIMI_HOOK_EVENTS.length, events: kimiEvents },
    bridge: bridgeStatus(),
  };
}
function cmdHooks(rest) {
  const sub = rest[0];
  if (sub !== 'install' && sub !== 'uninstall' && sub !== 'status') {
    console.error('pm hooks: expected install, uninstall, or status');
    process.exitCode = 1;
    return;
  }
  if (sub === 'status') { console.log(JSON.stringify(hooksStatus())); return; }
  const absPm = pmScriptPath();
  const claudePath = path.join(HOME, '.claude', 'settings.json');
  const kimiPath = path.join(HOME, '.kimi-code', 'config.toml');

  // Claude: JSON parse failure ⇒ typed failure, file left untouched.
  let settings = {};
  const claudeExisted = fs.existsSync(claudePath);
  if (claudeExisted) {
    const raw = fs.readFileSync(claudePath, 'utf8');
    if (raw.trim()) {
      try { settings = JSON.parse(raw); } catch {
        emitAIJSONFailure(aiError('config_read_failed',
          'Claude settings.json could not be parsed; leaving it untouched.'));
        return;
      }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        emitAIJSONFailure(aiError('config_read_failed',
          'Claude settings.json is not a JSON object; leaving it untouched.'));
        return;
      }
    }
  }
  if (sub === 'install') {
    backupOnce(claudePath);
    installClaudeHookEntries(settings, absPm);
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.writeFileSync(claudePath, JSON.stringify(settings, null, 2) + '\n');
  } else if (claudeExisted) {
    uninstallClaudeHookEntries(settings);
    fs.writeFileSync(claudePath, JSON.stringify(settings, null, 2) + '\n');
  }

  // Kimi: line-based TOML mutation; unmarked content is preserved verbatim.
  const kimiExisted = fs.existsSync(kimiPath);
  const kimiText = kimiExisted ? fs.readFileSync(kimiPath, 'utf8') : '';
  let kimiOut = kimiText;
  if (sub === 'install') {
    backupOnce(kimiPath);
    kimiOut = installKimiHookBlocks(kimiText, absPm).text;
    fs.mkdirSync(path.dirname(kimiPath), { recursive: true });
    fs.writeFileSync(kimiPath, kimiOut);
  } else if (kimiExisted) {
    kimiOut = uninstallKimiHookBlocks(kimiText).text;
    if (kimiOut !== kimiText) fs.writeFileSync(kimiPath, kimiOut);
  }
  console.log(JSON.stringify(hooksStatus()));
}

const SUBCOMMANDS = new Set(['status', 'roots', 'action', 'ai', 'config', 'aiclis', 'menubar', 'serve', 'agents', 'burn', 'hook-bridge', 'hooks']);
function dispatchSubcommand(cmd, rest) {
  switch (cmd) {
    case 'status': return cmdStatus(rest);
    case 'roots': return cmdRoots(rest);
    case 'action': return cmdAction(rest);
    case 'ai': return cmdAI(rest);
    case 'config': return cmdConfig(rest);
    case 'aiclis': return cmdAIClis(rest);
    case 'menubar': return cmdMenubar(rest);
    case 'serve': return cmdServe(rest);
    case 'agents': return cmdAgents(rest);
    case 'burn': return cmdBurn(rest);
    case 'hook-bridge': return cmdHookBridge(rest);
    case 'hooks': return cmdHooks(rest);
  }
}

// ────────────────────────────── main ──────────────────────────────────
// When launched with no explicit path, prefer ~/Documents (the user's real project home) over
// the current working directory — so `foldview` from anywhere lists the same, focused set of
// projects instead of sweeping whatever folder you happen to be standing in. An explicit path
// argument still wins. Falls back to cwd if ~/Documents doesn't exist.
function defaultRoot() {
  const docs = path.join(HOME, 'Documents');
  try { if (fs.statSync(docs).isDirectory()) return docs; } catch {}
  return process.cwd();
}

function main() {
  const argv = process.argv.slice(2);
  if (SUBCOMMANDS.has(argv[0])) {
    return Promise.resolve(dispatchSubcommand(argv[0], argv.slice(1)))
      .catch(err => { console.error(String(err && err.message || err)); process.exitCode = 1; });
  }

  const flags = new Set(argv.filter(a => a.startsWith('-')));
  const pathArg = argv.find(a => !a.startsWith('-'));
  const root = path.resolve(pathArg || defaultRoot());

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
  parseLsofListeners,
  detectApps, parseAppInput, mergeDiscovered, readConfig, addUserApp, removeUserApp,
  // config
  writeConfig, updateConfig, ensureConfigDefaults, CONFIG_PATH,
  // AI terminals
  KNOWN_AI_CLIS, resolveExecutable, assignFreeKey, discoverAIClis, resolveCustomCli, saveCustomCli,
  AIProviderError, classifyAIProvider, executableFile, providerConfigPath, parseCodexCatalogPayload, parseTomlSubset,
  parseKimiCatalogSource, readAIProviderDefaults, writeAIProviderDefaults, loadCodexCatalog,
  loadKimiCatalog, buildAIProviderCatalog, validateAISelection, availableProviderCatalog,
  prepareAIValidatedLaunch, buildAIProviderLaunch,
  computeGrid, getMainDisplayBounds, buildAITerminalsScript, buildAITerminalCommand,
  spawnAITerminals, launchAITerminals, shq, asq, quoteEnv,
  // GitHub push
  DEFAULT_GITIGNORE, sanitizeRepoName, repoNameFor, webUrlFromRemote, planPush, footerGh,
  // managed runtime registry
  RUNTIME_PATH, loadRuntimeRegistry, writeRuntimeRegistry, recordRuntimeEntry, removeRuntimeEntry,
  isPidAlive, pidCommandMatches, pidCwd, validateOwnership, findOwnedRegistryEntry, realpathSafe,
  // CLI bridge
  parseFlagValue, parseStrictFlags, lightProjectInfo, buildMenubarStatus, cmdStatus, cmdRoots, cmdAI, cmdConfig, cmdAIClis, cmdAction, cmdMenubar,
  inspectMenubarInstallation, installedMenubarVersion, menubarIsRunning, writeCLIPathRecord, MENUBAR_APP_PATH, CLI_PATH_RECORD,
  dispatchSubcommand, actionOpen, actionStart, actionStop, actionEditor, actionAi,
  // static site serving
  staticSiteDir, cmdServe, startStaticServer, isSelfProject,
  // telemetry: agents / burn / hook bridge / hook config
  readFileTailLines, parseTranscriptTail, parseKimiWireTail, parseCodexRolloutTail,
  collectClaudeAgents, collectKimiAgents, collectCodexAgents, collectClaudeFlowAgents,
  parsePsTable, snapshotProcesses, mergeAgentEntries, assignInteractivePids,
  buildAgentsEnvelope, cmdAgents,
  parseClaudeUsageLine, parseKimiUsageLine, parseCodexTokenCountLine, costForUsage, priceRowForModel,
  bucketByDay, codingMinutesByDay, localDayKey, dayKeysForWindow, buildCodingTimeSection,
  codexQuotaFromRateLimits, fetchGithubContributions, buildBurnEnvelope, cmdBurn, CLAUDE_PRICE_TABLE,
  runHookBridge, cmdHookBridge, NOTCH_BRIDGE_PATH,
  cmdHooks, hooksStatus, bridgeStatus, pmScriptPath, hookBridgeCommand,
  installClaudeHookEntries, uninstallClaudeHookEntries, claudeHookEventsInstalled,
  installKimiHookBlocks, uninstallKimiHookBlocks, kimiHookEventsPresent,
  CLAUDE_HOOK_EVENTS, KIMI_HOOK_EVENTS,
  // footer helper (for rendering assertions)
  footerAi, footer, keyhints, stripAnsi, resetAIEffort, initialAIEffort, moveAIChoice,
  backAIPhase, submitAILaunch,
  onKey, computeStats, scanProjects,
  // sub-features / drill-in navigation
  detectRoutes, detectNestedProjects, subFeaturesOf, isDescendable, serverPathOf,
  enterProject, goBack, hasFeatures,
};
