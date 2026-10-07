/**
 * Registry behaviour, driven against a fake transport.
 *
 * The registry is the only thing the actions talk to, so these tests pin the
 * exact JSON-RPC shape each action produces. That matters because Wave Link
 * accepts a `setChannel` it does not act on without reporting an error: a wrong
 * payload here looks like a plugin bug to the user, with nothing in the log to
 * explain it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WaveLinkRegistry } from '../plugin/service/core/registry.js';

/** Records every call instead of sending it, and holds the state Wave Link would. */
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.lastState = { channels: [], mixes: [] };
    this.calls = [];
    this.connectCalls = 0;
    this.disconnectCalls = 0;
  }

  async connect() {
    this.connectCalls++;
    this.connected = true;
    this.emit('connected');
  }

  disconnect() {
    this.disconnectCalls++;
    this.connected = false;
    this.emit('disconnected');
  }

  getChannel(id) {
    return this.lastState.channels.find((c) => c.id === id) || null;
  }

  getMix(id) {
    return this.lastState.mixes.find((m) => m.id === id) || null;
  }

  async setChannel(id, params) {
    this.calls.push(['setChannel', id, params]);
    return { ok: true };
  }

  async setMix(id, params) {
    this.calls.push(['setMix', id, params]);
    return { ok: true };
  }
}

function fixture({ channels = [], mixes = [] } = {}) {
  const client = new FakeClient();
  client.lastState.channels = channels;
  client.lastState.mixes = mixes;
  return { client, registry: new WaveLinkRegistry(client) };
}

/** A transport that refuses until it is told otherwise, like a Wave Link that is not running. */
class FailingClient extends FakeClient {
  constructor() {
    super();
    this.failing = true;
  }

  async connect() {
    this.connectCalls++;
    if (this.failing) throw new Error('Wave Link absent');
    this.connected = true;
    this.emit('connected');
  }
}

const channel = (over = {}) => ({ id: 'ch1', name: 'Mic 1', level: 0.5, isMuted: false, mixes: [], ...over });

test('a failed connection does not lock out the next attempt', async () => {
  // The Connect action on the deck and the button in the property inspector both go
  // through connect(). If a failed attempt leaves the in-flight guard armed, every
  // later call returns as if it had connected, without reaching Wave Link at all:
  // the button looks alive and does nothing, forever, with nothing in the log.
  const client = new FailingClient();
  const registry = new WaveLinkRegistry(client);

  await assert.rejects(registry.connect(), /Wave Link absent/);
  assert.equal(registry.snapshot().connecting, false, 'a failure must not look like a connection in progress');

  // Wave Link comes up, and the user presses Connect.
  client.failing = false;
  await registry.connect();
  assert.equal(client.connectCalls, 2, 'the second attempt must actually reach Wave Link');
  assert.equal(registry.isConnected(), true);
});

test('connect can be retried while Wave Link stays down, and reports each failure', async () => {
  const client = new FailingClient();
  const registry = new WaveLinkRegistry(client);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(registry.connect(), /Wave Link absent/, `attempt ${attempt} must surface its error`);
  }
  assert.equal(client.connectCalls, 3, 'each press must reach Wave Link');

  client.failing = false;
  await registry.connect();
  assert.equal(registry.isConnected(), true, 'and a later press must still connect');
  assert.equal(client.connectCalls, 4);
});

test('connect refuses to run twice at the same time', async () => {
  // Removing the guard is not the fix: two overlapping attempts would open two
  // sockets and duplicate every subscription. Only a failure has to release it.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = new FakeClient();
  client.connect = async () => {
    client.connectCalls++;
    await gate;
    client.connected = true;
    client.emit('connected');
  };
  const registry = new WaveLinkRegistry(client);

  const inFlight = registry.connect();
  const second = registry.connect();
  release();
  await Promise.all([inFlight, second]);

  assert.equal(client.connectCalls, 1, 'the second call must be dropped while the first is in flight');
  assert.equal(registry.snapshot().connecting, false, 'and the guard must be released once it settles');
});

test('a client error is relayed, and a registry nobody watches survives it', () => {
  // Same hazard one hop further along: the registry re-emits 'error' on itself, and
  // EventEmitter throws when 'error' has no listener. The service attaches one at
  // startup, so forwarding is what production does and must keep doing.
  const { client, registry } = fixture();
  const seen = [];
  registry.on('error', (err) => seen.push(err.message));
  registry.bind();
  client.emit('error', new Error('ECONNREFUSED'));
  assert.deepEqual(seen, ['ECONNREFUSED'], 'a watched registry must still forward');

  const other = fixture();
  other.registry.bind();
  assert.doesNotThrow(
    () => other.client.emit('error', new Error('ECONNREFUSED')),
    'an unwatched registry must not take the service down either'
  );
});

