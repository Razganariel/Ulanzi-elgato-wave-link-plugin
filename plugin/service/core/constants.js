export const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.wavelink';

export const ACTION = Object.freeze({
  CHANNEL_MUTE: `${PLUGIN_UUID}.channel-mute`,
  CHANNEL_VOLUME: `${PLUGIN_UUID}.channel-volume`,
  CHANNEL_VOLUME_UP: `${PLUGIN_UUID}.channel-volume-up`,
  CHANNEL_VOLUME_DOWN: `${PLUGIN_UUID}.channel-volume-down`,
  MIX_VOLUME: `${PLUGIN_UUID}.mix-volume`,
  MIX_MUTE: `${PLUGIN_UUID}.mix-mute`,
  CONNECT: `${PLUGIN_UUID}.connect`,
});

export const STATE = Object.freeze({
  DEFAULT: 0,
  MUTED: 0,
  UNMUTED: 1,
});

export const LIMITS = Object.freeze({
  VOLUME_MIN: 0,
  VOLUME_MAX: 1,
  VOLUME_STEP: 0.05,
});

/** The only step sizes a dial accepts; the inspectors offer exactly these. */
export const VOLUME_STEPS = Object.freeze([0.01, 0.02, 0.05, 0.1, 0.25]);

/**
 * Icons an encoder draws in its feedback layout.
 *
 * A dial's visible icon comes from the layout, not from setStateIcon, so these have
 * to be spelled out here. They are asserted against the manifest states by the test
 * suite: an encoder whose layout icon and state images disagree shows one thing on
 * the dial and another on the key.
 */
export const ENCODER_ICON = Object.freeze({
  CHANNEL_VOLUME: 'images/action-channel-volume.svg',
  CHANNEL_VOLUME_MUTED: 'images/action-channel-volume-muted.svg',
  MIX_VOLUME: 'images/action-mix-volume.svg',
});

export const REPAINT_DELAY_MS = 400;