#!/usr/bin/env node
// Builds a Safari Web Extension folder from the Chrome (MV3) release of
// Bypass Paywalls Clean that is stored in this repository.
//
//   node safari/build.mjs [--src <chrome zip|dir>] [--firefox <firefox zip>]
//                         [--out <dir>] [--zip]
//
// The output folder can be loaded in Safari directly (Safari 18+:
// Develop > Developer Settings > Add Temporary Extension) or wrapped in an
// app with `xcrun safari-web-extension-converter` (see safari/README.md).
//
// Every source patch must match the expected number of times; when upstream
// code changes in a way the patches no longer fit, the build fails instead of
// producing a broken extension.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

function parseArgs(argv) {
  const args = {
    src: path.join(repo, 'bypass-paywalls-chrome-clean-master.zip'),
    firefox: path.join(repo, 'bypass-paywalls-firefox-clean-master.zip'),
    out: path.join(repo, 'build', 'safari', 'extension'),
    zip: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip') args.zip = true;
    else if (['--src', '--firefox', '--out'].includes(a)) args[a.slice(2)] = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function unzipTo(zip, dir) {
  execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: ['ignore', 'ignore', 'inherit'] });
}

// The release zips contain a single top-level folder.
function singleRoot(dir) {
  const entries = fs.readdirSync(dir).filter((e) => !e.startsWith('__MACOSX'));
  if (entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory()) return path.join(dir, entries[0]);
  return dir;
}

function extract(src, tmp, name) {
  if (fs.statSync(src).isDirectory()) return src;
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  unzipTo(src, dir);
  return singleRoot(dir);
}

