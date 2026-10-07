/**
 * Assembles the installable plugin folder:
 *
 *   release/<pluginUUID>.ulanziPlugin/
 *     manifest.json, package.json, images/, property-inspector/
 *     service/          <- the Node.js main service (CodePath)
 *     ulanzi-api/       <- official plugin-common-node SDK
 *     libs/js|css/      <- official plugin-common-html SDK for the property inspectors
 *     assets/           <- icons required by uspi.css
 *     node_modules/     <- ws
 *
 * Run `npm run sdk` first, then `npm run build`.
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'plugin');
const SDK = path.join(ROOT, 'sdk');
// MSVC leaves its intermediates next to a source tree it compiled; they must
// never ship. Harmless when the plugin has no compiled sources.
const BUILD_ARTEFACTS = /\.(obj|pdb|ilk|exp|lib)$/i;
const skipInstall = process.argv.includes('--skip-install');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Every .js file under dir, recursively. */
async function collectJs(dir) {
  const { readdir } = await import('node:fs/promises');
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collectJs(full)));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

async function requirePath(p, hint) {
  if (await exists(p)) return;
  throw new Error(`missing ${path.relative(ROOT, p)}${hint ? ` - ${hint}` : ''}`);
}

async function main() {
  await requirePath(SOURCE, undefined);
  await requirePath(path.join(SDK, 'ulanzi-api', 'index.js'), 'run "npm run sdk" first');
  await requirePath(path.join(SDK, 'common-html', 'js', 'ulanziApi.js'), 'run "npm run sdk" first');
  await requirePath(path.join(SDK, 'common-html', 'css', 'uspi.css'), 'run "npm run sdk" first');
  await requirePath(path.join(SDK, 'common-html', 'assets'), 'run "npm run sdk" first');

  const manifest = JSON.parse(await readFile(path.join(SOURCE, 'manifest.json'), 'utf8'));
  if (manifest.UUID.split('.').length !== 4) throw new Error(`plugin UUID must have 4 segments, got "${manifest.UUID}"`);

  // Ulanzi convention: the package folder is <pluginUUID>.ulanziPlugin
  const pluginDir = `${manifest.UUID}.ulanziPlugin`;
  const out = path.join(ROOT, 'release', pluginDir);

  for (const action of manifest.Actions) {
    if (action.UUID.split('.').length <= 4) throw new Error(`action UUID must have 5+ segments, got "${action.UUID}"`);
    if (action.UUID !== `${manifest.UUID}.${action.UUID.split('.').pop()}`) {
      throw new Error(`action UUID "${action.UUID}" must be ${manifest.UUID}.<actionName>`);
    }
    for (const state of action.States || []) await requirePath(path.join(SOURCE, state.Image), `state icon of ${action.Name}`);
    if (action.PropertyInspectorPath) await requirePath(path.join(SOURCE, action.PropertyInspectorPath), `inspector of ${action.Name}`);
  }

  console.log(`[build] cleaning ${path.relative(ROOT, out)}`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await cp(SOURCE, out, { recursive: true, filter: (src) => !BUILD_ARTEFACTS.test(path.basename(src)) });
  console.log('[build] plugin sources copied');

  // Property inspector pages live in property-inspector/<action>/inspector.html and
  // reach the SDK through ../../libs, so libs/ and assets/ sit at the plugin root.
  await cp(path.join(SDK, 'ulanzi-api'), path.join(out, 'ulanzi-api'), { recursive: true });
  await cp(path.join(SDK, 'common-html', 'js'), path.join(out, 'libs', 'js'), { recursive: true });
  await cp(path.join(SDK, 'common-html', 'css'), path.join(out, 'libs', 'css'), { recursive: true });
  await cp(path.join(SDK, 'common-html', 'assets'), path.join(out, 'assets'), { recursive: true });
  // install-sdk leaves a freshness marker behind; it has no business shipping.
  await rm(path.join(out, 'ulanzi-api', '.installed'), { force: true });
  console.log('[build] Ulanzi SDK merged (ulanzi-api, libs/js, libs/css, assets)');

  // Every runtime path referenced by the property inspectors must exist in the output.
  const inspectorHtml = [];
  for (const action of manifest.Actions) {
    if (action.PropertyInspectorPath) inspectorHtml.push(path.join(out, action.PropertyInspectorPath));
  }
  for (const file of inspectorHtml) {
    const html = await readFile(file, 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      // shared.js carries a ?v=N cache buster for the inspector WebView, which
      // caches the file while re-reading the HTML. The query is not part of the path.
      const ref = match[1].split(/[?#]/)[0];
      if (/^(?:https?:|data:|#|\/)/.test(ref)) continue;
      const target = path.resolve(path.dirname(file), ref);
      await requirePath(target, `referenced by ${path.relative(out, file)}`);
    }
  }
  console.log('[build] property inspector asset references verified');

  const serviceEntry = path.resolve(out, manifest.CodePath);
  await requirePath(serviceEntry, 'manifest CodePath');
  const sdkEntry = path.resolve(path.dirname(serviceEntry), '..', 'ulanzi-api', 'index.js');
  await requirePath(sdkEntry, 'imported by the main service');
  console.log(`[build] main service ${manifest.CodePath} -> ulanzi-api/index.js`);

  // A syntax error in the service is invisible until the host starts it, and the
  // host only reports it as one line in a log nobody reads: the plugin simply
  // looks like it cannot reach the lamp. Nothing else in this build parses the
  // service, so parse every module here instead.
  const serviceDir = path.join(out, 'service');
  const modules = await collectJs(serviceDir);
  for (const file of modules) {
    try {
      // --check, not an import: the service opens a websocket and owns the radio on
      // load, so the build must parse it, never run it. The package is type=module,
      // so this checks ESM syntax.
      await run(process.execPath, ['--check', file], { maxBuffer: 1024 * 1024 });
    } catch (err) {
      console.error(`[build] ${path.relative(out, file)}`);
      console.error(String(err.stderr || err.message).trim());
      throw new Error('service module does not parse, refusing to ship a plugin that cannot start');
    }
  }
  console.log(`[build] service modules parsed (${modules.length} files)`);

  if (!skipInstall) {
    // No npm required: scripts/install-deps.mjs pulls the tarballs straight from
    // the registry. npm is used when available because it is the reference resolver.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    let usedNpm = false;
    try {
      await run(npm, ['--version'], { cwd: out, maxBuffer: 1024 * 1024 });
      usedNpm = true;
    } catch {
      console.log('[build] npm not available, using the bundled registry fetcher');
    }

    if (usedNpm) {
      console.log('[build] installing runtime dependencies (ws)');
      await run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: out,
        maxBuffer: 1024 * 1024 * 16,
      });
    } else {
      await run(process.execPath, [path.join(ROOT, 'scripts', 'install-deps.mjs'), out], { maxBuffer: 1024 * 1024 * 16 });
    }

    for (const dep of Object.keys(JSON.parse(await readFile(path.join(out, 'package.json'), 'utf8')).dependencies || {})) {
      await requirePath(path.join(out, 'node_modules', ...dep.split('/'), 'package.json'), `runtime dependency ${dep}`);
    }
    console.log('[build] runtime dependencies installed');
  }

  await writeFile(
    path.join(out, 'INSTALL.txt'),
    [
      `${manifest.Name} ${manifest.Version}`,
      '',
      'Copy this whole folder into the UlanziStudio plugins directory as:',
      `  ${pluginDir}`,
      '',
      'Windows: %AppData%\\Ulanzi\\UlanziDeck\\Plugins',
      'macOS:   ~/Library/Application Support/Ulanzi/UlanziDeck/Plugins',
      '',
      'Then restart UlanziStudio.',
      '',
    ].join('\n'),
    'utf8'
  );

  console.log(`[build] done -> ${path.relative(ROOT, out)}`);
}

main().catch((err) => {
  console.error(`[build] ${err.message}`);
  process.exitCode = 1;
});
