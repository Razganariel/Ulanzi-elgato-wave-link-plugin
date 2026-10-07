/**
 * Wave Link transport behaviour, driven without opening a socket.
 *
 * Two things matter here and neither is visible from the actions:
 *
 *  - a request is correlated to its response by id, so a late response to an
 *    abandoned request must not resolve the wrong call, and a request that never
 *    gets an answer must reject instead of hanging the action forever.
 *  - `channelChanged` carries a *partial* channel. Wave Link sends only the field
 *    that moved, and for a mix level only the mix that moved, so merging has to
 *    be done per mix entry. A shallow merge silently deletes every other mix the
 *    channel belongs to, which then disappears from the property inspector.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WaveLinkClient } from '../plugin/service/core/wavelink.js';

/**
 * Stands in for a `ws` socket, already open, wired exactly as connect() wires a
 * real one. Handlers are attached here rather than by connect() so the test never
 * has to perform a real handshake.
 */
function openSocket(client) {
  const sent = [];
  const socket = new EventEmitter();
  socket.readyState = 1; // WebSocket.OPEN
  socket.send = (frame) => sent.push(JSON.parse(frame));
  socket.close = () => socket.emit('close', 1000, 'bye');
  socket.terminate = () => {};
  socket.on('message', (data) => client._onMessage(data));
  socket.on('close', (code, reason) => client._onClose(code, reason));
  socket.on('error', (err) => client._onError(err));
  client.ws = socket;
  client.connected = true;
  return { socket, sent };
}

const parse = (sent, method) => sent.find((f) => f.method === method);

test('a request is framed as JSON-RPC 2.0 with an incrementing id', async () => {
  const client = new WaveLinkClient();
  const { socket, sent } = openSocket(client);
  const first = client.setChannel('ch1', { level: 0.5 });
  const second = client.setMix('mix1', { isMuted: true });

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { id: 1, jsonrpc: '2.0', method: 'setChannel', params: { id: 'ch1', level: 0.5 } });
  assert.deepEqual(sent[1], { id: 2, jsonrpc: '2.0', method: 'setMix', params: { id: 'mix1', isMuted: true } });
  assert.equal(sent[0].jsonrpc, '2.0', 'the host rejects a frame without the version');

  socket.emit('message', Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', result: {} })));
  socket.emit('message', Buffer.from(JSON.stringify({ id: 2, jsonrpc: '2.0', result: {} })));
  await Promise.all([first, second]);
});

