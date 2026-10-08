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
import { volumeBounds } from '../plugin/service/core/params.js';
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
    setMixVolume: (id, level) => calls.push(['setMix', id, { level }]),
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
  // A second state is only worth having when a press can change it. Every action whose
  // press toggles a mute therefore needs one, dial or button: Channel Mute and Mix
  // Mute, and the two volume dials, whose press mutes the bound scope.
  //
  // Mix Volume was left out of this list, and with a single state and an icon that
  // never changed, its press muted the mix in complete silence. The test encoded the
  // defect, so the rule is now stated by what a press does rather than by a list of
  // action names that has to be updated by hand.
  for (const mod of [...DIALS, ...MUTES]) {
    assert.equal(
      actionOf(mod.uuid).States.length,
      2,
      `${mod.uuid} can mute on a press, so it must declare a Muted and an Unmuted state`
    );
  }
  for (const mod of BUTTONS) {
    assert.equal(
      actionOf(mod.uuid).States.length,
      1,
      `${mod.uuid} only nudges or connects, so a second state would never be reached`
    );
  }
});

test('the mute states follow STATE.MUTED and look different from each other', () => {
  // STATE.MUTED is 0, so "Muted" has to be the first state for the shared index to
  // point at the right image in every action.
  for (const mod of [channelMute, mixMute, channelVolume, mixVolume]) {
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

test('every action that can mute shows it, and the others stay put', () => {
  // Mix Volume used to sit with the single-state actions despite toggling a mute,
  // which left its press silent on the deck. Note that DEFAULT and MUTED are both 0,
  // so a test that only ever checked "state 0" could not have told the two apart.
  //
  // Whatever the action is bound to, the mute it can toggle has to reach the key.
  for (const [mod, mutedCtx, unmutedCtx] of [
    [channelMute, { channel: channel({ isMuted: true }) }, { channel: channel() }],
    [mixMute, { mix: mix({ isMuted: true }) }, { mix: mix() }],
    [channelVolume, { channel: channel({ isMuted: true }) }, { channel: channel() }],
    [mixVolume, { mix: mix({ isMuted: true }) }, { mix: mix() }],
  ]) {
    const on = draw(mod, mutedCtx).find((c) => c[0] === 'state');
    assert.equal(on[1], STATE.MUTED, `${mod.uuid} shows the muted icon`);
    const off = draw(mod, unmutedCtx).find((c) => c[0] === 'state');
    assert.equal(off[1], STATE.UNMUTED, `${mod.uuid} and the unmuted one`);
  }

  for (const mod of [channelVolumeUp, channelVolumeDown, connect]) {
    const drawn = draw(mod, { channel: channel({ isMuted: true }), mix: mix({ isMuted: true }) })
      .find((c) => c[0] === 'state');
    assert.equal(drawn[1], STATE.DEFAULT, `${mod.uuid} declares one state and stays on it`);
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

test('the service carries none of the paths that were removed', () => {
  // Each of these was reachable, written, and did nothing. They are listed so that
  // nobody restores them: a reader who finds an unused handler assumes it is a feature
  // someone is relying on.
  const service = readFileSync(new URL('../plugin/service/app.js', import.meta.url), 'utf8');

  // A global-settings feature that read the host's own Config/global_settings.json --
  // another program's internal file -- and then used none of it. Nothing ever called the
  // save side, so nothing was ever written either.
  for (const gone of ['globalSettings', 'setGlobalSettings', 'getGlobalSettings', 'onDidReceiveGlobalSettings']) {
    assert.doesNotMatch(service, new RegExp(gone), `${gone} was a no-op feature`);
  }

  // Per-setting messages that no panel has ever sent. git confirms they never appeared
  // in a property inspector: set-settings has always been the only write path, and it
  // merges rather than replaces, which these two did not.
  assert.doesNotMatch(service, /set-channel/, 'no panel sends it');
  assert.doesNotMatch(service, /set-mix/, 'no panel sends it');

  // handlerContext().connect was a second way to reach the registry that no action used;
  // the Connect action calls registry.connect() itself.
  assert.doesNotMatch(service, /connect: async/, 'ctx.connect had no caller');

  // The transport handed out a defensive deep copy that nothing ever asked for, while
  // the copy that does matter -- the one app.js makes before attaching a registry -- is
  // asserted in the registry tests.
  const transport = readFileSync(new URL('../plugin/service/core/wavelink.js', import.meta.url), 'utf8');
  assert.doesNotMatch(transport, /getState\(\)/, 'getState had no caller');
});

test('the bound channel is copied before the registry is attached to it', () => {
  // app.js cannot be imported by a test -- it connects to the host on load -- so this is
  // asserted on the source. It matters because the copy is the only thing standing
  // between an action and the transport's own state: a registry on the cached object
  // would also make JSON.stringify throw, which is how the inspector payload is built,
  // and the panel would come up with a blank select and no error to trace it.
  const service = readFileSync(new URL('../plugin/service/app.js', import.meta.url), 'utf8');
  for (const fn of ['boundChannel', 'boundMix']) {
    const body = service.slice(service.indexOf(`function ${fn}(`));
    const block = body.slice(0, body.indexOf('\n}'));
    assert.match(
      block,
      /\.\.\.\w+, registry: waveLinkRegistry/,
      `${fn} must return a copy carrying the registry, not the cached object`
    );
  }
});

test('the service reports an unhandled rejection as such', () => {
  // Node raises an unhandled rejection as an uncaught exception, so without this
  // handler the two are the same line in the log. A stray promise then reads as a
  // crash of the plugin rather than as the stray promise it is, which sends the
  // reader hunting for a bug that does not exist.
  //
  // The service connects to the host the moment it is imported, so it cannot be
  // loaded here; its process-level wiring is asserted on the source, as elsewhere.
  const service = readFileSync(new URL('../plugin/service/app.js', import.meta.url), 'utf8');
  assert.match(service, /process\.on\('unhandledRejection'/, 'the service must handle rejections');
  assert.match(service, /process\.on\('uncaughtException'/, 'and keep handling exceptions');
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

test('every volume action refuses to leave the range it was given', async () => {
  // The range belongs to the action, not to the channel: settings are stored per key,
  // so the + and - buttons could never have read the min/max a dial was configured
  // with. They clamped to 0..1 instead, and a channel the user had capped at 0.8 on
  // one key could be walked straight past that cap from another.
  const levelOf = (call) => call[2].mixes ? call[2].mixes[0].level : call[2].level;

  const actions = [
    ['channel-volume', channelVolume, { channelId: 'ch1', mixId: '' }, { registry: null }],
    ['channel-volume-up', channelVolumeUp, { channelId: 'ch1', mixId: '' }, { registry: null }],
    ['channel-volume-down', channelVolumeDown, { channelId: 'ch1', mixId: '' }, { registry: null }],
  ];

  for (const [name, mod, base, extra] of actions) {
    for (const [from, dir] of [[0.79, 1], [0.21, -1]]) {
      const registry = recordingRegistry();
      const ctx = {
        settings: { step: '0.05', min: '0.2', max: '0.8', ...base },
        channel: { ...channel({ level: from }), registry },
        mix: mix(),
        report: (e) => assert.fail(`${name} reported ${e.message}`),
        ...extra,
      };
      if (mod.onRun) await mod.onRun(ctx);
      else await mod.onDialRotate(ctx, { rotateEvent: dir > 0 ? 'right' : 'left' });

      const [call] = registry.calls;
      const level = levelOf(call);
      assert.ok(
        level >= 0.2 && level <= 0.8,
        `${name} left its 0.2-0.8 range, asking for ${level}`
      );
    }
  }

  // And the mix dial, which carries the same controls.
  const registry = recordingRegistry();
  await mixVolume.onDialRotate(
    {
      settings: { step: '0.05', min: '0.3', max: '0.6', mixId: 'mix1' },
      mix: { ...mix({ level: 0.59 }), registry },
      report: (e) => assert.fail(`mix-volume reported ${e.message}`),
    },
    { rotateEvent: 'right' }
  );
  assert.ok(levelOf(registry.calls[0]) <= 0.6, 'the mix dial left its own range');
});

test('a range that no step can satisfy still leaves one usable level', () => {
  // An inverted pair, which a number field allows: Min 0.9, Max 0.1. Clamped to a
  // single level rather than to a range no step could fit into.
  const bounds = volumeBounds({ min: '0.9', max: '0.1' });
  assert.equal(bounds.min, 0.9);
  assert.equal(bounds.max, 0.9);
});

test('a volume action defaults to the full range when it has none', () => {
  assert.deepEqual(volumeBounds({}), { min: 0, max: 1 });
  assert.deepEqual(volumeBounds({ min: '', max: '' }), { min: 0, max: 1 }, 'a cleared field is not zero');
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

test('each dial follows the mute with its own icon', () => {
  // Both volume dials toggle a mute when pressed, so both have to show it. The Mix
  // Volume dial declared a single state and always drew the same icon, so its press
  // muted the mix with nothing at all on the deck to say that it had.
  const cases = [
    [channelVolume, (isMuted) => ({ settings: { mixId: '' }, channel: channel({ isMuted }) })],
    [mixVolume, (isMuted) => ({ settings: { mixId: '' }, mix: mix({ isMuted }) })],
  ];

  for (const [mod, contextFor] of cases) {
    // A context of its own, because the encoder cache is keyed by context and is
    // shared between the two dials.
    const context = `ctx-dial-icon-${mod.uuid.split('.').pop()}`;
    const paint = (isMuted) => {
      const $UD = fakeUD();
      mod.render({ $UD, context, snap: {}, isEncoder: true, ...contextFor(isMuted) });
      return $UD.sent.filter((c) => c[0] === 'feedback').length;
    };

    assert.equal(paint(false), 1, `${mod.uuid} draws the dial with the unmuted icon`);
    assert.equal(paint(false), 0, `${mod.uuid} does not redraw it for nothing`);
    assert.equal(paint(true), 1, `${mod.uuid} redraws it when the mute changes`);
    assert.equal(paint(true), 0, `${mod.uuid} and settles again`);
  }
});

test('every action uuid is the manifest uuid plus its short name', () => {
  const prefix = ACTION.CHANNEL_MUTE.slice(0, ACTION.CHANNEL_MUTE.lastIndexOf('.') + 1);
  for (const mod of ALL) {
    assert.equal(mod.uuid, `${prefix}${mod.uuid.split('.').pop()}`, `${mod.uuid} does not follow the plugin prefix convention`);
    assert.ok(actionOf(mod.uuid), `${mod.uuid} is declared`);
  }
});
