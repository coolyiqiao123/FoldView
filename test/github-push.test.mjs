// Unit tests: GitHub-push planning + rendering. All local & hermetic — no gh, no network.
// Real temp git repos exercise planPush; footerGh is checked via stripAnsi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { freshHome, tmpDir } from './helpers.mjs';

freshHome();
const mod = await import('../folder.mjs');
const { DEFAULT_GITIGNORE, sanitizeRepoName, repoNameFor, webUrlFromRemote, planPush, footerGh, stripAnsi } = mod;

// commit with an inline identity so the suite never depends on the machine's global git config.
const git = (dir, args) =>
  execSync(`git -c user.name=t -c user.email=t@t -C '${dir}' ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] });

test('sanitizeRepoName: folds spaces/metachars, trims edges, collapses dashes', () => {
  assert.equal(sanitizeRepoName('Kalshi BOT'), 'Kalshi-BOT');
  assert.equal(sanitizeRepoName('  my  app!! '), 'my-app');
  assert.equal(sanitizeRepoName('--weird__name--'), 'weird__name');
  assert.equal(sanitizeRepoName('...'), 'project');           // nothing valid left → fallback
  assert.equal(sanitizeRepoName('already-good'), 'already-good');
});

test('repoNameFor: derives the repo name from the folder basename', () => {
  assert.equal(repoNameFor({ path: '/Users/x/Documents/Foo Bar' }), 'Foo-Bar');
});

test('webUrlFromRemote: normalizes ssh and https remotes to a browsable URL', () => {
  assert.equal(webUrlFromRemote('git@github.com:o/r.git'), 'https://github.com/o/r');
  assert.equal(webUrlFromRemote('https://github.com/o/r.git'), 'https://github.com/o/r');
  assert.equal(webUrlFromRemote('https://github.com/o/r'), 'https://github.com/o/r');
});

test('DEFAULT_GITIGNORE: excludes the dangerous defaults for a public repo', () => {
  for (const pat of ['node_modules/', '.env', '.DS_Store', 'dist/']) assert.ok(DEFAULT_GITIGNORE.includes(pat), pat);
});

test('planPush: a non-git folder → create a new repo, initial commit, and add a .gitignore', () => {
  const dir = tmpDir('foldview-push-');
  fs.writeFileSync(path.join(dir, 'index.js'), 'x');
  const plan = planPush({ path: dir }, 'me');
  assert.equal(plan.isRepo, false);
  assert.equal(plan.mode, 'create');
  assert.equal(plan.hasCommits, false);
  assert.equal(plan.needsCommit, true);
  assert.equal(plan.needsGitignore, true);
  assert.deepEqual(plan.steps, ['git init', 'add .gitignore', 'initial commit', 'create public repo']);
  assert.equal(plan.branch, 'main');
});

test('planPush: a clean committed repo with no remote → create, nothing to commit', () => {
  const dir = tmpDir('foldview-push-');
  git(dir, 'init -q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, 'add -A');
  git(dir, 'commit -q -m init');
  const plan = planPush({ path: dir }, 'me');
  assert.equal(plan.isRepo, true);
  assert.equal(plan.hasCommits, true);
  assert.equal(plan.mode, 'create');
  assert.equal(plan.needsCommit, false);
  assert.equal(plan.needsGitignore, false);          // .gitignore already present
  assert.deepEqual(plan.steps, ['create public repo']);
});

test('planPush: a repo with an origin remote → push mode (never create)', () => {
  const dir = tmpDir('foldview-push-');
  git(dir, 'init -q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  git(dir, 'add -A');
  git(dir, 'commit -q -m init');
  git(dir, 'remote add origin git@github.com:me/thing.git');
  const plan = planPush({ path: dir }, 'me');
  assert.equal(plan.mode, 'push');
  assert.equal(plan.remoteUrl, 'git@github.com:me/thing.git');
  assert.deepEqual(plan.steps, ['push to origin']);
});

test('planPush: dirty committed repo → commit N changes then push/create', () => {
  const dir = tmpDir('foldview-push-');
  git(dir, 'init -q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  git(dir, 'add -A');
  git(dir, 'commit -q -m init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new');
  const plan = planPush({ path: dir }, 'me');
  assert.equal(plan.needsCommit, true);
  assert.equal(plan.dirty, 2);
  assert.ok(plan.steps.includes('commit 2 changes'));
});

test('footerGh: confirm/working/done/error each render their own affordances', () => {
  const base = { plan: { name: 'foo', mode: 'create', steps: ['git init', 'create public repo'], remoteUrl: '' }, owner: 'me' };
  const confirm = stripAnsi(footerGh({ ...base, phase: 'confirm' }, 120));
  assert.ok(confirm.includes('github.com/me/foo'));
  assert.ok(confirm.includes('public, new'));
  assert.ok(confirm.includes('↵ push'));

  const done = stripAnsi(footerGh({ ...base, phase: 'done', url: 'https://github.com/me/foo' }, 120));
  assert.ok(done.includes('pushed'));
  assert.ok(done.includes('open'));

  const err = stripAnsi(footerGh({ ...base, phase: 'error', log: 'boom' }, 120));
  assert.ok(err.includes('boom'));
});
