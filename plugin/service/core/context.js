/**
 * Action instance bookkeeping.
 *
 * The host identifies an action instance with a context string built by the SDK
 * as "<action uuid>___<key>___<actionid>", e.g.
 * "com.ulanzi.ulanzistudio.wavelink.channel-mute___3_3___7f1c...". That string
 * is the only
 * handle we get on "which key holds which action", so two things have to hold:
 *
 *  - every event carries one, so the action can be recovered from it, and
 *  - a removal never leaves an entry behind that a later event would reuse.
 *
 * The second point is why this module exists. Removing an action and placing the
 * same action back on the same key has been observed to reach the service with
 * no fresh "add", so the context was absent from the map and every later event
 * for that key was dropped. The Ulanzi UI still showed the action, because the
 * host owns that view; the Stream Deck key stayed blank, because drawing it is
 * this plugin's job. Recovering the action from the context string closes that
 * gap without depending on an event the host may not send twice.
 *
 * A removal really does erase the entry, so a recovery after a clear starts from
 * the action defaults. The host answers the getSettings() that follows an add with
 * the real values, and falling back to the defaults for the frames in between is
 * visible and harmless, whereas inheriting a stale value would not be.
 */

/** Separator the SDK uses in encodeContext(). */
const SEP = '___';

/**
 * Splits a context string.
 *
 * A host is allowed to omit fields, so every part can be missing: `undefined`
 * becomes an empty string rather than the string "undefined".
 */
export function decodeContext(context) {
  const [uuid = '', key = '', actionid = ''] = String(context ?? '').split(SEP);
  return {
    uuid: uuid === 'undefined' ? '' : uuid,
    key: key === 'undefined' ? '' : key,
    actionid: actionid === 'undefined' ? '' : actionid,
  };
}

/**
 * Physical slot of a context, i.e. everything before the instance id.
 *
 * Used to purge a whole key when a removal arrives without an actionid, which is
 * what the host does when an action is dropped from a key it had already cleared.
 */
export function slotOf(context) {
  const { uuid, key } = decodeContext(context);
  return `${uuid}${SEP}${key}`;
}

/**
 * Finds the context currently holding one action instance, if any.
 *
 * Used when an action shows up on a key it did not occupy: the same actionid on
 * another key means the user moved it, and its settings moved with it.
 */
function findInstance(contexts, actionid, actionUuid) {
  if (!actionid) return undefined;
  for (const [context, entry] of contexts) {
    if (context === undefined) continue;
    if (decodeContext(context).actionid === actionid && entry?.action?.uuid === actionUuid) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Resolves the context of an event into a live entry, creating it if needed.
 *
 * @param {Map} contexts  context -> { action, settings }, updated in place
 * @param {string} context  context string carried by the event
 * @param {object} message  { uuid, param } as sent by the host
 * @param {(uuid: string) => object|undefined} findAction  action lookup
 * @returns {{ entry: object|null, created: boolean }}
 */
export function ensureEntry(contexts, context, message, findAction) {
  if (!context) return { entry: null, created: false };

  const existing = contexts.get(context);
  const action = findAction(message?.uuid || decodeContext(context).uuid);
  if (!action) return { entry: existing || null, created: false };

  const sameActionHere = existing?.action?.uuid === action.uuid;
  // Settings are seeded from the defaults, then whatever this instance already had,
  // then the host's param. The instance is identified by its actionid, so its
  // settings are looked up on the key it currently occupies as well as on this one:
  // a moved action keeps its id and its configuration.
  const previous = sameActionHere
    ? existing
    : findInstance(contexts, decodeContext(context).actionid, action.uuid);
  const carried = previous?.action?.uuid === action.uuid ? previous.settings : action.defaults;

  const settings = {
    ...carried,
    ...(message?.param || {}),
  };

  if (sameActionHere) {
    existing.settings = settings;
    return { entry: existing, created: false };
  }
  if (existing) {
    // Forget the old instance on this context so it cannot leak state back in.
    contexts.delete(context);
  }

  const entry = { action, settings };
  contexts.set(context, entry);
  return { entry, created: true };
}

/**
 * Drops every context bound to one action instance except the one kept.
 *
 * Moving an action to another key keeps the same actionid, and the host then
 * announces the new key with `setactive` alone: no clear for the key it left, no
 * add for the key it reached. Without this the old context survives and every
 * later redraw also paints a key the action no longer occupies.
 *
 * @param {string} actionid  instance id, empty to match nothing
 * @param {string} keep  context that must survive
 * @returns {number} entries removed
 */
export function forgetActionId(contexts, actionid, keep) {
  if (!actionid) return 0;
  let removed = 0;
  for (const candidate of [...contexts.keys()]) {
    if (candidate === keep) continue;
    if (decodeContext(candidate).actionid === actionid) {
      contexts.delete(candidate);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Drops the entry for a context, falling back to the whole physical slot.
 *
 * A removal whose context carries no actionid cannot be matched exactly, so the
 * slot is cleared instead. Leaving the stale entry in place is what makes the
 * next placement on that key inherit dead state.
 *
 * @returns {number} entries removed
 */
export function forget(contexts, context) {
  if (contexts.delete(context)) return 1;
  const slot = slotOf(context);
  let removed = 0;
  for (const candidate of [...contexts.keys()]) {
    if (slotOf(candidate) === slot) {
      contexts.delete(candidate);
      removed += 1;
    }
  }
  return removed;
}
