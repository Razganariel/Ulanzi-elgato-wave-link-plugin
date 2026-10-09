/**
 * Wave Link Control for Ulanzi D200X - main service.
 *
 * Stays connected to UlanziStudio for the whole session, owns the connection
 * to Wave Link, and routes host events to the action handlers. Each action
 * instance is bound to a channel or mix through its settings.
 */

import { readFileSync } from 'node:fs';
import UlanziApi from '../ulanzi-api/index.js';
import { PLUGIN_UUID, REPAINT_DELAY_MS } from './core/constants.js';
import { waveLinkRegistry } from './core/registry.js';
import { findByUuid } from './actions/index.js';
import { decodeContext, ensureEntry, forget, forgetActionId } from './core/context.js';
import { trace, tracing } from './core/trace.js';
import { forgetHostDisplay, pruneHostDisplay } from './core/ui.js';

const $UD = new UlanziApi();

const contexts = new Map();
const encoderActions = new Set();

try {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const action of manifest.Actions || []) {
    if ((action.Controllers || []).includes('Encoder')) encoderActions.add(action.UUID);
  }
} catch (err) {
  log(`cannot read manifest: ${err.message}`, 'warn');
}

const controllers = new Map();

function isEncoderContext(context, entry) {
  const remembered = controllers.get(context);
  if (remembered) return remembered === 'Encoder';
  return encoderActions.has(entry?.action?.uuid || decodeContext(context).uuid);
}

function log(msg, level = 'info') {
  try {
    $UD.logMessage(msg, level);
  } catch {
    // logging is best effort
  }
  trace('LOG ', `${level} ${msg}`);
  process.stdout.write(`[wavelink] ${msg}\n`);
}

function report(err, context) {
  log(err.message, 'error');
  if (context) $UD.showAlert(context);
}

/**
 * Tells the user, once per key, that an action has nothing to act on.
 *
 * A key whose action is not bound used to be completely silent: turning the dial did
 * nothing at all, with no error anywhere, which is indistinguishable from a broken
 * connection. One alert is enough to explain it, and repeating it on every notch of
 * a fast rotation would be worse than the silence.
 */
const unboundReported = new Set();

function checkBinding(ctx) {
  const need = ctx.action?.binding;
  if (!need) return true;
  const subject = need === 'mix' ? ctx.mix : ctx.channel;
  if (subject) return true;
  if (unboundReported.has(ctx.context)) return false;
  unboundReported.add(ctx.context);
  report(new Error(`This action needs a ${need}: choose one in its properties`), ctx.context);
  return false;
}

function boundChannelId(context) {
  const entry = contexts.get(context);
  return String(entry?.settings?.channelId || '').trim();
}

function boundMixId(context) {
  const entry = contexts.get(context);
  return String(entry?.settings?.mixId || '').trim();
}

/**
 * The bound channel, as the action sees it.
 *
 * The action calls `channel.registry.setChannelVolume(...)`, so the registry has
 * to travel with the object. It is attached to a copy: writing it onto the cached
 * object would push the whole registry into every payload sent to the property
 * inspector, and a registry that points back at the cache is circular, which
 * JSON.stringify refuses outright.
 */
function boundChannel(context) {
  const channelId = boundChannelId(context);
  const channel = channelId ? waveLinkRegistry.getChannel(channelId) : null;
  return channel ? { ...channel, registry: waveLinkRegistry } : null;
}

function boundMix(context) {
  const mixId = boundMixId(context);
  const mix = mixId ? waveLinkRegistry.getMix(mixId) : null;
  return mix ? { ...mix, registry: waveLinkRegistry } : null;
}

function handlerContext(context, isEncoder) {
  const entry = contexts.get(context);
  const action = entry?.action;
  const channel = boundChannel(context);
  const mix = boundMix(context);
  const snap = waveLinkRegistry.snapshot();

  return {
    $UD,
    context,
    action,
    settings: { ...(action?.defaults || {}), ...(entry?.settings || {}) },
    registry: waveLinkRegistry,
    channel,
    mix,
    channelId: boundChannelId(context),
    mixId: boundMixId(context),
    snap,
    isEncoder,
    channels: snap.channels,
    mixes: snap.mixes,
    report: (err) => report(err, context),
  };
}

const pendingPaint = new Set();
let paintScheduled = false;

function scheduleRefresh(only) {
  if (only) pendingPaint.add(only);
  else for (const ctx of contexts.keys()) pendingPaint.add(ctx);
  if (paintScheduled) return;
  paintScheduled = true;
  setTimeout(() => {
    paintScheduled = false;
    const batch = [...pendingPaint];
    pendingPaint.clear();
    refreshAll(batch);
  }, REPAINT_DELAY_MS);
}

