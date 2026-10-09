/**
 * Volume parameter helpers.
 *
 * Every volume action reads its step and bounds through these two functions, so
 * the rules that keep the encoder usable live in one place. The host hands
 * settings back as strings sometimes and numbers other times depending on how
 * they were typed in the property inspector, so every read goes through them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { clampFloat, dialStep } from '../plugin/service/core/params.js';
import { VOLUME_STEPS } from '../plugin/service/core/constants.js';

test('clampFloat keeps a level inside range and falls back when unusable', () => {
  assert.equal(clampFloat(0.5, 0, 1, 0.05), 0.5);
  assert.equal(clampFloat(-5, 0, 1, 0.05), 0);
  assert.equal(clampFloat(500, 0, 1, 0.05), 1);
  assert.equal(clampFloat('abc', 0, 1, 0.05), 0.05);
  assert.equal(clampFloat(undefined, 0, 1, 0.05), 0.05);
  assert.equal(clampFloat('', 0, 1, 0.05), 0.05, 'an empty field must not become 0');
  assert.equal(clampFloat('  ', 0, 1, 0.05), 0.05, 'whitespace is still blank');
});

test('clampFloat never rounds: 0.95 must survive a rotation', () => {
  // The integer clamp this replaced turned every level above 0.5 into 1, which
  // made the top of the fader unreachable and snapped 0.95 to full scale.
  assert.equal(clampFloat(0.95, 0, 1, 0), 0.95);
  assert.equal(clampFloat(0.1 + 0.2, 0, 1, 0), 0.1 + 0.2);
  assert.equal(clampFloat(0.03, 0, 1, 0), 0.03, 'no rounding to 2 decimals either');
  assert.equal(clampFloat('0.95', 0, 1, 0), 0.95, 'a numeric string parses');
});

test('dialStep accepts every float step the inspectors offer', () => {
  // Rounding here used to collapse 0.01, 0.02, 0.05, 0.1 and 0.25 to 0 and then
  // fall back to the default, so the step selector had no effect at all.
  for (const step of VOLUME_STEPS) {
    assert.equal(dialStep(step, 0.01, 1, 0.05, VOLUME_STEPS), step, `step ${step} must survive`);
  }
});

test('dialStep reads a step typed as a string', () => {
  assert.equal(dialStep('0.25', 0.01, 1, 0.05, VOLUME_STEPS), 0.25);
});

test('dialStep refuses a step that would freeze the encoder', () => {
  assert.equal(dialStep(0, 0.01, 1, 0.05, VOLUME_STEPS), 0.05, 'zero would freeze the dial');
  assert.equal(dialStep(-1, 0.01, 1, 0.05, VOLUME_STEPS), 0.05);
  assert.equal(dialStep(2, 0.01, 1, 0.05, VOLUME_STEPS), 0.05, 'wider than the range');
  assert.equal(dialStep('', 0.01, 1, 0.05, VOLUME_STEPS), 0.05, 'blank is not a choice');
  assert.equal(dialStep(undefined, 0.01, 1, 0.05, VOLUME_STEPS), 0.05);
  assert.equal(dialStep('abc', 0.01, 1, 0.05, VOLUME_STEPS), 0.05);
});

test('dialStep rejects a step outside the allow list', () => {
  assert.equal(dialStep(0.03, 0.01, 1, 0.05, VOLUME_STEPS), 0.05, 'unsupported step falls back');
  assert.equal(dialStep(0.07, 0.01, 1, 0.05, VOLUME_STEPS), 0.05);
});

test('dialStep measures the step against the configured bounds', () => {
  // A 25 % step cannot be honoured on a range that only spans 10 %: accepting it
  // would make one press jump past both limits.
  assert.equal(dialStep(0.25, 0.01, 0.1, 0.05, VOLUME_STEPS), 0.05);
  assert.equal(dialStep(0.05, 0.01, 0.1, 0.05, VOLUME_STEPS), 0.05, 'fits exactly');
});