test('disconnect really releases the transport, not just the flag', async () => {
  // Clearing `_bound` looked like it undid the subscription, and it did not: the
  // transport kept all seven listeners, so the next connect() bound a second set over
  // the first. The repaint path hides the duplicates -- pending contexts sit in a Set
  // behind a debounce -- but the listener count grows by seven every cycle, and the
  // three events that are not deduplicated print twice in the log.
  const { client, registry } = fixture();
  const seen = [];
  for (const event of ['connected', 'disconnected', 'channelChanged', 'mixChanged']) {
    registry.on(event, () => seen.push(event));
  }

  await registry.start();
  const bound = client.eventNames().length;
  assert.equal(bound, 7, 'binding attaches one listener per event');

  for (let cycle = 0; cycle < 5; cycle += 1) {
    registry.disconnect();
    await registry.start();
  }
  assert.equal(
    client.eventNames().length,
    bound,
    'five disconnect/start cycles must leave the transport with exactly one set'
  );

  seen.length = 0;
  client.emit('channelChanged', { id: 'ch1' });
  assert.deepEqual(seen, ['channelChanged'], 'and an event must be forwarded exactly once');
});

test('a disconnected registry keeps nothing and says nothing more', () => {
  const { client, registry } = fixture();
  const seen = [];
  registry.on('connected', () => seen.push('connected'));
  registry.on('disconnected', () => seen.push('disconnected'));
  registry.bind();
  registry.disconnect();

  // Telling the transport to close makes it report back, and that one is honest:
  // the registry did go down. Anything after it is not, because it has let go.
  assert.deepEqual(seen, ['disconnected'], 'its own disconnection is reported exactly once');

  client.emit('connected');
  client.emit('disconnected');
  assert.deepEqual(seen, ['disconnected'], 'and nothing is forwarded afterwards');
  assert.equal(client.eventNames().length, 0, 'with no listener left on the transport');
});

test('bind is idempotent while it is in force', async () => {
  const { client, registry } = fixture();
  registry.bind();
  registry.bind();
  registry.bind();
  assert.equal(client.eventNames().length, 7, 'binding twice must not double the listeners');
});

test('start connects once and never twice', async () => {
  const { client, registry } = fixture();
  await registry.start();
  await registry.start();
  assert.equal(client.connectCalls, 1);
  assert.equal(registry.isConnected(), true);
});

test('connect is a no-op while a connection is already up', async () => {
  const { client, registry } = fixture();
  await registry.start();
  await registry.connect();
  assert.equal(client.connectCalls, 1, 'the open socket is not reopened');
});

test('disconnect releases the binding so a later start reconnects', async () => {
  const { client, registry } = fixture();
  await registry.start();
  registry.disconnect();
  assert.equal(client.disconnectCalls, 1);
  await registry.start();
  assert.equal(client.connectCalls, 2, 'a fresh start after a disconnect does connect');
});

test('muting a junction targets the mix entry, not the channel', async () => {
  // Wave Link keeps a channel's own mute and its per-mix mutes independent, which is
  // the whole point of a per-mix mute: { mixes: [{ id, isMuted }] } for one junction,
  // { isMuted } for the channel.
  const { client, registry } = fixture({
    channels: [channel({ isMuted: false, mixes: [{ id: 'mix1', level: 1, isMuted: false }] })],
  });

  await registry.toggleChannelMute('ch1', 'mix1');
  assert.deepEqual(client.calls[0], ['setChannel', 'ch1', { mixes: [{ id: 'mix1', isMuted: true }] }]);

  await registry.toggleChannelMute('ch1', null);
  assert.deepEqual(client.calls[1], ['setChannel', 'ch1', { isMuted: true }]);
});

test('unmuting a junction leaves the channel own mute alone', async () => {
  // Both muted: a press on the junction must only free that junction.
  const { client, registry } = fixture({
    channels: [channel({ isMuted: true, mixes: [{ id: 'mix1', level: 1, isMuted: true }] })],
  });
  await registry.toggleChannelMute('ch1', 'mix1');
  assert.deepEqual(
    client.calls[0],
    ['setChannel', 'ch1', { mixes: [{ id: 'mix1', isMuted: false }] }],
    'only the junction is freed'
  );
});

