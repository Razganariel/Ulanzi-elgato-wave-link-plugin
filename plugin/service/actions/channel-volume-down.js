/**
 * CHANNEL VOLUME DOWN — one button, bound to one channel.
 *
 * The mirror of CHANNEL VOLUME UP. The icon is the manifest's and never changes.
 */

import { ACTION, LIMITS, VOLUME_STEPS } from '../core/constants.js';
import { clampFloat, dialStep } from '../core/params.js';
import { setStateIcon } from '../core/ui.js';

export const uuid = ACTION.CHANNEL_VOLUME_DOWN;

/** What this action must be bound to before it can do anything, or null. */
export const binding = 'channel';

export const defaults = {
  channelId: '',
  mixId: '',
  step: LIMITS.VOLUME_STEP,
};

function currentLevel(channel, mixId) {
  if (!channel) return 0;
  if (mixId) {
    const mix = channel.mixes?.find((m) => m.id === mixId);
    return mix?.level ?? channel.level;
  }
  return channel.level;
}

export function render({ $UD, context }) {
  setStateIcon($UD, context, 0);
}

export async function onRun({ settings, channel, report }) {
  if (!channel) {
    report(new Error('No channel selected'));
    return;
  }
  const step = dialStep(settings.step, 0.01, 1, defaults.step, VOLUME_STEPS);
  const next = clampFloat(currentLevel(channel, settings.mixId) - step, 0, 1);
  try {
    await channel.registry.setChannelVolume(channel.id, next, settings.mixId || null);
  } catch (err) {
    report(err);
  }
}
