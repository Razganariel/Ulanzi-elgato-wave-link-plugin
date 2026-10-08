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

import { appendFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
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
  target = join(dir, 'com.ulanzi.ulanzistudio.wavelink.trace.log');
} catch {
  target = null;
}

/**
 * Whether anything is written, and why it is not by default.
 *
 * Set this to true to turn tracing back on; nothing else has to change.
 *
 * It is a switch rather than a commented-out call because tracing is threaded through
 * thirteen call sites, five of them on the path every websocket frame takes. Commenting
 * one call out would leave the rest in place and the file half-written, which is the
 * worst of both worlds: a trace that exists and is not the whole truth. A named flag
 * consulted at the top of trace() is one line, and it cannot be half-applied.
 *
 * The reason it is off: the host pushes state echoes several times a second, so a
 * single eight-hour session filled three 8 MB generations, and the rotation itself does
 * a stat and a rename per append. It stays in the tree because it is the only reliable
 * way to tell "the host never sent anything" from "everything worked", and every
 * connection problem in this plugin turned on it.
 */
export const TRACING = false;

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
  // One check, on the path every frame takes. Everything below is the real cost.
  if (!TRACING || !target) return;
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

/**
 * Where a trace would go, and whether anything will actually be written there.
 *
 * One export rather than a bare `tracePath`: a path on its own invites the caller to
 * announce a file that nothing will ever create, which is what happened while tracing
 * was off.
 */
export const tracing = { on: TRACING, path: target };
