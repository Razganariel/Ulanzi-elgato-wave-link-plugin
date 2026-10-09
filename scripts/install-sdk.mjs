/**
 * Fetches the two official Ulanzi SDK pieces into ./sdk:
 *
 *   sdk/ulanzi-api     <- UlanziTechnology/plugin-common-node  (main service)
 *   sdk/common-html    <- UlanziTechnology/plugin-common-html  (property inspector)
 *
 * Both are standalone repos on purpose: inside UlanziDeckPlugin-SDK they are
 * declared as git submodules, so the main archive ships them as empty folders.
 *
 * No npm/git required: plain HTTPS download plus the platform archiver.
 * Re-run is cheap, an existing up-to-date copy is kept unless --force is passed.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_DIR = path.join(ROOT, 'sdk');
const CACHE_DIR = path.join(SDK_DIR, '.cache');

const SOURCES = [
  {
    id: 'plugin-common-node',
    url: 'https://codeload.github.com/UlanziTechnology/plugin-common-node/zip/refs/heads/main',
    out: path.join(SDK_DIR, 'ulanzi-api'),
    keep: () => ['index.js', 'libs', 'apiTypes.d.ts'],
  },
  {
    id: 'plugin-common-html',
    url: 'https://codeload.github.com/UlanziTechnology/plugin-common-html/zip/refs/heads/main',
    out: path.join(SDK_DIR, 'common-html'),
    keep: () => ['js', 'css', 'assets'],
  },
];

const REQUIRED = [
  path.join(SDK_DIR, 'ulanzi-api', 'index.js'),
  path.join(SDK_DIR, 'ulanzi-api', 'libs', 'ulanziApi.js'),
  path.join(SDK_DIR, 'common-html', 'js', 'ulanziApi.js'),
  path.join(SDK_DIR, 'common-html', 'js', 'utils.js'),
  path.join(SDK_DIR, 'common-html', 'js', 'eventEmitter.js'),
  path.join(SDK_DIR, 'common-html', 'js', 'timers.js'),
  path.join(SDK_DIR, 'common-html', 'js', 'constants.js'),
  path.join(SDK_DIR, 'common-html', 'css', 'uspi.css'),
];

const force = process.argv.includes('--force');

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

async function extract(archive, destination) {
  await mkdir(destination, { recursive: true });
  if (process.platform === 'win32') {
    await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`]);
  } else {
    await run('unzip', ['-q', '-o', archive, '-d', destination]);
  }
}

async function copy(from, to) {
  await run(process.platform === 'win32' ? 'powershell' : 'cp', process.platform === 'win32'
    ? ['-NoProfile', '-Command', `Copy-Item -LiteralPath '${from}' -Destination '${to}' -Recurse -Force`]
    : ['-R', from, to]);
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });

  for (const source of SOURCES) {
    if (!force && (await exists(path.join(source.out, '.installed')))) {
      console.log(`[sdk] ${source.id} already present, skipping (use --force to refresh)`);
      continue;
    }

    console.log(`[sdk] downloading ${source.id}`);
    const archive = path.join(CACHE_DIR, `${source.id}.zip`);
    const staging = path.join(CACHE_DIR, `${source.id}-unpacked`);
    await rm(staging, { recursive: true, force: true });
    await rm(source.out, { recursive: true, force: true });

    await download(source.url, archive);
    await extract(archive, staging);

    // Zip archives keep everything under <repo>-main/
    const [root] = await readdir(staging);
    const repoRoot = path.join(staging, root);

    await mkdir(source.out, { recursive: true });
    for (const entry of source.keep(repoRoot)) {
      const from = path.join(repoRoot, entry);
      if (!(await exists(from))) {
        console.warn(`[sdk] ${source.id}: missing ${entry}, skipped`);
        continue;
      }
      await copy(from, path.join(source.out, entry));
    }

    await writeFile(path.join(source.out, '.installed'), new Date().toISOString());
    console.log(`[sdk] ${source.id} -> ${path.relative(ROOT, source.out)}`);
  }

  for (const required of REQUIRED) {
    if (!(await exists(required))) {
      console.error(`[sdk] missing ${path.relative(ROOT, required)} - re-run with --force`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`[sdk] ready. Downloaded archives kept in ${path.relative(ROOT, CACHE_DIR)}`);
}

main().catch((err) => {
  console.error(`[sdk] ${err.message}`);
  process.exitCode = 1;
});
