/**
 * Rendering contract for the keys, and the controller routing that decides whether
 * an encoder readout is sent at all.
 *
 * Two regressions behind this file each produced a blank key:
 *
 *  - `DisableAutomaticStates: true` makes the host draw nothing, and state 0 of
 *    every action is the action's own icon, so a dropped key showed the wrong
 *    thing rather than the action.
 *  - the encoder readout was decided from the manifest, where a stale entry listed
 *    both Keypad and Encoder. Every instance was then treated as a dial, and
 *    setFeedbackLayout/setFeedback were fired on plain buttons, where the host
 *    accepts them (code 0) and leaves the key blank.
 *
 * Keys must also carry no "waiting for connection" state. The host mounts a key
 * after announcing it, so the frame that corrected the icon arrived too early and
 * was dropped: every key stayed on the waiting icon while Wave Link was in fact
 * being driven normally. Only the two mute actions keep a second state, because
 * muted/unmuted is what the action does rather than link status.
 *
 * The manifest is asserted here because it is data, not code, and nothing else in
 * the suite would notice one of these flags coming back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as channelMute from '../plugin/service/actions/channel-mute.js';
import * as channelVolume from '../plugin/service/actions/channel-volume.js';
import * as channelVolumeUp from '../plugin/service/actions/channel-volume-up.js';
import * as channelVolumeDown from '../plugin/service/actions/channel-volume-down.js';
import * as mixVolume from '../plugin/service/actions/mix-volume.js';
import * as mixMute from '../plugin/service/actions/mix-mute.js';
import * as connect from '../plugin/service/actions/connect.js';
import { ACTION, ENCODER_ICON, STATE, VOLUME_STEPS } from '../plugin/service/core/constants.js';
import { forgetHostDisplay, pruneHostDisplay } from '../plugin/service/core/ui.js';

const manifest = JSON.parse(readFileSync(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
const actionOf = (uuid) => manifest.Actions.find((a) => a.UUID === uuid);

const DIALS = [channelVolume, mixVolume];
const MUTES = [channelMute, mixMute];
const BUTTONS = [channelVolumeUp, channelVolumeDown, connect];
const ALL = [...DIALS, ...MUTES, ...BUTTONS];


/** Records the calls an action makes, so a test can assert the exact payload. */
function recordingRegistry() {
  const calls = [];
  return {
    calls,
    setChannelMute: (id, muted) => calls.push(['setChannelMute', id, muted]),
    setChannelMuteInMix: (id, mixId, muted) => calls.push(['setChannelMuteInMix', id, mixId, muted]),
    setChannelVolume: (id, level, mixId) =>
      calls.push(['setChannel', id, mixId ? { mixes: [{ id: mixId, level }] } : { level }]),
    toggleChannelMute: (id, mixId) => calls.push(['toggleChannelMute', id, mixId]),
    setMixMute: (id, muted) => calls.push(['setMix', id, { isMuted: muted }]),
    toggleMixMute: (id) => calls.push(['toggleMixMute', id]),
  };
}
/** Records only what the render path asks the host to draw. */
function fakeUD() {
  const sent = [];
  return {
    sent,
    setStateIcon(context, state, text) { sent.push(['state', state, text]); },
    setTitle(context, text) { sent.push(['title', text]); },
    setFeedbackLayout(context, layout) { sent.push(['layout', layout]); },
    setFeedback(context, layout) { sent.push(['feedback', layout]); },
  };
}

const channel = (over = {}) => ({ id: 'ch1', name: 'Mic 1', level: 0.5, isMuted: false, mixes: [], ...over });
const mix = (over = {}) => ({ id: 'mix1', name: 'Stream Mix', level: 1, isMuted: false, ...over });

/**
 * Calls an action's render with whatever it needs, defaulting the rest away.
 *
 * Each call gets a fresh context, because one is per physical key on the deck and
 * the encoder label is remembered per context to avoid re-sending an unchanged
 * label. Sharing one context across tests would let that cache swallow renders.
 */
let drawCount = 0;
function draw(mod, { isEncoder = false, channel: ch, mix: mx, settings = {}, context } = {}) {
  const $UD = fakeUD();
  mod.render({
    $UD,
    context: context || `ctx-${++drawCount}`,
    snap: { connected: true, channels: [], mixes: [] },
    isEncoder,
    settings,
    channel: ch,
    mix: mx,
  });
  return $UD.sent;
}

