/**
 * Installs the plugin runtime dependencies into ./release/<plugin>.ulanziPlugin
 * without npm: fetch from the public registry, extract the .tgz with a minimal
 * tar reader, and flatten everything into node_modules/ the way npm hoists.
 *
 * Why not just call npm? Because the machine that builds the release does not
 * have to have npm installed - UlanziStudio ships its own Node runtime, and
 * that is all this script needs.
 *
 * Supported range syntax: exact, partial (1 / 1.2), ^, ~, >=, <=, >, <, =,
 * space separated conjunctions, hyphen ranges and || alternatives.
 * devDependencies are ignored; optionalDependencies are best effort and honour
 * os/cpu from the packument.
 */

import { gunzipSync } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'sdk', '.cache', 'npm');
const REGISTRY = 'https://registry.npmjs.org';

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`GET ${url} -> ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

/* ------------------------------------------------------------------ semver */

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function bump(v, level) {
  if (level === 'major') return { major: v.major + 1, minor: 0, patch: 0, pre: [] };
  if (level === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0, pre: [] };
  return { major: v.major, minor: v.minor, patch: v.patch + 1, pre: [] };
}

/** Expand one simple range token into a list of {op, version} comparators. */
function tokenComparators(token) {
  const t = token.trim();
  if (t === '' || t === '*' || t === 'x' || t === 'latest') return [];

  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?/.exec(t);
  if (!m) throw new Error(`unsupported range "${token}"`);

  const op = m[1] || '=';
  const major = m[2] === 'x' || m[2] === '*' ? null : Number(m[2]);
  const minor = m[3] === undefined || m[3] === 'x' || m[3] === '*' ? null : Number(m[3]);
  const patch = m[4] === undefined || m[4] === 'x' || m[4] === '*' ? null : Number(m[4]);
  const pre = m[5] ? m[5].split('.') : [];

  if (major === null) return [];

  const base = { major, minor: minor ?? 0, patch: patch ?? 0, pre };

  if (op === '^') {
    const upper = major > 0 ? bump(base, 'major') : minor > 0 ? bump(base, 'minor') : bump(base, 'patch');
    if (major === 0 && minor === null) return [{ op: '<', version: bump(base, 'major') }];
    if (major === 0 && minor === 0 && patch === 0) return [{ op: '<', version: bump(base, 'major') }];
    return [{ op: '>=', version: base }, { op: '<', version: upper }];
  }
  if (op === '~') {
    const upper = minor === null ? bump(base, 'major') : bump(base, 'minor');
    return [{ op: '>=', version: base }, { op: '<', version: upper }];
  }
  if (minor === null) return [{ op: '>=', version: base }, { op: '<', version: bump(base, 'major') }];
  if (patch === null) return [{ op: '>=', version: base }, { op: '<', version: bump(base, 'minor') }];
  return [{ op: op === '=' ? '=' : op, version: base }];
}

function satisfiesComparator(version, c) {
  const cmp = compare(version, c.version);
  switch (c.op) {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    default: return cmp === 0;
  }
}

export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  for (const alternative of String(range).split('||')) {
    const trimmed = alternative.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
    let comparators;
    if (hyphen) {
      const low = parseVersion(hyphen[1]);
      const high = parseVersion(hyphen[2]);
      if (!low || !high) continue;
      comparators = [{ op: '>=', version: low }, { op: '<=', version: high }];
    } else {
      try {
        comparators = trimmed.split(/\s+/).flatMap(tokenComparators);
      } catch {
        continue;
      }
    }
    // A prerelease only satisfies a range that itself mentions a prerelease.
    if (v.pre.length > 0 && !comparators.some((c) => c.version.pre.length > 0)) continue;
    if (comparators.every((c) => satisfiesComparator(v, c))) return true;
  }
  return false;
}

function pickVersion(versions, range) {
  const best = versions
    .filter((v) => satisfies(v, range))
    .sort((a, b) => compare(parseVersion(b), parseVersion(a)));
  return best[0] || null;
}

/* -------------------------------------------------------------------- tar */

function readString(buf, offset, size) {
  const slice = buf.subarray(offset, offset + size);
  const end = slice.indexOf(0);
  return slice.toString('utf8', 0, end === -1 ? slice.length : end).trim();
}

function readOctal(buf, offset, size) {
  const raw = readString(buf, offset, size).replace(/[^0-7]/g, '');
  return raw ? parseInt(raw, 8) : 0;
}

/** Extract a gzipped tar into `destination`, stripping the leading path. */
async function extractTgz(archive, destination, strip = 1) {
  const gz = await readFile(archive);
  const tar = gunzipSync(gz);

  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156]) || '0';
    const prefix = readString(header, 345, 155);
    const rawName = longName ?? `${prefix ? `${prefix}/` : ''}${readString(header, 0, 100)}`;
    longName = null;
    const dataStart = offset + 512;
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = tar.toString('utf8', dataStart, dataStart + size).replace(/\0+$/, '');
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '5') continue; // skip links/others

    const parts = rawName.split('/').filter(Boolean);
    if (parts.length <= strip) continue;
    const target = path.join(destination, ...parts.slice(strip));
    // Refuse to escape the destination.
    if (!target.startsWith(path.resolve(destination))) continue;

    if (type === '5') {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, tar.subarray(dataStart, dataStart + size));
    }
  }
}

/* ----------------------------------------------------------------- install */

const packumentCache = new Map();

async function packument(name) {
  if (!packumentCache.has(name)) {
    const url = `${REGISTRY}/${name.replace('/', '%2f')}`;
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`registry ${name} -> ${response.status}`);
    packumentCache.set(name, await response.json());
  }
  return packumentCache.get(name);
}

function platformOk(manifest) {
  const list = (value) => (Array.isArray(value) ? value : value ? [value] : null);
  const os = list(manifest.os);
  if (os && !os.includes(process.platform) && !os.includes(`!${process.platform}`)) return false;
  const cpu = list(manifest.cpu);
  if (cpu && !cpu.includes(process.arch)) return false;
  return true;
}

async function install(name, range, target, optional) {
  const dest = path.join(target, 'node_modules', ...name.split('/'));
  const marker = path.join(dest, 'package.json');
  if (await exists(marker)) {
    // npm hoists one copy per name; a second, incompatible requirement is a warning,
    // not a failure, which matches npm's own "nested dependency" behaviour closely enough.
    try {
      const installed = JSON.parse(await readFile(marker, 'utf8')).version;
      if (!satisfies(installed, range === 'latest' ? '*' : range)) {
        console.warn(`[deps] ${name}@${installed} already present but "${range}" was requested; keeping ${installed}`);
      }
    } catch {
      /* unreadable marker, keep going */
    }
    return false;
  }

  let meta;
  let version;
  try {
    meta = await packument(name);
    version = pickVersion(Object.keys(meta.versions), range === 'latest' || range === '*' ? '*' : range);
    if (!version) throw new Error(`no version of ${name} matches "${range}"`);
  } catch (err) {
    if (optional) {
      console.warn(`[deps] skipping optional ${name}@${range}: ${err.message}`);
      return false;
    }
    throw err;
  }

  const manifest = meta.versions[version];
  await mkdir(CACHE_DIR, { recursive: true });
  const archive = path.join(CACHE_DIR, `${name.replace(/[@/]/g, '-')}-${version}.tgz`);
  if (!(await exists(archive))) await download(manifest.dist.tarball, archive);

  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await extractTgz(archive, dest, 1);
  console.log(`[deps] ${name}@${version}`);

  const deps = { ...(manifest.dependencies || {}) };
  for (const [dep, depRange] of Object.entries(deps)) {
    await install(dep, depRange, target, optional);
  }
  for (const [dep, depRange] of Object.entries(manifest.optionalDependencies || {})) {
    if (deps[dep]) continue;
    try {
      if (!platformOk(meta.versions[version])) throw new Error('platform mismatch');
      await install(dep, depRange, target, true);
    } catch (err) {
      console.warn(`[deps] optional ${dep}@${depRange} unavailable: ${err.message}`);
    }
  }
  return true;
}

async function main() {
  const target = process.argv[2];
  if (!target) throw new Error('usage: node scripts/install-deps.mjs <plugin-folder>');

  const pkg = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  const deps = pkg.dependencies || {};
  if (!Object.keys(deps).length) {
    console.log('[deps] no runtime dependencies declared');
    return;
  }

  await mkdir(path.join(target, 'node_modules'), { recursive: true });
  for (const [name, range] of Object.entries(deps)) {
    await install(name, range, target, false);
  }
  console.log(`[deps] installed into ${path.join(target, 'node_modules')}`);
}

// Only install when executed directly, so the resolver can be unit tested.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[deps] ${err.message}`);
    process.exitCode = 1;
  });
}