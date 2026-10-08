/**
 * CHANNEL VOLUME UP — one button, bound to one channel.
 *
 * Nudges the channel level up by one step, in the mix when one is selected. The
 * icon is the manifest's and never changes: nothing here is worth a redraw, and the
 * host owns the title.
 */

import { ACTION, LIMITS, STATE, VOLUME_STEPS } from '../core/constants.js';
import { clampFloat, dialStep, volumeBounds } from '../core/params.js';
import { scopeLevel } from '../core/scope.js';
import { setStateIcon } from '../core/ui.js';

export const uuid = ACTION.CHANNEL_VOLUME_UP;

/** What this action must be bound to before it can do anything, or null. */
export const binding = 'channel';

export const defaults = {
  channelId: '',
  mixId: '',
  step: LIMITS.VOLUME_STEP,
};


export function render({ $UD, context }) {
  setStateIcon($UD, context, STATE.DEFAULT);
}

export async function onRun({ settings, channel, report }) {
  if (!channel) {
    report(new Error('No channel selected'));
    return;
  }
  const { min, max } = volumeBounds(settings);
  const step = dialStep(settings.step, 0.01, max - min, defaults.step, VOLUME_STEPS);
  const next = clampFloat(scopeLevel(channel, settings.mixId) + step, min, max);
  try {
    await channel.registry.setChannelVolume(channel.id, next, settings.mixId || null);
  } catch (err) {
    report(err);
  }
}
