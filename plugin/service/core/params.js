/**
 * Parameter helpers shared by every volume action.
 *
 * Wave Link levels are always floats in 0.0-1.0, so there is no integer variant:
 * rounding here silently turned a 0.95 level into 1. The host hands settings back
 * as strings sometimes and numbers other times depending on how they were typed in
 * the property inspector, so every read goes through clampFloat.
 */

import { LIMITS } from './constants.js';

/**
 * Float clamped into [min, max], falling back when absent or unparseable. */
export function clampFloat(value, min, max, fallback) {
  // `Number('')` is 0 and `Number('  ')` too, so a field the user emptied would
  // silently become 0 instead of keeping its default. Blank is not a number.
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Reads a dial step, refusing steps that would make the dial unusable: a step
 * wider than the range would freeze the encoder on its current value, and a
 * step of zero would too. Volume steps are floats, so the value must never be
 * rounded to an integer -- doing so turned every offered step into 0.
 */
export function dialStep(value, min, max, fallback, allowed = null) {
  const span = Math.max(Number.EPSILON, max - min);
  // Clamping the raw value into [min, span] would quietly turn 0 into min, so an
  // unusable step has to be recognised as such and replaced by the default.
  const blank = value === undefined || value === null || String(value).trim() === '';
  const n = blank ? NaN : Number(value);
  let step = Number.isFinite(n) ? n : NaN;
  if (!(step > 0) || step > span) step = fallback;
  return allowed && !allowed.includes(step) ? fallback : step;
}

/**
 * The range a volume action may travel in.
 *
 * One rule for every action that moves a level, because the alternative is a bound
 * that depends on which action happens to sit on the key: a Channel Volume dial with
 * Max 0.8 refuses to go past 0.8, while a Channel Volume Up button on the same channel,
 * having no range of its own to read, walked it up to 1. Settings are stored per key,
 * not per channel, so a button could never have honoured the dial's range -- it was
 * the panel that was missing, not the logic.
 *
 * `max` is clamped up to `min` so an inverted pair degrades to a single usable level
 * instead of producing a range that no step can satisfy.
 */
export function volumeBounds(settings) {
  const min = clampFloat(settings?.min, LIMITS.VOLUME_MIN, LIMITS.VOLUME_MAX, LIMITS.VOLUME_MIN);
  const max = clampFloat(settings?.max, min, LIMITS.VOLUME_MAX, LIMITS.VOLUME_MAX);
  return { min, max };
}
