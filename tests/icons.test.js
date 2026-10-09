/**
 * Geometry of the deck icons.
 *
 * These are SVG files, so nothing checks them: a path can be malformed, a part can stop
 * short of the one it is supposed to meet, and the host draws whatever comes out. The
 * mute icons were wrong in exactly that way for as long as they existed -- the cradle of
 * the microphone arced over the top of the capsule instead of under it, its two side
 * strokes started 4px away from the arc they were meant to continue, and its slash ran
 * the opposite way to every other muted icon in the set.
 *
 * So the joints are asserted here. It cannot say whether the result is handsome, but it
 * says the pieces meet, which is what was broken.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PLUGIN_ROOT, stripComments } from './helpers.js';

const IMAGES = `${PLUGIN_ROOT}/images`;
const SIZE = 72;

const svg = (name) => readFileSync(`${IMAGES}/${name}`, 'utf8');
/** The same file with its prose removed, for the checks that look for a construct. */
const code = (name) => stripComments(svg(name));
const icons = () => readdirSync(IMAGES).filter((f) => f.endsWith('.svg'));

/** Every `M`/`L`/`Q`/`C` start point in a `d`, which is every explicit point. */
function points(d) {
  return [...d.matchAll(/([MLQC])\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/g)]
    .map((m) => [Number(m[2]), Number(m[3])]);
}

/**
 * An arc command, which carries seven parameters: rx, ry, the x-axis rotation, two
 * flags, then the end point. Leaving the rotation out of the pattern reads the first
 * flag as the end coordinate, which is how a chord of 29.73 turned up on a diameter of
 * 32.
 */