/**
 * Paints the keys named in `list`, in one pass.
 *
 * It used to call refresh(ctx) per entry, and refresh() walks every context and
 * reconciles both caches before painting one. So a single notification about one channel
 * walked the whole deck once per key on it: quadratic, on the path Wave Link takes
 * several times a second while a knob turns. Pruning is done once here and the loop
 * paints directly.
 */
function refreshAll(list) {
  pruneCaches();
  const wanted = new Set(list);
  for (const [ctx, entry] of contexts) {
    if (wanted.has(ctx)) paint(ctx, entry);
  }
}

/**
 * The lists the property inspectors need: an id and a name, and nothing else.
 *
 * Two things are deliberately absent. Wave Link ships a base64 PNG per channel and
 * per mix, which is megabytes of payload for a panel that only draws a <select>. And
 * so are the levels: an inspector only ever shows a name, but a level changes on every
 * rotation, so carrying one made the payload differ every time and the panel was
 * rebuilt on every notch of the dial. With the payload stable, it can be compared
 * before sending.
 */
function pickerLists(snap) {
  return {
    channels: (snap.channels || []).map((c) => ({ id: c.id, name: c.name })),
    mixes: (snap.mixes || []).map((m) => ({ id: m.id, name: m.name })),
  };
}

/** Last payload sent to each panel, so an unchanged one is not sent again. */
const lastInspectorPayload = new Map();

/**
 * Tells a panel what it needs, unless it already has it.
 *
 * `force` exists because a panel lives in a WebView the host recreates on every
 * open: it announces itself with get-registry, and a cache cannot tell "that panel
 * already has this" from "that panel was just created and has nothing". Without the
 * force, every freshly opened panel showed a stale status and empty pickers.
 */
function sendInspectorState(ctx, snap, channelId, mixId, { force = false } = {}) {
  const { channels, mixes } = pickerLists(snap);
  const payload = {
    event: 'state',
    state: { connected: snap.connected, connecting: snap.connecting, channels, mixes },
    channelId,
    mixId,
    channels,
    mixes,
  };
  const serialised = JSON.stringify(payload);
  if (!force && lastInspectorPayload.get(ctx) === serialised) return;
  lastInspectorPayload.set(ctx, serialised);
  $UD.sendToPropertyInspector(payload, ctx);
}

/**
 * Drops cached entries whose context is no longer live.
 *
 * Contexts vanish in bulk -- a whole slot on a removal, the old one on a move -- and a
 * forgotten entry would outlive the session or wrongly suppress the next send for a
 * key that came back.
 */
function pruneCaches() {
  pruneHostDisplay(contexts);
  for (const ctx of [...lastInspectorPayload.keys()]) {
    if (!contexts.has(ctx)) lastInspectorPayload.delete(ctx);
  }
}

/** Draws one key: its icon, then the state of its property inspector. */
function paint(ctx, entry, options) {
  const isEncoder = isEncoderContext(ctx, entry);
  const ctxForAction = handlerContext(ctx, isEncoder);
  try {
    entry.action?.render?.(ctxForAction);
  } catch (err) {
    log(`render failed for ${ctx}: ${err.message}`, 'warn');
  }
  sendInspectorState(
    ctx,
    ctxForAction.snap,
    ctxForAction.channelId,
    ctxForAction.mixId,
    options
  );
}

/** Paints the one named key, or the whole deck when `only` is omitted. */
function refresh(only, options) {
  pruneCaches();
  for (const [ctx, entry] of contexts) {
    if (only && ctx !== only) continue;
    paint(ctx, entry, options);
  }
}

waveLinkRegistry.on('connected', () => {
  log('Wave Link connected');
  scheduleRefresh();
});

waveLinkRegistry.on('disconnected', () => {
  log('Wave Link disconnected', 'warn');
  scheduleRefresh();
});

waveLinkRegistry.on('error', (err) => {
  log(`Wave Link error: ${err.message}`, 'error');
});

waveLinkRegistry.on('channelsChanged', () => {
  scheduleRefresh();
});

waveLinkRegistry.on('channelChanged', () => {
  scheduleRefresh();
});

waveLinkRegistry.on('mixesChanged', () => {
  scheduleRefresh();
});

waveLinkRegistry.on('mixChanged', () => {
  scheduleRefresh();
});

$UD.connect(PLUGIN_UUID);

