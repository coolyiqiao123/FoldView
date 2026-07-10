// Unit tests: drill-in sub-features — Next.js route discovery, nested-project discovery, and the
// descend/back navigation state machine (↵/→ to enter a project, ←/esc to go back).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome, tmpDir } from './helpers.mjs';

freshHome();
const mod = await import('../folder.mjs');
const { detectRoutes, detectNestedProjects, subFeaturesOf, computeStats,
        hasFeatures, isDescendable, serverPathOf, enterProject, goBack, state } = mod;

const write = (p, s = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// A realistic Next.js App-Router project with a nested standalone project inside it.
function makeNextFixture() {
  const dir = tmpDir('foldview-next-');
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'arbiter-ish', dependencies: { next: '14.0.0' }, scripts: { dev: 'next dev' } }));
  write(path.join(dir, 'app/page.tsx'), 'export default () => null');           // /
  write(path.join(dir, 'app/dashboard/page.tsx'), 'export default () => null'); // /dashboard
  write(path.join(dir, 'app/replay/page.jsx'), 'export default () => null');    // /replay
  write(path.join(dir, 'app/live/page.tsx'), 'export default () => null');      // /live
  write(path.join(dir, 'app/(marketing)/promo/page.tsx'), 'export default () => null'); // /promo (route group folded)
  write(path.join(dir, 'app/api/health/route.ts'), 'export const GET = () => {}');       // /api — excluded
  write(path.join(dir, 'app/[id]/page.tsx'), 'export default () => null');      // dynamic — excluded
  write(path.join(dir, 'app/layout.tsx'), 'export default () => null');         // not a page.*
  // a nested, independently-runnable project
  write(path.join(dir, 'bot/package.json'), JSON.stringify({ name: 'bot', scripts: { start: 'node .' } }));
  write(path.join(dir, 'bot/index.js'), '');
  return dir;
}

test('detectRoutes: finds App-Router pages, folds route groups, excludes /api and dynamic segments', () => {
  const dir = makeNextFixture();
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const routes = detectRoutes(dir, pkg);
  assert.deepEqual(routes, ['/', '/dashboard', '/live', '/promo', '/replay'], 'home-first, alphabetical, no /api or [id]');
});

test('detectRoutes: returns nothing for a non-Next project (no filesystem routing)', () => {
  const dir = tmpDir('foldview-plain-');
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'plain', dependencies: { express: '4' } }));
  assert.deepEqual(detectRoutes(dir, JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))), []);
});

test('detectRoutes: Pages-Router index and nested files map to clean paths', () => {
  const dir = tmpDir('foldview-pages-');
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'pg', dependencies: { next: '13' } }));
  write(path.join(dir, 'pages/index.tsx'), '');       // /
  write(path.join(dir, 'pages/about.tsx'), '');       // /about
  write(path.join(dir, 'pages/blog/index.tsx'), '');  // /blog
  write(path.join(dir, 'pages/_app.tsx'), '');        // excluded
  write(path.join(dir, 'pages/api/x.ts'), '');        // excluded
  const routes = detectRoutes(dir, JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')));
  assert.deepEqual(routes, ['/', '/about', '/blog']);
});

test('detectNestedProjects: surfaces a runnable subfolder, excludes the parent itself', () => {
  const dir = makeNextFixture();
  const nested = detectNestedProjects(dir);
  assert.equal(nested.length, 1, 'exactly one nested project (bot)');
  assert.equal(nested[0].name, 'bot');
  assert.equal(path.resolve(nested[0].path), path.resolve(dir, 'bot'));
});

test('subFeaturesOf: yields route entries (parent-served) followed by nested-project entries', () => {
  const dir = makeNextFixture();
  const project = { name: 'arbiter-ish', path: dir, mtime: 0 };
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const st = { port: 3000, devName: 'dev' };
  const feats = subFeaturesOf(project, pkg, st);
  const routes = feats.filter(f => f.isFeature);
  const nested = feats.filter(f => !f.isFeature);
  assert.equal(routes.length, 5, 'five routes');
  assert.equal(nested.length, 1, 'one nested project');
  // routes carry the parent + a synthetic identity path that never collides with a real dir
  assert.equal(routes[0].parent.path, dir);
  assert.equal(routes[0].kind, 'route');
  assert.ok(routes.every(r => r.path.includes('::route::')), 'synthetic identity keys');
  assert.equal(serverPathOf(routes[0]), dir, 'a route is served by its parent');
  assert.equal(serverPathOf(nested[0]), nested[0].path, 'a nested project serves itself');
});

test('computeStats attaches .features so a project advertises it can be entered', () => {
  const dir = makeNextFixture();
  const p = { name: 'arbiter-ish', path: dir, mtime: 0 };
  const st = computeStats(p);
  assert.ok(Array.isArray(st.features) && st.features.length >= 6, 'routes + nested captured');
  state.cache.set(dir, st);
  assert.equal(hasFeatures(p), true);
  assert.equal(isDescendable(p), true);
});

test('enter → back is a faithful round trip: the list, selection, and breadcrumb all restore', () => {
  const dir = makeNextFixture();
  const parent = { name: 'arbiter-ish', path: dir, mtime: 0 };
  // seed a root level containing the descendable project
  state.cache.clear(); state.trail = []; state.stack = [];
  state.cache.set(dir, computeStats(parent));
  state.projects = [parent]; state.view = [parent]; state.sel = 0; state.scroll = 0; state.search = '';

  assert.equal(enterProject(parent), true, 'descends because it has sub-features');
  assert.equal(state.trail.length, 1);
  assert.equal(state.trail[0].name, 'arbiter-ish');
  assert.ok(state.view.length >= 6, 'now showing the sub-features');
  assert.ok(state.view.some(f => f.isFeature && f.route === '/replay'), 'the backtest route is present');

  assert.equal(goBack(), true);
  assert.equal(state.trail.length, 0, 'breadcrumb cleared');
  assert.deepEqual(state.view, [parent], 'exact original list restored');
  assert.equal(state.sel, 0, 'selection restored');
  assert.equal(goBack(), false, 'no-op at the root level');
});

test('a project with no sub-features cannot be entered', () => {
  const dir = tmpDir('foldview-leaf-');
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'leaf', dependencies: { express: '4' } }));
  const p = { name: 'leaf', path: dir, mtime: 0 };
  state.cache.set(dir, computeStats(p));
  assert.equal(hasFeatures(p), false);
  assert.equal(enterProject(p), false, 'enterProject refuses a featureless project');
});
