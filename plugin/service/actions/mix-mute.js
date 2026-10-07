/**
 * MIX MUTE — one button, bound to one mix.
 *
 * Same contract as CHANNEL MUTE: the only action shape that repaints on a change,
 * because the user has to see the mute state. Two states, so the icon flips.
 */

import { ACTION, STATE } from '../core/constants.js';
import { setStateIcon } from '../core/ui.js';

export const uuid = ACTION.MIX_MUTE;

/** What this action must be bound to before it can do anything, or null. */
export const binding = 'mix';

export const defaults = {
  mixId: '',
  behaviour: 'toggle',
};

export function render({ $UD, context, mix }) {
  setStateIcon($UD, context, mix?.isMuted ? STATE.MUTED : STATE.UNMUTED);
}

export async function onRun({ settings, mix, report }) {
  if (!mix) {
    report(new Error('No mix selected'));
    return;
  }
  const registry = mix.registry;
  try {
    if (settings.behaviour === 'mute') await registry.setMixMute(mix.id, true);
    else if (settings.behaviour === 'unmute') await registry.setMixMute(mix.id, false);
    else await registry.toggleMixMute(mix.id);
  } catch (err) {
    report(err);
  }
}
