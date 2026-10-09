/**
 * Registry of Wave Link channels and mixes.
 *
 * Wraps the WaveLinkClient and provides a simplified interface for actions.
 * Maintains cached state and emits change events for UI updates.
 */

import { EventEmitter } from 'node:events';
import { scopeEntry, scopeLevel, scopeMuted } from './scope.js';
import { waveLinkClient } from './wavelink.js';

/**
 * Keeps a level inside 0.0-1.0 and free of binary floating point debris.
 * 0.9 + 0.05 is 0.9500000000000001 in IEEE 754, and sending that to the audio
 * engine means the fader settles a hair off the step the user asked for.
 */
function normaliseLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 1e6) / 1e6;
}

/**
 * Writes a field and hands back the undo, which also removes the field if it was not
 * there before.
 */
function setOptimistically(target, key, value) {
  const had = Object.hasOwn(target, key);
  const previous = target[key];
  target[key] = value;
  return () => {
    if (had) target[key] = previous;
    else delete target[key];
  };
}

/**
 * Writes a field, sends, and puts the field back if the request is refused.
 *
 * `target` may be null, in which case the request is simply sent with nothing written
 * first -- see scopeEntry in core/scope.js, which says why.
 */
async function optimistically(target, key, value, send) {
  if (!target) return send();
  const undo = setOptimistically(target, key, value);
  try {
    await send();
  } catch (err) {
    undo();
    throw err;
  }
}

export class WaveLinkRegistry extends EventEmitter {
  /**
   * @param {WaveLinkClient} [client] transport to drive. Defaults to the shared
   *   singleton; the tests inject a fake so they never open a socket.
   */
  constructor(client = waveLinkClient) {
    super();
    this._client = client;
    this._bound = false;
    this._handlers = new Map();
    this._connecting = false;
    this._started = false;
  }

  /**
   * Subscribes to the transport, and remembers the subscriptions.
   *
   * The handlers are held rather than written inline because `disconnect()` has to be
   * able to undo them. Clearing `_bound` alone used to look like it did: the client
   * went on carrying a full set of listeners, so the next `connect()` bound a second
   * one on top and every event arrived twice. The repaint path hides that -- the
   * pending contexts live in a Set behind a debounce, so a duplicate refresh collapses
   * into the one that was already queued. What does not collapse is the client itself:
   * seven listeners per cycle, for as many cycles as the session went through, and
   * duplicated lines in the log for the three events that are not deduplicated.
   */
  bind() {
    if (this._bound) return;
    this._bound = true;

    const client = this._client;

    this._handlers = new Map([
      ['connected', () => {
        this._connecting = false;
        this.emit('connected');
      }],
      ['disconnected', () => {
        this.emit('disconnected');
      }],
      ['error', (err) => {
        // Same hazard one hop further along: emitting 'error' on an EventEmitter that
        // has no listener throws. The service attaches one at startup, so in production
        // this always forwards.
        if (this.listenerCount('error') > 0) this.emit('error', err);
      }],
      ['channelsChanged', (channels) => {
        this.emit('channelsChanged', channels);
      }],
      ['channelChanged', (params) => {
        this.emit('channelChanged', params);
      }],
      ['mixesChanged', (mixes) => {
        this.emit('mixesChanged', mixes);
      }],
      ['mixChanged', (params) => {
        this.emit('mixChanged', params);
      }],
    ]);

    for (const [event, handler] of this._handlers) client.on(event, handler);
  }

  /** Removes every listener this registry added to the transport. */
  unbind() {
    for (const [event, handler] of this._handlers) this._client.off(event, handler);
    this._handlers = new Map();
    this._bound = false;
  }

  /** Start the connection (call once at service startup) */
  async start() {
    if (this._started) return;
    this._started = true;
    this.bind();
    await this.connect();
  }

  async connect() {
    if (this._connecting || this._client.connected) return;
    this._connecting = true;
    this.bind();
    try {
      await this._client.connect();
    } catch (err) {
      // The guard above must not stay armed after a failure. It used to, and every
      // later call then returned as if it had succeeded without ever reaching Wave
      // Link -- the Connect action on the deck and the button in the property
      // inspector both went permanently inert, silently, after one failed attempt.
      // Only the client's own 'connected' event cleared the flag, and that arrives
      // solely if the client reconnects by itself, which it stops attempting once
      // its last delay is spent. So a failure is what releases the guard.
      this._connecting = false;
      throw err;
    }
  }

  disconnect() {
    this._client.disconnect();
    // Releasing the flag was never enough on its own: the transport kept the listeners
    // this registry had added, so the next connect() bound a second set over the first
    // and every event arrived twice, seven more listeners per cycle. unbind() is what
    // actually undoes the subscription.
    this.unbind();
    this._connecting = false;
    this._started = false;
  }

  isConnected() {
    return this._client.connected;
  }

