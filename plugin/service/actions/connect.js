/**
 * CONNECT — one button.
 *
 * Forces a reconnection to Wave Link and refreshes the channel and mix lists. Its
 * only dynamic display is the link state, which is worth seeing: a key that cannot
 * reach Wave Link should say so rather than look identical to one that can.
 */

import { ACTION } from '../core/constants.js';
import { setStateIcon } from '../core/ui.js';

export const uuid = ACTION.CONNECT;

/** What this action must be bound to before it can do anything, or null. */
export const binding = null;

export const defaults = {};

export function render({ $UD, context, snap }) {
  setStateIcon($UD, context, 0, snap.connected ? 'ONLINE' : 'OFFLINE');
}

export async function onRun({ registry, report }) {
  try {
    await registry.connect();
  } catch (err) {
    report(err);
  }
}
