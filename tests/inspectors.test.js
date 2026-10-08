/**
 * Property inspector contract.
 *
 * These are static properties of the inspector pages, and nothing else in the
 * suite would notice them breaking: the panel still opens, the selects still
 * fill, and the only symptom is that a setting the user typed never reaches the
 * service. The dial label was exactly that -- captured on `change` only, so it
 * was lost whenever the user typed and reached for the physical dial.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PLUGIN_ROOT, PI_ROOT, jsCode, stripComments } from './helpers.js';

const read = (relative) => readFileSync(`${PLUGIN_ROOT}/${relative}`, 'utf8');
const readInspector = (name) => readFileSync(`${PI_ROOT}/${name}`, 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));

/**
 * The settings each action is expected to persist, keyed by action name.
 *
 * No Title anywhere, on purpose: Ulanzi Studio already provides that field, so a
 * second one created two sources for the same text and the plugin's copy was the one
 * that had to be retyped. Connect declares no setting at all -- buttons only.
 */
const EXPECTED = {
  'Channel Mute': ['channelId', 'mixId', 'behaviour'],
  'Channel Volume': ['channelId', 'mixId', 'step', 'min', 'max'],
  // The range travels with the action, not with the channel: settings are stored per
  // key, so a button could never have read the dial's min/max. Every action that moves
  // a level therefore offers the same three controls and reads the same three.
  'Channel Volume Up': ['channelId', 'mixId', 'step', 'min', 'max'],
  'Channel Volume Down': ['channelId', 'mixId', 'step', 'min', 'max'],
  'Mix Volume': ['mixId', 'step', 'min', 'max'],
  'Mix Mute': ['mixId', 'behaviour'],
  Connect: [],
};

test('every action has an inspector page', () => {
  for (const action of manifest.Actions) {
    assert.ok(action.PropertyInspectorPath, `${action.Name} declares no inspector`);
    assert.ok(read(action.PropertyInspectorPath), `${action.Name} inspector is missing`);
  }
});

test('an inspector targets its own action id', () => {
  for (const action of manifest.Actions) {
    const html = read(action.PropertyInspectorPath);
    const id = html.match(/data-actionid="([^"]+)"/)?.[1];
    assert.equal(id, action.UUID, `${action.Name} panel is wired to ${id}`);
  }
});

test('every setting an action declares is a named control inside the form', () => {
  for (const action of manifest.Actions) {
    const html = read(action.PropertyInspectorPath);
    // Everything the panel can persist must sit between <form> and </form>, or
    // getFormValue() never sees it and the setting is silently dropped.
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    assert.ok(form.length > 0, `${action.Name} has no <form>`);
    for (const field of EXPECTED[action.Name] || []) {
      assert.match(form, new RegExp(`name="${field}"`), `${action.Name} is missing a control named "${field}"`);
    }
  }
});

