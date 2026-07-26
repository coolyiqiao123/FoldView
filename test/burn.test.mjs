// Unit + integration tests for `pm burn --json`: token buckets, exact cost math against
// the embedded price table, cache-hit %, coding-time gap logic, the 60s disk cache, and
// the gh-unavailable fallback. Fixtures live in per-scenario tmp dirs; buildBurnEnvelope
// takes the home dir as a parameter so tests never touch the real home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome, tmpDir, makeBin, withPath } from './helpers.mjs';

const home = freshHome();
const {
  buildBurnEnvelope, cmdBurn, parseClaudeUsageLine, parseKimiUsageLine, parseCodexTokenCountLine,
  costForUsage, bucketByDay, codingMinutesByDay, localDayKey, fetchGithubContributions,
  codexQuotaFromRateLimits,
} = await import('../folder.mjs');

const iso = ms => new Date(ms).toISOString();
// local noon on the calendar day `off` days before today — immune to midnight-boundary flakes.
const noonMs = off => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - off, 12, 0, 0, 0).getTime();
};

async function captureJSON(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = orig; }
  return JSON.parse(lines.join('\n'));
}
function noGh() { return withPath([tmpDir('foldview-nobin-')]); }

// ── claude scenario ──
function claudeFixtureHome() {
  const dir = tmpDir('foldview-burn-claude-');
  const proj = path.join(dir, '.claude', 'projects', 'projA');
  fs.mkdirSync(proj, { recursive: true });
  const t0 = noonMs(0), tY = noonMs(1);
  const usage = (input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens) =>
    ({ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens });
  const asst = (ms, model, u) => JSON.stringify({
    type: 'assistant', sessionId: 's1', timestamp: iso(ms), cwd: '/x',
    message: { model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u },
  });
  fs.writeFileSync(path.join(proj, 's1.jsonl'), [
    JSON.stringify({ type: 'user', sessionId: 's1', timestamp: iso(t0), cwd: '/x', message: { role: 'user', content: [] } }),
    asst(t0 + 120_000, 'claude-sonnet-4-20250514', usage(1_000_000, 500_000, 2_000_000, 1_000_000)),
    asst(t0 + 600_000, 'claude-future-9', usage(1_000_000, 0, 0, 0)),
    'not json {',
    asst(tY, 'claude-opus-4-20250514', usage(1_000_000, 0, 0, 0)),
  ].join('\n') + '\n');
  return dir;
}

test('burn claude: token buckets, exact cost math, cacheHitPct, unpricedModels, byDay ordering', async () => {
  const restore = noGh();
  let env;
  try { env = await buildBurnEnvelope(claudeFixtureHome(), new Date(), 30); }
  finally { restore(); }
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.ok, true);
  assert.equal(env.days, 30);
  const c = env.claude;
  // today/week/month are total-token ints (all components summed); byDay keeps the breakdown
  assert.equal(c.tokens.today, 5_500_000);   // sonnet 4.5M + unpriced fallback 1M
  assert.equal(c.tokens.week, 6_500_000);    // + opus 1M yesterday
  assert.equal(c.tokens.month, c.tokens.week);
  // sonnet: 1M*3 + 0.5M*15 + 2M*0.30 + 1M*3.75 (per 1M) = 3 + 7.5 + 0.6 + 3.75 = 14.85
  assert.equal(c.byModel['claude-sonnet-4-20250514'].costUsd, 14.85);
  assert.deepEqual(c.byModel['claude-sonnet-4-20250514'], { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 1_000_000, costUsd: 14.85 });
  // opus: 1M input @ 15 = 15.00
  assert.equal(c.byModel['claude-opus-4-20250514'].costUsd, 15);
  // unknown model falls back to the sonnet row: 1M input @ 3 = 3.00, and is reported
  assert.equal(c.byModel['claude-future-9'].costUsd, 3);
  assert.deepEqual(c.unpricedModels, ['claude-future-9']);
  assert.deepEqual(c.costUsd, { today: 17.85, week: 32.85, month: 32.85 });
  // cacheHitPct = cacheRead / (input + cacheRead) = 2M / (3M + 2M) = 40
  assert.equal(c.cacheHitPct, 40);
  assert.equal(c.tokens.byDay.length, 2);
  assert.equal(c.tokens.byDay[0].date, localDayKey(noonMs(1)), 'byDay is ordered oldest first');
  assert.equal(c.tokens.byDay[1].date, localDayKey(noonMs(0)));
  assert.deepEqual(c.tokens.byDay[1], { date: localDayKey(noonMs(0)), input: 2_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 1_000_000 });
  assert.equal(env.github.error.code, 'gh-unavailable');
  assert.equal(env.ok, true, 'github failure does not flip the envelope ok flag');
});