// Said with log() and not trace(): trace() writes nothing while the switch is off, so
// this is the only way the state of tracing is visible at all in the host log.
log(
  tracing.on
    ? `tracing on -> ${tracing.path || '(unavailable)'}`
    : 'tracing off (set TRACING to true in service/core/trace.js)',
  'info'
);
try {
  const ws = $UD.websocket;
  const onMessage = ws.onmessage;
  const onSend = ws.send;
  ws.onmessage = (evt) => {
    trace('IN  ', evt?.data);
    return onMessage.call(ws, evt);
  };
  ws.send = (data) => {
    trace('OUT ', data);
    return onSend.call(ws, data);
  };
  trace('SYS ', 'websocket frames traced');
} catch (err) {
  log(`cannot install websocket trace: ${err.message}`, 'warn');
}

$UD.onConnected(() => {
  log('main service connected to UlanziStudio');
  // Auto-connect to Wave Link on startup
  waveLinkRegistry.start().catch((err) => log(`Wave Link auto-connect failed: ${err.message}`, 'warn'));
});

$UD.onClose(() => log('websocket closed', 'warn'));
$UD.onError((err) => log(`websocket error: ${err}`, 'error'));

$UD.onAdd((message) => {
  const context = message.context;
  if (message.controller) controllers.set(context, message.controller);
  // Placing an action replaces whatever that key held, under a new instance id. The
  // previous entry is gone from the host but not from us, so it stayed in the map and
  // kept repainting a key that no longer carried it -- and the host kept sending dial
  // events for the new instance, which has no settings until one is chosen for it.
  // Clearing the slot before seeding it keeps exactly one live entry per key.
  forget(contexts, context);
  const { entry, created } = ensureEntry(contexts, context, message, (uuid) => findByUuid(uuid));
  if (!entry) return;
  // The host mounts a key from scratch, so its dial starts blank whatever we last
  // sent: the remembered icon must not suppress this first repaint.
  forgetHostDisplay(context);
  $UD.getSettings(context);
  scheduleRefresh(context);
});

$UD.onDidReceiveSettings((message) => {
  const context = message.context;
  const { entry } = ensureEntry(contexts, context, { uuid: message.uuid, param: message.settings }, (uuid) => findByUuid(uuid));
  if (!entry) return;
  forgetActionId(contexts, decodeContext(context).actionid, context);
  // Merged, not replaced: the host replays its stored settings, sometimes as an empty
  // "param": {}, and replacing would drop what the user chose for the rest of the session.
  entry.settings = { ...entry.action.defaults, ...entry.settings, ...(message.settings || {}) };
  // No forgetHostDisplay. The encoder icon depends on the mute state, never on these
  // settings, so there is nothing new to draw -- and the host replays settings on every
  // key selection, so clearing here rewrote the whole dial layout on every click.
  refresh(context);
});

$UD.onParamFromApp((message) => {
  const context = message.context;
  const { entry, created } = ensureEntry(contexts, context, { uuid: message.uuid, param: message.param }, (uuid) => findByUuid(uuid));
  if (!entry) return;
  const ghosts = forgetActionId(contexts, decodeContext(context).actionid, context);
  if (ghosts) trace('EVT ', `action moved, dropped ${ghosts} stale context(s) for ${decodeContext(context).actionid}`);
  // Merged for the same reason as onDidReceiveSettings.
  entry.settings = { ...entry.action.defaults, ...entry.settings, ...(message.param || {}) };
  // No forgetHostDisplay either. setActive is immediately followed by paramfromapp on
  // every selection, so clearing the cache here was the other half of the same repaint.
  refresh(context);
});

$UD.onClear((message) => {
  const items = Array.isArray(message.param) ? message.param : [];
  for (const item of items) {
    if (!item?.context) continue;
    controllers.delete(item.context);
    unboundReported.delete(item.context);
    // forget() drops the whole slot, not just this context, so the encoder icon cache
    // is reconciled against the surviving set by the next refresh instead of being
    // pruned one context at a time here.
    forget(contexts, item.context);
  }
  scheduleRefresh();
});

function contextFor(context, message) {
  const { entry, created } = ensureEntry(contexts, context, message, (uuid) => findByUuid(uuid));
  if (created) {
    trace('EVT ', `recovered context ${context} -> ${entry.action.uuid}`);
    refresh(context);
  }
  return handlerContext(context, isEncoderContext(context, entry));
}