test('the manifest must not disable automatic states', () => {
  // Every shipped Ulanzi plugin omits the flag, and with it set the host draws
  // nothing until the plugin answers. A key dropped while the service starts stays
  // blank, which is exactly the reported symptom.
  for (const action of manifest.Actions) {
    assert.equal(
      action.DisableAutomaticStates,
      undefined,
      `${action.Name} sets DisableAutomaticStates; the host would draw nothing`
    );
  }
});

test('every action draws a real icon as its first state', () => {
  for (const action of manifest.Actions) {
    const [first] = action.States;
    assert.equal(
      first.Image,
      action.Icon,
      `${action.Name} state 0 must be its own icon, otherwise a dropped key shows the wrong thing`
    );
  }
});

test('only the actions that can mute declare a second state', () => {
  // A second state is only worth having when the action can change it: the two mute
  // buttons, and the Channel Volume dial, whose press now mutes the bound scope.
  for (const action of manifest.Actions) {
    const expected = action.UUID.startsWith('com.ulanzi.ulanzistudio.wavelink.mix-mute')
      || action.UUID === 'com.ulanzi.ulanzistudio.wavelink.channel-mute'
      || action.UUID === 'com.ulanzi.ulanzistudio.wavelink.channel-volume'
      ? 2
      : 1;
    assert.equal(
      action.States.length,
      expected,
      `${action.Name} declares ${expected} state(s)`
    );
  }
});

test('the mute states follow STATE.MUTED and look different from each other', () => {
  // STATE.MUTED is 0, so "Muted" has to be the first state for the shared index to
  // point at the right image in every action.
  for (const mod of [channelMute, mixMute, channelVolume]) {
    const [muted, unmuted] = actionOf(mod.uuid).States;
    assert.equal(muted.Name, 'Muted', `${mod.uuid} state ${STATE.MUTED} is Muted`);
    assert.equal(unmuted.Name, 'Unmuted', `${mod.uuid} state ${STATE.UNMUTED} is Unmuted`);
    assert.equal(muted.Image, actionOf(mod.uuid).Icon, `${mod.uuid} state 0 is its own icon`);
    assert.notEqual(unmuted.Image, muted.Image, `${mod.uuid} must look different when muted`);
  }
});

test('no action paints a waiting-for-connection icon on the deck', () => {
  // Regression: a "disconnected" state made every key look broken while Wave Link
  // was in fact being driven, and the corrective repaint raced the key mounting.
  for (const action of manifest.Actions) {
    for (const state of action.States) {
      assert.doesNotMatch(
        state.Image,
        /disconnected/i,
        `${action.Name} must not reference the waiting-for-connection icon`
      );
    }
  }
});

test('state indices agree with the manifest', () => {
  for (const mod of MUTES) {
    const declared = actionOf(mod.uuid).States;
    assert.equal(declared[STATE.MUTED].Name, 'Muted');
    assert.equal(declared[STATE.UNMUTED].Name, 'Unmuted');
  }
});

test('every action module is declared in the manifest', () => {
  for (const mod of ALL) {
    assert.ok(actionOf(mod.uuid), `${mod.uuid} is not declared in the manifest`);
  }
  assert.equal(
    manifest.Actions.length,
    ALL.length,
    `the manifest declares ${manifest.Actions.length} actions for ${ALL.length} modules`
  );
});

test('only the two volume actions declare the Encoder controller', () => {
  const encoders = manifest.Actions
    .filter((a) => (a.Controllers || []).includes('Encoder'))
    .map((a) => a.UUID);
  assert.deepEqual(
    encoders.sort(),
    DIALS.map((m) => m.uuid).sort(),
    'the mutes and Connect are button-only: a dial has nothing else to sweep'
  );
});

