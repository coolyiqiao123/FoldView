// Unit + integration tests for `pm agents --json`: live agent discovery across
// Claude Code transcripts, Kimi Code wire files, Codex rollouts, claude-flow daemons,
// and the ps cross-check — all against a synthetic fixture home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome, tmpDir, makeBin, withPath } from './helpers.mjs';

const home = freshHome();
const {
  collectClaudeAgents, collectKimiAgents, collectCodexAgents, collectClaudeFlowAgents,
  parseTranscriptTail, parsePsTable, mergeAgentEntries, assignInteractivePids,
  readFileTailLines, cmdAgents,
} = await import('../folder.mjs');

const iso = ms => new Date(ms).toISOString();
const now = () => Date.now();

async function captureJSON(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = orig; }
  return JSON.parse(lines.join('\n'));
}

function writeClaudeTranscript(slug, sid, records, mtimeMs = now()) {
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, records.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  const d = new Date(mtimeMs);
  fs.utimesSync(file, d, d);
  return file;
}
const claudeUser = (ms, cwd, sid = 'sid-1') =>
  ({ type: 'user', sessionId: sid, timestamp: iso(ms), cwd, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
const claudeTool = (ms, cwd, tool, sid = 'sid-1') =>
  ({ type: 'assistant', sessionId: sid, timestamp: iso(ms), cwd, message: { model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'tool_use', name: tool, input: {} }] } });
