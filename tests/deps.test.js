/**
 * The dependency installer resolves version ranges by hand, so the ranges it
 * understands are pinned down here rather than discovered on a build machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { satisfies } from '../scripts/install-deps.mjs';

const CASES = [
  // the direct runtime dependency
  ['8.22.0', '^8.18.0', true],
  ['8.17.0', '^8.18.0', false],
  // caret on a major below 1
  ['2.8.0', '^2.8.0', true],
  ['2.9.0', '^2.8.0', true],
  ['3.0.0', '^2.8.0', false],
  // caret on a zero major pins the minor
  ['0.2.5', '^0.2.3', true],
  ['0.3.0', '^0.2.3', false],
  ['0.0.5', '^0.0.4', false],
  // tilde pins the minor
  ['1.2.9', '~1.2.3', true],
  ['1.3.0', '~1.2.3', false],
  // ranges a transitive dependency tree can produce
  ['4.17.21', '^4.3.7', true],
  ['8.1.0', '^8.1.0', true],
  ['4.8.1', '^4.8.1', true],
  ['2.3.0', '^2.3.0', true],
  // compound and alternative ranges
  ['1.0.0', '>=1.0.0 <2.0.0', true],
  ['2.0.0', '>=1.0.0 <2.0.0', false],
  ['3.0.0', '1.0.0 || 3.0.0', true],
  ['10.0.0', '^8.0.0 || ^10.0.0', true],
  ['1.5.0', '1.0.0 - 2.0.0', true],
  ['2.5.0', '1.0.0 - 2.0.0', false],
  // partial versions and wildcards
  ['1.2.3', '1.2', true],
  ['1.3.0', '1.2', false],
  ['1.2.3', '*', true],
  // prereleases stay out unless asked for
  ['1.0.0-rc.1', '^1.0.0', false],
  ['1.0.0-rc.2', '>=1.0.0-rc.1', true],
  ['1.0.0', '^1.0.0-rc.1', true],
];

test('version ranges resolve the way npm resolves them', () => {
  for (const [version, range, expected] of CASES) {
    assert.equal(satisfies(version, range), expected, `${version} vs "${range}"`);
  }
});

test('garbage ranges never throw', () => {
  for (const range of ['', 'not-a-range', '>=', '^^1.0.0', 'latest']) {
    assert.doesNotThrow(() => satisfies('1.0.0', range));
  }
});
