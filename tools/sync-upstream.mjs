#!/usr/bin/env node
// Brings the release files of upstream's bpc_uploads into this repository.
//
//   node tools/sync-upstream.mjs [--upstream <url>] [--branch main] [--check]
//                                [--message <file>] [--json <file>]
//
// Upstream publishes every release as one "Release latest" commit and rewrites
// its history each time, so there is nothing to merge. This compares the
// release files of upstream's commit (its top-level *.crx, *.xpi and *.zip
// files and release-hashes.txt) with the ones here; when they differ it puts
// upstream's into the working tree and the index and removes the ones upstream
// no longer has. The caller commits (--message gets the commit message).
//
// Nothing else is taken from upstream: not its README, no directory, no other
// kind of file. An upstream commit can therefore never add or change a
// workflow or a script of this repository, which matters because
// .github/workflows/upstream-sync.yml runs this unattended.
//
// --check only reports. The exit status is 0 whether or not something changed;
// see the report, the JSON file, or the GITHUB_OUTPUT values changed, version,
// previous_version and upstream.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const UPSTREAM_URL = 'https://gitflic.ru/project/magnolia1234/bpc_uploads.git';
// The release files: a plain name with one of these endings, at the top level.
export const RELEASE_FILE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\.(?:crx|xpi|zip)|release-hashes\.txt)$/;
// The Safari and Chrome builds are made from these two.
export const CHROME_ZIP = 'bypass-paywalls-chrome-clean-master.zip';
export const REQUIRED = [CHROME_ZIP, 'bypass-paywalls-firefox-clean-master.zip'];
// What upstream has besides release files and is expected to.
const EXPECTED_OTHERS = ['README.md'];
const MAX_BYTES = 30 * 1024 * 1024; // a release file is about 0.3 MB
const MAX_FILES = 60;
const LOCAL_REF = 'refs/upstream-sync/head';

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Fetches upstream's branch into a ref of its own and returns the commit.
function fetchUpstream(dir, url, branch, { attempts = 3, pause = 5000 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (i) sleep(pause * i);
    try {
      git(dir, ['fetch', '--quiet', '--no-tags', '--force', url, `+refs/heads/${branch}:${LOCAL_REF}`]);
      return git(dir, ['rev-parse', '--verify', `${LOCAL_REF}^{commit}`]).trim();
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`could not fetch ${branch} from ${url}: ${String(last && (last.stderr || last.message)).trim().split('\n').pop()}`);
}

// The top-level entries of a commit: [{ mode, type, sha, size, name }].
function topLevel(dir, commit) {
  return git(dir, ['ls-tree', '-l', '-z', commit]).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, sha, size] = line.slice(0, tab).split(/ +/);
    return { mode, type, sha, size: size === '-' ? null : Number(size), name: line.slice(tab + 1) };
  });
}

