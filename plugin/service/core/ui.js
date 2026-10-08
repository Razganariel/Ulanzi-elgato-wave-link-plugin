/**
 * Host UI helpers. The encoder display commands (setFeedbackLayout / setFeedback)
 * need UlanziStudio 3.3.0+; on older hosts they must not break the classic state
 * icon, so every call is individually guarded.
 *
 * Everything the plugin draws is remembered per context and re-sent only when it
 * actually differs. Wave Link notifies on every level change, so the repaint path
 * runs several times per second during a knob turn; without this the plugin
 * redraws every key with values it has already drawn. That is not only wasted
 * traffic: the host repaints the whole key when asked to, which is what appears to
 * discard the Title the user typed in its own field.
 */

/** Last state icon drawn per context, as `statetext`. */
const lastStateIcon = new Map();

export function setStateIcon($UD, context, state, text) {
  const label = text == null ? '' : String(text);
  const key = `${state}${label}`;
  if (lastStateIcon.get(context) === key) return;
  lastStateIcon.set(context, key);
  try {
    $UD.setStateIcon(context, state, label);
  } catch {
    /* host too old for this command */
    lastStateIcon.delete(context);
  }
}

/**
 * Encoder readout.
 *
 * Protocol V3.1 only ships built-in layout ids, and $UA1 is the one every shipped
 * plugin uses, so we stay on it and send only the `icon` element of its documented
 * shape ({ title: { text }, icon: { value } }).
 *
 * Only the icon is sent. The text on a dial belongs to Ulanzi Studio: it has its own
 * Title field, and filling the layout's title with the name of the bound channel or
 * mix fought it -- two sources for one word, and the user had to retype theirs. The
 * icon is ours because the host does not derive it from anything we set.
 *
 * An encoder's visible icon comes from this layout, not from setStateIcon, which is
 * why a mute change left the dial untouched while the key beside it did react.
 *
 * Sent only when the icon actually differs. Wave Link notifies on every level change,
 * so the repaint path runs constantly, and re-sending an identical layout dozens of
 * times per knob turn is pure noise -- and, since the host repaints the key when asked
 * to, also a good way to lose the Title the user typed.
 */
const lastEncoderIcon = new Map();

export function setEncoderIcon($UD, context, icon) {
  const image = icon == null ? '' : String(icon);
  if (lastEncoderIcon.get(context) === image) return;
  lastEncoderIcon.set(context, image);
  try {
    $UD.setFeedbackLayout(context, '$UA1');
    $UD.setFeedback(context, { icon: { value: image } });
  } catch {
    /* host without V3.1 display support */
    lastEncoderIcon.delete(context);
  }
}

/**
 * Forgets everything drawn on a key, so the next render repaints it from scratch.
 * Needed whenever the host rebuilds a key: it mounts blank, whatever we last sent.
 */
export function forgetHostDisplay(context) {
  lastEncoderIcon.delete(context);
  lastStateIcon.delete(context);
}

  /**
   * Drops every icon this cache remembers whose context is no longer live.
   *
   * The cache is keyed by context, and contexts do not disappear one at a time:
   * forgetting a key purges the whole slot, which can hold several instances of the
   * same action, and moving an action drops its previous context. Forgetting only the
   * one context named in the event left the others behind, so the map grew for the
   * whole session and a context that came back could be wrongly believed to already
   * carry its icon. Reconciling against the live set is complete by construction and
   * costs one pass over a handful of keys.
   *
   * @param {Iterable<string>} liveContexts
 */
export function pruneHostDisplay(liveContexts) {
  for (const context of [...lastEncoderIcon.keys()]) {
    if (liveContexts.has(context)) continue;
    lastEncoderIcon.delete(context);
    lastStateIcon.delete(context);
  }
  for (const context of [...lastStateIcon.keys()]) {
    if (!liveContexts.has(context)) lastStateIcon.delete(context);
  }
}
