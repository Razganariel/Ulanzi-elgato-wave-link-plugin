/**
 * What a bound scope currently is.
 *
 * A binding points either at a channel, or at one junction of a channel: the channel
 * within one mix. Both are read the same way everywhere -- the level and the mute of
 * "the thing this key is bound to" -- and Wave Link keeps them independent: muting a
 * junction says nothing about the channel, and the reverse.
 *
 * That single sentence was written out four times over, in the registry, in Channel
 * Volume, in Channel Volume Up and in Channel Volume Down. They drifted, and the drift
 * is what produced two of the defects this audit turned up: an encoder showing the
 * channel's mute while its press only touched a junction, and a step computed from the
 * channel's level when a junction was bound. One definition, one truth.
 */

/**
 * The cache entry for a scope, or null when the host never reported it.
 *
 * A junction that does not exist is never invented here. The transport merges a
 * notification junction by junction, so an entry invented at this level and never
 * confirmed would survive in the cache for the rest of the session, showing a level or
 * a mute that never happened.
 *
 * @param {{level?: number, mixes?: Array}} subject  a channel, or a mix for a bound mix
 * @param {string|null} scopeId  the mix id, or null/empty for the subject itself
 */
export function scopeEntry(subject, scopeId) {
  if (!scopeId) return subject || null;
  return subject?.mixes?.find((m) => m.id === scopeId) || null;
}

/**
 * The level of a scope.
 *
 * A junction the host has not reported has no level, and the channel's own is the only
 * sensible thing to measure from until it does.
 */
export function scopeLevel(subject, scopeId) {
  if (!subject) return 0;
  if (!scopeId) return subject.level ?? 0;
  return scopeEntry(subject, scopeId)?.level ?? subject.level ?? 0;
}

/** The mute of a scope. An unreported junction reads as unmuted. */
export function scopeMuted(subject, scopeId) {
  if (!subject) return false;
  if (!scopeId) return Boolean(subject.isMuted);
  return Boolean(scopeEntry(subject, scopeId)?.isMuted);
}
