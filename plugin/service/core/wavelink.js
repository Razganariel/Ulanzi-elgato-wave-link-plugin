/**
 * Wave Link WebSocket JSON-RPC 2.0 client.
 *
 * Handles connection to Wave Link local API, port discovery via ws-info.json,
 * request/response correlation, and notification dispatch.
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

// Multiple possible ws-info.json locations
const WS_INFO_PATHS = [
  // Windows Store version
  join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Packages', 'Elgato.WaveLink_g54w8ztgkx496', 'LocalState', 'ws-info.json'),
  // Standalone installer version (older)
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Elgato', 'WaveLink', 'ws-info.json'),
  // Alternative standalone location
  join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Elgato', 'WaveLink', 'ws-info.json'),
];

const FALLBACK_PORTS = [1884, 1885, 1886, 1887, 1888, 1889, 1890, 1891, 1892, 1893];
const ORIGIN = 'streamdeck://';
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const CONNECT_TIMEOUT_MS = 5000;
/** How many times a port that refuses the socket is looked up again. */
const DISCOVERY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 750;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function wlLog(msg) {
  const time = new Date().toISOString();
  console.log(`[WaveLink] ${time} ${msg}`);
}

export class WaveLinkClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.port = null;
    this.connected = false;
    this.connecting = false;
    this.requestId = 0;
    this.pending = new Map();
    this.reconnectAttempt = 0;
    this.reconnectPending = false;
    this.stopped = false;
    this.lastState = {
      channels: [],
      mixes: [],
      inputDevices: [],
      outputDevices: [],
      appInfo: null
    };
  }

  async connect() {
    if (this.connected || this.connecting) return;
    this.stopped = false;
    this.connecting = true;
    this.emit('connecting');

    // Wave Link picks a fresh port every time it starts, and writes it to
    // ws-info.json. Reading that file once is not enough on its own: if it is read
    // while the previous instance is still shutting down, the port it names is dead,
    // and a single attempt would leave the plugin disconnected until the next
    // restart. So the file is re-read on each attempt and a stale answer is
    // discarded as soon as the socket refuses it.
    let lastError = null;
    for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
      if (this.stopped) return;
      const port = await this._discoverPort();
      if (!port) {
        lastError = new Error('Wave Link not found: ws-info.json missing and all fallback ports failed');
      } else {
        try {
          await this._openSocket(port);
          return;
        } catch (err) {
          lastError = err;
          wlLog(`attempt ${attempt}/${DISCOVERY_ATTEMPTS} on port ${port} failed: ${err.message}`);
          this.ws = null;
          if (attempt < DISCOVERY_ATTEMPTS) await delay(RETRY_DELAY_MS);
        }
      }
    }

    this.connecting = false;
    wlLog(`ERROR: ${lastError.message}`);
    this.emit('error', lastError);
    this._scheduleReconnect();
    throw lastError;
  }

  async _openSocket(port) {
    this.port = port;
    const url = `ws://127.0.0.1:${port}`;
    wlLog(`Connecting to Wave Link at ${url}`);

    // ws library needs headers option for origin, not origin directly
    this.ws = new WebSocket(url, { headers: { Origin: ORIGIN } });
    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('close', (code, reason) => this._onClose(code, reason));
    this.ws.on('error', (err) => this._onError(err));

    // The handshake is asynchronous, so awaiting the constructor is not enough:
    // callers that go straight to getChannels() would be told "Not connected" while
    // the socket is still opening. Wait for the socket itself, and let _onOpen do the
    // initial queries once it really is open.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          this.ws?.terminate();
        } catch {
          /* already gone */
        }
        reject(new Error('Wave Link connection timed out'));
      }, CONNECT_TIMEOUT_MS);

      const onOpen = () => {
        cleanup();
        this._onOpen();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error('Wave Link connection failed'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.ws?.off('open', onOpen);
        this.ws?.off('error', onError);
      };

      this.ws.once('open', onOpen);
      this.ws.once('error', onError);
    });
  }

  async _discoverPort() {
    for (const path of WS_INFO_PATHS) {
      try {
        if (!existsSync(path)) {
          wlLog(`ws-info.json not found at ${path}`);
          continue;
        }
        const content = readFileSync(path, 'utf8');
        const data = JSON.parse(content);
        wlLog(`Found ws-info.json at ${path}: ${JSON.stringify(data)}`);
        if (data?.port && Number.isInteger(data.port) && data.port > 0) {
          wlLog(`Using port ${data.port} from ws-info.json`);
          return data.port;
        }
      } catch (e) {
        wlLog(`Failed to read ${path}: ${e.message}`);
      }
    }

    wlLog('ws-info.json not found, trying fallback ports...');
    for (const port of FALLBACK_PORTS) {
      wlLog(`Probing port ${port}...`);
      if (await this._probePort(port)) {
        wlLog(`Port ${port} responded`);
        return port;
      }
    }
    wlLog('No fallback ports responded');
    return null;
  }

  _probePort(port) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Origin: ORIGIN }
      });
      const timeout = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 500);
      ws.on('open', () => {
        clearTimeout(timeout);
        ws.close();
        resolve(true);
      });
      ws.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  _onOpen() {
    this.connected = true;
    this.connecting = false;
    this.reconnectAttempt = 0;
    wlLog('Connected to Wave Link');
    this.emit('connected');
    this._send({ method: 'getApplicationInfo', params: null });
    this._send({ method: 'setPluginInfo', params: { connectedDevices: ['SD'] } });
    // Use the methods that update lastState
    this.getChannels().catch((e) => wlLog(`getChannels failed: ${e.message}`));
    this.getMixes().catch((e) => wlLog(`getMixes failed: ${e.message}`));
    this.getInputDevices().catch((e) => wlLog(`getInputDevices failed: ${e.message}`));
    this.getOutputDevices().catch((e) => wlLog(`getOutputDevices failed: ${e.message}`));
    this._send({
      method: 'setSubscription',
      params: { focusedAppChanged: { isEnabled: true } }
    });
    wlLog('Initial requests sent (getChannels, getMixes, etc.)');
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        wlLog(`Request ${msg.id} error: ${JSON.stringify(msg.error)}`);
        reject(new Error(msg.error.message || 'Wave Link error'));
      } else {
        wlLog(`Request ${msg.id} response received`);
        resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      wlLog(`Notification: ${msg.method}`);
      this._handleNotification(msg);
    }
  }

  _handleNotification(msg) {
    switch (msg.method) {
      case 'channelsChanged':
        this.lastState.channels = msg.params?.channels || [];
        this.emit('channelsChanged', this.lastState.channels);
        break;
      case 'channelChanged':
        this._updateChannel(msg.params);
        this.emit('channelChanged', msg.params);
        break;
      case 'mixesChanged':
        this.lastState.mixes = msg.params?.mixes || [];
        this.emit('mixesChanged', this.lastState.mixes);
        break;
      case 'mixChanged':
        this._updateMix(msg.params);
        this.emit('mixChanged', msg.params);
        break;
      case 'inputDevicesChanged':
        this.lastState.inputDevices = msg.params?.inputDevices || [];
        this.emit('inputDevicesChanged', this.lastState.inputDevices);
        break;
      case 'inputDeviceChanged':
        this.emit('inputDeviceChanged', msg.params);
        break;
      case 'outputDevicesChanged':
        this.lastState.outputDevices = msg.params?.outputDevices || [];
        this.emit('outputDevicesChanged', this.lastState.outputDevices);
        break;
      case 'outputDeviceChanged':
        this.emit('outputDeviceChanged', msg.params);
        break;
      case 'focusedAppChanged':
        this.emit('focusedAppChanged', msg.params);
        break;
      case 'levelMeterChanged':
        this.emit('levelMeterChanged', msg.params);
        break;
    }
  }

  _updateChannel(params) {
    if (!params || params.id === undefined) return;
    const idx = this.lastState.channels.findIndex((c) => c.id === params.id);
    if (idx < 0) return;
    const merged = { ...this.lastState.channels[idx], ...params };
    // Wave Link reports a mix-level change as a partial `mixes` array holding
    // only the mix that moved. A shallow merge would therefore drop every other
    // mix the channel belongs to, and the property inspector would start showing
    // an incomplete channel. Merge entry by entry instead.
    if (Array.isArray(params.mixes)) {
      const byId = new Map(this.lastState.channels[idx].mixes?.map((m) => [m.id, m]));
      for (const entry of params.mixes) byId.set(entry.id, { ...byId.get(entry.id), ...entry });
      merged.mixes = [...byId.values()];
    }
    this.lastState.channels[idx] = merged;
  }

  _updateMix(params) {
    if (!params || params.id === undefined) return;
    const idx = this.lastState.mixes.findIndex((m) => m.id === params.id);
    if (idx >= 0) {
      this.lastState.mixes[idx] = { ...this.lastState.mixes[idx], ...params };
    }
  }

  _onClose(code, reason) {
    this.connected = false;
    this.connecting = false;
    wlLog(`Disconnected (code: ${code}, reason: ${reason || 'none'})`);
    this.emit('disconnected');
    if (!this.stopped) this._scheduleReconnect();
  }

  _onError(err) {
    wlLog(`WebSocket error: ${err.message}`);
    // EventEmitter throws when 'error' is emitted with no listener, which would kill
    // the service on a perfectly ordinary "Wave Link is not running". The registry
    // binds its listener before anything here runs, so the guard changes nothing in
    // production -- it is there for the day something instantiates a client without
    // one, which otherwise fails as ECONNREFUSED and reads like a network fault
    // rather than the ordering mistake it would be.
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  /**
   * Queues the next connection attempt, and keeps queueing them for as long as the
   * client is not stopped.
   *
   * There used to be a ceiling of six attempts, spanning about 68 seconds. A plugin
   * whose whole job is mirroring Wave Link onto the deck cannot afford to give up on
   * a program that simply was not running yet: starting Wave Link after that window
   * left the deck dead until the host itself was restarted. The delay stops growing
   * at 30s, so the retry costs nothing but one socket attempt, and the only thing
   * that ends the loop is disconnect() or the host closing the process.
   */
  _scheduleReconnect() {
    if (this.stopped || this.reconnectPending) return;
    const capped = this.reconnectAttempt >= RECONNECT_DELAYS_MS.length - 1;
    const wait = capped ? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1] : RECONNECT_DELAYS_MS[this.reconnectAttempt];
    this.reconnectAttempt++;
    if (!capped) {
      wlLog(`Scheduling reconnect in ${wait}ms (attempt ${this.reconnectAttempt})`);
    } else if (this.reconnectAttempt === RECONNECT_DELAYS_MS.length) {
      // Announced once, then silent. Retrying every 30s is cheap; saying so every
      // 30s for the rest of the session is not, and it buries anything else.
      wlLog(`Wave Link still unreachable, retrying every ${wait}ms until it appears`);
    }
    this.reconnectPending = true;
    setTimeout(() => {
      this.reconnectPending = false;
      if (this.stopped) return;
      // connect() logs and emits its own failure, so the rejection is expected here.
      // Left unhandled it surfaced as an uncaught exception, which reads like a bug
      // in the plugin instead of the ordinary consequence of Wave Link being down.
      this.connect().catch(() => {});
    }, wait);
  }

  _send(payload) {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ id, jsonrpc: '2.0', ...payload });
      if (this.ws?.readyState === WebSocket.OPEN) {
        wlLog(`Sending request ${id}: ${frame}`);
        this.ws.send(frame);
      } else {
        this.pending.delete(id);
        reject(new Error('WebSocket not connected'));
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          wlLog(`Request ${id} timeout`);
          reject(new Error('Request timeout'));
        }
      }, 5000);
    });
  }

  async call(method, params) {
    if (!this.connected) throw new Error('Not connected to Wave Link');
    wlLog(`Calling ${method} with params: ${JSON.stringify(params)}`);
    return this._send({ method, params });
  }

  async getChannels() {
    const res = await this.call('getChannels', null);
    this.lastState.channels = res?.channels || [];
    return this.lastState.channels;
  }

  async getMixes() {
    const res = await this.call('getMixes', null);
    this.lastState.mixes = res?.mixes || [];
    return this.lastState.mixes;
  }

  async getInputDevices() {
    const res = await this.call('getInputDevices', null);
    this.lastState.inputDevices = res?.inputDevices || [];
    return this.lastState.inputDevices;
  }

  async getOutputDevices() {
    const res = await this.call('getOutputDevices', null);
    this.lastState.outputDevices = res?.outputDevices || [];
    this.lastState.mainOutput = res?.mainOutput || {};
    return this.lastState.outputDevices;
  }

  async setChannel(id, params) {
    return this.call('setChannel', { id, ...params });
  }

  async setMix(id, params) {
    return this.call('setMix', { id, ...params });
  }

  async setInputDevice(id, inputs) {
    return this.call('setInputDevice', { id, inputs });
  }

  async setOutputDevice(params) {
    return this.call('setOutputDevice', params);
  }

  async subscribeLevelMeter(type, id, enabled = true) {
    return this.call('setSubscription', {
      levelMeterChanged: { type, id, isEnabled: enabled }
    });
  }

  disconnect() {
    this.stopped = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.connecting = false;
  }

  getState() {
    // Callers redraw keys from this snapshot, so they must not be able to reach
    // back into the cache through a shared array or channel object.
    return {
      ...this.lastState,
      channels: this.lastState.channels.map((c) => ({ ...c, mixes: (c.mixes || []).map((m) => ({ ...m })) })),
      mixes: this.lastState.mixes.map((m) => ({ ...m })),
      inputDevices: [...(this.lastState.inputDevices || [])],
      outputDevices: [...(this.lastState.outputDevices || [])],
    };
  }

  getChannel(id) {
    return this.lastState.channels.find((c) => c.id === id) || null;
  }

  getMix(id) {
    return this.lastState.mixes.find((m) => m.id === id) || null;
  }
}

export const waveLinkClient = new WaveLinkClient();