const claudeText = (ms, cwd, sid = 'sid-1') =>
  ({ type: 'assistant', sessionId: sid, timestamp: iso(ms), cwd, message: { model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });

test('parseTranscriptTail: last record drives currentAction (tool_use / Writing / Waiting / null)', () => {
  const t0 = now();
  assert.equal(parseTranscriptTail([JSON.stringify(claudeTool(t0, '/p', 'Bash'))]).currentAction, 'Using Bash');
  assert.equal(parseTranscriptTail([JSON.stringify(claudeText(t0, '/p'))]).currentAction, 'Writing');
  assert.equal(parseTranscriptTail([JSON.stringify(claudeUser(t0, '/p'))]).currentAction, 'Waiting for model');
  assert.equal(parseTranscriptTail([JSON.stringify({ type: 'system', timestamp: iso(t0) })]).currentAction, null);
  // unparseable lines are skipped, leaving the previous meaningful action intact
  const lines = [JSON.stringify(claudeTool(t0, '/p', 'Read')), 'not json {', ''];
  const info = parseTranscriptTail(lines);
  assert.equal(info.currentAction, 'Using Read');
  assert.equal(info.sessionId, 'sid-1');
  assert.equal(info.cwd, '/p');
  assert.equal(info.lastTimestamp, iso(t0));
});

test('collectClaudeAgents: newest transcript per project, tool_use tail, old transcripts excluded', () => {
  const t0 = now();
  writeClaudeTranscript('proj-live', 'sid-live', [claudeUser(t0 - 5000, '/proj/live', 'sid-live'), claudeTool(t0, '/proj/live', 'Bash', 'sid-live')]);
  writeClaudeTranscript('proj-stale', 'sid-stale', [claudeTool(t0, '/proj/stale', 'Bash', 'sid-stale')], t0 - 2 * 3600_000);
  const agents = collectClaudeAgents(path.join(home, '.claude', 'projects'), new Date());
  assert.equal(agents.length, 1, 'the 2-hour-old transcript is excluded by the 30-min recency window');
  const a = agents[0];
  assert.equal(a.id, 'claude:sid-live');
  assert.equal(a.cli, 'claude');
  assert.deepEqual(a.roles, ['interactive']);
  assert.equal(a.project, '/proj/live');
  assert.equal(a.pid, null);
  assert.equal(a.status, 'active');
  assert.equal(a.currentAction, 'Using Bash');
  assert.equal(typeof a.startedAt, 'string');
  assert.equal(a.lastActivityAt, iso(t0));
});

test('collectKimiAgents: session index + state.json recency + wire.jsonl tail action', () => {
  const t0 = now();
  const sessionDir = path.join(home, '.kimi-code', 'sessions', 'k-session-1');
  fs.mkdirSync(path.join(sessionDir, 'agents', 'a1'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ updatedAt: iso(t0) }));
  fs.writeFileSync(path.join(sessionDir, 'agents', 'a1', 'wire.jsonl'), [
    JSON.stringify({ type: 'context.append_loop_event', time: t0 - 4000, event: { type: 'step.begin', name: 'Bash' } }),
    JSON.stringify({ type: 'turn.prompt', time: t0 }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(home, '.kimi-code', 'session_index.jsonl'),
    JSON.stringify({ sessionId: 'k-session-1', sessionDir, workDir: '/proj/kimi' }) + '\n');
  const agents = collectKimiAgents(home, new Date());
  assert.equal(agents.length, 1);
  const a = agents[0];
  assert.equal(a.id, 'kimi:k-session-1');
  assert.equal(a.cli, 'kimi');
  assert.equal(a.project, '/proj/kimi');
  assert.equal(a.currentAction, 'Waiting for model');
  assert.equal(a.status, 'active');
  assert.equal(a.lastActivityAt, iso(t0));
});

test('collectKimiAgents: append_loop_event keeps tool info; approval results are reported', () => {
  const t0 = now();
  const sessionDir = path.join(home, '.kimi-code', 'sessions', 'k-session-2');
  fs.mkdirSync(path.join(sessionDir, 'agents', 'a1'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ updatedAt: iso(t0) }));
  fs.writeFileSync(path.join(sessionDir, 'agents', 'a1', 'wire.jsonl'), [
    JSON.stringify({ type: 'context.append_loop_event', time: t0 - 2000, event: { type: 'step.begin', name: 'Read' } }),
    JSON.stringify({ type: 'permission.record_approval_result', time: t0, approved: true }),
  ].join('\n') + '\n');
  fs.appendFileSync(path.join(home, '.kimi-code', 'session_index.jsonl'),
    JSON.stringify({ sessionId: 'k-session-2', sessionDir, workDir: '/proj/kimi2' }) + '\n');
  const agents = collectKimiAgents(home, new Date());
  const a = agents.find(x => x.id === 'kimi:k-session-2');
  assert.ok(a);
  assert.equal(a.currentAction, 'Approval approved');
});

test('collectCodexAgents: session index matched to rollout; session_meta cwd + last event_msg', () => {
  const t0 = now();
  fs.mkdirSync(path.join(home, '.codex', 'sessions', '2026', '07', '20'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'),
    JSON.stringify({ id: 'codex-1', thread_name: 'work', updated_at: iso(t0) }) + '\n');
  fs.writeFileSync(path.join(home, '.codex', 'sessions', '2026', '07', '20', 'rollout-2026-07-20T12-00-00-codex-1.jsonl'), [
    JSON.stringify({ timestamp: iso(t0 - 3000), type: 'session_meta', payload: { id: 'codex-1', cwd: '/proj/codex' } }),
    JSON.stringify({ timestamp: iso(t0), type: 'event_msg', payload: { type: 'task_started' } }),
  ].join('\n') + '\n');
  const agents = collectCodexAgents(home, new Date());
  assert.equal(agents.length, 1);
  const a = agents[0];
  assert.equal(a.id, 'codex:codex-1');
  assert.equal(a.cli, 'codex');
  assert.equal(a.project, '/proj/codex');
  assert.equal(a.currentAction, 'Working');
  assert.equal(a.status, 'active');
});

test('collectClaudeFlowAgents + merge: daemon-state and ps sighting of the same pid merge to one entry', () => {
  fs.mkdirSync(path.join(home, '.claude-flow'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-flow', 'daemon-state.json'), JSON.stringify({ running: true }));
  fs.writeFileSync(path.join(home, '.claude-flow', 'daemon.pid'), '77777\n');
  const rows = [{ pid: 77777, comm: 'node', args: 'node /usr/lib/@claude-flow/cli daemon --workspace /ws/x' }];
  const flow = collectClaudeFlowAgents(home, rows, new Date());
  assert.equal(flow.length, 2, 'seen twice: once from the state file, once from ps');
  const merged = mergeAgentEntries(flow);
  assert.equal(merged.length, 1, 'same pid ⇒ one logical agent');
  assert.deepEqual(merged[0].roles, ['daemon']);
  assert.equal(merged[0].cli, 'claude-flow');
  assert.equal(merged[0].project, '/ws/x', 'null project from the state file is filled from the ps sighting');
  assert.equal(merged[0].pid, 77777);
});

test('mergeAgentEntries: same session from multiple sources unions roles and keeps the freshest activity', () => {
  const merged = mergeAgentEntries([
    { id: 'claude:s1', _session: 'claude:s1', cli: 'claude', roles: ['interactive'], project: '/p', pid: null, status: 'active', currentAction: 'Writing', startedAt: null, lastActivityAt: '2026-01-01T00:00:00.000Z' },
    { id: 'claude:s1-dup', _session: 'claude:s1', cli: 'claude', roles: ['observer'], project: null, pid: null, status: 'idle', currentAction: null, startedAt: null, lastActivityAt: '2026-01-01T00:01:00.000Z' },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].roles, ['interactive', 'observer']);
  assert.equal(merged[0].lastActivityAt, '2026-01-01T00:01:00.000Z');
});

test('parsePsTable + assignInteractivePids: unambiguous 1:1 match only; observers excluded from the pool', () => {
  const rows = parsePsTable('  123 /usr/local/bin/claude claude\n  124 /usr/bin/kimi kimi\n');
  assert.deepEqual(rows, [
    { pid: 123, comm: '/usr/local/bin/claude', args: 'claude' },
    { pid: 124, comm: '/usr/bin/kimi', args: 'kimi' },
  ]);
  const agents = [{ cli: 'claude', roles: ['interactive'], pid: null }];
  assignInteractivePids(agents, [{ pid: 5, comm: '/usr/local/bin/claude', args: 'claude' }]);
  assert.equal(agents[0].pid, 5, 'exactly one process for exactly one agent ⇒ attributed');
  agents[0].pid = null;
  assignInteractivePids(agents, [{ pid: 5, comm: 'claude', args: '' }, { pid: 6, comm: 'claude', args: '' }]);
  assert.equal(agents[0].pid, null, 'two candidate processes ⇒ ambiguous ⇒ pid stays null');
  agents[0].pid = null;
  assignInteractivePids(agents, [
    { pid: 5, comm: 'claude', args: 'claude' },
    { pid: 9, comm: 'claude', args: 'claude --output-format stream-json' },
  ]);
  assert.equal(agents[0].pid, 5, 'stream-json observers are their own entries, not attribution candidates');
});

test('collectors degrade gracefully on a completely empty home', () => {
  const empty = tmpDir('foldview-empty-home-');
  assert.deepEqual(collectClaudeAgents(path.join(empty, '.claude', 'projects'), new Date()), []);
  assert.deepEqual(collectKimiAgents(empty, new Date()), []);
  assert.deepEqual(collectCodexAgents(empty, new Date()), []);
  assert.deepEqual(collectClaudeFlowAgents(empty, [], new Date()), []);
  assert.deepEqual(readFileTailLines(path.join(empty, 'nope.jsonl')), []);
});

test('cmdAgents --json: envelope shape, ps pid attribution, observer + daemon entries', async () => {
  const binDir = tmpDir('foldview-bin-');
  makeBin(binDir, 'ps', `#!/bin/sh
echo '  123 /usr/local/bin/claude claude'
echo '  777 /usr/bin/node node /usr/lib/@claude-flow/cli daemon --workspace /ws/daemon'
echo '  888 /usr/local/bin/claude claude --output-format stream-json --verbose'
`);
  const restore = withPath([binDir]);
  let env;
  try { env = await captureJSON(() => cmdAgents(['--json'])); }
  finally { restore(); }
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.ok, true);
  assert.equal(typeof env.generatedAt, 'string');
  assert.ok(Array.isArray(env.agents));
  for (const a of env.agents) {
    assert.deepEqual(Object.keys(a).sort(),
      ['cli', 'currentAction', 'id', 'lastActivityAt', 'pid', 'project', 'roles', 'startedAt', 'status'],
      'public agent shape is exactly the documented contract (no internal _session leak)');
  }
  const claude = env.agents.find(a => a.id === 'claude:sid-live');
  assert.ok(claude, 'fixture claude agent is present');
  assert.equal(claude.pid, 123, 'the single claude process is attributed to the single claude agent');
  assert.equal(claude.currentAction, 'Using Bash');
  const observer = env.agents.find(a => a.pid === 888);
  assert.ok(observer, 'the stream-json process appears as its own entry');
  assert.deepEqual(observer.roles, ['observer']);
  assert.equal(observer.cli, 'claude');
  assert.equal(observer.project, null);
  const daemon = env.agents.find(a => a.pid === 777);
  assert.ok(daemon, 'the @claude-flow/cli daemon process is detected from ps args');
  assert.deepEqual(daemon.roles, ['daemon']);
  assert.equal(daemon.project, '/ws/daemon');
  assert.ok(env.agents.some(a => a.cli === 'kimi'), 'kimi fixture agent is present');
  assert.ok(env.agents.some(a => a.cli === 'codex'), 'codex fixture agent is present');
});