test('burn codingTime: 5-minute-gap wall-clock segments with a 2min tail', async () => {
  const restore = noGh();
  let env;
  try { env = await buildBurnEnvelope(claudeFixtureHome(), new Date(), 30); }
  finally { restore(); }
  const ct = env.codingTime;
  // today: 12:00+12:02 merge (2min span + 2min tail = 4min); 12:10 is a lone segment (0 + 2min tail) ⇒ 6min
  assert.equal(ct.todayMin, 6);
  // yesterday: a single event ⇒ lone segment + 2min tail = 2min
  assert.equal(ct.weekMin, 8);
  assert.equal(ct.monthMin, 8);
  assert.equal(ct.totalMin, 8);
  assert.deepEqual(ct.byDay, [
    { date: localDayKey(noonMs(1)), minutes: 2 },
    { date: localDayKey(noonMs(0)), minutes: 6 },
  ]);
});

test('burn kimi: usage.record tokens bucketed by day, note subscription', async () => {
  const dir = tmpDir('foldview-burn-kimi-');
  const wireDir = path.join(dir, '.kimi-code', 'sessions', 's1', 'main', 'agents', 'a1');
  fs.mkdirSync(wireDir, { recursive: true });
  const t0 = noonMs(0);
  fs.writeFileSync(path.join(wireDir, 'wire.jsonl'), [
    JSON.stringify({ type: 'turn.prompt', time: t0 }),
    JSON.stringify({ type: 'usage.record', time: t0 + 60_000, model: 'kimi-k2', usage: { inputOther: 1000, output: 500, inputCacheRead: 200, inputCacheCreation: 100 } }),
  ].join('\n') + '\n');
  const restore = noGh();
  let env;
  try { env = await buildBurnEnvelope(dir, new Date(), 30); }
  finally { restore(); }
  assert.equal(env.kimi.tokens.today, 1800);
  assert.equal(env.kimi.tokens.week, env.kimi.tokens.today);
  assert.equal(env.kimi.tokens.byDay.length, 1);
  assert.equal(env.kimi.note, 'subscription');
  // two events 1min apart: one 1min segment + 2min tail = 3min
  assert.equal(env.codingTime.todayMin, 3);
});

test('burn codex: latest cumulative token_count per rollout wins; quota from the newest record', async () => {
  const dir = tmpDir('foldview-burn-codex-');
  const rollDir = path.join(dir, '.codex', 'sessions', '2026', '07', '20');
  fs.mkdirSync(rollDir, { recursive: true });
  const t0 = noonMs(0);
  const resetsAt = Math.floor(t0 / 1000) + 3600;
  fs.writeFileSync(path.join(rollDir, 'rollout-2026-07-20T12-00-00-r1.jsonl'), [
    JSON.stringify({ timestamp: iso(t0), type: 'session_meta', payload: { id: 'r1', cwd: '/p' } }),
    JSON.stringify({ timestamp: iso(t0 + 1000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 } } } }),
    JSON.stringify({ timestamp: iso(t0 + 2000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 10, output_tokens: 40, total_tokens: 350 } }, rate_limits: { primary_rate_limit: { used_percent: 55, window_minutes: 300, resets_at: resetsAt }, credits: { balance: 12.5 }, plan_type: 'pro' } } }),
  ].join('\n') + '\n');
  const restore = noGh();
  let env;
  try { env = await buildBurnEnvelope(dir, new Date(), 30); }
  finally { restore(); }
  assert.deepEqual(env.codex.tokens.total, { input: 300, output: 40, cached: 10, total: 350 },
    'cumulative records ⇒ only the latest record per rollout is summed');
  assert.deepEqual(env.codex.quota, {
    usedPercent: 55, windowMinutes: 300,
    resetsAt: new Date(resetsAt * 1000).toISOString(),
    creditBalance: 12.5, planType: 'pro',
  });
  // the real codex shape nests the window under `primary` with a string credit balance
  const quota2 = codexQuotaFromRateLimits({
    primary: { used_percent: 15.0, window_minutes: 10080, resets_at: resetsAt },
    credits: { has_credits: true, unlimited: false, balance: '5000' }, plan_type: 'pro',
  });
  assert.deepEqual(quota2, {
    usedPercent: 15, windowMinutes: 10080,
    resetsAt: new Date(resetsAt * 1000).toISOString(),
    creditBalance: 5000, planType: 'pro',
  });
});

