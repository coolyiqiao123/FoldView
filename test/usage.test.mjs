// Unit tests: Claude Code usage reader (`pm usage`) — local JSONL tallying, per-message dedupe,
// day/model grouping, model-price estimation, and the empty-logs path. Everything is local: we
// seed a throwaway ~/.claude/projects tree and read it back. No network, no real Claude install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome } from './helpers.mjs';

const HOME = freshHome();
const { readClaudeUsage, usagePriceFor, usageEntryCost, usageTokens, claudeUsageDirs } = await import('../folder.mjs');

const PROJ = path.join(HOME, '.claude', 'projects', '-Users-me-app');
fs.mkdirSync(PROJ, { recursive: true });

function todayIso() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).toISOString();
}

// one assistant turn (req_1/msg_1) is written twice — the reader must count it once. A
// <synthetic> turn with huge counts must be ignored. A user line has no usage and is skipped.
const lines = [
  { type: 'user', message: { role: 'user', content: 'hi' } },
  { type: 'assistant', timestamp: todayIso(), requestId: 'req_1', message: { id: 'msg_1', model: 'claude-opus-4-8',
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 200, cache_read_input_tokens: 8000 } } },
  { type: 'assistant', timestamp: todayIso(), requestId: 'req_1', message: { id: 'msg_1', model: 'claude-opus-4-8',
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 200, cache_read_input_tokens: 8000 } } },
  { type: 'assistant', timestamp: '2026-07-01T10:00:00.000Z', requestId: 'req_2', message: { id: 'msg_2', model: 'claude-sonnet-5',
    usage: { input_tokens: 3000, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 1200 } } },
  { type: 'assistant', timestamp: '2026-07-01T10:05:00.000Z', requestId: 'req_3', message: { id: 'msg_3', model: '<synthetic>',
    usage: { input_tokens: 99999, output_tokens: 99999 } } },
];
fs.writeFileSync(path.join(PROJ, 'session1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

test('usagePriceFor: matches opus/sonnet/haiku by substring, falls back for unknowns', () => {
  assert.equal(usagePriceFor('claude-opus-4-8').out, 75);
  assert.equal(usagePriceFor('claude-sonnet-5').out, 15);
  assert.equal(usagePriceFor('claude-haiku-4-5').out, 4);
  assert.equal(usagePriceFor('some-future-model').out, 15);   // default (sonnet-ish)
});

test('usageEntryCost: computes $ from per-token published rates', () => {
  // opus: (1000*15 + 500*75 + 200*18.75 + 8000*1.5) / 1e6 = 0.06825
  const cost = usageEntryCost({ input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 200, cache_read_input_tokens: 8000 }, 'claude-opus-4-8');
  assert.ok(Math.abs(cost - 0.06825) < 1e-9);
});

test('readClaudeUsage: dedupes replayed turns and skips synthetic/user lines', () => {
  const u = readClaudeUsage();
  assert.equal(u.files, 1);
  assert.equal(u.totals.messages, 2);              // opus turn counted once + one sonnet turn
  assert.equal(u.totals.input, 4000);              // 1000 (deduped) + 3000
  assert.equal(u.totals.output, 1400);             // 500 + 900
  assert.equal(usageTokens(u.totals), 14800);      // no 99999 synthetic leakage
});

test('readClaudeUsage: today slice and per-day / per-model breakdowns', () => {
  const u = readClaudeUsage();
  assert.equal(usageTokens(u.today), 9700);        // just the opus turn from today
  assert.ok(Math.abs(u.today.cost - 0.06825) < 1e-9);
  assert.equal(u.byModel.get('claude-opus-4-8').messages, 1);
  assert.equal(u.byModel.get('claude-sonnet-5').input, 3000);
  assert.equal(u.byDay.get('2026-07-01').output, 900);
  assert.equal(u.byModel.has('<synthetic>'), false);
});

test('readClaudeUsage: prefers a record-level costUSD over the estimate when present', () => {
  const dir = path.join(HOME, '.claude', 'projects', '-Users-me-billed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), JSON.stringify({
    type: 'assistant', timestamp: todayIso(), requestId: 'req_b', costUSD: 1.23,
    message: { id: 'msg_b', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 10 } },
  }) + '\n');
  const u = readClaudeUsage();
  const billed = u.byModel.get('claude-opus-4-8');
  // opus estimate for this tiny turn is ~0.0009; the 1.23 costUSD must dominate the model total
  assert.ok(billed.cost > 1.2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readClaudeUsage: no logs → zeroed totals, empty file list, still-valid shape', () => {
  const empty = fs.mkdtempSync(path.join(HOME, 'empty-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = empty;           // points at a dir with no projects/ subtree
  try {
    assert.deepEqual(claudeUsageDirs(), []);
    const u = readClaudeUsage();
    assert.equal(u.files, 0);
    assert.equal(usageTokens(u.totals), 0);
    assert.equal(usageTokens(u.today), 0);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
