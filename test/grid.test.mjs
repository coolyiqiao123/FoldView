// Unit tests: computeGrid — pure terminal-window layout math for 1-9 windows.
// New spec: windows fully tile the screen with no wasted space. rows = floor(sqrt(n)),
// items distributed as evenly as possible across rows, and every row is stretched to
// fill the full width. So 2 = left/right halves, 3 = three columns, 4 = 2×2, 9 = 3×3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshHome } from './helpers.mjs';

freshHome();
const { computeGrid } = await import('../folder.mjs');

const SCREEN = { x: 0, y: 0, width: 1728, height: 1080 };
const GAP = 12;

// group rects into rows by their (shared) y coordinate, preserving order
function rowsOf(rects) {
  const byY = new Map();
  for (const r of rects) { if (!byY.has(r.y)) byY.set(r.y, []); byY.get(r.y).push(r); }
  return [...byY.values()];
}

test('computeGrid: returns exactly n rects for n = 1..9, each within the screen bounds', () => {
  for (let n = 1; n <= 9; n++) {
    const rects = computeGrid(n, SCREEN, GAP);
    assert.equal(rects.length, n, `n=${n}`);
    for (const r of rects) {
      assert.ok(r.x >= SCREEN.x, 'left edge in bounds');
      assert.ok(r.y >= SCREEN.y, 'top edge in bounds');
      assert.ok(r.x + r.width <= SCREEN.x + SCREEN.width, 'right edge in bounds');
      assert.ok(r.y + r.height <= SCREEN.y + SCREEN.height, 'bottom edge in bounds');
      assert.ok(r.width > 0 && r.height > 0, 'non-degenerate cell');
    }
  }
});

test('computeGrid: n=1 uses (nearly) the full available display area', () => {
  const [r] = computeGrid(1, SCREEN, GAP);
  assert.ok(r.width > SCREEN.width * 0.9);
  assert.ok(r.height > SCREEN.height * 0.9);
});

test('computeGrid: n=2 places two windows side by side — same row, non-overlapping x-ranges', () => {
  const [a, b] = computeGrid(2, SCREEN, GAP);
  assert.equal(a.y, b.y);
  assert.equal(a.height, b.height);
  assert.ok(a.x + a.width <= b.x, 'the two windows do not overlap horizontally');
});

test('computeGrid: n=3 is a single row of three columns (left / center / right)', () => {
  const rects = computeGrid(3, SCREEN, GAP);
  assert.equal(new Set(rects.map(r => r.y)).size, 1, 'all three share one row');
  assert.equal(new Set(rects.map(r => r.x)).size, 3, 'three distinct columns');
  const sorted = [...rects].sort((a, b) => a.x - b.x);
  assert.ok(sorted[0].x + sorted[0].width <= sorted[1].x, 'no overlap 0-1');
  assert.ok(sorted[1].x + sorted[1].width <= sorted[2].x, 'no overlap 1-2');
});

test('computeGrid: n=4 is a clean 2×2 grid', () => {
  const rects = computeGrid(4, SCREEN, GAP);
  assert.equal(new Set(rects.map(r => r.y)).size, 2, 'two rows');
  assert.equal(new Set(rects.map(r => r.x)).size, 2, 'two columns');
});

test('computeGrid: n=9 is a 3×3 grid', () => {
  const rects = computeGrid(9, SCREEN, GAP);
  assert.equal(new Set(rects.map(r => r.y)).size, 3, 'three rows');
  assert.equal(rowsOf(rects).every(row => row.length === 3), true, 'three columns per row');
});

test('computeGrid: every row is stretched to fill the full width — no wasted horizontal space', () => {
  for (let n = 1; n <= 9; n++) {
    const rects = computeGrid(n, SCREEN, GAP);
    for (const row of rowsOf(rects)) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      const rightEdge = sorted[sorted.length - 1].x + sorted[sorted.length - 1].width;
      // the row reaches within one gap+rounding of the screen's right edge
      assert.ok(rightEdge >= SCREEN.x + SCREEN.width - GAP - sorted.length,
        `n=${n}: row right edge ${rightEdge} should fill toward ${SCREEN.x + SCREEN.width}`);
    }
  }
});

test('computeGrid: rows fully fill the height — bottom row reaches toward the screen bottom', () => {
  for (let n = 1; n <= 9; n++) {
    const rects = computeGrid(n, SCREEN, GAP);
    const bottomEdge = Math.max(...rects.map(r => r.y + r.height));
    assert.ok(bottomEdge >= SCREEN.y + SCREEN.height - GAP - rowsOf(rects).length,
      `n=${n}: bottom edge ${bottomEdge} should fill toward ${SCREEN.y + SCREEN.height}`);
  }
});

test('computeGrid: there is a gap between adjacent cells, and no two cells overlap', () => {
  for (let n = 2; n <= 9; n++) {
    const rects = computeGrid(n, SCREEN, GAP);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        assert.ok(!overlap, `n=${n}: rect ${i} and ${j} overlap`);
      }
    }
  }
});

test('computeGrid: clamps n to the 1-9 range', () => {
  assert.equal(computeGrid(0, SCREEN).length, 1);
  assert.equal(computeGrid(20, SCREEN).length, 9);
});
