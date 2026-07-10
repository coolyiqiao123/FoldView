// Unit tests: spawnAITerminals — the core launch action. Uses a fake `osascript` placed early
// on PATH so these tests never actually open real Terminal windows, while still exercising the
// real spawn()/child 'error'/'exit' handling paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome, makeBin, withPath, tmpDir } from './helpers.mjs';

freshHome();
const { spawnAITerminals } = await import('../folder.mjs');

function fakeProject() {
  const dir = tmpDir('foldview-proj-');
  return { name: path.basename(dir), path: dir };
}
function fakeCli(bin) {
  return { name: 'FakeCLI', executable: makeBin(bin, 'fake-cli', '#!/bin/sh\n') };
}

test('spawnAITerminals: reports success only after a zero exit from the single osascript process', async () => {
  const bin = tmpDir('foldview-bin-');
  makeBin(bin, 'osascript', '#!/bin/sh\nexit 0\n');
  const restore = withPath([bin]);
  try {
    const r = await spawnAITerminals(fakeProject(), fakeCli(bin), 3);
    assert.equal(r.ok, true);
    assert.equal(r.message, 'opened 3 × FakeCLI');
  } finally { restore(); }
});

test('spawnAITerminals: a non-zero exit is reported as a failure, never as success', async () => {
  const bin = tmpDir('foldview-bin-');
  makeBin(bin, 'osascript', '#!/bin/sh\nexit 1\n');
  const restore = withPath([bin]);
  try {
    const r = await spawnAITerminals(fakeProject(), fakeCli(bin), 2);
    assert.equal(r.ok, false);
    assert.equal(r.message, 'could not open Terminal windows');
  } finally { restore(); }
});

test('spawnAITerminals: a spawn error (non-executable osascript) is reported as a failure, never throws', async () => {
  const bin = tmpDir('foldview-bin-');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 0\n');   // deliberately not chmod +x
  const restore = withPath([bin]);
  try {
    const r = await spawnAITerminals(fakeProject(), fakeCli(bin), 1);
    assert.equal(r.ok, false);
    assert.equal(r.message, 'could not open Terminal windows');
  } finally { restore(); }
});

test('spawnAITerminals: never runs a different executable — an unresolvable CLI fails without spawning osascript', async () => {
  const bin = tmpDir('foldview-bin-');
  const marker = path.join(bin, 'RAN');
  makeBin(bin, 'osascript', `#!/bin/sh\necho ran > ${marker}\nexit 0\n`);
  const restore = withPath([bin]);
  try {
    const r = await spawnAITerminals(fakeProject(), { name: 'Ghost', executable: path.join(bin, 'does-not-exist') }, 1);
    assert.equal(r.ok, false);
    assert.match(r.message, /could not resolve/);
    assert.equal(fs.existsSync(marker), false, 'osascript must never run when the CLI cannot be resolved');
  } finally { restore(); }
});

test('spawnAITerminals: an entry with no real local directory fails with a status message, no spawn', async () => {
  const bin = tmpDir('foldview-bin-');
  const marker = path.join(bin, 'RAN');
  makeBin(bin, 'osascript', `#!/bin/sh\necho ran > ${marker}\nexit 0\n`);
  const restore = withPath([bin]);
  try {
    const r = await spawnAITerminals({ name: 'ghost-app', path: '/definitely/not/a/real/path' }, fakeCli(bin), 1);
    assert.equal(r.ok, false);
    assert.match(r.message, /no local directory/);
    assert.equal(fs.existsSync(marker), false);
  } finally { restore(); }
});

test('spawnAITerminals: macOS-only guard fires on non-darwin platforms',
  { skip: 'PLATFORM is captured from process.platform at module load; this environment is always darwin, so the non-darwin branch is reviewed by inspection, not exercised here' },
  async () => {
    const bin = tmpDir('foldview-bin-');
    const r = await spawnAITerminals(fakeProject(), fakeCli(bin), 1);
    assert.equal(r.ok, false);
    assert.match(r.message, /macOS only/);
  });
