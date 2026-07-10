// Focused rendering assertions: the Foldview wordmark, footer behavior at the minimum supported
// width, the AI-terminals prompt footer at every phase, and non-color (stripped ANSI) readability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshHome } from './helpers.mjs';

freshHome();
const mod = await import('../folder.mjs');
const { footer, footerAi, stripAnsi, state } = mod;

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