test('a forced junction mute writes the mix entry directly', async () => {
  const { client, registry } = fixture({
    channels: [channel({ mixes: [{ id: 'mix1', level: 1, isMuted: false }] })],
  });
  await registry.setChannelMuteInMix('ch1', 'mix1', true);
  await registry.setChannelMuteInMix('ch1', 'mix1', false);
  assert.deepEqual(client.calls, [
    ['setChannel', 'ch1', { mixes: [{ id: 'mix1', isMuted: true }] }],
    ['setChannel', 'ch1', { mixes: [{ id: 'mix1', isMuted: false }] }],
  ]);
});

test('channelMuted reads the scope, and is false for an unknown one', () => {
  const { registry } = fixture({
    channels: [channel({ isMuted: true, mixes: [{ id: 'mix1', isMuted: false }] })],
  });
  assert.equal(registry.channelMuted('ch1'), true, 'the channel is muted');
  assert.equal(registry.channelMuted('ch1', 'mix1'), false, 'its junction in mix1 is not');
  assert.equal(registry.channelMuted('ch1', 'other'), false, 'an unknown mix is not muted');
  assert.equal(registry.channelMuted('nope'), false, 'an unknown channel is not muted');
});

test('setChannelMute sends an explicit mute flag', async () => {
  const { client, registry } = fixture({ channels: [channel()] });
  await registry.setChannelMute('ch1', true);
  await registry.setChannelMute('ch1', false);
  assert.deepEqual(client.calls, [
    ['setChannel', 'ch1', { isMuted: true }],
    ['setChannel', 'ch1', { isMuted: false }],
  ]);
});

test('toggleChannelMute inverts the cached state', async () => {
  const { client, registry } = fixture({ channels: [channel({ isMuted: false })] });
  await registry.toggleChannelMute('ch1');
  assert.deepEqual(client.calls[0], ['setChannel', 'ch1', { isMuted: true }]);

  client.lastState.channels[0].isMuted = true;
  await registry.toggleChannelMute('ch1');
  assert.deepEqual(client.calls[1], ['setChannel', 'ch1', { isMuted: false }]);
});

test('toggleChannelMute refuses an unknown channel instead of muting nothing', async () => {
  const { client, registry } = fixture();
  await assert.rejects(() => registry.toggleChannelMute('nope'), /not found/);
  assert.equal(client.calls.length, 0, 'no request is sent for a channel that does not exist');
});

test('setChannelVolume without a mix sets the overall level', async () => {
  const { client, registry } = fixture({ channels: [channel()] });
  await registry.setChannelVolume('ch1', 0.75);
  assert.deepEqual(client.calls[0], ['setChannel', 'ch1', { level: 0.75 }]);
});

test('setChannelVolume with a mix targets that mix, not the overall level', async () => {
  // Wave Link has no channel-wide "volume in mix X" parameter: the level lives in
  // the channel's per-mix entry. Sending `level` here would move the channel on
  // every mix at once.
  const { client, registry } = fixture({ channels: [channel()] });
  await registry.setChannelVolume('ch1', 0.75, 'mix1');
  assert.deepEqual(client.calls[0], ['setChannel', 'ch1', { mixes: [{ id: 'mix1', level: 0.75 }] }]);
});

test('setChannelVolume preserves a fractional level', async () => {
  const { client, registry } = fixture({ channels: [channel()] });
  await registry.setChannelVolume('ch1', 0.95);
  assert.equal(client.calls[0][2].level, 0.95, 'no rounding to 1');
});

test('stepChannelVolume steps the overall level and clamps at the limits', async () => {
  const { client, registry } = fixture({ channels: [channel({ level: 0.5 })] });
  await registry.stepChannelVolume('ch1', 0.05);
  assert.deepEqual(client.calls[0], ['setChannel', 'ch1', { level: 0.55 }]);

  client.lastState.channels[0].level = 0.99;
  await registry.stepChannelVolume('ch1', 0.05);
  assert.equal(client.calls[1][2].level, 1, 'clamped, not 1.04');

  client.lastState.channels[0].level = 0.01;
  await registry.stepChannelVolume('ch1', -0.05);
  assert.equal(client.calls[2][2].level, 0, 'clamped, not negative');
});

test('stepChannelVolume reads the level of the selected mix', async () => {
  const { client, registry } = fixture({
    channels: [channel({ level: 0.5, mixes: [{ id: 'mix1', level: 0.8, isMuted: false }] })],
  });
  await registry.stepChannelVolume('ch1', 0.05, 'mix1');
  assert.deepEqual(client.calls[0], ['setChannel', 'ch1', { mixes: [{ id: 'mix1', level: 0.85 }] }]);
});