  /**
   * The registry's own view of the cache, shared and mutable.
   *
   * These arrays and the objects in them are the transport's live state, not a copy:
   * the optimistic writes above depend on writing into them, and the notification that
   * follows merges into them in place. Copying here would break both.
   *
   * So ownership is stated instead. Nothing outside this module may write to what these
   * return, and app.js keeps to it by copying before an action ever sees a channel --
   * see boundChannel, and the copy is what keeps a registry off the inspector payload.
   * The lists the property inspector receives are built field by field, so nothing
   * handed to a panel can reach the cache either.
   */
  getChannels() {
    return this._client.lastState.channels || [];
  }

  getMixes() {
    return this._client.lastState.mixes || [];
  }

  getChannel(id) {
    return this._client.getChannel(id);
  }

  getMix(id) {
    return this._client.getMix(id);
  }

  async setChannelMute(channelId, muted) {
    await this._client.setChannel(channelId, { isMuted: muted });
  }

  /**
   * Inverts one scope of a channel.
   *
   * With a mixId this touches only that junction, leaving the channel's own mute and
   * every other mix alone. Without one it touches the whole channel. The two are
   * independent, so muting a junction never implies muting the channel and unmuting a
   * junction never implies unmuting the channel.
   *
   * The intended state is written to the cache before the request goes out. Wave Link
   * answers with a notification, and that round trip has not finished when a second
   * press arrives -- so two quick presses both read the state from before, both ask
   * for the same value, and the second is absorbed in silence. Reading back what was
   * asked for instead makes consecutive presses alternate, which is what a toggle is.
   * A request that fails undoes the write, so a refused mute is never shown as done.
   */
  async toggleChannelMute(channelId, mixId = null) {
    const channel = this.getChannel(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);
    const muted = !this.channelMuted(channelId, mixId);

    await optimistically(scopeEntry(channel, mixId), 'isMuted', muted, () =>
      (mixId ? this.setChannelMuteInMix(channelId, mixId, muted) : this.setChannelMute(channelId, muted))
    );
  }

  async setChannelVolume(channelId, volume, mixId = null) {
    const level = normaliseLevel(volume);
    if (mixId) {
      await this._client.setChannel(channelId, { mixes: [{ id: mixId, level }] });
    } else {
      await this._client.setChannel(channelId, { level });
    }
  }

  /**
   * Whether the given scope of a channel is muted.
   *
   * Two scopes exist and they are independent in Wave Link: the channel as a whole
   * (`isMuted`) and the channel within one mix (`mixes[].isMuted`). Muting a junction
   * says nothing about the rest of the channel, which is what makes a per-mix mute
   * useful at all.
   */
  channelMuted(channelId, mixId = null) {
    return scopeMuted(this.getChannel(channelId), mixId);
  }

  /** Mutes one scope: the whole channel, or just the channel within a mix. */
  async setChannelMuteInMix(channelId, mixId, muted) {
    await this._client.setChannel(channelId, { mixes: [{ id: mixId, isMuted: muted }] });
  }

  /**
   * Moves a level by one step.
   *
   * The new level is written to the cache before the request goes out, for the same
   * reason a toggle reads back what it asked for. Measured: four rotations of +0.05
   * from 0.50 used to send 0.55 four times, so three steps in four were absorbed -- a
   * notification lands between two presses now and then, and every rotation that
   * outran it was measured from the same starting point. Rotating a dial is the most
   * repeated action the plugin has, so this was the costly half of the problem.
   */
  async stepChannelVolume(channelId, delta, mixId = null) {
    const channel = this.getChannel(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);
    const current = scopeLevel(channel, mixId);
    const next = normaliseLevel(current + delta);

    await optimistically(scopeEntry(channel, mixId), 'level', next, () =>
      this.setChannelVolume(channelId, next, mixId)
    );
  }

  async setMixMute(mixId, muted) {
    await this._client.setMix(mixId, { isMuted: muted });
  }

  /** Inverts a mix's own mute, with the same optimistic read-back as a channel. */
  async toggleMixMute(mixId) {
    const mix = this.getMix(mixId);
    if (!mix) throw new Error(`Mix ${mixId} not found`);
    const muted = !mix.isMuted;

    await optimistically(mix, 'isMuted', muted, () => this.setMixMute(mixId, muted));
  }

  async setMixVolume(mixId, volume) {
    await this._client.setMix(mixId, { level: normaliseLevel(volume) });
  }

  async stepMixVolume(mixId, delta) {
    const mix = this.getMix(mixId);
    if (!mix) throw new Error(`Mix ${mixId} not found`);
    const next = normaliseLevel(mix.level + delta);

    await optimistically(mix, 'level', next, () => this.setMixVolume(mixId, next));
  }

  snapshot() {
    return {
      connected: this._client.connected,
      connecting: this._connecting,
      channels: this.getChannels(),
      mixes: this.getMixes(),
    };
  }
}

export const waveLinkRegistry = new WaveLinkRegistry();