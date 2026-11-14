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
import vm from 'node:vm';

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

// What identifies this build: the commit it was built from (BPC_BUILD_COMMIT,
// or the checked out commit) and a number that grows with every build
// (BPC_BUILD_NUMBER, or the UTC time as YYYYMMDD.H.M, three integers as Apple
// requires of a build number). The Safari diagnostics page shows both, and
// the Xcode project uses the number as the app's build number, so that a
// newer copy of the app always counts as newer (safari/xcode/set-version.mjs).
function buildIdentity(now = new Date()) {
  let commit = process.env.BPC_BUILD_COMMIT || null;
  if (!commit) {
    try {
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      commit = git('rev-parse', 'HEAD') + (git('status', '--porcelain', '--', 'safari', '*.zip') ? '+changes' : '');
    } catch (e) {
      commit = null; // not a git checkout
    }
  }
  const stamp = now.toISOString().replace(/\D/g, ''); // YYYYMMDDHHMMSSmmm
  const number = /^\d+(\.\d+){0,2}$/.test(process.env.BPC_BUILD_NUMBER || '') ? process.env.BPC_BUILD_NUMBER
    : `${stamp.slice(0, 8)}.${Number(stamp.slice(8, 10))}.${Number(stamp.slice(10, 12))}`;
  return { commit, number, builtAt: now.toISOString() };
}

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
  {
    why: 'Safari repeats the install event on every re-enable and omits it at browser start-up; set the defaults once',
    find: /(details\.reason == "install"\) \{\s*)setDefaultOptions\(\);/,
    replace: '$1bpcSafari.firstRun(setDefaultOptions);',
    count: 1,
  },
  {
    why: 'open the options page once during the first start, not once per caller',
    find: 'ext_api.runtime.openOptionsPage()',
    replace: 'bpcSafari.openOptionsPage()',
    count: { min: 1 },
  },
];

// For a few sites the extension injects its content scripts into the page's
// own JavaScript world (world: "MAIN"). Chrome has a `chrome` object there;
// Safari has neither `chrome` nor `browser` in a page, so the first statement
// of those scripts threw and nothing ran. In the page world they now get an
// empty object, which is what they are prepared for (no runtime, no storage),
// and take the Chromium code path like the rest of the Safari build.
const PAGE_WORLD_PATCHES = [
  {
    file: 'contentScript.js',
    why: 'content script: no chrome or browser object in the page world of Safari',
    find: 'var ext_api = chrome || browser;',
    replace: "var ext_api = (typeof chrome === 'object' && chrome) || (typeof browser === 'object' && browser) || {};",
    count: 1,
  },
  {
    file: 'contentScript.js',
    why: 'content script: Chromium code path in the page world too (the user agent of Safari does not say "chrome")',
    find: "var ext_chromium = window.navigator.userAgent.toLowerCase().includes('chrome');",
    replace: 'var ext_chromium = true;',
    count: 1,
  },
  {
    file: 'contentScript_once_var.js',
    why: 'page-world script: no chrome or browser object in the page world of Safari',
    find: "var ext_api = (typeof browser === 'object') ? browser : chrome;",
    replace: "var ext_api = (typeof browser === 'object' && browser) || (typeof chrome === 'object' && chrome) || {};",
    count: 1,
  },
];

