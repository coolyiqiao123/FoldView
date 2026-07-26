// Tests for the `pm hook-bridge` stdin shim against a real local HTTP server standing in
// for the notch bridge: /event fan-out, the /approve 200 + hookSpecificOutput contract,
// and every fail-open path (204, bad JSON, refused connection, missing state file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { freshHome, tmpDir } from './helpers.mjs';

const home = freshHome();
const { runHookBridge, NOTCH_BRIDGE_PATH } = await import('../folder.mjs');

function fakeBridge(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      handler(req, res, body);
    });
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}
const close = server => new Promise(r => server.close(r));

function writeBridgeState(port, token = 'tok-123') {
  fs.mkdirSync(path.dirname(NOTCH_BRIDGE_PATH), { recursive: true });
  fs.writeFileSync(NOTCH_BRIDGE_PATH, JSON.stringify({
    schemaVersion: 1, port, token, pid: process.pid, launchedAt: new Date().toISOString(),
  }));
}
const outSink = () => ({ chunks: [], write(s) { this.chunks.push(String(s)); } });

test('hook-bridge: ordinary events POST to /event with bearer auth and the wrapped payload', async () => {
  const { server, requests, port } = await fakeBridge((req, res) => { res.statusCode = 204; res.end(); });
  try {
    writeBridgeState(port);
    const out = outSink();
    const code = await runHookBridge({ cli: 'claude', event: 'SessionStart', stdin: '{"x":1}', stdout: out });
    assert.equal(code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/event');
    assert.equal(requests[0].auth, 'Bearer tok-123');
    assert.deepEqual(JSON.parse(requests[0].body), { cli: 'claude', event: 'SessionStart', payload: { x: 1 } });
    assert.deepEqual(out.chunks, [], 'event responses are ignored — nothing is printed');
  } finally { await close(server); }
});

test('hook-bridge: claude PreToolUse goes to /approve; 200 + hookSpecificOutput is printed verbatim', async () => {
  const reply = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  const { server, requests, port } = await fakeBridge((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(reply);
  });
  try {
    writeBridgeState(port);
    const out = outSink();
    const code = await runHookBridge({ cli: 'claude', event: 'PreToolUse', stdin: '{"tool_name":"Bash"}', stdout: out });
    assert.equal(code, 0);
    assert.equal(requests[0].url, '/approve');
    assert.deepEqual(JSON.parse(requests[0].body), { cli: 'claude', event: 'PreToolUse', payload: { tool_name: 'Bash' } });
    assert.deepEqual(out.chunks, [reply], 'the bridge response body is printed byte-for-byte');
  } finally { await close(server); }
});

test('hook-bridge: kimi PreToolUse is NOT an approval — it posts to /event', async () => {
  const { server, requests, port } = await fakeBridge((req, res) => { res.statusCode = 204; res.end(); });
  try {
    writeBridgeState(port);
    const out = outSink();
    await runHookBridge({ cli: 'kimi', event: 'PreToolUse', stdin: '{}', stdout: out });
    assert.equal(requests[0].url, '/event');
    assert.deepEqual(out.chunks, []);
  } finally { await close(server); }
});

test('hook-bridge: /approve 204 (abstain) prints nothing; 200 without hookSpecificOutput prints nothing', async () => {
  const { server, port } = await fakeBridge((req, res) => { res.statusCode = 204; res.end(); });
  try {
    writeBridgeState(port);
    const out = outSink();
    const code = await runHookBridge({ cli: 'claude', event: 'PreToolUse', stdin: '{}', stdout: out });
    assert.equal(code, 0);
    assert.deepEqual(out.chunks, []);
  } finally { await close(server); }

  const { server: s2, port: p2 } = await fakeBridge((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"unrelated":true}');
  });
  try {
    writeBridgeState(p2);
    const out = outSink();
    await runHookBridge({ cli: 'claude', event: 'PreToolUse', stdin: '{}', stdout: out });
    assert.deepEqual(out.chunks, []);
  } finally { await close(s2); }
});

test('hook-bridge: fail-open — invalid stdin JSON never reaches the bridge, exits 0', async () => {
  const { server, requests, port } = await fakeBridge((req, res) => { res.statusCode = 204; res.end(); });
  try {
    writeBridgeState(port);
    const code = await runHookBridge({ cli: 'claude', event: 'SessionStart', stdin: 'this is not json', stdout: outSink() });
    assert.equal(code, 0);
    assert.equal(requests.length, 0);
  } finally { await close(server); }
});

test('hook-bridge: fail-open — missing state file exits 0 with no output', async () => {
  const missing = path.join(tmpDir('foldview-no-state-'), 'notch-bridge-v1.json');
  const out = outSink();
  const code = await runHookBridge({ cli: 'claude', event: 'PreToolUse', stdin: '{}', stdout: out, statePath: missing });
  assert.equal(code, 0);
  assert.deepEqual(out.chunks, []);
});

test('hook-bridge: fail-open — unparseable state file exits 0 with no output', async () => {
  const dir = tmpDir('foldview-bad-state-');
  const statePath = path.join(dir, 'notch-bridge-v1.json');
  fs.writeFileSync(statePath, '{corrupt');
  const code = await runHookBridge({ cli: 'claude', event: 'SessionStart', stdin: '{}', stdout: outSink(), statePath });
  assert.equal(code, 0);
});

test('hook-bridge: fail-open — connection refused exits 0, prints nothing, never throws', async () => {
  // grab a port and immediately release it so the connection is refused
  const { server, port } = await fakeBridge((req, res) => res.end());
  await close(server);
  writeBridgeState(port);
  const out = outSink();
  const code = await runHookBridge({ cli: 'claude', event: 'PreToolUse', stdin: '{}', stdout: out });
  assert.equal(code, 0);
  assert.deepEqual(out.chunks, []);
});

test('hook-bridge: fail-open — unknown cli / missing event exit 0 without any request', async () => {
  const { server, requests, port } = await fakeBridge((req, res) => { res.statusCode = 204; res.end(); });
  try {
    writeBridgeState(port);
    assert.equal(await runHookBridge({ cli: 'emacs', event: 'SessionStart', stdin: '{}', stdout: outSink() }), 0);
    assert.equal(await runHookBridge({ cli: 'claude', event: '', stdin: '{}', stdout: outSink() }), 0);
    assert.equal(requests.length, 0);
  } finally { await close(server); }
});