function patch(text, file, { find, replace, count }) {
  const isRegex = find instanceof RegExp;
  const matches = isRegex ? [...text.matchAll(new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g'))].length
    : text.split(find).length - 1;
  const ok = typeof count === 'number' ? matches === count : matches >= count.min;
  if (!ok) {
    const want = typeof count === 'number' ? count : `>= ${count.min}`;
    throw new Error(`${file}: patch expected ${want} match(es) of ${find} but found ${matches}; upstream code changed, update safari/build.mjs`);
  }
  const out = isRegex ? text.replace(new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g'), replace)
    : text.split(find).join(replace);
  return { text: out, matches };
}

const BACKGROUND_PATCHES = [
  {
    why: 'Safari runs the background as a page: sites.js is loaded by the manifest, importScripts does not exist',
    find: "self.importScripts('sites.js');",
    replace: "if (typeof self.importScripts === 'function') self.importScripts('sites.js');",
    count: 1,
  },
  {
    why: 'management.getSelf() is not available in Safari',
    find: 'ext_api.management.getSelf(',
    replace: 'bpcSafari.getSelf(',
    count: { min: 1 },
  },
  {
    why: 'Safari accepts a subset of declarativeNetRequest rules; adapt them before applying',
    find: 'ext_api.declarativeNetRequest.updateSessionRules(',
    replace: 'bpcSafari.updateSessionRules(',
    count: { min: 1 },
  },
  {
    why: 'Safari has no offscreen documents; parse the fetched article in the background page instead',
    find: "sendMessageToOffscreenDocument('getExtSrc_dom', message.data)",
    replace: 'bpcSafari.offscreenParse(message.data).then(function (data) { sendArticleSrc(data.tab_id, {data: data}); })',
    count: 1,
  },
];

function transformManifest(manifest) {
  const m = structuredClone(manifest);
  if (m.manifest_version !== 3) throw new Error(`expected a manifest v3 source, got v${m.manifest_version}`);
  // Event page instead of a service worker: Safari supports both, but only a
  // page has DOMParser, which replaces Chrome's offscreen document.
  m.background = { scripts: ['safari-compat.js', 'sites.js', 'background.js'] };
  // Chrome-only keys. `key` is kept on purpose: its presence selects the
  // extension's Chromium code paths (ext_chromium), which match Safari's MV3
  // APIs best; Safari ignores it.
  delete m.minimum_chrome_version;
  delete m.incognito; // "split" is not supported; Safari always uses spanning mode
  m.permissions = (m.permissions || []).filter((p) => p !== 'offscreen');
  m.action = { ...(m.action || {}), default_icon: { 128: 'bypass.png' } };
  return m;
}

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const rel = path.relative(skip.root, path.join(from, entry.name)).split(path.sep).join('/');
    if (skip.paths.has(rel)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst, skip);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

export function build(options = {}) {
  const args = { ...parseArgs(['', '']), ...options };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-safari-'));
  try {
    const chromeDir = extract(args.src, tmp, 'chrome');
    const manifest = JSON.parse(fs.readFileSync(path.join(chromeDir, 'manifest.json'), 'utf8'));

    fs.rmSync(args.out, { recursive: true, force: true });
    copyDir(chromeDir, args.out, {
      root: chromeDir,
      // Chrome's offscreen document is replaced by bpcSafari.offscreenParse().
      paths: new Set(['options/offscreen.html', 'options/offscreen.js']),
    });

    // background.js
    const bgFile = path.join(args.out, 'background.js');
    let bg = fs.readFileSync(bgFile, 'utf8');
    const applied = [];
    for (const p of BACKGROUND_PATCHES) {
      const res = patch(bg, 'background.js', p);
      bg = res.text;
      applied.push({ patch: p.why, matches: res.matches });
    }
    fs.writeFileSync(bgFile, bg);

    // No other script may rely on APIs Safari lacks.
    for (const file of walk(args.out).filter((f) => f.endsWith('.js'))) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(args.out, file);
      for (const api of ['ext_api.management.', 'chrome.management.', 'ext_api.offscreen.createDocument', 'chrome.offscreen.']) {
        if (rel !== 'background.js' && text.includes(api)) throw new Error(`${rel} uses ${api}, which Safari does not provide`);
      }
    }
    if (/ext_api\.management\./.test(bg)) throw new Error('background.js still calls ext_api.management');

    // Real DOMPurify from the Firefox release instead of Chrome's no-op stub.
    let purify = 'chrome stub (Firefox zip not found)';
    if (args.firefox && fs.existsSync(args.firefox)) {
      const ffDir = extract(args.firefox, tmp, 'firefox');
      const ffPurify = path.join(ffDir, 'lib', 'purify.min.js');
      if (fs.existsSync(ffPurify) && fs.readFileSync(ffPurify, 'utf8').includes('DOMPurify')) {
        fs.copyFileSync(ffPurify, path.join(args.out, 'lib', 'purify.min.js'));
        purify = (/DOMPurify (\d+\.\d+\.\d+)/.exec(fs.readFileSync(ffPurify, 'utf8')) || [, 'unknown'])[1];
      }
    }

    fs.copyFileSync(path.join(here, 'src', 'safari-compat.js'), path.join(args.out, 'safari-compat.js'));
    const safariManifest = transformManifest(manifest);
    fs.writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify(safariManifest, null, 2) + '\n');

    const info = {
      name: manifest.name,
      version: manifest.version,
      source: path.basename(args.src),
      sourceSha256: fs.statSync(args.src).isFile() ? sha256(args.src) : null,
      domPurify: purify,
      patches: applied,
    };
    fs.writeFileSync(path.join(args.out, 'safari-build.json'), JSON.stringify(info, null, 2) + '\n');

    let zipFile = null;
    if (args.zip) {
      zipFile = path.join(path.dirname(args.out), `bypass-paywalls-clean-safari-${manifest.version}.zip`);
      fs.rmSync(zipFile, { force: true });
      execFileSync('zip', ['-q', '-r', '-X', zipFile, '.'], { cwd: args.out });
    }
    return { out: args.out, zip: zipFile, info };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const res = build(parseArgs(process.argv));
    console.log(`Safari extension ${res.info.version} written to ${path.relative(process.cwd(), res.out) || '.'}`);
    for (const p of res.info.patches) console.log(`  patched (${p.matches}x): ${p.patch}`);
    console.log(`  DOMPurify: ${res.info.domPurify}`);
    if (res.zip) console.log(`  zip: ${path.relative(process.cwd(), res.zip)}`);
  } catch (e) {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  }
}