test('a volume dial sweeps and does not answer a key press', () => {
  for (const dial of DIALS) {
    const declared = actionOf(dial.uuid);
    assert.deepEqual(declared.Controllers, ['Encoder'], `${dial.uuid} is a dial`);
    assert.equal(typeof dial.onDialRotate, 'function', `${dial.uuid} sweeps`);
    assert.equal(typeof dial.onDialPress, 'function', `${dial.uuid} mutes on a press`);
    assert.equal(dial.onRun, undefined, `${dial.uuid} does not answer a keypad run`);
  }
});

test('the remaining actions are buttons only', () => {
  for (const button of BUTTONS) {
    const declared = actionOf(button.uuid);
    assert.deepEqual(declared.Controllers, ['Keypad'], `${button.uuid} is a button`);
    assert.equal(declared.Encoder, undefined, `${button.uuid} declares no dial layout`);
    assert.equal(typeof button.onRun, 'function', `${button.uuid} answers a press`);
    assert.equal(button.onDialRotate, undefined, `${button.uuid} has no sweep`);
  }
});

test('the one-step buttons declare a step the dial accepts', () => {
  for (const button of [channelVolumeUp, channelVolumeDown]) {
    assert.ok(
      VOLUME_STEPS.includes(button.defaults.step),
      `${button.uuid} default step ${button.defaults.step} is not one the dial would honour`
    );
  }
  assert.notEqual(channelVolumeUp.uuid, channelVolumeDown.uuid, 'up and down are distinct actions');
});

test('an encoder sends its icon and nothing else', () => {
  // The dial's text belongs to Ulanzi Studio. Filling the layout's title with the
  // name of the bound channel or mix fought it: two sources for one word, and the
  // user had to retype theirs. Only the icon is ours, because the host does not
  // derive it from anything we set.
  for (const mod of DIALS) {
    const feedback = draw(mod, { isEncoder: true, channel: channel(), mix: mix() })
      .find((c) => c[0] === 'feedback');
    assert.deepEqual(
      Object.keys(feedback[1]),
      ['icon'],
      `${mod.uuid} must send an icon and nothing else`
    );
  }
});

test('no action writes a channel or mix name onto the deck', () => {
  // The names survive only in the property inspector payload, which needs them to
  // fill its pickers. Nothing may reach the key or the dial.
  for (const mod of ALL) {
    const $UD = fakeUD();
    mod.render({
      $UD,
      context: `ctx-noname-${mod.uuid}`,
      snap: { connected: true },
      isEncoder: true,
      settings: {},
      channel: channel({ name: 'Firefox' }),
      mix: mix({ name: 'Personal Mix' }),
    });
    const serialised = JSON.stringify($UD.sent);
    assert.doesNotMatch(
      serialised,
      /Firefox|Personal Mix/,
      `${mod.uuid} must not put a channel or mix name on the deck`
    );
  }
});

test('no render throws, whatever the context holds', () => {
  // A missing destructure in render is invisible to `node --check` and to every
  // other assertion here: it only shows up as a blank key at runtime. So give each
  // action a fully populated context and a half-empty one, and require a paint.
  const full = {
    channel: channel({ name: 'HyperX Mic' }),
    mix: mix({ name: 'Stream Mix' }),
    settings: { channelId: 'ch1', mixId: 'mix1', step: 0.05, label: 'X', behaviour: 'toggle' },
  };
  for (const mod of ALL) {
    for (const [label, subject] of [['full', full], ['empty', {}]]) {
      const sent = draw(mod, { ...subject, isEncoder: true });
      assert.ok(sent.some((c) => c[0] === 'state'), `${mod.uuid} paints a key with a ${label} context`);
    }
  }
});


test('a keypad instance gets no encoder command at all', () => {
  // This is the regression: setFeedbackLayout/setFeedback on a button is accepted
  // by the host (code 0) and leaves the key blank instead of drawing it.
  for (const [mod, subject] of [
    [channelMute, channel()],
    [mixMute, mix()],
    [channelVolumeUp, channel()],
    [channelVolumeDown, channel()],
    [connect, null],
  ]) {
    const sent = draw(mod, { isEncoder: false, channel: subject, mix: subject === channel() ? mix() : subject });
    assert.ok(
      !sent.some((c) => c[0] === 'layout' || c[0] === 'feedback'),
      `${mod.uuid} must not send encoder commands from a button`
    );
    assert.ok(sent.some((c) => c[0] === 'state'), `${mod.uuid} still draws its icon`);
  }
});

