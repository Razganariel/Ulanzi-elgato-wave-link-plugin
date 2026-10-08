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

/**
 * State indices, shared by every action that can mute.
 *
 * UNMUTED is 0 on purpose. The host paints state 0 for a key the plugin has not
 * answered yet, so the first state has to be what the key should look like at rest --
 * and an action nobody has pressed is not muted. It also makes the icon an action shows
 * in the list equal to the one a dropped key falls back to, which is what the manifest
 * pins. Muted being 1 and not 0 cost a round of re-ordering; DEFAULT and UNMUTED being
 * the same number is not a coincidence, it is the same idea.
 */
export const STATE = Object.freeze({
  DEFAULT: 0,
  UNMUTED: 0,
  MUTED: 1,
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
  MIX_VOLUME_MUTED: 'images/action-mix-volume-muted.svg',
});

export const REPAINT_DELAY_MS = 400;