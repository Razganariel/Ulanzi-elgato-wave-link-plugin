/**
 * CHANNEL MUTE — one button, bound to a channel, optionally to one mix.
 *
 * Same scope rule as CHANNEL VOLUME DIAL, and for the same reason:
 *
 *    channel, no mix      ->  mutes the whole channel
 *    channel + a mix      ->  mutes only that junction
 *
 * The press behaviour is configurable, as it always was: toggle, or force a direction.
 */

import { ACTION, STATE } from '../core/constants.js';
import { scopeMuted } from '../core/scope.js';
import { setStateIcon } from '../core/ui.js';

export const uuid = ACTION.CHANNEL_MUTE;

/** What this action must be bound to before it can do anything, or null. */
export const binding = 'channel';

export const defaults = {
  channelId: '',
  mixId: '',
  behaviour: 'toggle',
};

export function render({ $UD, context, channel, settings }) {
  setStateIcon($UD, context, scopeMuted(channel, settings.mixId) ? STATE.MUTED : STATE.UNMUTED);
}

export async function onRun({ settings, channel, report }) {
  if (!channel) {
    report(new Error('No channel selected'));
    return;
  }
  const registry = channel.registry;
  const mixId = settings.mixId || null;
  const muted = scopeMuted(channel, mixId);
  try {
    if (settings.behaviour === 'mute') {
      if (mixId) await registry.setChannelMuteInMix(channel.id, mixId, true);
      else await registry.setChannelMute(channel.id, true);
    } else if (settings.behaviour === 'unmute') {
      if (mixId) await registry.setChannelMuteInMix(channel.id, mixId, false);
      else await registry.setChannelMute(channel.id, false);
    } else {
      await registry.toggleChannelMute(channel.id, mixId);
    }
  } catch (err) {
    report(err);
  }
}