test('a mute action switches icon with the mute state', () => {
  const on = draw(channelMute, { channel: channel({ isMuted: true }) });
  const off = draw(channelMute, { channel: channel({ isMuted: false }) });
  assert.equal(on.find((c) => c[0] === 'state')[1], STATE.MUTED, 'muted draws the Muted state');
  assert.equal(off.find((c) => c[0] === 'state')[1], STATE.UNMUTED, 'unmuted draws the Unmuted state');
  assert.notEqual(off.find((c) => c[0] === 'state')[1], on.find((c) => c[0] === 'state')[1]);
});

test('a mute action tracks mute, and nothing else moves a single-state icon', () => {
  // Link status used to flip the icon, which is what produced the mismatch: the
  // payload said connected while the key kept the waiting icon. A mute icon may
  // follow the mute state; a single-state icon may never move.
  for (const [mod, subject, other] of [[channelMute, channel(), mix()], [mixMute, mix(), channel()]]) {
    const muted = draw(mod, { channel: { ...subject, isMuted: true }, mix: { ...other, isMuted: true } });
    const unmuted = draw(mod, { channel: { ...subject, isMuted: false }, mix: { ...other, isMuted: false } });
    assert.equal(muted.find((c) => c[0] === 'state')[1], STATE.MUTED, `${mod.uuid} follows the mute state`);
    assert.equal(unmuted.find((c) => c[0] === 'state')[1], STATE.UNMUTED, `${mod.uuid} and comes back`);
  }
  for (const mod of [channelVolumeUp, channelVolumeDown, connect]) {
    const muted = draw(mod, { channel: channel({ isMuted: true }), mix: mix({ isMuted: true }) });
    const unmuted = draw(mod, { channel: channel({ isMuted: false }), mix: mix({ isMuted: false }) });
    assert.equal(muted.find((c) => c[0] === 'state')[1], STATE.DEFAULT, `${mod.uuid} has a single state`);
    assert.equal(unmuted.find((c) => c[0] === 'state')[1], STATE.DEFAULT, `${mod.uuid} never moves it`);
  }
});

test('no icon carries a live level', () => {
  // The level is on the fader, and a text that changed on every notification meant
  // redrawing the key several times a second during a turn.
  for (const [mod, subject, other] of [
    [channelVolume, channel({ level: 0.5 }), mix({ level: 0.9 })],
    [mixVolume, channel(), mix({ level: 0.37 })],
    [channelVolumeUp, channel({ level: 0.5 }), mix()],
    [channelVolumeDown, channel({ level: 0.5 }), mix()],
    [channelMute, channel({ level: 0.5 }), mix()],
    [mixMute, channel(), mix({ level: 0.5 })],
  ]) {
    const drawn = draw(mod, { channel: subject, mix: other }).filter((c) => c[0] === 'state');
    assert.ok(drawn.length > 0, `${mod.uuid} paints its key`);
    assert.ok(
      drawn.every((c) => !String(c[2]).includes('%')),
      `${mod.uuid} must not put a level on its icon`
    );
  }
});

test('only the mute actions change icon, and only with the mute state', () => {
  // They are the only ones with a second state declared in the manifest, so they are
  // the only ones that can report a mute change visually.
  for (const [mod, subject, other, muted] of [
    [channelMute, channel({ isMuted: true }), mix(), STATE.MUTED],
    [mixMute, channel(), mix({ isMuted: true }), STATE.MUTED],
  ]) {
    const on = draw(mod, { channel: subject, mix: other }).find((c) => c[0] === 'state');
    assert.equal(on[1], muted, `${mod.uuid} shows the muted icon`);
    const off = draw(mod, {
      channel: { ...subject, isMuted: false },
      mix: { ...other, isMuted: false },
    }).find((c) => c[0] === 'state');
    assert.equal(off[1], STATE.UNMUTED, `${mod.uuid} and the unmuted one`);
  }

  for (const [mod, subject, other] of [
    [channelVolume, channel({ isMuted: true }), mix()],
    [mixVolume, channel(), mix({ isMuted: true })],
    [channelVolumeUp, channel({ isMuted: true }), mix()],
    [channelVolumeDown, channel({ isMuted: true }), mix()],
  ]) {
    const on = draw(mod, { channel: subject, mix: other }).find((c) => c[0] === 'state');
    assert.equal(on[1], STATE.DEFAULT, `${mod.uuid} declares one state and stays on it`);
  }
});

