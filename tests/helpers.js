/**
 * Shared paths for the test suite.
 *
 * The tests read the plugin sources straight from plugin/, which is what gets
 * copied into the release folder, so a check here covers what actually ships.
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PLUGIN_ROOT = path.join(ROOT, 'plugin');
export const PI_ROOT = path.join(PLUGIN_ROOT, 'property-inspector');
export const SERVICE_ROOT = path.join(PLUGIN_ROOT, 'service');
export const ACTION_UUID = 'com.ulanzi.ulanzistudio.wavelink';

/**
 * Removes line and block comments.
 *
 * Several checks scan the plugin sources for a construct that must not appear. Doing
 * that on the raw text reads the prose too, and a comment explaining why a call is not
 * made contains the very name being hunted -- two of these checks failed on their own
 * justification before the sources were stripped. Line and block comments go; string
 * literals are left alone, which is a known limit and harmless here.
 */
export const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A file under plugin/, comments removed, for the checks that scan code. */
export const jsCode = (relative) => stripComments(readFileSync(path.join(PLUGIN_ROOT, relative), 'utf8'));