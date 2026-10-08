/**
 * CHANNEL VOLUME DIAL — one encoder, bound to a channel, optionally to one mix.
 *
 * Contract of a Wave Link action, restated from scratch:
 *
 *  - The host owns the key. It draws the icon from the manifest states, it owns the
 *    Title field, and it repaints the key whenever it sees fit. This module never
 *    publishes a title, never publishes a level, and never asks for a redraw it does
 *    not need.
 *  - The dial is the one thing the host does not own, so the plugin fills it once
 *    with the name of whatever it is bound to. It changes only when the binding does.
 *  - Wave Link notifies on every level change, several times a second while a knob
 *    turns. None of that is worth drawing: the fader already shows the level.
 *
 * Scope. A binding has one, and both the level and the mute follow it:
 *
 *    channel, no mix      ->  the channel itself
 *    channel + a mix      ->  the channel within that mix
 *
 * So "Discord" with no mix mutes the whole Discord channel, and "Discord" bound to
 * Stream Mix mutes only the Discord/Stream Mix junction, which Wave Link keeps
 * independent of the channel's own mute.
 */

import { ACTION, ENCODER_ICON, LIMITS, STATE, VOLUME_STEPS } from '../core/constants.js';
import { rotateSteps } from '../core/dial.js';
import { clampFloat, dialStep, volumeBounds } from '../core/params.js';
import { setEncoderIcon, setStateIcon } from '../core/ui.js';

export const uuid = ACTION.CHANNEL_VOLUME;

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

/**
 * Draws the key and the dial. The icon shows the mute of the bound scope, which is
 * the same scope a press acts on -- showing the channel's own mute while the press
 * would only touch a junction would be a lie.
 */
export function render({ $UD, context, channel, isEncoder, settings }) {
  const mixId = settings.mixId || null;
  const muted = mixId
    ? Boolean(channel?.mixes?.find((m) => m.id === mixId)?.isMuted)
    : Boolean(channel?.isMuted);
  setStateIcon($UD, context, muted ? STATE.MUTED : STATE.UNMUTED);
  if (isEncoder) {
    // The dial's text is the host's Title; the only thing we draw there is the icon,
    // which follows the mute of the bound scope.
    setEncoderIcon($UD, context, muted ? ENCODER_ICON.CHANNEL_VOLUME_MUTED : ENCODER_ICON.CHANNEL_VOLUME);
  }
}

export async function onDialRotate(ctx, message) {
  const { settings, channel, mix, report } = ctx;
  if (!channel) return;
  const direction = rotateSteps(message);
  if (direction === 0) return;
  const { min, max } = volumeBounds(settings);
  const step = dialStep(settings.step, 0.01, max - min, defaults.step, VOLUME_STEPS);
  const level = currentLevel(channel, settings.mixId);
  const next = clampFloat(level + direction * step, min, max, level);
  try {
    await channel.registry.setChannelVolume(channel.id, next, settings.mixId || null);
  } catch (err) {
    report(err);
  }
}

export async function onDialPress(ctx) {
  const { settings, channel, report } = ctx;
  if (!channel) return;
  try {
    await channel.registry.toggleChannelMute(channel.id, settings.mixId || null);
  } catch (err) {
    report(err);
  }
}
