// Static-site support: a project that is just static HTML (no dev server) is detected as such
// and served on a real localhost by Foldview's own zero-dependency `pm serve`. Covers the pure
// detection heuristic, the `--json` surface, and the `serve` subcommand as a live HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { freshHome, tmpDir, FOLDER_MJS } from './helpers.mjs';

const home = freshHome();   // sets PM_NO_MAIN, so importing folder.mjs below won't launch the TUI
const { staticSiteDir, lightProjectInfo } = await import(FOLDER_MJS);

// ── pure detection ──────────────────────────────────────────────────────
test('staticSiteDir: a site/index.html with no dev server is a static site', () => {
  const root = tmpDir('foldview-static-');
  fs.mkdirSync(path.join(root, 'site'));
  fs.writeFileSync(path.join(root, 'site', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { start: 'node cli.js', test: 'node --test' } }));
  assert.equal(staticSiteDir(root, JSON.parse(fs.readFileSync(path.join(root, 'package.json')))), path.join(root, 'site'));
});

test('staticSiteDir: a bare index.html at the project root is a static site', () => {
  const root = tmpDir('foldview-static-root-');
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
  assert.equal(staticSiteDir(root, null), root);
});

test('staticSiteDir: a framework app (dev script or framework dep) is NOT a static site', () => {
  const nx = tmpDir('foldview-next-');
  fs.mkdirSync(path.join(nx, 'public'));
  fs.writeFileSync(path.join(nx, 'public', 'index.html'), '<h1>x</h1>');
  fs.writeFileSync(path.join(nx, 'package.json'), JSON.stringify({ name: 'nx', scripts: { dev: 'next dev' }, dependencies: { next: '14' } }));
  assert.equal(staticSiteDir(nx, JSON.parse(fs.readFileSync(path.join(nx, 'package.json')))), null);

  const vt = tmpDir('foldview-vite-');
  fs.mkdirSync(path.join(vt, 'dist'));
  fs.writeFileSync(path.join(vt, 'dist', 'index.html'), '<h1>x</h1>');
  fs.writeFileSync(path.join(vt, 'package.json'), JSON.stringify({ name: 'vt', scripts: { dev: 'vite' }, devDependencies: { vite: '5' } }));
  assert.equal(staticSiteDir(vt, JSON.parse(fs.readFileSync(path.join(vt, 'package.json')))), null);
});

test('lightProjectInfo: a static site reports siteDir and nulls the ambiguous start script', () => {
  const root = tmpDir('foldview-lpi-');
  fs.mkdirSync(path.join(root, 'site'));
  fs.writeFileSync(path.join(root, 'site', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { start: 'node cli.js' } }));
  const info = lightProjectInfo(root);
  assert.equal(info.siteDir, path.join(root, 'site'));
  assert.equal(info.devName, null);
  assert.equal(info.port, null);
});

// ── live `pm serve` HTTP server ─────────────────────────────────────────
function serve(dir, port) {
  // PM_NO_MAIN is set in THIS process (freshHome) so importing folder.mjs didn't launch the TUI;
  // it must NOT leak into the child, or main() never runs and `serve` silently no-ops.
  const env = { ...process.env }; delete env.PM_NO_MAIN;
  const child = spawn(process.execPath, [FOLDER_MJS, 'serve', dir, String(port)],
    { stdio: ['ignore', 'pipe', 'inherit'], env });
  const ready = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', d => { buf += d; const m = buf.match(/localhost:(\d+)/); if (m) resolve(Number(m[1])); });
    child.on('exit', () => reject(new Error('serve exited before listening')));
    setTimeout(() => reject(new Error('serve did not announce a port in time')), 5000);
  });
  return { child, ready };
}
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

test('pm serve: serves index.html on localhost and blocks path traversal', async () => {
  const root = tmpDir('foldview-serve-');
  fs.writeFileSync(path.join(root, 'index.html'), '<title>served ok</title>');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'do not leak');   // a sibling ABOVE the served dir
  const siteDir = path.join(root, 'site');
  fs.mkdirSync(siteDir);
  fs.writeFileSync(path.join(siteDir, 'index.html'), '<title>the site</title>');

  const { child, ready } = serve(siteDir, 8199);
  try {
    const port = await ready;
    const home = await get(port, '/');
    assert.equal(home.status, 200);
    assert.match(home.type, /text\/html/);
    assert.match(home.body, /the site/);

    const traversal = await get(port, '/%2e%2e/index.html');   // try to escape to root/index.html
    assert.equal(traversal.status, 403);

    const missing = await get(port, '/nope.css');
    assert.equal(missing.status, 404);
  } finally {
    child.kill('SIGTERM');
  }
});