test('stepChannelVolume falls back to the overall level for an unknown mix', async () => {
  const { client, registry } = fixture({ channels: [channel({ level: 0.5, mixes: [] })] });
  await registry.stepChannelVolume('ch1', 0.05, 'gone');
  assert.deepEqual(client.calls[0], ['setChannel', 'ch1', { mixes: [{ id: 'gone', level: 0.55 }] }]);
});

test('stepChannelVolume refuses an unknown channel', async () => {
  const { client, registry } = fixture();
  await assert.rejects(() => registry.stepChannelVolume('nope', 0.05), /not found/);
  assert.equal(client.calls.length, 0);
});

test('setMixMute sends an explicit mute flag', async () => {
  const { client, registry } = fixture();
  await registry.setMixMute('mix1', true);
  assert.deepEqual(client.calls[0], ['setMix', 'mix1', { isMuted: true }]);
});

test('toggleMixMute inverts the cached state and refuses an unknown mix', async () => {
  const { client, registry } = fixture({ mixes: [{ id: 'mix1', level: 1, isMuted: false }] });
  await registry.toggleMixMute('mix1');
  assert.deepEqual(client.calls[0], ['setMix', 'mix1', { isMuted: true }]);
  await assert.rejects(() => registry.toggleMixMute('nope'), /not found/);
});

test('setMixVolume drives the mix fader shown in the Wave Link mix editor', async () => {
  const { client, registry } = fixture();
  await registry.setMixVolume('mix1', 0.85);
  assert.deepEqual(client.calls[0], ['setMix', 'mix1', { level: 0.85 }]);
});

test('stepMixVolume steps and clamps', async () => {
  const { client, registry } = fixture({ mixes: [{ id: 'mix1', level: 0.9, isMuted: false }] });
  await registry.stepMixVolume('mix1', 0.05);
  assert.deepEqual(client.calls[0], ['setMix', 'mix1', { level: 0.95 }]);

  client.lastState.mixes[0].level = 0.99;
  await registry.stepMixVolume('mix1', 0.05);
  assert.equal(client.calls[1][2].level, 1);

  client.lastState.mixes[0].level = 0.01;
  await registry.stepMixVolume('mix1', -0.05);
  assert.equal(client.calls[2][2].level, 0);
});

test('stepMixVolume refuses an unknown mix', async () => {
  const { client, registry } = fixture();
  await assert.rejects(() => registry.stepMixVolume('nope', 0.05), /not found/);
  assert.equal(client.calls.length, 0);
});

test('getChannels and getMixes never hand out undefined', () => {
  const { registry } = fixture();
  assert.deepEqual(registry.getChannels(), []);
  assert.deepEqual(registry.getMixes(), []);
});

test('snapshot reports the link state and the cached lists', async () => {
  const { registry } = fixture({ channels: [channel()], mixes: [{ id: 'mix1', level: 1 }] });
  const before = registry.snapshot();
  assert.equal(before.connected, false);
  assert.equal(before.channels.length, 1);
  assert.equal(before.mixes.length, 1);

  await registry.start();
  assert.equal(registry.snapshot().connected, true);
});

test('transport events are relayed to the UI layer', async () => {
  const { client, registry } = fixture();
  const seen = [];
  for (const event of ['connected', 'disconnected', 'channelsChanged', 'channelChanged', 'mixesChanged', 'mixChanged', 'error']) {
    registry.on(event, (payload) => seen.push([event, payload]));
  }
  await registry.start();
  client.emit('channelsChanged', [channel()]);
  client.emit('channelChanged', { id: 'ch1', level: 0.2 });
  client.emit('mixesChanged', [{ id: 'mix1' }]);
  client.emit('mixChanged', { id: 'mix1', level: 0.5 });
  client.emit('error', new Error('boom'));
  client.emit('disconnected');

  assert.deepEqual(
    seen.map(([event]) => event),
    ['connected', 'channelsChanged', 'channelChanged', 'mixesChanged', 'mixChanged', 'error', 'disconnected']
  );
  assert.equal(seen[2][1].level, 0.2, 'the payload reaches the redraw handler');
});

test('bind is idempotent: one client event must not be forwarded twice', async () => {
  const { client, registry } = fixture();
  let count = 0;
  await registry.start();
  registry.on('channelChanged', () => count++);
  registry.bind();
  registry.bind();
  client.emit('channelChanged', { id: 'ch1' });
  assert.equal(count, 1, 'the repaint must not run twice per notification');
});