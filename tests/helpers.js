/**
 * Shared paths for the test suite.
 *
 * The tests read the plugin sources straight from plugin/, which is what gets
 * copied into the release folder, so a check here covers what actually ships.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PLUGIN_ROOT = path.join(ROOT, 'plugin');
export const PI_ROOT = path.join(PLUGIN_ROOT, 'property-inspector');
export const SERVICE_ROOT = path.join(PLUGIN_ROOT, 'service');
export const ACTION_UUID = 'com.ulanzi.ulanzistudio.wavelink';