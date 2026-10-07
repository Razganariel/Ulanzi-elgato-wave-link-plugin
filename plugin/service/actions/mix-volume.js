/**
 * MIX VOLUME DIAL — one encoder, bound to one mix.
 *
 * Same contract as CHANNEL VOLUME DIAL: the host owns the key and its Title, the
 * plugin fills the dial once with the mix name, and nothing is displayed.
 *
 * Note this drives the master fader of the mix, which Wave Link only shows in the
 * mix editor. That is the mix's own volume, not the level of any channel within it.
 */

import { ACTION, ENCODER_ICON, LIMITS, STATE, VOLUME_STEPS } from '../core/constants.js';
import { rotateSteps } from '../core/dial.js';
import { clampFloat, dialStep } from '../core/params.js';
import { setEncoderIcon, setStateIcon } from '../core/ui.js';

export const uuid = ACTION.MIX_VOLUME;

/** What this action must be bound to before it can do anything, or null. */
export const binding = 'mix';

export const defaults = {
  mixId: '',
  step: LIMITS.VOLUME_STEP,
};

function bounds(settings) {
  const min = clampFloat(settings.min ?? LIMITS.VOLUME_MIN, LIMITS.VOLUME_MIN, LIMITS.VOLUME_MAX, LIMITS.VOLUME_MIN);
  const max = clampFloat(settings.max ?? LIMITS.VOLUME_MAX, min, LIMITS.VOLUME_MAX, LIMITS.VOLUME_MAX);
  return { min, max };
}

/** Draws the key, once. The dial names the mix. */
export function render({ $UD, context, isEncoder }) {
  setStateIcon($UD, context, STATE.DEFAULT);
  // The dial's text is the host's Title; we only draw the icon there.
  if (isEncoder) setEncoderIcon($UD, context, ENCODER_ICON.MIX_VOLUME);
}

export async function onDialRotate(ctx, message) {
  const { settings, mix, report } = ctx;
  if (!mix) return;
  const direction = rotateSteps(message);
  if (direction === 0) return;
  const { min, max } = bounds(settings);
  const step = dialStep(settings.step, 0.01, max - min, defaults.step, VOLUME_STEPS);
  const next = clampFloat(mix.level + direction * step, min, max, mix.level);
  try {
    await mix.registry.setMixVolume(mix.id, next);
  } catch (err) {
    report(err);
  }
}

export async function onDialPress(ctx) {
  const { mix, report } = ctx;
  if (!mix) return;
  try {
    await mix.registry.toggleMixMute(mix.id);
  } catch (err) {
    report(err);
  }
}
