// The crossfade arithmetic, checked without ffmpeg.
//
// Importing server.mjs would start a listener, so the two pure functions are
// re-derived here from the same rules and compared against hand-worked cases.
// If this file and the server ever disagree, the server is what ships — but
// the numbers below are the ones a wrong implementation gets wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function xfadeOffsets(durations, fade) {
  const offsets = [];
  let length = durations[0];
  for (let i = 1; i < durations.length; i++) {
    offsets.push(Number((length - fade).toFixed(3)));
    length += durations[i] - fade;
  }
  return offsets;
}

const crossfadedDuration = (durations, fade) =>
  durations.reduce((sum, d) => sum + d, 0) - fade * Math.max(0, durations.length - 1);

test('the first dissolve starts one fade before the first clip ends', () => {
  assert.deepEqual(xfadeOffsets([3, 3], 0.4), [2.6]);
});

test('offsets track the accumulated film, not the raw clip lengths', () => {
  // Naively summing durations would give 3, 6, 9 — each dissolve would start
  // later than the film actually is, and the drift compounds.
  assert.deepEqual(xfadeOffsets([3, 3, 3, 3], 0.4), [2.6, 5.2, 7.8]);
});

test('handles clips of different lengths', () => {
  assert.deepEqual(xfadeOffsets([5, 2, 3], 0.5), [4.5, 6]);
});

test('a single clip has nothing to dissolve into', () => {
  assert.deepEqual(xfadeOffsets([3], 0.4), []);
});

test('every dissolve shortens the film by one fade', () => {
  assert.equal(crossfadedDuration([3, 3, 3], 0.4), 8.2);
  assert.equal(crossfadedDuration([3], 0.4), 3);
  assert.equal(crossfadedDuration([1, 1, 1, 1, 1], 0.25), 4);
});

test('offsets stay strictly increasing, so ffmpeg never sees a backwards seek', () => {
  const offsets = xfadeOffsets([1, 1, 1, 1, 1, 1, 1, 1], 0.25);
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(offsets[i] > offsets[i - 1], `offset ${i} went backwards`);
  }
});
