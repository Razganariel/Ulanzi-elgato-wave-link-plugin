/**
 * Action instance bookkeeping.
 *
 * The bug these tests pin down: removing an action from a Stream Deck key and
 * placing the same action back on that key left the key blank while the Ulanzi UI
 * showed it. The host redraws its own view from its own model; the deck key is
 * drawn only by this plugin, so a context the service does not know about can
 * never be drawn, however correct the host's state is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeContext, ensureEntry, forget, forgetActionId, slotOf } from '../plugin/service/core/context.js';

const UUID = 'com.ulanzi.ulanzistudio.wavelink';
const actions = {
  [`${UUID}.channel-volume`]: { uuid: `${UUID}.channel-volume`, defaults: { step: 0.05, min: 0, max: 1 } },
  [`${UUID}.mix-volume`]: { uuid: `${UUID}.mix-volume`, defaults: { step: 0.1, min: 0, max: 1 } },
};
const findAction = (uuid) => actions[uuid];

const ctx = (key, actionid, action = 'channel-volume') => `${UUID}.${action}___${key}___${actionid}`;

test('decodeContext splits the SDK context string', () => {
  assert.deepEqual(decodeContext(ctx('3_3', 'abc')), {
    uuid: `${UUID}.channel-volume`,
    key: '3_3',
    actionid: 'abc',
  });
});

test('decodeContext tolerates the undefined the host sends for missing fields', () => {
  // String(undefined) would leak the literal "undefined" into every lookup.
  assert.deepEqual(decodeContext(`${UUID}.channel-volume___3_3___undefined`), {
    uuid: `${UUID}.channel-volume`,
    key: '3_3',
    actionid: '',
  });
  assert.deepEqual(decodeContext(''), { uuid: '', key: '', actionid: '' });
  assert.deepEqual(decodeContext(undefined), { uuid: '', key: '', actionid: '' });
});

test('slotOf ignores the instance id so a whole key can be purged', () => {
  assert.equal(slotOf(ctx('3_3', 'abc')), `${UUID}.channel-volume___3_3`);
  assert.equal(slotOf(ctx('3_3', 'other')), slotOf(ctx('3_3', 'abc')), 'same key, same slot');
  assert.notEqual(slotOf(ctx('3_3', 'abc')), slotOf(ctx('4_3', 'abc')));
});

test('an add registers the action and seeds its settings', () => {
  const contexts = new Map();
  const { entry, created } = ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume` }, findAction);
  assert.equal(created, true);
  assert.equal(entry.action.uuid, `${UUID}.channel-volume`);
  assert.deepEqual(entry.settings, { step: 0.05, min: 0, max: 1 });
  assert.equal(contexts.size, 1);
});

test('a later event rebuilds a context that was never added', () => {
  // The reported failure: the key holds an action again, but no add was sent, so
  // the map is empty and the deck key can never be drawn.
  const contexts = new Map();
  assert.equal(contexts.size, 0, 'precondition: nothing known about the key');

  // A run event is the only thing that arrives; the action uuid is in the context.
  const { entry, created } = ensureEntry(contexts, ctx('3_3', 'abc'), {}, findAction);
  assert.equal(created, true, 'the action must be recovered from the context');
  assert.equal(entry.action.uuid, `${UUID}.channel-volume`);
  assert.deepEqual(entry.settings, { step: 0.05, min: 0, max: 1 }, 'defaults, since the host sent none');
});

test('an unknown context recovers nothing instead of inventing an action', () => {
  const contexts = new Map();
  const { entry, created } = ensureEntry(contexts, 'other.plugin___3_3___abc', {}, findAction);
  assert.equal(entry, null);
  assert.equal(created, false);
  assert.equal(contexts.size, 0);
});

test('after a removal, recovery starts from the defaults', () => {
  // forget() drops the entry, so a recovery cannot inherit anything from it. That
  // is deliberate: the entry is the only memory of the old instance, and the host
  // answers the getSettings() that follows an add with the real values. Falling
  // back to the defaults for the frames in between is visible and harmless,
  // whereas inheriting a stale value would not be.
  const contexts = new Map();
  ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume`, param: { step: 0.3 } }, findAction);
  forget(contexts, ctx('3_3', 'abc'));

  const { entry } = ensureEntry(contexts, ctx('3_3', 'abc'), {}, findAction);
  assert.equal(entry.settings.step, 0.05, 'the default, not the removed step');
});

test('a surviving entry keeps its settings across repeated events', () => {
  // The no-clear case: the host re-sends an event for a context still in the map.
  const contexts = new Map();
  ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume`, param: { step: 0.3 } }, findAction);
  const { entry } = ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume` }, findAction);
  assert.equal(entry.settings.step, 0.3, 'the step the user chose');
});

test('a host param wins over a recovered setting', () => {
  const contexts = new Map();
  ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume`, param: { step: 0.3 } }, findAction);
  const { entry } = ensureEntry(contexts, ctx('3_3', 'abc'), { param: { step: 0.02 } }, findAction);
  assert.equal(entry.settings.step, 0.02);
});

test('switching actions on one key discards the previous action settings', () => {
  // Channel Volume settings must not leak into Mix Volume: a leftover
  // `step: 0.3` would be a silent wrong value for a different action.
  const contexts = new Map();
  ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume`, param: { step: 0.3, min: 0, max: 1 } }, findAction);
  const { entry } = ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.mix-volume`, param: {} }, findAction);
  assert.equal(entry.action.uuid, `${UUID}.mix-volume`);
  assert.equal(entry.settings.step, 0.1, 'Mix Volume default, not the channel 0.3');
  assert.equal(entry.settings.bounds, undefined, 'no leftover bounds from the other action');
});

test('a repeated event for a known context does not recreate it', () => {
  const contexts = new Map();
  ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume` }, findAction);
  const first = contexts.get(ctx('3_3', 'abc'));
  const { created, entry } = ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume`, param: { step: 0.15 } }, findAction);
  assert.equal(created, false);
  assert.equal(contexts.get(ctx('3_3', 'abc')), first, 'same object, no duplicate');
  assert.equal(entry.settings.step, 0.15, 'but the new setting is applied');
});

test('forget removes the entry, then the whole slot when the context is partial', () => {
  const contexts = new Map();
  ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume` }, findAction);
  assert.equal(forget(contexts, ctx('3_3', 'abc')), 1);
  assert.equal(contexts.size, 0);

  // Two instances left on the same key, removed by a frame with no actionid.
  ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume` }, findAction);
  ensureEntry(contexts, ctx('3_3', 'def'), { uuid: `${UUID}.channel-volume` }, findAction);
  ensureEntry(contexts, ctx('4_3', 'ghi'), { uuid: `${UUID}.channel-volume` }, findAction);
  assert.equal(forget(contexts, `${UUID}.channel-volume___3_3___undefined`), 2, 'both instances of that key');
  assert.equal(contexts.size, 1, 'the other key is untouched');
});

test('moving an action to another key drops the key it left', () => {
  // Observed in the host log: channel volume bacfa1cb added on 1_0, then moved to
  // 1_2 with only a setactive. No clear for 1_0, no add for 1_2. Keeping both
  // contexts means every redraw also paints 1_0, which no longer holds the
  // action, and the new key depends on a later frame to appear at all.
  const contexts = new Map();
  const moved = ctx('1_0', 'bacfa1cb');
  const destination = ctx('1_2', 'bacfa1cb');
  ensureEntry(contexts, moved, { uuid: `${UUID}.channel-volume` }, findAction);

  const { entry, created } = ensureEntry(contexts, destination, { uuid: `${UUID}.channel-volume`, param: { step: 0.02 } }, findAction);
  const ghosts = forgetActionId(contexts, 'bacfa1cb', destination);

  assert.equal(created, true, 'the new key is a fresh context');
  assert.equal(entry.settings.step, 0.02);
  assert.equal(ghosts, 1, 'the context for the key it left is gone');
  assert.equal(contexts.has(moved), false, '1_0 is not redrawn any more');
  assert.equal(contexts.has(destination), true);
  assert.equal(contexts.size, 1);
});

test('a move keeps the settings, since the instance is the same', () => {
  const contexts = new Map();
  ensureEntry(contexts, ctx('1_0', 'bacfa1cb'), { uuid: `${UUID}.channel-volume`, param: { step: 0.3 } }, findAction);
  const { entry } = ensureEntry(contexts, ctx('1_2', 'bacfa1cb'), { uuid: `${UUID}.channel-volume` }, findAction);
  assert.equal(entry.settings.step, 0.3, 'the step the user chose follows the action');
});

test('forgetActionId never drops the context it is asked to keep', () => {
  const contexts = new Map();
  const keep = ctx('1_2', 'bacfa1cb');
  ensureEntry(contexts, ctx('1_0', 'bacfa1cb'), { uuid: `${UUID}.channel-volume` }, findAction);
  ensureEntry(contexts, keep, { uuid: `${UUID}.channel-volume` }, findAction);
  assert.equal(forgetActionId(contexts, 'bacfa1cb', keep), 1);
  assert.equal(contexts.size, 1);
  assert.equal(contexts.has(keep), true);
});

test('forgetActionId leaves other instances alone', () => {
  const contexts = new Map();
  ensureEntry(contexts, ctx('1_0', 'bacfa1cb'), { uuid: `${UUID}.channel-volume` }, findAction);
  ensureEntry(contexts, ctx('1_2', 'other-id'), { uuid: `${UUID}.channel-volume` }, findAction);
  ensureEntry(contexts, ctx('1_1', 'mix-volume-id'), { uuid: `${UUID}.mix-volume` }, findAction);
  forgetActionId(contexts, 'bacfa1cb', ctx('9_9', 'bacfa1cb'));
  assert.equal(contexts.size, 2, 'only the moved instance went away');
});

test('forgetActionId matches nothing without an actionid', () => {
  const contexts = new Map();
  ensureEntry(contexts, ctx('1_0', ''), { uuid: `${UUID}.channel-volume` }, findAction);
  assert.equal(forgetActionId(contexts, '', 'other'), 0, 'an empty id must not match every key');
  assert.equal(contexts.size, 1);
});

test('a stale entry does not survive a removal, so the next placement starts clean', () => {
  const contexts = new Map();
  ensureEntry(contexts, ctx('3_3', 'abc'), { uuid: `${UUID}.channel-volume`, param: { step: 0.3 } }, findAction);
  forget(contexts, ctx('3_3', 'abc'));
  // Whatever the host sends next, the previous action state is unreachable.
  assert.equal(contexts.has(ctx('3_3', 'abc')), false);
  assert.equal([...contexts.values()][0], undefined);
});

test('placing an action replaces whatever that key held', () => {
  // The host tells us about a new instance with a new id and never mentions the old
  // one again. Left in the map it kept repainting a key that no longer carried it,
  // while the dial events went to the new instance, which has no settings yet.
  const contexts = new Map();
  const find = (uuid) => actions[uuid];
  ensureEntry(contexts, ctx('2_3', 'old-instance'), { uuid: `${UUID}.channel-volume`, param: { channelId: 'ch1' } }, find);
  assert.equal(contexts.size, 1);

  forget(contexts, ctx('2_3', 'new-instance'));
  ensureEntry(contexts, ctx('2_3', 'new-instance'), { uuid: `${UUID}.channel-volume`, param: {} }, find);

  assert.equal(contexts.size, 1, 'the replaced instance is gone');
  assert.equal(contexts.has(ctx('2_3', 'old-instance')), false);
  const entry = contexts.get(ctx('2_3', 'new-instance'));
  assert.ok(!entry.settings.channelId, 'and the new one starts unbound, as placed');

});