// Fixes for sites whose upstream rule no longer works, applied to sites.js.
// Each one is a change to the site's rule, written with the options the
// extension already has (block_regex, cs_code), and must match exactly once:
// when upstream changes the rule, the build fails and the fix is looked at
// again (it may no longer be needed).
export const SITE_FIXES = [
  {
    site: 'thehill.com',
    why: 'The Hill: the Hill Insider paywall (2026) is a dialog over the full article; block the script that opens it, hide it and let the page scroll',
    // The whole article is in the page. The Nexstar login-registration plugin
    // opens #login-registration-paywall over it on articles marked
    // body.is-premium and stops the page from scrolling.
    find: /("The Hill": \{\r?\n\s*domain: "thehill\.com",\r?\n\s*allow_cookies: 1,\r?\n\s*)block_regex: \/\\\.tinypass\\\.com\\\/\/(\r?\n)/,
    replace: '$1block_regex: /(\\.tinypass\\.com\\/|\\/lakana\\/inc\\/blueconic\\/scripts\\/login-registration-bc-wall\\.js)/,$2' +
      '    cs_code: [{add_style: "' + [
        '#login-registration-paywall{display:none !important}',
        // The page cannot be scrolled while the dialog is open.
        'html:has(#login-registration-paywall:not([hidden])),body:has(#login-registration-paywall:not([hidden])),html:has(body.is-premium),body.is-premium' +
          '{overflow:auto !important;position:static !important;height:auto !important}',
        'body.is-premium #aria-dialog-overlay{display:none !important}',
        // In case the text is shortened or veiled while the dialog is open.
        'body.is-premium .article__text{max-height:none !important;overflow:visible !important;filter:none !important;-webkit-mask-image:none !important;mask-image:none !important}',
        'body.is-premium .article__text p{display:block !important;visibility:visible !important;opacity:1 !important;filter:none !important}',
      ].join(' ') + '"}]$2',
    count: 1,
  },
];

// sites.js with the site fixes applied (the tests compare against this).
export function applySiteFixes(text) {
  for (const fix of SITE_FIXES) text = patch(text, 'sites.js', fix).text;
  return text;
}

// Appended to background.js: puts right a site list stored by an earlier
// Safari build, then does the first-time setup when no install event arrived
// (the extension was first loaded while Safari was starting).
const BACKGROUND_APPENDIX = `
// Safari build: see bpcSafari.repairSiteNames and bpcSafari.firstRun in safari-compat.js.
setTimeout(function () {
  bpcSafari.repairSiteNames(defaultSites).then(function () {
    bpcSafari.firstRun(setDefaultOptions);
  });
}, 1500);
`;

// Released Safari versions read the scripts of the background page as Latin-1:
// the page WebKit generates for "background.scripts" declares no character
// set there. The site names with accented letters in sites.js arrived garbled
// ("TÃ©lÃ©rama.fr"); the options page, which reads the same file as UTF-8,
// then no longer recognised those sites and saved the list without them.
// A script without non-ASCII characters reads the same in every encoding, so
// the scripts of the Safari build spell such characters as \uXXXX escapes.
// In this code base they only occur in string and regular expression literals
// (and comments), where the escape means the same; the build checks that
// every rewritten script still parses.
export function asciiJs(source) {
  return source.replace(/^\ufeff/, '').replace(/(\\*)([^\x00-\x7f])/gu, (match, slashes, ch) => {
    let escaped = '';
    for (let i = 0; i < ch.length; i++) escaped += '\\u' + ch.charCodeAt(i).toString(16).padStart(4, '0');
    // An odd number of backslashes escapes the character itself: "\é" is "é".
    return (slashes.length % 2 ? slashes.slice(1) : slashes) + escaped;
  });
}

function parses(code) {
  try {
    new vm.Script(code);
    return true;
  } catch (e) {
    return false;
  }
}

// Rewrites every script in dir that has non-ASCII characters (see asciiJs).
// The background scripts must come out ASCII-only; any other script that
// cannot be checked or rewritten safely is left as it is (Safari reads the
// scripts it injects into pages as UTF-8) and reported.
function asciiScripts(dir, required) {
  const done = [];
  const kept = [];
  for (const file of walk(dir).filter((f) => f.endsWith('.js'))) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    if (!/[^\x00-\x7f]/.test(text)) continue;
    const ascii = asciiJs(text);
    const isBackground = required.includes(rel);
    const checkable = parses(text); // otherwise nothing can be said about the rewritten script
    const sound = parses(ascii);
    if (isBackground && checkable && !sound)
      throw new Error(`${rel} has non-ASCII characters outside of string literals, which Safari's background page would misread; update safari/build.mjs`);
    if (!isBackground && !(checkable && sound)) {
      kept.push(rel);
      continue;
    }
    fs.writeFileSync(file, ascii);
    done.push(rel);
  }
  return { done, kept };
}

