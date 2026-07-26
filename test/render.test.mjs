// Focused rendering assertions: the Foldview wordmark, footer behavior at the minimum supported
// width, the AI-terminals prompt footer at every phase, and non-color (stripped ANSI) readability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshHome } from './helpers.mjs';

freshHome();
const mod = await import('../folder.mjs');
const { footer, footerAi, stripAnsi, state, AIProviderError, resetAIEffort, initialAIEffort,
  moveAIChoice, backAIPhase, submitAILaunch } = mod;

test.beforeEach(() => {
  state.status = ''; state.statusUntil = 0;
  state.searching = false; state.ai = null; state.adding = false;
});

test('footer: default hints fit within the minimum supported width (64 cols)', () => {
  const line = stripAnsi(footer(64));
  assert.ok(line.length <= 64, `footer line is ${line.length} chars wide at cols=64`);
});

test('footer: keeps the highest-priority actions (move / launch) even at minimum width', () => {
  const line = stripAnsi(footer(64));
  assert.match(line, /↑↓/);
  assert.match(line, /launch/);
});

test('footerAi (select-cli): fits within width, and keeps "+ custom" / "esc cancel" whenever there is room', () => {
  const a = {
    project: { name: 'my-app' }, phase: 'select-cli',
    choices: [
      { name: 'Claude', executable: '/bin/claude', key: 'c' },
      { name: 'Codex', executable: '/bin/codex', key: 'x' },
      { name: 'Gemini', executable: '/bin/gemini', key: 'g' },
    ],
    cli: null, input: '',
  };
  for (const cols of [64, 80, 120]) {
    const line = stripAnsi(footerAi(a, cols));
    assert.ok(line.length <= cols, `footerAi line is ${line.length} wide at cols=${cols}`);
    assert.match(line, /\+ custom/);
    assert.match(line, /esc cancel/);
  }
});

test('footerAi (select-cli): omits a key-less entry from the visible menu', () => {
  const a = {
    project: { name: 'my-app' }, phase: 'select-cli',
    choices: [{ name: 'Overflow', executable: '/bin/overflow', key: null }],
    cli: null, input: '',
  };
  const line = stripAnsi(footerAi(a, 80));
  assert.doesNotMatch(line, /overflow/i);
  assert.match(line, /\+ custom/);
});

test('footerAi (custom-cli): shows the live text buffer with save/cancel hints', () => {
  const a = { project: { name: 'my-app' }, phase: 'custom-cli', choices: [], cli: null, input: 'my-agent' };
  const line = stripAnsi(footerAi(a, 80));
  assert.match(line, /Custom AI CLI executable: my-agent/);
  assert.match(line, /save/);
  assert.match(line, /cancel/);
});

test('footerAi (select-count): shows the chosen CLI name and the 1-9 hint', () => {
  const a = { project: { name: 'my-app' }, phase: 'select-count', choices: [], cli: { name: 'Claude', executable: '/bin/claude', key: 'c' }, input: '' };
  const line = stripAnsi(footerAi(a, 80));
  assert.match(line, /Claude/);
  assert.match(line, /how many windows/);
});

test('footerAi: loading, error, model, effort, and selected-count phases remain narrow and explicit', () => {
  const model = { id: 'deep', label: 'Deep model', efforts: ['low', 'high'], defaultEffort: 'high' };
  const base = { project: { name: 'my-app' }, choices: [], cli: { name: 'Codex', provider: 'codex' },
    providerCatalog: { models: [model] }, model, effort: 'high', error: 'catalog unavailable', loadToken: 0 };
  for (const phase of ['loading-catalog', 'catalog-error', 'select-model', 'select-effort', 'select-count']) {
    const line = stripAnsi(footerAi({ ...base, phase }, 64));
    assert.ok(line.length <= 64, `${phase} exceeded the narrow footer`);
    assert.ok(line.trim().length > 0);
  }
  assert.match(stripAnsi(footerAi({ ...base, phase: 'select-count' }, 80)), /Deep model · high/);
});

test('AI model selection preserves supported effort, then uses model default, then first effort', () => {
  const a = { effort: 'high' };
  assert.equal(resetAIEffort(a, { efforts: ['low', 'high'], defaultEffort: 'low' }), 'high');
  assert.equal(resetAIEffort(a, { efforts: ['low'], defaultEffort: 'low' }), 'low');
  a.effort = 'unsupported';
  assert.equal(resetAIEffort(a, { efforts: ['medium', 'high'], defaultEffort: null }), 'medium');
  assert.equal(resetAIEffort(a, { efforts: [], defaultEffort: null }), null);
  const models = [
    { id: 'a', efforts: ['low'], defaultEffort: 'low' },
    { id: 'b', efforts: [], defaultEffort: null },
  ];
  const draft = { model: models[0], effort: 'low' };
  moveAIChoice(draft, 'model', models, 1);
  assert.equal(draft.model.id, 'b');
  assert.equal(draft.effort, null, 'fixed-thinking model removes the effort choice');
});

test('AI initial effort uses provider default, then model default, then first supported value', () => {
  const model = { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };
  assert.equal(initialAIEffort({ defaultEffort: 'high' }, model), 'high');
  assert.equal(initialAIEffort({ defaultEffort: 'removed' }, model), 'medium');
  assert.equal(initialAIEffort({ defaultEffort: null }, { ...model, defaultEffort: null }), 'low');
  assert.equal(initialAIEffort({ defaultEffort: 'high' }, { efforts: [], defaultEffort: null }), null);
});

