#!/usr/bin/env node
// Builds the Chrome release with the site fixes of this repository applied:
// the upstream Chrome zip, with only sites.js changed (SITE_FIXES in
// safari/build.mjs) and a version name that says so.
//
//   node chrome/build.mjs [--src <chrome zip>] [--out <dir>]
//
// Writes <out>/bypass-paywalls-chrome-clean-<version>-fixed.zip, with the same
// single top-level folder as the upstream zip; install it like upstream's
// (unzip, chrome://extensions, Developer mode, Load unpacked).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_FIXES, applySiteFixes } from '../safari/build.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildChrome(options = {}) {
  const src = options.src || path.join(repo, 'bypass-paywalls-chrome-clean-master.zip');
  const out = options.out || path.join(repo, 'build', 'chrome');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-chrome-'));
  try {
    execFileSync('unzip', ['-q', src, '-d', tmp], { stdio: ['ignore', 'ignore', 'inherit'] });
    const roots = fs.readdirSync(tmp);
    if (roots.length !== 1) throw new Error(`expected one folder in ${src}, found ${roots.join(', ')}`);
    const root = path.join(tmp, roots[0]);

    // sites.js: fails if a fix no longer matches upstream exactly once.
    const sitesFile = path.join(root, 'sites.js');
    fs.writeFileSync(sitesFile, applySiteFixes(fs.readFileSync(sitesFile, 'utf8')));

    // manifest.json: same version (so upstream's update notice still works), a version name that tells the copies apart.
    const manifestFile = path.join(root, 'manifest.json');
    const manifestText = fs.readFileSync(manifestFile, 'utf8');
    const manifest = JSON.parse(manifestText);
    const versionName = `${manifest.version} (site fixes: ${SITE_FIXES.map((f) => f.site).join(', ')})`;
    const versionLine = /("version": "[^"]+")(,?\r?\n)/;
    if (!versionLine.test(manifestText)) throw new Error('manifest.json: version line not found');
    fs.writeFileSync(manifestFile, manifestText.replace(versionLine, `$1,$2  "version_name": ${JSON.stringify(versionName)}$2`));
    JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

    fs.mkdirSync(out, { recursive: true });
    const zip = path.join(out, `bypass-paywalls-chrome-clean-${manifest.version}-fixed.zip`);
    fs.rmSync(zip, { force: true });
    execFileSync('zip', ['-q', '-r', '-X', zip, roots[0]], { cwd: tmp });
    return { zip, version: manifest.version, versionName, fixes: SITE_FIXES.map((f) => f.site) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  try {
    const res = buildChrome(args);
    console.log(`Chrome extension ${res.versionName} written to ${path.relative(process.cwd(), res.zip)}`);
  } catch (e) {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  }
}