function transformManifest(manifest) {
  const m = structuredClone(manifest);
  if (m.manifest_version !== 3) throw new Error(`expected a manifest v3 source, got v${m.manifest_version}`);
  // Event page instead of a service worker: Safari supports both, but only a
  // page has DOMParser, which replaces Chrome's offscreen document.
  // persistent: false is explicit because iOS/iPadOS only run non-persistent
  // background pages; without it Apple's converter warns that the extension
  // will not run on iOS. (The Xcode 16 converter then lists `persistent` as
  // an unsupported MV3 key, which is harmless: false is the MV3 default.)
  m.background = { scripts: ['safari-compat.js', 'sites.js', 'background.js'], persistent: false };
  // Chrome-only keys. `key` is kept on purpose: its presence selects the
  // extension's Chromium code paths (ext_chromium), which match Safari's MV3
  // APIs best; Safari ignores it.
  delete m.minimum_chrome_version;
  delete m.incognito; // "split" is not supported; Safari always uses spanning mode
  m.permissions = (m.permissions || []).filter((p) => p !== 'offscreen');
  // Chrome's declarativeNetRequestWithHostAccess limits every rule to sites the
  // user granted; plain declarativeNetRequest lets block rules work without it
  // (header rules and content scripts still need site access in Safari).
  if (!m.permissions.includes('declarativeNetRequest')) m.permissions.push('declarativeNetRequest');
  // Lets the compat layer see a navigation that gets no answer: a site that
  // refuses the Googlebot user agent Safari cannot back up with Googlebot's
  // address (see "Finding the sites that refuse a crawler" in safari-compat.js).
  if (!m.permissions.includes('webNavigation')) m.permissions.push('webNavigation');
  // Safari always opens the options page in a tab and flags this key as unsupported.
  if (m.options_ui) delete m.options_ui.open_in_tab;
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
    if (!/\bfunction setDefaultOptions\(\)/.test(bg))
      throw new Error('background.js: setDefaultOptions() not found; upstream code changed, update safari/build.mjs');
    bg += BACKGROUND_APPENDIX;
    fs.writeFileSync(bgFile, bg);

    for (const p of PAGE_WORLD_PATCHES) {
      const file = path.join(args.out, p.file);
      const res = patch(fs.readFileSync(file, 'utf8'), p.file, p);
      fs.writeFileSync(file, res.text);
      applied.push({ patch: p.why, matches: res.matches });
    }

    // Site rules that need a fix (see SITE_FIXES).
    const sitesFile = path.join(args.out, 'sites.js');
    let sitesText = fs.readFileSync(sitesFile, 'utf8');
    for (const fix of SITE_FIXES) {
      const res = patch(sitesText, 'sites.js', fix);
      sitesText = res.text;
      applied.push({ patch: fix.why, matches: res.matches, site: fix.site });
    }
    fs.writeFileSync(sitesFile, sitesText);

    // Popup: link to the Safari diagnostics page.
    const popupFile = path.join(args.out, 'options', 'popup.html');
    const popup = patch(fs.readFileSync(popupFile, 'utf8'), 'options/popup.html', {
      find: '</body>',
      replace: '<div><a href="#" id="bpc_safari_diag">Safari 诊断 / diagnostics</a></div>\n<script src="/safari-popup.js"></script>\n</body>',
      count: 1,
    });
    fs.writeFileSync(popupFile, popup.text);
    applied.push({ patch: 'popup links to the Safari diagnostics page', matches: popup.matches });

    // lib/empty.js is injected before contentScript.js on most sites; give it
    // content so that no browser treats it as a missing script.
    const emptyLib = path.join(args.out, 'lib', 'empty.js');
    if (fs.existsSync(emptyLib) && !fs.readFileSync(emptyLib, 'utf8').trim())
      fs.writeFileSync(emptyLib, '/* intentionally empty (Safari build) */\n');

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

    for (const file of ['safari-compat.js', 'safari-popup.js', 'safari-diagnostics.html', 'safari-diagnostics.js'])
      fs.copyFileSync(path.join(here, 'src', file), path.join(args.out, file));
    const safariManifest = transformManifest(manifest);
    fs.writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify(safariManifest, null, 2) + '\n');
    const ascii = asciiScripts(args.out, safariManifest.background.scripts);

    const info = {
      name: manifest.name,
      version: manifest.version,
      build: buildIdentity(),
      source: path.basename(args.src),
      sourceSha256: fs.statSync(args.src).isFile() ? sha256(args.src) : null,
      domPurify: purify,
      patches: applied,
      asciiScripts: ascii.done,
      nonAsciiScripts: ascii.kept,
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
    console.log(`  build ${res.info.build.number}, commit ${res.info.build.commit || 'unknown'}`);
    for (const p of res.info.patches) console.log(`  patched (${p.matches}x): ${p.patch}`);
    console.log(`  DOMPurify: ${res.info.domPurify}`);
    console.log(`  rewritten without non-ASCII characters: ${res.info.asciiScripts.join(', ') || 'none'}`);
    if (res.info.nonAsciiScripts.length) console.log(`  left with non-ASCII characters: ${res.info.nonAsciiScripts.join(', ')}`);
    if (res.zip) console.log(`  zip: ${path.relative(process.cwd(), res.zip)}`);
  } catch (e) {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  }
}
