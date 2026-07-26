import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = fs.readFileSync(path.join(root, 'mac', 'Packaging', 'package-app.sh'), 'utf8');
const helperSource = path.join(root, 'mac', 'Packaging', 'atomic-install.swift');
const helperText = fs.readFileSync(helperSource, 'utf8');
const plist = fs.readFileSync(path.join(root, 'mac', 'Packaging', 'Info.plist'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let sandbox;
let helper;

before(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'foldview-atomic-test-'));
  helper = path.join(sandbox, 'atomic-install');
  execFileSync('/usr/bin/swiftc', [helperSource, '-o', helper]);
});
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function app(parent, name, marker) {
  const target = path.join(parent, name);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'marker'), marker);
  return target;
}

function staging(parent, marker, suffix = Math.random().toString(36).slice(2)) {
  const container = path.join(parent, `.Foldview.install.${suffix}`);
  fs.mkdirSync(container, { mode: 0o700 });
  return app(container, 'Foldview.app', marker);
}

test('packager verifies its physical current-user parent and uses only unique owned staging', () => {
  assert.match(script, /physical_home=.*pwd -P/);
  assert.match(script, /physical_install_parent=.*pwd -P/);
  assert.match(script, /stat -f '%u %Lp'/);
  assert.match(script, /mktemp -d "\$physical_install_parent\/\.Foldview\.install\.XXXXXXXX"/);
  assert.match(script, /"\$stage_root\/atomic-install" "\$stage_app" "\$app_path"/);
  assert.match(script, /trap cleanup EXIT/);
  assert.doesNotMatch(script, /backup|mv "\$app_path"|--uninstall|\.Trash/);
  assert.doesNotMatch(script, /rm -rf -- "\$HOME"|rm -rf -- "\/Applications"/);
});

test('atomic helper installs into an absent destination with one rename', () => {
  const parent = fs.mkdtempSync(path.join(sandbox, 'absent-'));
  const staged = staging(parent, 'new');
  const destination = path.join(parent, 'Foldview.app');
  execFileSync(helper, [staged, destination]);
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.readFileSync(path.join(destination, 'marker'), 'utf8'), 'new');
});

test('atomic helper exchanges an existing bundle without an absent-target window', () => {
  const parent = fs.mkdtempSync(path.join(sandbox, 'swap-'));
  const staged = staging(parent, 'new');
  const destination = app(parent, 'Foldview.app', 'old');
  const oldInode = fs.statSync(destination).ino;
  execFileSync(helper, [staged, destination]);
  assert.equal(fs.readFileSync(path.join(destination, 'marker'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(staged, 'marker'), 'utf8'), 'old');
  assert.equal(fs.statSync(staged).ino, oldInode, 'RENAME_SWAP leaves the prior bundle recoverable in owned staging');
  assert.match(helperText, /renameatx_np[\s\S]*RENAME_SWAP/);
});

test('atomic helper rejects cross-parent collisions, regular-file targets, and symlink targets', () => {
  const one = fs.mkdtempSync(path.join(sandbox, 'one-'));
  const two = fs.mkdtempSync(path.join(sandbox, 'two-'));
  assert.throws(() => execFileSync(helper, [app(one, 'cross.app', 'new'), path.join(two, 'Foldview.app')], { stdio: 'pipe' }));

  const stagedFileCollision = staging(one, 'new');
  const fileTarget = path.join(one, 'Foldview.app');
  fs.writeFileSync(fileTarget, 'collision');
  assert.throws(() => execFileSync(helper, [stagedFileCollision, fileTarget], { stdio: 'pipe' }));
  assert.equal(fs.readFileSync(fileTarget, 'utf8'), 'collision');

  fs.unlinkSync(fileTarget);
  const real = app(one, 'real.app', 'old');
  fs.symlinkSync(real, fileTarget);
  assert.throws(() => execFileSync(helper, [stagedFileCollision, fileTarget], { stdio: 'pipe' }));
  assert.equal(fs.lstatSync(fileTarget).isSymbolicLink(), true);
});

test('Foldview Info.plist carries the release identity and accessory-app contract', () => {
  assert.match(plist, /<string>FoldviewMenuBar<\/string>/);
  assert.match(plist, /<string>com\.foldview\.menubar<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
  assert.match(plist, new RegExp(`<string>${pkg.version.replaceAll('.', '\\.') }<\\/string>`));
  assert.match(plist, /<key>NSAppleEventsUsageDescription<\/key>/);
});