test('one-effort model renders read-only and fixed-thinking model skips the effort choice', () => {
  const one = { id: 'one', label: 'One', efforts: ['only'], defaultEffort: 'only' };
  const line = stripAnsi(footerAi({ phase: 'select-effort', cli: { name: 'Codex' }, model: one, effort: 'only' }, 80));
  assert.match(line, /fixed/); assert.doesNotMatch(line, /←→/);
  assert.equal(initialAIEffort({}, { efforts: [], defaultEffort: null }), null);
});

test('TUI revalidation derives stale state when a second probe removes the selected model', async () => {
  const oldModel = { id: 'removed', label: 'Removed', efforts: ['high'], defaultEffort: 'high' };
  const freshCatalog = { id: 'codex', available: true, defaultModel: 'new', defaultEffort: 'low',
    models: [{ id: 'new', label: 'New', efforts: ['low'], defaultEffort: 'low' }] };
  const a = { phase: 'select-count', project: { path: '/tmp/project' },
    cli: { name: 'Codex', executable: '/bin/codex', provider: 'codex' },
    model: oldModel, effort: 'high', providerCatalog: { models: [oldModel] }, loadToken: 0 };
  state.ai = a; let launches = 0;
  const err = new AIProviderError('unsupported_model', 'Selected model disappeared.', 'codex', { model: 'removed' });
  err.providerCatalog = freshCatalog;
  await submitAILaunch(a, 2, { prepare: async () => { throw err; }, launch: () => { launches++; }, render: () => {} });
  assert.equal(launches, 0); assert.equal(state.ai, a); assert.equal(a.phase, 'catalog-error');
  assert.equal(a.stale, true); assert.equal(a.model.id, 'removed'); assert.equal(a.providerCatalog, freshCatalog);
});

test('TUI revalidation derives stale state when a second probe removes the selected effort', async () => {
  const model = { id: 'deep', label: 'Deep', efforts: ['high'], defaultEffort: 'high' };
  const freshCatalog = { id: 'codex', available: true, defaultModel: 'deep', defaultEffort: 'low',
    models: [{ ...model, efforts: ['low'], defaultEffort: 'low' }] };
  const a = { phase: 'select-count', project: { path: '/tmp/project' },
    cli: { name: 'Codex', executable: '/bin/codex', provider: 'codex' },
    model, effort: 'high', providerCatalog: { models: [model] }, loadToken: 0 };
  state.ai = a; let launches = 0;
  const err = new AIProviderError('unsupported_effort', 'Selected effort disappeared.', 'codex', { model: 'deep', effort: 'high' });
  err.providerCatalog = freshCatalog;
  await submitAILaunch(a, 2, { prepare: async () => { throw err; }, launch: () => { launches++; }, render: () => {} });
  assert.equal(launches, 0); assert.equal(a.phase, 'catalog-error'); assert.equal(a.stale, true);
  assert.equal(a.providerCatalog, freshCatalog);
});

test('TUI validation completion is ignored after Escape cancels its token', async () => {
  const model = { id: 'deep', label: 'Deep', efforts: ['high'], defaultEffort: 'high' };
  const a = { phase: 'select-count', project: { path: '/tmp/project' },
    cli: { name: 'Codex', executable: '/bin/codex', provider: 'codex' }, model, effort: 'high', loadToken: 0 };
  state.ai = a; let resolveProbe, launches = 0;
  const pending = submitAILaunch(a, 1, { prepare: () => new Promise(resolve => { resolveProbe = resolve; }),
    launch: () => { launches++; }, render: () => {} });
  assert.equal(a.phase, 'validating-selection');
  backAIPhase(a);
  resolveProbe({ provider: 'codex', launchSpec: { provider: 'codex', model: 'deep', effort: 'high' } });
  await pending;
  assert.equal(a.phase, 'select-count'); assert.equal(launches, 0); assert.equal(state.ai, a);
});

test('AI prompt Escape backs up one phase before cancelling', () => {
  const model = { id: 'deep', efforts: ['low'], defaultEffort: 'low' };
  const a = { phase: 'select-count', cli: { provider: 'codex' }, model, effort: 'low', loadToken: 0,
    providerCatalog: { models: [model] } };
  assert.equal(backAIPhase(a), 'back'); assert.equal(a.phase, 'select-effort');
  assert.equal(backAIPhase(a), 'back'); assert.equal(a.phase, 'select-model');
  assert.equal(backAIPhase(a), 'back'); assert.equal(a.phase, 'select-cli');
  assert.equal(backAIPhase(a), 'cancel');
});

test('non-color output: stripAnsi leaves the footer fully readable with no residual escape codes', () => {
  const line = stripAnsi(footer(80));
  assert.ok(!/\x1b\[/.test(line), 'no residual ANSI escape codes');
  assert.ok(line.trim().length > 0);
});

test('status line: a set status message is shown verbatim (once stripped of color)', () => {
  state.status = 'opened 3 × claude';
  state.statusUntil = Date.now() + 5000;
  const line = stripAnsi(footer(80));
  assert.match(line, /opened 3 × claude/);
});