test('no action publishes a title of its own', () => {
  // Ulanzi Studio owns the Title field. Ours overwrote what the user typed there,
  // and what it sent was rebuilt from the live level, so it changed on every
  // notification. The key belongs to the host, entirely.
  for (const mod of ALL) {
    const $UD = fakeUD();
    mod.render({
      $UD,
      context: `ctx-title-${mod.uuid}`,
      snap: { connected: true },
      isEncoder: true,
      settings: { title: 'System' },
      channel: channel({ name: 'Firefox', level: 0.5 }),
      mix: mix({ name: 'Personal Mix', level: 0.5 }),
    });
    assert.ok(
      !$UD.sent.some((c) => c[0] === 'title'),
      `${mod.uuid} must leave the title to the host`
    );
    assert.ok($UD.sent.some((c) => c[0] === 'state'), `${mod.uuid} still draws its icon`);
  }
});

test('an unchanged icon is not redrawn, and a mute change still is', () => {
  // Wave Link notifies on every level change, so without this the plugin asks the
  // host to redraw every key several times a second while the user turns a knob.
  const context = 'ctx-icon-dedupe';
  const paint = (isMuted) => {
    const $UD = fakeUD();
    channelMute.render({ $UD, context, snap: {}, settings: {}, channel: channel({ isMuted }), mix: mix() });
    return $UD.sent.filter((c) => c[0] === 'state').length;
  };

  assert.equal(paint(false), 1, 'the first paint draws the key');
  assert.equal(paint(false), 0, 'and the same icon is not sent again');
  assert.equal(paint(true), 1, 'a mute change is still reported');
  assert.equal(paint(true), 0, 'and not repeated');
  assert.equal(paint(false), 1, 'unmuting comes back');
});

test('a volume key is drawn once and then never touched again', () => {
  // Its icon carries only the mute of its scope: no level, and nothing else that a
  // notification could change.
  const context = 'ctx-volume-stable';
  let sends = 0;
  for (let i = 0; i < 20; i++) {
    const $UD = fakeUD();
    channelVolume.render({
      $UD,
      context,
      snap: {},
      isEncoder: true,
      settings: {},
      channel: channel({ level: i / 20, isMuted: false }),
      mix: mix({ level: i / 10 }),
    });
    sends += $UD.sent.filter((c) => c[0] === 'state').length;
  }
  assert.equal(sends, 1, 'twenty notifications, one redraw');
});

test('the volume dial still reports a mute change', () => {
  // The same twenty notifications, with the mute moving: the icon must follow,
  // otherwise the press would be silent on the key.
  const context = 'ctx-volume-mute';
  const paint = (isMuted) => {
    const $UD = fakeUD();
    channelVolume.render({ $UD, context, snap: {}, isEncoder: true, settings: {}, channel: channel({ isMuted }), mix: mix() });
    return $UD.sent.filter((c) => c[0] === 'state').length;
  };
  assert.equal(paint(false), 1);
  assert.equal(paint(false), 0);
  assert.equal(paint(true), 1, 'muting is visible');
  assert.equal(paint(true), 0);
  assert.equal(paint(false), 1, 'and unmuting too');
});
test('an action with nothing selected still paints its key', () => {
  for (const mod of ALL) {
    const sent = draw(mod, {});
    assert.ok(sent.some((c) => c[0] === 'state'), `${mod.uuid} paints its key with no selection`);
  }
});

test('the dial cache never outlives the contexts it describes', () => {
  // Contexts vanish in bulk: forgetting a key drops the whole slot, and moving an
  // action drops its previous context. Pruning one named context at a time left the
  // siblings behind, so the map grew all session and a returning key could be
  // wrongly believed to already carry its label.
  const paint = (context) => {
    const $UD = fakeUD();
    channelVolume.render({ $UD, context, snap: {}, isEncoder: true, settings: {}, channel: channel(), mix: mix() });
    return $UD.sent.filter((c) => c[0] === 'feedback').length;
  };

  const a = 'ctx-a';
  const b = 'ctx-b';
  const live = new Set([a, b]);
  assert.equal(paint(a), 1);
  assert.equal(paint(b), 1);

  live.delete(b);
  pruneHostDisplay(live);
  assert.equal(paint(a), 0, 'a live key stays deduplicated');
  assert.equal(paint(b), 1, 'a forgotten key is repainted from scratch');
});

