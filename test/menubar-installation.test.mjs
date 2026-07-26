import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freshHome } from './helpers.mjs';

freshHome();
const { inspectMenubarInstallation, menubarIsRunning } = await import('../folder.mjs');

function makeSignedBundle() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'foldview-bundle-'));
  const app = path.join(parent, 'Foldview.app');
  const macos = path.join(app, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(macos, 'FoldviewMenuBar'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.foldview.menubar</string>
<key>CFBundleExecutable</key><string>FoldviewMenuBar</string>
<key>CFBundleShortVersionString</key><string>1.3.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  return app;
}

test('installation identity requires exact plist identity, executable, X_OK, and valid ad-hoc signature',
  { skip: process.platform !== 'darwin' }, () => {
    const app = makeSignedBundle();
    assert.deepEqual(inspectMenubarInstallation(app), {
      installed: true,
      version: '1.3.0',
      executable: path.join(app, 'Contents', 'MacOS', 'FoldviewMenuBar'),
    });
    fs.appendFileSync(path.join(app, 'Contents', 'MacOS', 'FoldviewMenuBar'), '# tampered\n');
    assert.equal(inspectMenubarInstallation(app).installed, false, 'signature tampering invalidates installation');
  });

test('installation identity rejects symlinked bundles and non-executable binaries',
  { skip: process.platform !== 'darwin' }, () => {
    const app = makeSignedBundle();
    fs.chmodSync(path.join(app, 'Contents', 'MacOS', 'FoldviewMenuBar'), 0o600);
    assert.equal(inspectMenubarInstallation(app).installed, false);

    const signed = makeSignedBundle();
    const link = path.join(path.dirname(signed), 'Linked.app');
    fs.symlinkSync(signed, link);
    assert.equal(inspectMenubarInstallation(link).installed, false);
  });

test('running detection matches the exact installed executable path, not a process name or argument substring', () => {
  const app = '/Users/test/Applications/Foldview.app';
  const executable = `${app}/Contents/MacOS/FoldviewMenuBar`;
  assert.equal(menubarIsRunning(app, `${executable}\n`), true);
  assert.equal(menubarIsRunning(app, `${executable} --flag\n`), true);
  assert.equal(menubarIsRunning(app, 'FoldviewMenuBar\n'), false);
  assert.equal(menubarIsRunning(app, `/bin/sh -c ${executable}\n`), false);
  assert.equal(menubarIsRunning(app, `${executable}-impostor\n`), false);
});