$UD.onSetActive((message) => {
  const context = message.context;
  if (message.controller) controllers.set(context, message.controller);
  const { entry, created } = ensureEntry(contexts, context, message, (uuid) => findByUuid(uuid));
  if (!entry) return;
  const { key, actionid } = decodeContext(context);
  for (const [other, otherEntry] of contexts) {
    if (other !== context && decodeContext(other).actionid === actionid) controllers.delete(other);
  }
  const ghosts = forgetActionId(contexts, actionid, context);
  if (ghosts) trace('EVT ', `action moved to ${key}, dropped ${ghosts} stale context(s) for ${actionid}`);
  // Deliberately no forgetHostDisplay here. setActive fires when a key is merely
  // selected, not when it is mounted, and clearing the cache there rewrote the whole
  // encoder layout on every click: the host repaints the dial and puts its own title
  // back, so the text flickered each time a key was selected. The icon is already on
  // the dial and the layout is already correct. A genuine mount goes through onAdd,
  // and an action moved to another key lands on a context that has no cached icon.
  refresh(context);
});

$UD.onRun((message) => {
  const ctx = contextFor(message.context, message);
  trace('EVT ', `run ${message.context} channel=${ctx.channelId || 'none'} mix=${ctx.mixId || 'none'}`);
  if (checkBinding(ctx)) ctx.action?.onRun?.(ctx);
});

$UD.onDialRotate((message) => {
  const ctx = contextFor(message.context, message);
  trace('EVT ', `dialrotate ${message.context} ${message.rotateEvent || ''} action=${ctx.action?.uuid}`);
  if (checkBinding(ctx)) ctx.action?.onDialRotate?.(ctx, message);
});

$UD.onDialUp((message) => {
  const ctx = contextFor(message.context, message);
  trace('EVT ', `dialup ${message.context}`);
  if (checkBinding(ctx)) ctx.action?.onDialPress?.(ctx);
});

$UD.onSendToPlugin(async (message) => {
  const payload = message.payload || {};
  const context = message.context || `${message.uuid}___${message.key}___${message.actionid}`;
  trace('EVT ', `sendToPlugin ${payload.event || '?'} ${JSON.stringify(payload)}`);
  ensureEntry(contexts, context, message, (uuid) => findByUuid(uuid));

  try {
    if (payload.event === 'pi-hello') {
      log(`property inspector ready, shared.js v${payload.version}`, 'info');
      return;
    }
    if (payload.event === 'pi-form') {
      log(`pi-form ${JSON.stringify(payload.values)}`, 'info');
      return;
    }
    if (payload.event === 'set-settings') {
      const current = contexts.get(context);
      log(`set-settings ${JSON.stringify(payload.settings)}`, 'info');
      if (current) {
        // Merged, not replaced: the host still holds keys this plugin has dropped
        // from the panel, and rewriting the settings without them would prune them.
current.settings = { ...current.settings, ...(payload.settings || {}) };
        // The user just chose something: if we had warned them that nothing was bound,
        // that is no longer true, so the next miss must be able to warn again.
        unboundReported.delete(context);
        forgetHostDisplay(context);
        // This is what actually persists the edit. Holding it only in memory would
        // lose it the moment the key is reselected, because the host replays its
        // own stored copy on every open.
        log(`set-settings merged -> ${JSON.stringify(current.settings)}`, 'info');
        $UD.setSettings(current.settings, context);
        refresh(context);
      }
      return;
    }
    if (payload.event === 'connect') {
      await waveLinkRegistry.connect();
      refresh(context);
      return;
    }
    if (payload.event === 'get-registry') {
      log(`get-registry received for context: ${context}`);
      // Only the panel that asked. Refreshing every instance of the action looked
      // helpful -- it is what a panel needs when the lists changed -- but the host
      // delivers these to whichever panel is open, so the last one sent won and all
      // the dials ended up showing the same channel and mix. Each panel gets its own
      // answer, and a panel that is closed learns nothing until it asks.
      refresh(context, { force: true });
      return;
    }
  } catch (err) {
    report(err, context);
    $UD.sendToPropertyInspector({ event: 'error', message: err.message }, context);
  }
});

process.on('uncaughtException', (err) => {
  log(`uncaught: ${err && err.stack ? err.stack : err}`, 'error');
});

// Node raises an unhandled rejection as an uncaught exception, so without this the
// two would be indistinguishable in the log: a stray promise would be filed as a
// crash and send the reader looking for a bug that is not there.
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${(reason && reason.message) || reason}`, 'error');
});

process.on('SIGINT', () => {
  waveLinkRegistry.disconnect();
  process.exit(0);
});

log('Wave Link plugin main service started');
export { $UD, waveLinkRegistry };