test('a text setting is captured while typing, not only on blur', () => {
  // `change` on a text field fires on blur. A label typed and then abandoned -- the
  // user reaching for the dial -- never reached the service, so the dial reverted to
  // the bound name on the next repaint.
  const shared = code('property-inspector/shared.js');
  assert.match(shared, /addEventListener\('input'/, 'shared.js must listen to input events');
  assert.match(shared, /addEventListener\('change'/, 'and still to change events');
});

test('settings arriving from the host do not overwrite the field being typed in', () => {
  const shared = code('property-inspector/shared.js');
  assert.match(shared, /document\.activeElement/, 'hydration must skip the focused control');
});

test('a number field cannot offer a step the dial would reject', () => {
  // dialStep only accepts VOLUME_STEPS, so a free number input would let the user
  // pick 0.03 and get 5% instead, with nothing to explain it.
  for (const name of ['channel-volume', 'mix-volume', 'channel-volume-up', 'channel-volume-down']) {
    const html = readInspector(`${name}/inspector.html`);
    assert.doesNotMatch(html, /<input[^>]*name="step"/, `${name} must offer step as a <select>`);
    assert.match(html, /<select name="step">/, `${name} must offer step as a <select>`);
  }
});

test('no inspector offers a setting the service ignores', () => {
  // A control the action never reads is worse than none: it looks like it does
  // something and silently does not. Only real form controls count -- the page
  // also carries <meta name="viewport">, which is not a setting. Connect declares
  // no setting on purpose: its panel is buttons only.
  for (const action of manifest.Actions) {
    const html = read(action.PropertyInspectorPath);
    const expected = EXPECTED[action.Name] || [];
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    const fields = [...form.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([\w]+)"/g)].map((m) => m[1]);
    if (expected.length === 0) {
      assert.deepEqual(fields, [], `${action.Name} should declare no setting`);
      continue;
    }
    assert.ok(fields.length > 0, `${action.Name} exposes no setting at all`);
    for (const field of new Set(fields)) {
      assert.ok(expected.includes(field), `${action.Name} exposes "${field}", which the action does not read`);
    }
  }
});

test('every action that moves a level offers the same three controls', () => {
  // The other test checks that no panel offers more than its action reads. This one
  // checks the other direction: that a panel offers everything its action reads.
  //
  // It is what stops the range from drifting apart again. The two volume dials offered
  // Min and Max while the + and - buttons did not, so the same channel had one
  // reachable range on one key and the full 0..1 on another. An allowlist per action
  // cannot catch that -- it happily records a button with no range at all.
  const VOLUME_ACTIONS = ['Channel Volume', 'Channel Volume Up', 'Channel Volume Down', 'Mix Volume'];

  for (const name of VOLUME_ACTIONS) {
    const declared = manifest.Actions.find((a) => a.Name === name);
    assert.ok(declared, `${name} is not in the manifest`);
    const html = read(declared.PropertyInspectorPath);
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    const fields = [...form.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([\w]+)"/g)].map((m) => m[1]);
    for (const control of ['step', 'min', 'max']) {
      assert.ok(fields.includes(control), `${name} moves a level but offers no ${control}`);
    }
    assert.deepEqual(
      EXPECTED[name].filter((f) => ['step', 'min', 'max'].includes(f)),
      ['step', 'min', 'max'],
      `${name} must be listed as reading all three`
    );
  }
});


/** A file under property-inspector/, comments removed. */
const code = (relative) => stripComments(read(relative));


test('the cache-buster carries the version the panels actually report', () => {
  // The WebView caches shared.js while re-reading the HTML, so ?v= is the only thing
  // telling a stale script from a new one. Checking that a number is present is not
  // enough: a panel left on ?v=4 serves the previous shared.js, so PI.fillSelect would
  // be missing and the panel would do nothing at all, with no error to trace it.
  const shared = read('property-inspector/shared.js');
  const declared = shared.match(/const PI_VERSION = (\d+)/)[1];

  for (const action of manifest.Actions) {
    const html = read(action.PropertyInspectorPath);
    const used = html.match(/shared\.js\?v=(\d+)/)[1];
    assert.equal(
      used,
      declared,
      `${action.Name} loads shared.js?v=${used} but the script reports ${declared}`
    );
  }
});

test('the pickers are built in one place, with one wording', () => {
  // Six panels used to carry their own copy of the loop that fills a <select>, and the
  // empty option had to read the same across panels offering the same choice -- a
  // Channel Mute panel and a Channel Volume panel must not describe "no mix" two ways.
  // Nothing held that except copy-paste discipline, and M5 made it worse: giving the
  // two one-step buttons their channel and mix pickers duplicated the code again.
  const shared = read('property-inspector/shared.js');
  assert.match(shared, /fillSelect\(select, items, selectedId, blank\)/, 'shared.js owns the loop');
  assert.match(shared, /mixBlank\(count, optional\)/, 'and the wording of the empty option');

  for (const action of manifest.Actions) {
    if (action.Name === 'Connect') continue;
    const js = read(action.PropertyInspectorPath.replace('inspector.html', 'inspector.js'));
    assert.doesNotMatch(
      js,
      /document\.createElement\('option'\)/,
      `${action.Name} rebuilds options by hand instead of using PI.fillSelect`
    );
    assert.match(js, /PI\.fillSelect\(/, `${action.Name} must fill its pickers through shared.js`);
  }
});

/**
 * Runs shared.js and boots a form, returning the pieces a test needs to drive it.
 *
 * The file is an IIFE that reaches for `$UD` and `Utils` only from inside its functions,
 * so a sandbox is enough to run it. That buys behavioural tests of the hydration path
 * rather than assertions about its source -- which matters, because two checks written
 * as source scans were answering "is this line still there" instead of "does the panel
 * behave", and a line can move without the behaviour changing.
 */
function bootShared(options = {}) {
  const source = read('property-inspector/shared.js');
  const sent = [];
  const applied = [];
  const handlers = {};
  const form = fakeNode('form');
  form.addEventListener = () => {};
  form.querySelector = () => null;

  const window = { addEventListener() {}, PI: null };
  const document = {
    activeElement: null,
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => form,
    createElement: () => fakeNode('div'),
    // connect() reads the action id off the body, as the real panel's markup carries it.
    body: { dataset: {}, appendChild() {} },
  };
  const $UD = {
    connect() {},
    sendToPlugin(payload) { sent.push(payload); },
    onParamFromApp(fn) { handlers.param = fn; },
    onDidReceiveSettings(fn) { handlers.settings = fn; },
    onSendToPropertyInspector(fn) { handlers.toPanel = fn; },
    on() {},
  };
  const Utils = {
    debounce: (fn) => fn,
    getFormValue: () => ({ channelId: 'ch1', mixId: '' }),
    setFormValue: (settings) => applied.push({ ...settings }),
  };

  vm.runInNewContext(source, { window, document, console, $UD, Utils, setTimeout });
  window.PI.boot('#property-inspector', options);

  return {
    sent,
    applied,
    document,
    /** Simulates the host replaying its stored settings for a key. */
    replay: (settings) => handlers.param({ param: settings }),
    /** Puts the caret in a field, as a user typing into it would. */
    focus: (name) => {
      document.activeElement = { form, name };
    },
  };
}

test('a field the user is in is left alone, and told apart from the rest', () => {
  // The host replays its stored settings on every open. Writing those over a field the
  // user is still typing in wipes half-typed text, so the focused control is skipped --
  // and the hook is handed the fields that were actually applied, not the whole
  // incoming set. A hook given the whole set would put that value straight back under
  // the user's cursor, which is the thing being avoided here.
  const hooked = [];
  const panel = bootShared({ onSettings: (settings) => hooked.push({ ...settings }) });

  panel.focus('channelId');
  panel.replay({ channelId: 'stored', mixId: 'mix2' });

  assert.deepEqual(panel.applied, [{ mixId: 'mix2' }], 'the focused field is not written over');
  assert.deepEqual(hooked, [{ mixId: 'mix2' }], 'and the hook is told what was applied');
  assert.equal(hooked[0].channelId, undefined, 'the field under the user is absent, not restored');
});

test('with nothing in focus, everything is applied', () => {
  const hooked = [];
  const panel = bootShared({ onSettings: (settings) => hooked.push({ ...settings }) });

  panel.replay({ channelId: 'stored', mixId: 'mix2' });

  assert.deepEqual(panel.applied, [{ channelId: 'stored', mixId: 'mix2' }]);
  assert.deepEqual(hooked, [{ channelId: 'stored', mixId: 'mix2' }], 'the hook sees the whole set');
});

test('replayed settings do not make the panel write back for nothing', () => {
  // The host replays on every key selection. Forcing a re-report each time meant every
  // click on the deck produced a pi-form back to the service, describing a form that had
  // not changed. reportForm compares on its own, so replaying has to leave it alone.
  const panel = bootShared();

  panel.replay({ channelId: 'stored' });
  const afterFirst = panel.sent.filter((p) => p.event === 'pi-form').length;
  panel.replay({ channelId: 'stored' });
  panel.replay({ channelId: 'stored' });

  assert.equal(
    panel.sent.filter((p) => p.event === 'pi-form').length,
    afterFirst,
    'an unchanged replay must not produce another report'
  );
});

test('the settings hook is told what was applied, not what was held', () => {
  const shared = code('property-inspector/shared.js');
  assert.doesNotMatch(shared, /options\.onSettings\(settings/, 'never the whole incoming set');
});

test('the connect panel has one listener, not two', () => {
  // bootForm already installs onSendToPropertyInspector and routes state and error
  // messages to the hooks. A second listener in this panel meant two handlers on the
  // same message and a second place to keep in step with the protocol.
  const shared = code('property-inspector/shared.js');
  const panel = code('property-inspector/connect/inspector.js');
  assert.doesNotMatch(panel, /onSendToPropertyInspector/, 'the panel must not install its own');
  assert.match(panel, /onState\(payload\)/, 'it routes state through the hook');
  assert.match(panel, /onError\(message\)/, 'and errors too');
  assert.match(shared, /payload\.event === 'error' && options\.onError/, 'and shared.js delivers them');
});

test('the connect panel debug box cannot grow without bound', () => {
  const panel = code('property-inspector/connect/inspector.js');
  assert.match(panel, /MAX_LINES/, 'lines are capped');
  assert.match(panel, /\.slice\(0, MAX_LINES\)/, 'and the cap is applied');
  assert.doesNotMatch(
    panel,
    /debugEl\.textContent = `[^\n]*\+ debugEl\.textContent/,
    'prepending to the whole text grows it for the life of the session'
  );
});

test('the pickers never inject a name as markup', () => {
  // The names come from Wave Link and are whatever the user typed there. Building them
  // as HTML would run it in this WebView.
  const shared = code('property-inspector/shared.js');
  assert.doesNotMatch(shared, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(shared, /option\.textContent = item\.name \|\| item\.id;/);
});

test('only core/scope.js looks a junction up inside a channel', () => {
  // The structural half of the same rule, on the service side. Reading a junction was
  // written out in four modules and they drifted: an encoder showing the channel's mute
  // while its press only touched a junction, and a step measured from the channel's
  // level with a junction bound. Nothing stopped the fourth copy appearing, so nothing
  // but the shape of the code stops it here.
  //
  // The word "mixes" is not evidence on its own: in the registry it is part of the wire
  // protocol -- the mixesChanged event, lastState.mixes, the { mixes: [...] } payload.
  // What must not be repeated is locating one junction inside a channel.
  const reads = [
    'actions/channel-volume.js',
    'actions/channel-volume-up.js',
    'actions/channel-volume-down.js',
    'actions/channel-mute.js',
    'actions/mix-volume.js',
    'actions/mix-mute.js',
    'core/registry.js',
  ];

  for (const relative of reads) {
    const source = jsCode(`service/${relative}`);
    assert.doesNotMatch(
      source,
      /mixes\s*\?*\.\s*find\(/,
      `${relative} looks a junction up itself; use scopeLevel / scopeMuted / scopeEntry from core/scope.js`
    );
  }

  // And the modules that bind a scope have to be reading it from there.
  for (const relative of ['actions/channel-volume.js', 'actions/channel-mute.js', 'core/registry.js']) {
    const source = jsCode(`service/${relative}`);
    assert.match(
      source,
      /from '[^']*scope\.js'/,
      `${relative} must read scopes through core/scope.js`
    );
  }
});

/** A stand-in for a <select> or an <option>, faithful about the two things that matter. */
function fakeNode(tag) {
  return {
    tag,
    value: '',
    // The error banner shared.js raises writes here, so a node without it turns a real
    // failure into a confusing "cannot set properties of undefined".
    style: {},
    _text: '',
    children: [],
    get textContent() { return this._text; },
    // Assigning textContent empties the node, which is how fillSelect clears it first.
    set textContent(value) {
      this._text = value;
      if (value === '') this.children = [];
    },
    appendChild(child) { this.children.push(child); },
  };
}

/**
 * Runs shared.js in a sandbox and returns the PI it exposes.
 *
 * The file is an IIFE that touches only `window` at load time -- `$UD` and `Utils` are
 * reached from inside its functions -- so a stub window is enough to run it. That buys
 * real behavioural tests of the picker code instead of assertions about its source,
 * which is the only way the empty-option wording can be pinned at all.
 */
function loadShared() {
  const source = read('property-inspector/shared.js');
  const window = { addEventListener() {}, PI: null };
  const document = {
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => fakeNode('option'),
    body: { appendChild() {} },
  };
  vm.runInNewContext(source, { window, document, console });
  return window.PI;
}

test('the empty option says what choosing nothing actually means', () => {
  const PI = loadShared();

  assert.equal(PI.channelBlank(3), 'Default channel', 'a channel picker always offers the default');
  assert.equal(PI.channelBlank(0), 'No channel found', 'and says so when there is none');

  assert.equal(PI.mixBlank(3, true), 'Overall volume', 'an optional mix scopes a level');
  assert.equal(PI.mixBlank(3, false), 'No mix selected', 'a required mix has no such fallback');
  assert.notEqual(
    PI.mixBlank(3, true),
    PI.mixBlank(3, false),
    'the two meanings must not read the same, or a panel cannot be trusted for either'
  );
  assert.equal(PI.mixBlank(0, false), 'No mix found', 'with nothing to choose, it says so');

  for (const label of [PI.channelBlank(1), PI.mixBlank(1, true), PI.mixBlank(1, false)]) {
    assert.ok(label.trim().length > 0, `an empty label "${label}" would leave the picker unexplained`);
  }
});

test('a picker keeps the bound choice and falls back to the names', () => {
  const PI = loadShared();
  const select = fakeNode('select');

  PI.fillSelect(
    select,
    [{ id: 'a', name: 'Firefox' }, { id: 'b' }],
    'b',
    'Overall volume'
  );

  assert.deepEqual(
    select.children.map((c) => c.value),
    ['', 'a', 'b'],
    'the empty option comes first, then every id'
  );
  assert.deepEqual(
    select.children.map((c) => c.textContent),
    ['Overall volume', 'Firefox', 'b'],
    'an unnamed entry falls back to its id rather than a blank row'
  );
  assert.equal(select.value, 'b', 'and the bound choice is applied');

  // An id the list no longer holds is left to the control: a real <select> resolves a
  // value it cannot find to its first option, which is the empty one. The stub does
  // not, so the case asserted here is the one the service actually sends -- no binding
  // chosen yet, reported as an empty id.
  PI.fillSelect(select, [{ id: 'a', name: 'Firefox' }], '', 'None');
  assert.equal(select.value, '', 'an unbound key shows the empty option');
  assert.equal(select.children.length, 2, 'and the previous options are gone, not appended to');
});

test('settings are saved through a channel the host actually persists', () => {
  // The host does not read this form. On reopening a key it replays its own stored
  // copy -- observed still carrying `wrap`, a setting removed from the panel months
  // earlier, and never carrying a newly added one. A sendParamFromPlugin from here
  // therefore leaves no trace: the edit is simply lost when the key is reselected.
  // sendToPlugin reaches the service, which persists it with setSettings.
  const shared = code('property-inspector/shared.js');
  assert.match(shared, /sendToPlugin\(\{\s*event: 'set-settings'/, 'shared.js must save through sendToPlugin');
  assert.doesNotMatch(shared, /sendParamFromPlugin\(/, 'shared.js must not use the channel the host ignores');

  const service = jsCode('service/app.js');
  assert.doesNotMatch(service, /sendParamFromPlugin\(/, 'the service must not echo into the void either');
  assert.match(service, /setSettings\(current\.settings, context\)/, 'the service must persist what the panel sends');
});

test('a panel edit is merged, so settings the host still holds are not pruned', () => {
  const service = jsCode('service/app.js');
  assert.match(
    service,
    /current\.settings = \{ \.\.\.current\.settings, \.\.\.\(payload\.settings \|\| \{\}\) \}/,
    'settings must be merged, not replaced'
  );
});

test('no action publishes a title, and none asks for one', () => {
  // Ulanzi Studio owns the Title field. The plugin published its own, and that was
  // worse than useless twice over: it overwrote what the user typed there, and the
  // value it sent was rebuilt from the live level, so it changed on every
  // notification. Removing it leaves the key entirely to the host.
  const ui = jsCode('service/core/ui.js');
  assert.doesNotMatch(ui, /export function setTitle/, 'ui.js must not offer setTitle');

  for (const action of manifest.Actions) {
    const short = action.UUID.split('.').pop();
    const source = jsCode(`service/actions/${short}.js`);
    assert.doesNotMatch(source, /setTitle\(/, `${action.Name} must not publish a title`);
    assert.doesNotMatch(source, /title: ''/, `${action.Name} must not declare a title setting`);
    assert.doesNotMatch(read(action.PropertyInspectorPath), /name="title"/, `${action.Name} must not ask for one`);
    assert.doesNotMatch(read(action.PropertyInspectorPath), /<legend>Appearance<\/legend>/, `${action.Name} has no Appearance section`);
  }
});

test('an unchanged inspector payload is not resent, but a new panel always is', () => {
  // Two bugs, one shape. Sending unconditionally rebuilt the panel on every
  // notification, which the user could see as a refresh on each notch of a dial.
  // Deduplicating it instead left every freshly opened panel showing a stale status
  // and empty pickers, because its WebView was created empty and nothing told us.
  //
  // So the payload is compared, and the panel's own get-registry forces the send.
  const service = jsCode('service/app.js');
  assert.match(service, /lastInspectorPayload/, 'the payload must be compared');
  assert.match(
    service,
    /if \(!force && lastInspectorPayload\.get\(ctx\) === serialised\) return;/,
    'an unchanged payload must be suppressed'
  );
  assert.match(
    service,
    /refresh\(context, \{ force: true \}\)/,
    'a panel announcing itself must always be answered'
  );
  // And only that panel. The host delivers these to whichever panel is open, so
  // refreshing every instance of the action meant the last one sent won: three dials
  // bound to three different channels all ended up showing the same one.
  const registry = service.slice(service.indexOf("payload.event === 'get-registry'"));
  const block = registry.slice(0, registry.indexOf('return;'));
  assert.doesNotMatch(
    block,
    /for \(const \[ctx, entry\] of contexts\)/,
    'a panel request must not fan out to the other instances'
  );

  // And the payload has to be stable for that comparison to mean anything: a level
  // changes on every rotation, and an inspector never reads one.
  const list = service.slice(service.indexOf('function pickerLists'), service.indexOf('/** Last payload sent'));
  assert.doesNotMatch(list, /level/, 'the picker lists must carry no level');
  assert.doesNotMatch(list, /isMuted/, 'nor a mute flag');
  assert.doesNotMatch(list, /imgData|image/, 'nor the base64 icon');
  assert.match(list, /id: c\.id, name: c\.name/, 'only an id and a name');
});

test('a draw is deduplicated, so a repaint with nothing new emits nothing', () => {
  const ui = jsCode('service/core/ui.js');
  assert.match(ui, /lastStateIcon\.get\(context\) === key/, 'the state icon must be deduplicated');
  assert.match(ui, /lastEncoderIcon\.get\(context\) === image/, 'the dial icon must be deduplicated');
});

test('shared.js is referenced with a version so the WebView refetches it', () => {
  // The WebView caches shared.js while re-reading the HTML, so a fix silently does
  // not land: the new field shows up, the behaviour behind it stays old.
  for (const action of manifest.Actions) {
    const html = read(action.PropertyInspectorPath);
    assert.match(
      html,
      /<script src="\.\.\/shared\.js\?v=\d+"><\/script>/,
      `${action.Name} must bust the shared.js cache`
    );
  }
});

test('inspectors reach the SDK through the bundled libs', () => {
  for (const action of manifest.Actions) {
    const html = read(action.PropertyInspectorPath);
    assert.match(html, /\.\.\/\.\.\/libs\/js\/ulanziApi\.js/, `${action.Name} must load ulanziApi.js`);
    assert.match(html, /\.\.\/shared\.js/, `${action.Name} must load shared.js`);
  }
});

test('no inspector offers a second label field for the dial', () => {
  // The dial shows what it is bound to. There is no setting for that: the host's
  // Title is never delivered to the plugin, so a second field would be the only way
  // to set it, and the user chose the host's field instead.
  for (const name of ['channel-volume', 'mix-volume']) {
    const html = readInspector(`${name}/inspector.html`);
    assert.doesNotMatch(html, /name="label"/, `${name} must not declare a dial label field`);
    assert.doesNotMatch(html, /<input type="text"/, `${name} must offer no text field at all`);
  }
});