function arc(d) {
  const m = d.match(
    /A\s*(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+([01])[,\s]+([01])[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/
  );
  if (!m) return null;
  return {
    rx: Number(m[1]),
    ry: Number(m[2]),
    rotation: Number(m[3]),
    largeArc: m[4] === '1',
    sweep: m[5] === '1',
    to: [Number(m[6]), Number(m[7])],
  };
}

/** WCAG relative luminance, for the one check that is about legibility rather than shape. */
const luminance = (hex) => {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** `#abc` and `#aabbcc` mean the same colour; these files use the short form. */
function normaliseHex(hex) {
  const h = hex.slice(1).toLowerCase();
  return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}



/**
 * Icons that draw a knob, identified by the body rather than by their name.
 *
 * These were faders once. Selecting on geometry means an icon renamed or added is
 * picked up without a list to update, and it is what caught the eight of them drifting
 * apart in the first place.
 */
const knobs = () => icons().filter((f) => svg(f).includes('<circle cx="36" cy="32" r="12"'));

/** The centre every knob shares, and the radius of its travel. */
const KNOB = { x: 36, y: 32, travel: 19 };

/**
 * The travel arc, read back with its flags.
 *
 * The span it traverses is computed from the endpoints, the radius and the sweep flag,
 * so a flag flipped in either direction fails here rather than on somebody's deck. That
 * is not hypothetical: this arc was once a dashed circle plus a transform, which the
 * deck rendered rotated.
 */
function travelArc(name) {
  const m = code(name).match(/<path d="M([\d.]+) ([\d.]+) A([\d.]+) \3 0 ([01]) ([01]) ([\d.]+) ([\d.]+)"/);
  assert.ok(m, `${name}: no travel arc, or one that is not a plain arc command`);
  // slice(1) and not [m[1], m[2], ...]: the seven groups then land on seven names, where
  // a hand-written list of the same length is one short and every value shifts along,
  // putting NaN in the last one and quietly comparing against nothing.
  const [x1, y1, r, large, sweep, x2, y2] = m.slice(1).map(Number);

  const chord = Math.hypot(x2 - x1, y2 - y1) / 2;
  assert.ok(chord <= r, `${name}: the chord is longer than the radius, which no arc can draw`);
  // Two centres, and they lie on the line perpendicular to the chord -- not along it.
  // For a horizontal chord that is a vertical offset. Getting this backwards puts the
  // centre nowhere near the knob, which is the third time this geometry has been
  // written down backwards in this project.
  const off = Math.sqrt(r * r - chord * chord);
  const mid = [(x1 + x2) / 2, (y1 + y2) / 2];
  const chordIsVertical = Math.abs(x2 - x1) < 1e-6;
  const centres = chordIsVertical
    ? [[mid[0] + off, mid[1]], [mid[0] - off, mid[1]]]
    : [[mid[0], mid[1] + off], [mid[0], mid[1] - off]];
  const centre = centres.find(([cx, cy]) =>
    // A hundredth of a pixel: the coordinates in the file are rounded, so an exact
    // comparison rejects a centre that is right to within the precision it was written
    // at. Anything looser would hide a genuinely misplaced arc.
    Math.hypot(cx - KNOB.x, cy - KNOB.y) < 0.01);
  assert.ok(centre, `${name}: neither candidate centre is the knob's, so the arc is not centred on it`);

  const a1 = (Math.atan2(y1 - centre[1], x1 - centre[0]) * 180) / Math.PI;
  const a2 = (Math.atan2(y2 - centre[1], x2 - centre[0]) * 180) / Math.PI;
  const span = sweep === 1 ? (a2 - a1 + 360) % 360 : (a1 - a2 + 360) % 360;
  return { large: large === 1, sweep: sweep === 1, span, centre, r };
}

/**
 * The angle of a marker, in degrees clockwise from vertical.
 *
 * Read back from the file rather than from the arithmetic that produced it, so the test
 * states the rule the icons have to obey.
 */
function markerAngle(name) {
  // The marker is the only white stroke on the knob body.
  const d = code(name).match(/<path d="M(-?[\d.]+) (-?[\d.]+) L(-?[\d.]+) (-?[\d.]+)" stroke="#ffffff"/);
  assert.ok(d, `${name}: no marker to read`);
  const [x1, y1, x2, y2] = d.slice(1).map(Number);
  return (Math.atan2(x2 - x1, -(y2 - y1)) * 180) / Math.PI;
}

const near = (value, expected, tolerance, message) =>
  assert.ok(
    Math.abs(value - expected) <= tolerance,
    `${message} (got ${value.toFixed(1)}, expected ${expected} +/- ${tolerance})`
  );

test('every knob draws the same body and the same travel', () => {
  // Eight icons share this knob, and the travel used to be a dashed circle with a
  // transform on it. The deck rendered that rotated while Ulanzi Studio rendered it
  // correctly, which is why the travel is now a plain arc command: `stroke-dasharray`
  // and `transform` are the two constructs not to assume on a device renderer.
  const bodies = new Set();
  const travels = new Set();
  for (const name of knobs()) {
    const s = code(name);
    assert.doesNotMatch(s, /stroke-dasharray/, `${name}: the dash pattern came back`);
    assert.doesNotMatch(s, /transform=/, `${name}: a transform came back`);

    const body = s.match(/<circle cx="36" cy="32" r="12" fill="(#[0-9a-fA-F]{3,6})" stroke="(#[0-9a-fA-F]{3,6})"[^>]*\/>/);
    assert.ok(body, `${name}: no knob body`);
    bodies.add(`${normaliseHex(body[1])}/${normaliseHex(body[2])}`);

    const arc = travelArc(name);
    travels.add(`${arc.large}|${arc.sweep}|${arc.span.toFixed(2)}|${arc.r}`);
  }
  assert.equal(knobs().length, 8, `expected the eight knobs, saw ${knobs().join(', ')}`);
  assert.equal(travels.size, 1, `the travels disagree: ${[...travels].join('  ')}`);

  // 270 of travel, so the opening at the bottom is the missing 90, where a
  // potentiometer has its notch.
  const [, sweep, span, r] = [...travels][0].split('|');
  near(Number(span), 270, 0.01, 'the travel is not 270 degrees');
  assert.equal(sweep, 'true', 'it must run the long way, through 9h and 12h');
  assert.equal(Number(r), 19, 'and share the knob radius');
  assert.ok(bodies.size >= 3, 'expected the state colours to differ');
});

test('the marker reads the state: three quarters live, zero muted', () => {
  // The rule the icons are drawn to express. A live knob shows its level at three
  // quarters; a muted one is turned to zero as well as barred.
  //
  // The two one-step buttons sit at the ends of the travel rather than at three
  // quarters, because that is what they do: up turns it as far as it goes, down winds
  // it back to zero. They are not mute states, and the minus is not a bar.
  const LIVE = ['action-channel-volume.svg', 'action-mix-volume.svg', 'action-mix-unmute.svg'];
  const MUTED = [
    'action-channel-volume-muted.svg',
    'action-mix-volume-muted.svg',
    'action-mix-mute.svg',
  ];

  for (const name of LIVE) {
    near(markerAngle(name), 67.5, 0.5, `${name}: a live knob should read three quarters`);
  }
  for (const name of MUTED) {
    near(markerAngle(name), -135, 0.5, `${name}: a muted knob should read zero`);
  }
  near(markerAngle('action-channel-volume-up.svg'), 135, 0.5, 'the up button turns it as far as it goes');
  near(markerAngle('action-channel-volume-down.svg'), -135, 0.5, 'the down button winds it back to zero');

  // Three quarters really is three quarters of a 270 degree travel from -135.
  const travel = markerAngle('action-mix-volume.svg') - -135;
  near(travel / 270, 0.75, 0.005, 'the marker is not at three quarters of the travel');

  // Zero also means barred, on the three mute states and on nothing else.
  for (const name of MUTED) {
    assert.match(svg(name), /<path d="M18 54 L54 18"/, `${name} is muted but not barred`);
  }
  assert.doesNotMatch(
    svg('action-channel-volume-down.svg'),
    /M18 54 L54 18/,
    'a step button reads zero but is not a mute state'
  );
  assert.doesNotMatch(svg('action-mix-unmute.svg'), /M18 54 L54 18/, 'and nothing live is barred');
});

test('the marker stays on the knob', () => {
  for (const name of knobs()) {
    const d = code(name).match(/<path d="M(-?[\d.]+) (-?[\d.]+) L(-?[\d.]+) (-?[\d.]+)" stroke="#ffffff"/);
    for (const [x, y] of [[Number(d[1]), Number(d[2])], [Number(d[3]), Number(d[4])]]) {
      const r = Math.hypot(x - KNOB.x, y - KNOB.y);
      assert.ok(r > 3, `${name}: the marker starts inside the centre`);
      assert.ok(r < 12, `${name}: the marker runs off the knob body at r=${r.toFixed(1)}`);
    }
  }
});

test('the travel arc is a near-white, neutral ring', () => {
  // The rail was #333 on a #1a1a1a plate, a contrast of 1.38: in the file, not on the
  // deck. Lightened twice on request, and now the arc of travel rather than a bar.
  //
  // It must stay a neutral grey. A coloured ring would read as a state, and the three
  // states here are green, orange and pink.
  const RING = /<path d="M[\d.]+ [\d.]+ A19 19 0 1 1 [\d.]+ [\d.]+" fill="none" stroke="(#[0-9a-fA-F]{3,6})"/;
  for (const name of knobs()) {
    const colour = normaliseHex(code(name).match(RING)[1]);
    const ratio = contrast(colour, '#1a1a1a');
    assert.ok(ratio >= 8, `${name}: its ring ${colour} sits at a contrast of ${ratio.toFixed(2)}, not near-white`);

    const n = parseInt(colour.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    assert.equal(
      Math.max(r, g, b) - Math.min(r, g, b),
      0,
      `${name}: its ring ${colour} is not neutral, so it could be mistaken for a state`
    );
  }
});

test('the other icon keeps its own greys', () => {
  // Connect uses #333 for the bodies of two devices. That is a different element and it
  // was left alone: lightening the fader track must not quietly lighten everything that
  // happens to share a hex value.
  const connect = svg('action-connect.svg');
  assert.ok(connect.includes('fill="#333"'), 'connect lost its device bodies');
  assert.ok(!knobs().includes('action-connect.svg'), 'connect is not a knob');
});

test('every icon is well-formed XML', () => {
  // The two microphone icons carried a "--" inside an XML comment, which the spec
  // forbids. Nothing in the build looked at them: the deck's renderer recovered and drew
  // them, and Chromium refused, so the icons simply did not exist in Ulanzi Studio. The
  // one that renders is not the one that displays everywhere.
  //
  // There is no XML parser in the standard library, so the two malformations these files
  // are actually prone to are checked directly.
  for (const name of icons()) {
    const s = svg(name);

    for (const m of s.matchAll(/<!--([\s\S]*?)-->/g)) {
      assert.doesNotMatch(m[1], /--/, `${name}: a comment contains '--', which is not valid XML`);
      assert.doesNotMatch(m[1], /-$/, `${name}: a comment ends with a hyphen`);
    }

    for (const m of s.matchAll(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g)) {
      assert.fail(`${name}: a bare '&' at offset ${m.index}`);
    }

    // Balanced tags, for the handful of elements these files use.
    const stack = [];
    for (const m of s.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
      const [, closing, tag, selfClosing] = m;
      if (closing) {
        assert.equal(stack.pop(), tag, `${name}: </${tag}> closes the wrong element`);
      } else if (!selfClosing) {
        stack.push(tag);
      }
    }
    assert.deepEqual(stack, [], `${name}: unclosed <${stack.join('>, <')}>`);
  }
});

test('every icon declares the same box', () => {
  for (const name of icons()) {
    const s = svg(name);
    assert.match(s, new RegExp(`width="${SIZE}"`), `${name} has no width`);
    assert.match(s, new RegExp(`height="${SIZE}"`), `${name} has no height`);
    assert.match(s, new RegExp(`viewBox="0 0 ${SIZE} ${SIZE}"`), `${name} has no viewBox`);
    assert.match(s, /<rect width="72" height="72" rx="12" fill="#1a1a1a"\/>/, `${name} lost its plate`);
  }
});

test('nothing is drawn outside the box', () => {
  for (const name of icons()) {
    const s = svg(name);
    for (const m of s.matchAll(/ d="([^"]+)"/g)) {
      for (const [x, y] of points(m[1])) {
        assert.ok(x >= 0 && x <= SIZE, `${name}: x=${x} is outside the box`);
        assert.ok(y >= 0 && y <= SIZE, `${name}: y=${y} is outside the box`);
      }
    }
    for (const m of s.matchAll(/<circle[^>]*\bcx="(-?[\d.]+)"[^>]*\bcy="(-?[\d.]+)"[^>]*\br="([\d.]+)"/g)) {
      const [cx, cy, r] = [Number(m[1]), Number(m[2]), Number(m[3])];
      assert.ok(cx - r >= 0 && cx + r <= SIZE, `${name}: circle crosses a vertical edge`);
      assert.ok(cy - r >= 0 && cy + r <= SIZE, `${name}: circle crosses a horizontal edge`);
    }
  }
});

test('the microphone is built from parts that meet', () => {
  for (const name of ['action-channel-mute.svg', 'action-channel-unmute.svg']) {
    const s = svg(name);

    // The capsule is a capsule: rx of half its width rounds both ends completely.
    const cap = s.match(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)"/);
    assert.ok(cap, `${name}: no capsule`);
    const [, , , capW, , capR] = cap.map(Number);
    assert.equal(capR, capW / 2, `${name}: the capsule is not rounded at both ends`);

    // The cradle's chord is its diameter, so the arc has a single possible centre and
    // cannot be flipped to the other side by a sweep flag. This is the defect the old
    // version had: a 16-wide chord under a radius of 10 left two candidate centres, and
    // the flags picked the one that arced over the top of the capsule.
    const cradle = s.match(/d="(M[^"]*A[^"]*)"/);
    assert.ok(cradle, `${name}: no cradle`);
    const start = points(cradle[1])[0];
    const a = arc(cradle[1]);
    assert.ok(a, `${name}: the cradle arc could not be read`);

    const chord = Math.hypot(a.to[0] - start[0], a.to[1] - start[1]);
    assert.ok(chord > 0, `${name}: the cradle is a point`);
    assert.equal(a.rx, a.ry, `${name}: the cradle is not a circle, so its ends cannot be level`);
    assert.ok(
      chord <= 2 * a.rx,
      `${name}: chord ${chord} is longer than the diameter ${2 * a.rx}, which no arc can draw`
    );
    assert.equal(
      chord,
      2 * a.rx,
      `${name}: cradle chord ${chord} is not its diameter ${2 * a.rx}, so the shape depends on the sweep flag`
    );

    // Bottom of the cradle, then the stem that has to start exactly there.
    const bottom = [(start[0] + a.to[0]) / 2, (start[1] + a.to[1]) / 2 + a.rx];
    const stem = s.match(/d="M(-?[\d.]+) (-?[\d.]+) L(-?[\d.]+) (-?[\d.]+)"/);
    assert.ok(stem, `${name}: no stem`);
    assert.deepEqual(
      [Number(stem[1]), Number(stem[2])],
      bottom.map(Math.round),
      `${name}: the stem starts somewhere other than the bottom of the cradle`
    );

    // And the base has to cross the end of the stem, or the stem ends in mid-air.
    const lines = [...s.matchAll(/d="M(-?[\d.]+) (-?[\d.]+) L(-?[\d.]+) (-?[\d.]+)"/g)]
      .map((m) => m.slice(1).map(Number));
    const horizontal = lines.find(([, ay, , by]) => ay === by);
    assert.ok(horizontal, `${name}: no horizontal base`);
    const [, y, a1, b1] = horizontal;
    const stemEnd = Number(stem[4]);
    assert.ok(
      stemEnd >= Math.min(a1, b1) && stemEnd <= Math.max(a1, b1),
      `${name}: the stem ends at x=${stemEnd}, outside the base ${Math.min(a1, b1)}..${Math.max(a1, b1)}`
    );
    assert.ok(y > Number(stem[3]), `${name}: the base is above the end of the stem`);
  }
});

test('the two channel mute icons differ only in colour and their mark', () => {
  // Same shape on both faces, so a mute toggle does not appear to change the object it
  // is muting. Only the stroke colour, the slash or waves, and the label may differ.
  const shape = (s) => s
    .replace(/stroke="#[0-9a-f]{6}"/gi, 'stroke="#COLOR"')
    .replace(/opacity="[\d.]+"/g, '')
    .replace(/<text[\s\S]*?<\/text>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const muted = shape(svg('action-channel-mute.svg'));
  const unmuted = shape(svg('action-channel-unmute.svg'));
  assert.notEqual(muted, unmuted, 'the mute icon should not be identical to the unmuted one');

  // The microphone itself: capsule, cradle, stem and base, shared verbatim.
  const mic = (name) => svg(name)
    .replace(/<!--[\s\S]*?-->/g, '')
    .match(/<rect x="28"[^>]*\/>|<path d="(M20 30 A16 16 0 0 0 52 30|M36 46 L36 52|M26 52 L46 52)"[^>]*\/>/g)
    .map((p) => p.replace(/#[0-9a-f]{6}/gi, '#C'));
  const mutedMic = mic('action-channel-mute.svg');
  assert.equal(mutedMic.length, 4, 'the muted face lost a part of the microphone');
  assert.deepEqual(mutedMic, mic('action-channel-unmute.svg'), 'the microphone must be drawn identically on both faces');
});

test('every muted icon slashes the same way', () => {
  // Bottom-left to top-right throughout. The channel mute icon ran the other way, which
  // is the sort of thing nobody notices until the six icons sit side by side.
  const muted = icons().filter((f) => /muted?\b|mute\b/.test(f));
  assert.ok(muted.length >= 2, 'expected the muted icons to be found');
  const directions = new Map();
  for (const name of muted) {
    for (const m of svg(name).matchAll(/ d="M(\d+) (\d+) L(\d+) (\d+)"/g)) {
      const [, x1, y1, x2, y2] = m.map(Number);
      const rising = x2 > x1 ? y2 < y1 : y2 > y1;
      if (Math.abs(x2 - x1) !== Math.abs(y2 - y1)) continue; // not a diagonal
      if (!directions.has(name)) directions.set(name, rising ? 'bottom-left to top-right' : 'top-left to bottom-right');
    }
  }
  assert.ok(directions.size >= 2, `expected a slash in several icons, saw ${[...directions.keys()].join(', ')}`);
  const kinds = new Set(directions.values());
  assert.equal(kinds.size, 1, `the slashes disagree: ${[...directions].map(([k, v]) => `${k} = ${v}`).join('; ')}`);
});

test('the icons the manifest names are all there', () => {
  const manifest = JSON.parse(readFileSync(`${PLUGIN_ROOT}/manifest.json`, 'utf8'));
  const referenced = new Set();
  for (const action of manifest.Actions) {
    referenced.add(action.Icon);
    for (const state of action.States) referenced.add(state.Image);
  }
  for (const path of referenced) {
    assert.ok(icons().includes(path.replace('images/', '')), `${path} is referenced but missing`);
  }
});