test('pruning never forgets a context that is still live', () => {
  const context = 'ctx-live';
  const paint = () => {
    const $UD = fakeUD();
    channelVolume.render({ $UD, context, snap: {}, isEncoder: true, settings: {}, channel: channel(), mix: mix() });
    return $UD.sent.filter((c) => c[0] === 'feedback').length;
  };
  assert.equal(paint(), 1);
  pruneHostDisplay(new Set([context, 'ctx-other']));
  assert.equal(paint(), 0, 'the live key keeps its remembered label');
});

test('selecting a key must not rewrite the encoder layout', () => {
  // Selecting a key in Ulanzi Studio fires setActive and then paramfromapp, and the
  // host replays the stored settings with it. Clearing the icon cache on either one
  // made every selection rewrite the whole dial layout, and rewriting the layout is
  // what the user sees: the host repaints the dial and restores its own title, so the
  // text flickered on each click. setStateIcon on a button touches a single element
  // and shows none of this, which is why only the dials were affected.
  //
  // None of those three events is a mount. onAdd covers the genuine mount, and an
  // action moved to another key lands on a context with no cached icon anyway.
  const service = readFileSync(new URL('../plugin/service/app.js', import.meta.url), 'utf8');

  const body = (event) => {
    const block = service.slice(service.indexOf(event));
    const end = block.indexOf('\n$UD.');
    return end > 0 ? block.slice(0, end) : block;
  };

  for (const event of ['$UD.onSetActive(', '$UD.onParamFromApp(', '$UD.onDidReceiveSettings(']) {
    assert.doesNotMatch(
      body(event),
      /forgetHostDisplay\(/,
      `${event} must not clear the encoder icon cache`
    );
  }

  // The genuine mount still repaints, or a key added to the deck would come up blank.
  assert.match(body('$UD.onAdd('), /forgetHostDisplay\(/, 'a real mount must still repaint');
});

test('pressing a channel dial toggles the scope it is bound to', async () => {
  // The rule, as specified:
  //   channel with no mix  ->  the whole channel
  //   channel with a mix  ->  only that junction
  // The payload each scope turns into is the registry's business, tested there.
  const press = async (mod, mixId) => {
    const registry = recordingRegistry();
    await mod.onDialPress({
      settings: { mixId },
      channel: { ...channel(), registry, mixes: [{ id: 'mix1', level: 1, isMuted: false }] },
      report: (e) => assert.fail(`unexpected report: ${e.message}`),
    });
    return registry.calls;
  };

  assert.deepEqual(await press(channelVolume, ''), [['toggleChannelMute', 'ch1', null]]);
  assert.deepEqual(await press(channelVolume, 'mix1'), [['toggleChannelMute', 'ch1', 'mix1']]);
});

test('the Channel Mute button targets the same scope as the dial', async () => {
  const press = async (settings) => {
    const registry = recordingRegistry();
    await channelMute.onRun({
      settings: { behaviour: 'toggle', ...settings },
      channel: { ...channel(), registry, mixes: [{ id: 'mix1', level: 1, isMuted: false }] },
      report: (e) => assert.fail(`unexpected report: ${e.message}`),
    });
    return registry.calls;
  };

  assert.deepEqual(await press({ mixId: '' }), [['toggleChannelMute', 'ch1', null]], 'no mix means the whole channel');
  assert.deepEqual(await press({ mixId: 'mix1' }), [['toggleChannelMute', 'ch1', 'mix1']]);
  assert.deepEqual(
    await press({ mixId: '', behaviour: 'mute' }),
    [['setChannelMute', 'ch1', true]],
    'a forced mute with no mix applies to the whole channel'
  );
  assert.deepEqual(
    await press({ mixId: 'mix1', behaviour: 'mute' }),
    [['setChannelMuteInMix', 'ch1', 'mix1', true]],
    'and with a mix, only to the junction'
  );
  assert.deepEqual(await press({ mixId: 'mix1', behaviour: 'unmute' }), [
    ['setChannelMuteInMix', 'ch1', 'mix1', false],
  ]);
});

test('the dial icon shows the mute of the bound scope', () => {
  // Showing the channel's own mute while the press would only touch a junction would
  // be a lie: the key would read unmuted while the audio was silent.
  const withJunction = (over = {}, junctionMuted = false) => ({
    ...channel(over),
    mixes: [{ id: 'mix1', level: 1, isMuted: junctionMuted }],
  });

  const junctionBound = draw(channelVolume, {
    channel: withJunction({ isMuted: true }),
    mix: mix(),
    settings: { mixId: 'mix1' },
  }).find((c) => c[0] === 'state');
  assert.equal(junctionBound[1], STATE.UNMUTED, 'the channel is muted but the junction is not');

  const junctionNowMuted = draw(channelVolume, {
    channel: withJunction({ isMuted: false }, true),
    mix: mix(),
    settings: { mixId: 'mix1' },
  }).find((c) => c[0] === 'state');
  assert.equal(junctionNowMuted[1], STATE.MUTED, 'the junction mute is what the key shows');

  const wholeChannel = draw(channelVolume, {
    channel: withJunction({ isMuted: true }),
    mix: mix(),
    settings: { mixId: '' },
  }).find((c) => c[0] === 'state');
  assert.equal(wholeChannel[1], STATE.MUTED, 'with no mix the scope is the whole channel');
});

test('an encoder draws its icon from the feedback layout, and the paths exist', () => {
  // The dial's visible icon is the layout's, not the state icon's: setStateIcon alone
  // left the dial untouched on a mute change. The paths are also declared in
  // constants.js, so they have to agree with the manifest or the dial and the key
  // would show two different pictures of the same action.
  for (const mod of DIALS) {
    const sent = draw(mod, { isEncoder: true, channel: channel(), mix: mix() });
    const feedback = sent.find((c) => c[0] === 'feedback');
    assert.ok(feedback, `${mod.uuid} sends a layout`);
    const image = feedback[1].icon?.value;
    assert.ok(image, `${mod.uuid} must put an icon in its layout`);
    const declared = actionOf(mod.uuid).States.map((s) => s.Image);
    assert.ok(declared.includes(image), `${mod.uuid} layout icon "${image}" is not one of its states`);
    assert.ok(existsSync(new URL(`../plugin/${image}`, import.meta.url)), `${image} does not exist`);
  }

  for (const [mod, image] of [
    [channelVolume, ENCODER_ICON.CHANNEL_VOLUME],
    [mixVolume, ENCODER_ICON.MIX_VOLUME],
  ]) {
    assert.ok(
      actionOf(mod.uuid).States.some((s) => s.Image === image),
      `${image} is not declared by ${mod.uuid}`
    );
  }
});

test('the dial follows the mute with its own icon', () => {
  const context = 'ctx-dial-icon';
  const paint = (isMuted) => {
    const $UD = fakeUD();
    channelVolume.render({
      $UD,
      context,
      snap: {},
      isEncoder: true,
      settings: { mixId: '' },
      channel: channel({ isMuted }),
      mix: mix(),
    });
    return $UD.sent.filter((c) => c[0] === 'feedback').length;
  };
  assert.equal(paint(false), 1, 'the dial is drawn with the unmuted icon');
  assert.equal(paint(false), 0, 'and not redrawn for nothing');
  assert.equal(paint(true), 1, 'muting redraws it, icon included');
  assert.equal(paint(true), 0);
});

test('every action uuid is the manifest uuid plus its short name', () => {
  const prefix = ACTION.CHANNEL_MUTE.slice(0, ACTION.CHANNEL_MUTE.lastIndexOf('.') + 1);
  for (const mod of ALL) {
    assert.equal(mod.uuid, `${prefix}${mod.uuid.split('.').pop()}`, `${mod.uuid} does not follow the plugin prefix convention`);
    assert.ok(actionOf(mod.uuid), `${mod.uuid} is declared`);
  }
});