test('burn pure helpers: costForUsage fallback, bucketByDay window, codingMinutesByDay segments', () => {
  // unknown model → sonnet row, flagged unpriced
  const fb = costForUsage('claude-unknown-x', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(fb.priced, false);
  assert.equal(fb.costUsd, 3);
  assert.equal(costForUsage('claude-3-haiku-20240307', { input: 1_000_000 }).costUsd, 0.25);
  // a record 40 days back falls outside the 30-day byDay window
  const old = { ms: noonMs(40), input: 5, output: 0, cacheRead: 0, cacheWrite: 0 };
  const b = bucketByDay([old, { ms: noonMs(0), input: 7, output: 0, cacheRead: 0, cacheWrite: 0 }], new Date(), 30);
  assert.equal(b.byDay.length, 1);
  assert.equal(b.byDay[0].date, localDayKey(noonMs(0)));
  // 10s gap → one segment: 10s span + 2min tail = 130s = 13/6 min
  const m = codingMinutesByDay([noonMs(0), noonMs(0) + 10_000]);
  assert.ok(Math.abs(m.get(localDayKey(noonMs(0))) - 130 / 60) < 1e-9);
  // a day can never exceed 24h even with dense parallel-agent traffic
  const dense = [];
  for (let i = 0; i < 5000; i++) dense.push(noonMs(0) + i * 1000);
  assert.ok(codingMinutesByDay(dense).get(localDayKey(noonMs(0))) <= 24 * 60);
  // line-level parsers tolerate junk
  assert.equal(parseClaudeUsageLine('no usage here'), null);
  assert.equal(parseClaudeUsageLine('{"usage": "broken'), null);
  assert.equal(parseKimiUsageLine('{"type":"usage.record","time":' + noonMs(0) + ',"usage":{"inputOther":1}}').input, 1);
  assert.equal(parseCodexTokenCountLine('{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2}}}}').usage.input, 2);
});

test('fetchGithubContributions: parses gh graphql output; missing gh → typed envelope error', async () => {
  const binDir = tmpDir('foldview-bin-');
  makeBin(binDir, 'gh', `#!/bin/sh
echo '{"data":{"viewer":{"login":"me","contributionsCollection":{"totalCommitContributions":7,"commitContributionsByRepository":[{"repository":{"nameWithOwner":"a/b"},"contributions":{"totalCount":5}}]}}}}'
`);
  let restore = withPath([binDir]);
  try {
    const gh = await fetchGithubContributions(new Date(), 30);
    assert.deepEqual(gh, { login: 'me', commits30d: 7, byRepo: [{ repo: 'a/b', commits: 5 }] });
  } finally { restore(); }
  restore = noGh();
  try { await assert.rejects(() => fetchGithubContributions(new Date(), 30)); }
  finally { restore(); }
});

test('cmdBurn: writes burn-cache-v1.json, reuses it within 60s, --refresh bypasses it', async () => {
  const cachePath = path.join(home, 'Library', 'Application Support', 'Foldview', 'burn-cache-v1.json');
  const restore = noGh();
  try {
    const out1 = await captureJSON(() => cmdBurn(['--json']));
    assert.equal(out1.schemaVersion, 1);
    assert.equal(out1.ok, true);
    assert.equal(out1.days, 30);
    assert.equal(out1.github.error.code, 'gh-unavailable');
    // empty fixture home ⇒ zeroed (but non-error) sections
    assert.equal(out1.claude.tokens.today, 0);
    assert.deepEqual(out1.claude.tokens.byDay, []);
    assert.equal(out1.claude.cacheHitPct, 0);
    assert.deepEqual(out1.claude.unpricedModels, []);
    assert.equal(out1.codingTime.totalMin, 0);
    assert.ok(fs.existsSync(cachePath), 'the cache file is written after computing');
    const out2 = await captureJSON(() => cmdBurn(['--json']));
    assert.equal(out2.generatedAt, out1.generatedAt, 'a <60s-old cache is printed verbatim');
    await new Promise(r => setTimeout(r, 15));
    const out3 = await captureJSON(() => cmdBurn(['--json', '--refresh']));
    assert.notEqual(out3.generatedAt, out1.generatedAt, '--refresh recomputes instead of reading the cache');
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(cached.generatedAt, out3.generatedAt, 'the refreshed envelope replaces the cache');
  } finally { restore(); }
});
