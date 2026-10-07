/**
 * Registry of Wave Link channels and mixes.
 *
 * Wraps the WaveLinkClient and provides a simplified interface for actions.
 * Maintains cached state and emits change events for UI updates.
 */

import { EventEmitter } from 'node:events';
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

export class WaveLinkRegistry extends EventEmitter {
  /**
   * @param {WaveLinkClient} [client] transport to drive. Defaults to the shared
   *   singleton; the tests inject a fake so they never open a socket.
   */
  constructor(client = waveLinkClient) {
    super();
    this._client = client;
    this._bound = false;
    this._connecting = false;
    this._started = false;
  }

  bind() {
    if (this._bound) return;
    this._bound = true;

    const client = this._client;

    client.on('connected', () => {
      this._connecting = false;
      this.emit('connected');
    });

    client.on('disconnected', () => {
      this.emit('disconnected');
    });

    client.on('error', (err) => {
      // Same hazard one hop further along: emitting 'error' on an EventEmitter that
      // has no listener throws. The service attaches one at startup, so in production
      // this always forwards.
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });

    client.on('channelsChanged', (channels) => {
      this.emit('channelsChanged', channels);
    });

    client.on('channelChanged', (params) => {
      this.emit('channelChanged', params);
    });

    client.on('mixesChanged', (mixes) => {
      this.emit('mixesChanged', mixes);
    });

    client.on('mixChanged', (params) => {
      this.emit('mixChanged', params);
    });
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
    this._bound = false;
    this._connecting = false;
    this._started = false;
  }

  isConnected() {
    return this._client.connected;
  }

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
   */
  async toggleChannelMute(channelId, mixId = null) {
    if (!this.getChannel(channelId)) throw new Error(`Channel ${channelId} not found`);
    if (mixId) {
      await this.setChannelMuteInMix(channelId, mixId, !this.channelMuted(channelId, mixId));
    } else {
      await this.setChannelMute(channelId, !this.channelMuted(channelId));
    }
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
    const channel = this.getChannel(channelId);
    if (!channel) return false;
    if (!mixId) return Boolean(channel.isMuted);
    return Boolean(channel.mixes?.find((m) => m.id === mixId)?.isMuted);
  }

  /** Mutes one scope: the whole channel, or just the channel within a mix. */
  async setChannelMuteInMix(channelId, mixId, muted) {
    await this._client.setChannel(channelId, { mixes: [{ id: mixId, isMuted: muted }] });
  }

  async stepChannelVolume(channelId, delta, mixId = null) {
    const channel = this.getChannel(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);
    const current = mixId
      ? (channel.mixes?.find((m) => m.id === mixId)?.level ?? channel.level)
      : channel.level;
    const next = normaliseLevel(current + delta);
    await this.setChannelVolume(channelId, next, mixId);
  }

  async setMixMute(mixId, muted) {
    await this._client.setMix(mixId, { isMuted: muted });
  }

  async toggleMixMute(mixId) {
    const mix = this.getMix(mixId);
    if (!mix) throw new Error(`Mix ${mixId} not found`);
    await this.setMixMute(mixId, !mix.isMuted);
  }

  async setMixVolume(mixId, volume) {
    await this._client.setMix(mixId, { level: normaliseLevel(volume) });
  }

  async stepMixVolume(mixId, delta) {
    const mix = this.getMix(mixId);
    if (!mix) throw new Error(`Mix ${mixId} not found`);
    const next = normaliseLevel(mix.level + delta);
    await this.setMixVolume(mixId, next);
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