test('a setChannel targeting a mix sends the mix entry, not the overall level', async () => {
  const client = new WaveLinkClient();
  const { socket, sent } = openSocket(client);
  const pending = client.setChannel('ch1', { mixes: [{ id: 'mix1', level: 0.75 }] });
  assert.deepEqual(parse(sent, 'setChannel').params, {
    id: 'ch1',
    mixes: [{ id: 'mix1', level: 0.75 }],
  });
  socket.emit('message', Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', result: {} })));
  await pending;
});

test('a response resolves only its own request', async () => {
  const client = new WaveLinkClient();
  const { socket } = openSocket(client);
  const first = client.setChannel('ch1', { level: 0.1 });
  const second = client.setChannel('ch2', { level: 0.2 });

  socket.emit('message', Buffer.from(JSON.stringify({ id: 2, jsonrpc: '2.0', result: { ok: 'second' } })));
  assert.deepEqual(await second, { ok: 'second' });

  socket.emit('message', Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', result: { ok: 'first' } })));
  assert.deepEqual(await first, { ok: 'first' });
});

test('an error response rejects with the message the host sent', async () => {
  const client = new WaveLinkClient();
  const { socket } = openSocket(client);
  const pending = client.setChannel('ch1', { level: 0.1 });
  socket.emit('message', Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', error: { message: 'no such channel' } })));
  await assert.rejects(() => pending, /no such channel/);
});

test('a malformed frame is ignored instead of killing the socket', async () => {
  const client = new WaveLinkClient();
  const { socket, sent } = openSocket(client);
  socket.emit('message', Buffer.from('{not json'));
  assert.equal(sent.length, 0);
  assert.equal(client.pending.size, 0, 'nothing was waiting on it');

  const pending = client.setMix('mix1', { level: 1 });
  socket.emit('message', Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', result: {} })));
  assert.deepEqual(await pending, {}, 'the socket still works afterwards');
});

test('calling a method while disconnected fails instead of hanging', async () => {
  const client = new WaveLinkClient();
  client.connected = false;
  await assert.rejects(() => client.call('getChannels', null), /Not connected/);
});

test('a request sent on a closed socket rejects immediately', async () => {
  const client = new WaveLinkClient();
  const socket = new EventEmitter();
  socket.readyState = 3; // CLOSED
  socket.send = () => assert.fail('must not send on a closed socket');
  client.ws = socket;
  client.connected = true;
  await assert.rejects(() => client.setMix('mix1', { level: 1 }), /not connected/);
  assert.equal(client.pending.size, 0, 'the pending entry is not left behind');
});

test('channelsChanged replaces the cached list', () => {
  const client = new WaveLinkClient();
  let received = null;
  client.on('channelsChanged', (channels) => { received = channels; });
  client._handleNotification({ method: 'channelsChanged', params: { channels: [{ id: 'ch1' }] } });
  assert.equal(received.length, 1);
  assert.equal(client.getChannel('ch1').id, 'ch1');
});

test('channelChanged merges the fields that moved', () => {
  const client = new WaveLinkClient();
  client.lastState.channels = [{ id: 'ch1', name: 'Mic 1', level: 0.5, isMuted: false, mixes: [] }];
  client._handleNotification({ method: 'channelChanged', params: { id: 'ch1', level: 0.8 } });

  const channel = client.getChannel('ch1');
  assert.equal(channel.level, 0.8);
  assert.equal(channel.name, 'Mic 1', 'untouched fields survive');
  assert.equal(channel.isMuted, false);
});

test('channelChanged merges a mix level without dropping the other mixes', () => {
  // Wave Link reports only the mix that moved. Replacing the array wholesale would
  // leave a two-mix channel looking like a one-mix channel everywhere afterwards.
  const client = new WaveLinkClient();
  client.lastState.channels = [
    {
      id: 'ch1',
      level: 1,
      mixes: [
        { id: 'mix1', level: 1, isMuted: false },
        { id: 'mix2', level: 0.4, isMuted: true },
      ],
    },
  ];
  client._handleNotification({ method: 'channelChanged', params: { id: 'ch1', mixes: [{ id: 'mix2', level: 0.6 }] } });

  const { mixes } = client.getChannel('ch1');
  assert.equal(mixes.length, 2, 'the untouched mix is still there');
  assert.equal(mixes.find((m) => m.id === 'mix1').level, 1);
  assert.equal(mixes.find((m) => m.id === 'mix2').level, 0.6, 'the moved mix took the new level');
  assert.equal(mixes.find((m) => m.id === 'mix2').isMuted, true, 'and kept its other fields');
});

test('a mix level change does not disturb the channel overall level', () => {
  const client = new WaveLinkClient();
  client.lastState.channels = [{ id: 'ch1', level: 0.9, mixes: [{ id: 'mix1', level: 0.2 }] }];
  client._handleNotification({ method: 'channelChanged', params: { id: 'ch1', mixes: [{ id: 'mix1', level: 0.3 }] } });
  assert.equal(client.getChannel('ch1').level, 0.9);
});

test('a notification for an unknown channel is dropped, not invented', () => {
  const client = new WaveLinkClient();
  client.lastState.channels = [{ id: 'ch1', level: 0.5 }];
  client._handleNotification({ method: 'channelChanged', params: { id: 'ghost', level: 1 } });
  assert.equal(client.lastState.channels.length, 1, 'no half-built channel appears');
  assert.equal(client.getChannel('ghost'), null);
});

test('mixChanged merges the mix that moved', () => {
  const client = new WaveLinkClient();
  client.lastState.mixes = [{ id: 'mix1', name: 'Stream Mix', level: 1, isMuted: false }];
  client._handleNotification({ method: 'mixChanged', params: { id: 'mix1', level: 0.85 } });
  assert.equal(client.getMix('mix1').level, 0.85);
  assert.equal(client.getMix('mix1').name, 'Stream Mix');
});

test('getChannels and getMixes store what they are told', async () => {
  const client = new WaveLinkClient();
  const { socket } = openSocket(client);
  const channels = client.getChannels();
  const mixes = client.getMixes();
  socket.emit('message', Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', result: { channels: [{ id: 'ch1' }] } })));
  socket.emit('message', Buffer.from(JSON.stringify({ id: 2, jsonrpc: '2.0', result: { mixes: [{ id: 'mix1' }] } })));

  assert.deepEqual((await channels)[0].id, 'ch1');
  assert.deepEqual((await mixes)[0].id, 'mix1');
  assert.equal(client.getChannel('ch1').id, 'ch1', 'the cache is usable straight after');
  assert.equal(client.getMix('mix1').id, 'mix1');
});

test('a missing list in a response yields an empty list, not undefined', async () => {
  const client = new WaveLinkClient();
  const { socket } = openSocket(client);
  const channels = client.getChannels();
  socket.emit('message', Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', result: {} })));
  assert.deepEqual(await channels, [], 'the inspector must not iterate undefined');
});

test('getState hands out a copy so a caller cannot corrupt the cache', () => {
  const client = new WaveLinkClient();
  client.lastState.channels = [{ id: 'ch1', level: 0.5 }];
  const state = client.getState();
  state.channels[0].level = 1;
  assert.equal(client.getChannel('ch1').level, 0.5);
});

test('disconnect closes the socket and stops reconnecting', () => {
  const client = new WaveLinkClient();
  const { socket } = openSocket(client);
  let closed = 0;
  socket.on('close', () => closed++);
  client.disconnect();
  assert.equal(closed, 1);
  assert.equal(client.connected, false);
  assert.equal(client.stopped, true, 'no reconnect may be scheduled afterwards');
});

test('level meter subscription is a setSubscription frame', async () => {
  const client = new WaveLinkClient();
  const { socket, sent } = openSocket(client);
  const pending = client.subscribeLevelMeter('output', 'mix1', true);
  assert.deepEqual(parse(sent, 'setSubscription').params, {
    levelMeterChanged: { type: 'output', id: 'mix1', isEnabled: true },
  });
  socket.emit('message', Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', result: {} })));
  await pending;
});

test('an unknown notification is ignored rather than thrown on', () => {
  const client = new WaveLinkClient();
  assert.doesNotThrow(() => client._handleNotification({ method: 'somethingNew', params: {} }));
});