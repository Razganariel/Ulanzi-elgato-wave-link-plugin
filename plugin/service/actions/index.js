/**
 * Action registry. Each entry owns its own settings handling and icon/feedback
 * updates; app.js only routes host events here.
 */

import * as channelMute from './channel-mute.js';
import * as channelVolume from './channel-volume.js';
import * as channelVolumeUp from './channel-volume-up.js';
import * as channelVolumeDown from './channel-volume-down.js';
import * as mixVolume from './mix-volume.js';
import * as mixMute from './mix-mute.js';
import * as connect from './connect.js';

const MODULES = [
  channelMute,
  channelVolume,
  channelVolumeUp,
  channelVolumeDown,
  mixVolume,
  mixMute,
  connect,
];

export const registry = new Map();
for (const mod of MODULES) registry.set(mod.uuid, mod);

export function findByUuid(uuid) {
  return registry.get(uuid) || null;
}