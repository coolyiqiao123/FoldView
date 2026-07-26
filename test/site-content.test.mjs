// Brand contract for the Asme-language rebrand (2026-07-20): a pure-black, liquid-glass site
// with the Instrument Serif display face, a canvas galaxy backdrop, one dark theme, and
// product copy that stays truthful to folder.mjs (CLI roster, tiling shapes, install command).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve('site/index.html'), 'utf8');
const css = fs.readFileSync(path.resolve('site/styles.css'), 'utf8');
const js = fs.readFileSync(path.resolve('site/app.js'), 'utf8');

test('site-content: brand landmarks of the liquid-glass rebrand are present', () => {
  assert.match(html, /Instrument\+Serif/);
  assert.match(html, /<canvas id="galaxy" aria-hidden="true">/);
  assert.match(js, /getElementById\('galaxy'\)/);
  assert.match(css, /\.liquid-glass/);
  assert.match(css, /mask-composite:\s*exclude/);
  assert.match(html, /id="manifestoModal"/);
});

test('site-content: every product section is reachable', () => {
  for (const id of ['overview', 'jobs', 'ai', 'menubar', 'on-phone', 'install', 'shortcuts']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
});

test('site-content: install command, aliases, and the real CLI roster stay truthful', () => {
  assert.ok(html.split('npm i -g folderpreview').length >= 3, 'install command in hero and final CTA');
  for (const name of ['Claude', 'Codex', 'Kimi Code', 'Gemini', 'OpenCode', 'Aider']) {
    assert.ok(html.includes(name), `missing CLI ${name}`);
  }
  assert.match(html, /2 = halves · 3 = columns · 4 = 2×2 · 9 = 3×3/);
});

test('site-content: single dark theme — no light-theme remnants', () => {
  assert.doesNotMatch(css, /data-theme="light"/);
  assert.doesNotMatch(html, /themeButton/);
  assert.doesNotMatch(js, /fv-theme/);
});

test('site-content: accessibility scaffolding survives the rebrand', () => {
  assert.match(html, /class="skip-link"/);
  assert.match(html, /<noscript>/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(css, /prefers-reduced-motion/);
  const divs = [...html.matchAll(/<\/?div\b[^>]*>/g)];
  const balance = divs.reduce((depth, match) => depth + (match[0].startsWith('</') ? -1 : 1), 0);
  assert.equal(balance, 0, 'divs balanced across the document');
});