const isFile = (e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755');

// Text of upstream's that ends up in a commit message, a log or on a web page:
// plain lines without anything GitHub would turn into a mention, markup or a
// workflow command.
export function plainLines(text, { maxLines = 40, maxLength = 160 } = {}) {
  const lines = String(text).split(/\r?\n/)
    .map((l) => l.replace(/[^\x20-\x7e -ɏ]/g, ' ').replace(/[`<>]/g, "'").replace(/@/g, '(at)').replace(/::/g, ': :').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((l) => (l.length > maxLength ? l.slice(0, maxLength - 3) + '...' : l));
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more)`] : lines;
}

// The version and the newest part of the changelog of a Chrome release zip.
export function chromeRelease(zip) {
  const unzip = (args) => execFileSync('unzip', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const names = unzip(['-Z1', zip]).split('\n');
  const manifests = names.filter((n) => /^[A-Za-z0-9._-]+\/manifest\.json$/.test(n));
  if (manifests.length !== 1) throw new Error(`expected one top-level manifest.json in ${path.basename(zip)}, found ${manifests.length}`);
  const version = JSON.parse(unzip(['-p', zip, manifests[0]])).version;
  if (typeof version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`unexpected version in ${path.basename(zip)}: ${JSON.stringify(version)}`);
  const changelogName = manifests[0].replace(/manifest\.json$/, 'changelog.txt');
  return { version, changelog: names.includes(changelogName) ? newestChanges(unzip(['-p', zip, changelogName])) : [] };
}

// The same for a zip that is stored in the repository as the given blob.
function chromeReleaseOfBlob(dir, blob) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-sync-'));
  try {
    const zip = path.join(tmp, CHROME_ZIP);
    fs.writeFileSync(zip, git(dir, ['cat-file', 'blob', blob], { encoding: 'buffer' }));
    return chromeRelease(zip);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The first section of upstream's changelog.txt: the lines under its first
// heading ("Post-release" or "* v4.4.9.0 (date)"), up to the next heading.
export function newestChanges(changelog) {
  const lines = String(changelog).split(/\r?\n/);
  const isHeading = (l) => /^(Post-release\b|\* v\d)/.test(l);
  const start = lines.findIndex(isHeading);
  if (start < 0) return [];
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (isHeading(line)) break;
    section.push(line);
  }
  return plainLines(section.join('\n'), { maxLines: 200 });
}

// Compares upstream with the checked out commit. Changes nothing in the
// working tree (it does fetch upstream's commit into the repository).
export function planSync({ dir = repo, upstream = UPSTREAM_URL, branch = 'main', maxBytes = MAX_BYTES, fetch = {} } = {}) {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error(`unexpected branch name ${JSON.stringify(branch)}`);
  const commit = fetchUpstream(dir, upstream, branch, fetch);
  const theirs = new Map();
  const ignored = [];
  for (const e of topLevel(dir, commit)) {
    if (!RELEASE_FILE.test(e.name)) {
      if (!EXPECTED_OTHERS.includes(e.name)) ignored.push(`${e.name} (${e.type === 'tree' ? 'a directory' : 'not a release file'})`);
    } else if (!isFile(e)) ignored.push(`${e.name} (${e.mode === '120000' ? 'a symbolic link' : `not a regular file, mode ${e.mode}`})`);
    else if (e.size > maxBytes) throw new Error(`upstream's ${e.name} is ${e.size} bytes, more than a release file can be`);
    else theirs.set(e.name, e.sha);
  }
  for (const name of REQUIRED) if (!theirs.has(name)) throw new Error(`upstream has no ${name}`);
  if (theirs.size > MAX_FILES) throw new Error(`upstream has ${theirs.size} release files, more than expected`);

  const ours = new Map(topLevel(dir, 'HEAD').filter((e) => RELEASE_FILE.test(e.name) && e.type === 'blob').map((e) => [e.name, e.sha]));
  const added = [...theirs.keys()].filter((n) => !ours.has(n)).sort();
  const updated = [...theirs.keys()].filter((n) => ours.has(n) && ours.get(n) !== theirs.get(n)).sort();
  const removed = [...ours.keys()].filter((n) => !theirs.has(n)).sort();
  const changed = added.length + updated.length + removed.length > 0;

  const next = chromeReleaseOfBlob(dir, theirs.get(CHROME_ZIP));
  let previous = { version: null, changelog: [] };
  if (ours.has(CHROME_ZIP)) {
    try {
      previous = chromeReleaseOfBlob(dir, ours.get(CHROME_ZIP));
    } catch (e) {
      // what is here now does not matter for what upstream has
    }
  }
  const newChanges = next.changelog.filter((l) => !previous.changelog.includes(l));
  return {
    changed, upstream: commit, version: next.version, previousVersion: previous.version,
    added, updated, removed, ignored, changes: newChanges, blobs: Object.fromEntries(theirs),
  };
}

// Puts the planned changes into the working tree and the index.
export function applySync(plan, { dir = repo } = {}) {
  if (plan.removed.length) git(dir, ['rm', '--quiet', '-f', '--', ...plan.removed]);
  for (const name of [...plan.added, ...plan.updated]) {
    if (!RELEASE_FILE.test(name)) throw new Error(`not a release file: ${name}`);
    const file = path.join(dir, name);
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, git(dir, ['cat-file', 'blob', plan.blobs[name]], { encoding: 'buffer' }), { mode: 0o644 });
    git(dir, ['update-index', '--add', '--cacheinfo', `100644,${plan.blobs[name]},${name}`]);
  }
  // Exactly the planned files are staged, and the working tree agrees with the index.
  const staged = git(dir, ['diff', '--cached', '--no-renames', '--name-only', '-z']).split('\0').filter(Boolean).sort();
  const planned = [...plan.added, ...plan.updated, ...plan.removed].sort();
  if (JSON.stringify(staged) !== JSON.stringify(planned)) throw new Error(`staged ${JSON.stringify(staged)}, planned ${JSON.stringify(planned)}`);
  const unstaged = git(dir, ['diff', '--no-renames', '--name-only', '-z', '--', ...planned]).split('\0').filter(Boolean);
  if (unstaged.length) throw new Error(`the working tree differs from the index: ${unstaged.join(', ')}`);
}

export function commitMessage(plan) {
  const from = plan.previousVersion && plan.previousVersion !== plan.version ? `, from ${plan.previousVersion}` : '';
  const lines = [
    `Sync with upstream bpc_uploads (${plan.version})`,
    '',
    `The release files are those of upstream's current "Release latest"`,
    `commit (${plan.upstream.slice(0, 7)}${from}), taken as a plain commit because upstream`,
    'rewrites its history for every release.',
  ];
  if (plan.changes.length) lines.push('', "New in upstream's changelog:", ...plan.changes.map((l) => `  ${l}`));
  if (plan.ignored.length) lines.push('', 'Not taken from upstream:', ...plainLines(plan.ignored.join('\n')).map((l) => `  ${l}`));
  lines.push('', 'Synced by tools/sync-upstream.mjs.');
  return lines.join('\n') + '\n';
}

function report(plan, check) {
  const out = [];
  if (!plan.changed) out.push(`Up to date with upstream ${plan.upstream.slice(0, 7)} (${plan.version}).`);
  else {
    out.push(`Upstream ${plan.upstream.slice(0, 7)} has ${plan.version}${plan.previousVersion ? ` (here: ${plan.previousVersion})` : ''}${check ? '' : '; its release files are staged'}.`);
    for (const [label, names] of [['added', plan.added], ['updated', plan.updated], ['removed', plan.removed]])
      if (names.length) out.push(`  ${label}: ${names.join(', ')}`);
    if (plan.changes.length) out.push("  new in upstream's changelog:", ...plan.changes.map((l) => `    ${l}`));
  }
  if (plan.ignored.length) out.push('  not taken from upstream:', ...plainLines(plan.ignored.join('\n')).map((l) => `    ${l}`));
  return out.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = { check: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--check') args.check = true;
    else if (['--upstream', '--branch', '--message', '--json'].includes(a)) args[a.slice(2)] = process.argv[++i];
    else {
      console.error(`unknown argument ${a}`);
      process.exit(2);
    }
  }
  try {
    const plan = planSync({ upstream: args.upstream || UPSTREAM_URL, branch: args.branch || 'main' });
    if (plan.changed && !args.check) applySync(plan);
    console.log(report(plan, args.check));
    if (args.message) fs.writeFileSync(args.message, commitMessage(plan));
    if (args.json) fs.writeFileSync(args.json, JSON.stringify({ ...plan, blobs: undefined }, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${plan.changed}\nversion=${plan.version}\nprevious_version=${plan.previousVersion || ''}\nupstream=${plan.upstream}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + report(plan, args.check) + '\n```\n');
  } catch (e) {
    console.error(`sync failed: ${e.message}`);
    process.exit(1);
  }
}
