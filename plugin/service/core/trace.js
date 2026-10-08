/**
 * Raw event tracing.
 *
 * UlanziStudio only persists `logMessage` calls made at "error" level, so an
 * info-level trace is invisible: there is no way to tell "the host never sent
 * anything" from "everything worked". This module appends every websocket frame
 * in both directions plus the plugin's own log lines to a plain file next to the
 * host plugin log, which is the only reliable way to observe a live session.
 *
 * Everything is best effort: tracing must never break the service.
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Longest single line kept, in characters. */
const MAX_LINE = 1200;
/** Hard ceiling for the live trace file. */
const MAX_BYTES = 8 * 1024 * 1024;
/** How many rotated generations to keep. */
const KEEP = 2;

let target = null;
try {
  // <plugin>/service/core -> <UlanziDeck>/logs
  const dir = join(HERE, '..', '..', '..', '..', 'logs');
  mkdirSync(dir, { recursive: true });
  target = join(dir, 'com.ulanzi.ulanzistudio.wavelink.trace.log');
} catch {
  target = null;
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * An unbounded trace is a liability, not a diagnostic: the host pushes state
 * echoes several times a second, so a long session produced a gigabyte of
 * mostly noise. Rotate instead, keeping the most recent generations.
 */
/** Current size, or 0 when the file does not exist yet. */
function size() {
  try {
    return statSync(target).size;
  } catch {
    return 0;
  }
}

function rotate() {
  try {
    if (!size()) return;
    const oldest = `${target}.${KEEP}`;
    try {
      unlinkSync(oldest);
    } catch {
      /* nothing to discard yet */
    }
    for (let i = KEEP - 1; i >= 1; i -= 1) {
      try {
        renameSync(`${target}.${i}`, `${target}.${i + 1}`);
      } catch {
        /* generation absent */
      }
    }
    renameSync(target, `${target}.1`);
  } catch {
    /* tracing is best effort */
  }
}

export function trace(direction, data) {
  if (!target) return;
  let text;
  if (typeof data === 'string') {
    try {
      text = JSON.stringify(JSON.parse(data));
    } catch {
      text = data;
    }
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
  }
  if (text === undefined) text = String(data);
  if (text.length > MAX_LINE) text = `${text.slice(0, MAX_LINE)}…(+${text.length - MAX_LINE})`;
  try {
    // Checked on every append, with no one-shot flag: a long-lived service
    // that rotated only once would grow straight past the ceiling again.
    // `size()` rather than `statSync`: a bare statSync throws ENOENT on a fresh
    // install, that throw is caught right here, and the append below is never
    // reached -- so the trace file could never bootstrap itself.
    if (size() >= MAX_BYTES) rotate();
    appendFileSync(target, `[${stamp()}] ${direction} ${text}\n`, 'utf8');
  } catch {
    /* tracing is best effort */
  }
}

export const tracePath = target;
