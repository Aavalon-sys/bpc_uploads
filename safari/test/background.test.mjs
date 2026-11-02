// Loads the real extension code in a mocked browser and compares the
// declarativeNetRequest rules of the Chrome release with those of the Safari
// build under Safari's constraints.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';
import { runBackground } from './harness.mjs';
import { safariRuleProblems } from './webkit-rules.mjs';
import { findMismatch } from './sampler.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-safari-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const chromeZip = path.join(repo, 'bypass-paywalls-chrome-clean-master.zip');
const chromeRaw = path.join(tmp, 'chrome');
fs.mkdirSync(chromeRaw);
execFileSync('unzip', ['-q', chromeZip, '-d', chromeRaw]);
const chromeDir = path.join(chromeRaw, fs.readdirSync(chromeRaw)[0]);

const safariDir = path.join(tmp, 'safari');
const buildResult = build({ out: safariDir });

const EXTRA_ID_BASE = 10000000;
const baseId = (id) => (id >= EXTRA_ID_BASE ? Math.floor((id - EXTRA_ID_BASE) / 64) : id);
const responseHeadersOnly = (rule) => rule.action.type === 'modifyHeaders' && rule.action.responseHeaders && !(rule.action.requestHeaders || []).length;

let chromeRun;
test('Chrome release: baseline rules in a Chrome-like browser', async () => {
  chromeRun = await runBackground({ extDir: chromeDir, flavor: 'chrome' });
  assert.equal(chromeRun.loadError, null);
  assert.deepEqual(chromeRun.errors, []);
  assert.deepEqual(chromeRun.dnrErrors, []);
  assert.ok(chromeRun.sessionRules.length > 500, `only ${chromeRun.sessionRules.length} rules`);
});

test('Chrome release loaded unchanged in a Safari-like browser installs no rules', async () => {
  // Same code, only the background switched to Safari-style scripts.
  const dir = path.join(tmp, 'chrome-as-is');
  fs.cpSync(chromeDir, dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.background = { scripts: ['sites.js', 'background.js'] };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'background.js'),
    fs.readFileSync(path.join(dir, 'background.js'), 'utf8').replace("self.importScripts('sites.js');", ''));
  const run = await runBackground({ extDir: dir, flavor: 'safari', safariVersion: [18, 4] });
  assert.equal(run.sessionRules.length, 0);
  // Startup stops at management.getSelf() ...
  assert.ok(run.errors.some((e) => /getSelf/.test(String(e))), 'expected the missing management API to break startup');
  // ... and the all-or-nothing rule update is rejected.
  assert.ok(run.dnrErrors.length > 0);
});

test('Safari build: the patched background uses the compat layer', () => {
  const bg = fs.readFileSync(path.join(safariDir, 'background.js'), 'utf8');
  assert.ok(!bg.includes('ext_api.management.'));
  assert.ok(!bg.includes('ext_api.declarativeNetRequest.updateSessionRules('));
  assert.ok(bg.includes('bpcSafari.offscreenParse(message.data)'));
  const manifest = JSON.parse(fs.readFileSync(path.join(safariDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.background, { scripts: ['safari-compat.js', 'sites.js', 'background.js'], persistent: false });
  assert.deepEqual(manifest.options_ui, { page: 'options/options.html' });
  assert.ok(!manifest.permissions.includes('offscreen'));
  assert.equal(manifest.incognito, undefined);
  assert.match(fs.readFileSync(path.join(safariDir, 'lib', 'purify.min.js'), 'utf8'), /DOMPurify \d/);
  assert.equal(buildResult.info.patches.length, 5);
  assert.ok(manifest.permissions.includes('declarativeNetRequest'));
  assert.ok(fs.readFileSync(path.join(safariDir, 'lib', 'empty.js'), 'utf8').trim().length > 0);
  const popup = fs.readFileSync(path.join(safariDir, 'options', 'popup.html'), 'utf8');
  assert.match(popup, /id="bpc_safari_diag"/);
  assert.match(popup, /<script src="\/safari-popup.js"><\/script>\n<\/body>/);
  for (const f of ['safari-popup.js', 'safari-diagnostics.html', 'safari-diagnostics.js'])
    assert.ok(fs.existsSync(path.join(safariDir, f)), f);
});

for (const version of [[16, 4], [17, 0], [18, 4], [26, 0]]) {
  test(`Safari ${version.join('.')}: every rule is valid and equivalent to the Chrome rule set`, async () => {
    assert.ok(chromeRun, 'baseline test must run first');
    const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: version });
    assert.equal(run.loadError, null);
    assert.deepEqual(run.errors.map(String), []);
    assert.deepEqual(run.dnrErrors, [], 'Safari rejected an update');

    const report = run.sandbox.bpcSafari.report;
    const addCall = report.lastAddCall;
    assert.ok(addCall && addCall.rulesIn === chromeRun.sessionRules.length, 'compat layer did not see the full rule set');
    assert.equal(addCall.batchRejected, false);
    for (const rule of run.sessionRules) {
      assert.deepEqual(safariRuleProblems(rule, version), [], JSON.stringify(rule).slice(0, 300));
      const keys = Object.keys(rule.condition);
      if (version[0] < 18 || (version[0] === 18 && version[1] < 4))
        assert.ok(!keys.includes('initiatorDomains') && !keys.includes('excludedInitiatorDomains'));
    }

    // Every Chrome rule is present, except response-header rules Safari cannot express.
    const chromeRules = new Map(chromeRun.sessionRules.map((r) => [r.id, r]));
    const byBase = new Map();
    for (const rule of run.sessionRules) {
      const id = baseId(rule.id);
      assert.ok(chromeRules.has(id), `rule ${rule.id} has no Chrome counterpart`);
      if (!byBase.has(id)) byBase.set(id, []);
      byBase.get(id).push(rule);
    }
    const missing = [...chromeRules.values()].filter((r) => !byBase.has(r.id));
    assert.deepEqual(missing.filter((r) => !responseHeadersOnly(r)).map((r) => r.id), []);
    const dropped = [...addCall.droppedRules]; // copy out of the VM realm
    assert.deepEqual(dropped.map((d) => d.id).sort((a, b) => a - b), missing.map((r) => r.id).sort((a, b) => a - b));
    assert.ok(dropped.every((d) => /responseHeaders/.test(d.reason)), JSON.stringify(dropped.map((d) => d.reason)));
    assert.equal(addCall.rulesOut, run.sessionRules.length);

    // Same matching behaviour: rewritten regexes accept exactly the same URLs.
    for (const [id, rules] of byBase) {
      const orig = chromeRules.get(id);
      const strip = (r) => {
        const c = structuredClone(r.condition);
        delete c.regexFilter;
        if (c.domains) { c.initiatorDomains = c.domains; delete c.domains; }
        if (c.excludedDomains) { c.excludedInitiatorDomains = c.excludedDomains; delete c.excludedDomains; }
        return c;
      };
      // X-Forwarded-For carries a random IP address chosen at each start.
      const action = (r) => JSON.parse(JSON.stringify(r.action).replace(/("header":"X-Forwarded-For","operation":"set","value":")[^"]*"/g, '$1<ip>"'));
      for (const r of rules) {
        assert.deepEqual(strip(r), strip(orig), `condition of rule ${r.id}`);
        assert.deepEqual(action(r), action(orig), `action of rule ${r.id}`);
      }
      if (orig.condition.regexFilter !== undefined) {
        const variants = rules.map((r) => r.condition.regexFilter);
        if (variants.length > 1 || variants[0] !== orig.condition.regexFilter)
          assert.equal(findMismatch(orig.condition.regexFilter, variants), null, orig.condition.regexFilter);
      }
    }
  });
}

test('Safari build: changing the enabled sites leaves no stale rewritten rules', async () => {
  const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [17, 0] });
  const chrome = await runBackground({ extDir: chromeDir, flavor: 'chrome' });
  const before = run.currentRules();
  const allSites = structuredClone(run.store.sites);
  assert.ok(before.some((r) => r.id >= EXTRA_ID_BASE), 'expected some rewritten rules');

  // Keep a handful of sites, including ones whose regexes get rewritten.
  const keep = Object.fromEntries(Object.entries(run.store.sites).filter(([k, v]) =>
    /nytimes|ampproject|theaustralian|Australia News|cxense|Winnipeg|Straits|Bloomberg/i.test(k + v)).slice(0, 12));
  assert.ok(Object.keys(keep).length >= 3);
  for (const r of [run, chrome]) {
    r.api.storage.local.set({ sites: keep });
    await r.settle(800);
  }
  const after = run.currentRules();
  const ids = new Set(after.map((r) => r.id));
  for (const r of after) if (r.id >= EXTRA_ID_BASE) assert.ok(ids.has(baseId(r.id)), `orphan rewritten rule ${r.id}`);
  assert.ok(after.length < before.length / 4, `${after.length} rules left of ${before.length}`);

  const chromeIds = new Set(chrome.currentRules().filter((r) => !responseHeadersOnly(r)).map((r) => r.id));
  const safariBase = new Set(after.map((r) => baseId(r.id)));
  assert.deepEqual([...safariBase].sort((a, b) => a - b), [...chromeIds].sort((a, b) => a - b));
  assert.deepEqual(run.dnrErrors, []);

  // And back to everything: same as a fresh install.
  run.api.storage.local.set({ sites: allSites });
  await run.settle(800);
  assert.equal(run.currentRules().length, before.length);
  assert.deepEqual(run.dnrErrors, []);
});

test('offscreenParse strips scripts and extracts the selected element', async () => {
  const { compat } = await import('./sampler.mjs');
  let parsed;
  globalThis.DOMParser = class {
    parseFromString(html) {
      parsed = html;
      return { querySelector: (sel) => (sel === 'article' ? { outerHTML: '<article>text</article>' } : null) };
    }
  };
  try {
    const data = await compat.offscreenParse({ html: '<script src="x.js"></script><article onclick="steal()">text</article>', selector_source: 'article', tab_id: 3 });
    assert.equal(data.html, '<article>text</article>');
    assert.equal(data.tab_id, 3);
    assert.ok(!/<script/.test(parsed) && !/onclick=/.test(parsed));
    const none = await compat.offscreenParse({ html: '<p>x</p>', selector_source: 'main' });
    assert.equal(none.html, '');
  } finally {
    delete globalThis.DOMParser;
  }
});

for (const errorStyle of ['plain', 'webkit']) test(`Safari build: rules Safari refuses unexpectedly are isolated, the rest still apply (${errorStyle} errors)`, async () => {
  // Pretend Safari refuses to modify the Cookie request header.
  const refusesCookie = (rule) => ((rule.action.requestHeaders || []).some((h) => h.header === 'Cookie') ? 'header Cookie not allowed' : null);
  const normal = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4] });
  const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4], extraRuleCheck: refusesCookie, errorStyle });
  const call = run.sandbox.bpcSafari.report.lastAddCall;
  assert.ok(call.batchRejected, 'the first, complete batch should have been rejected');
  const expectedRefused = normal.sessionRules.filter((r) => refusesCookie(r)).map((r) => r.id).sort((a, b) => a - b);
  assert.ok(expectedRefused.length > 0);
  const refused = [...call.droppedRules].filter((d) => /^rejected by Safari/.test(d.reason)).map((d) => d.id).sort((a, b) => a - b);
  assert.deepEqual(refused, expectedRefused);
  assert.equal(run.sessionRules.length, normal.sessionRules.length - expectedRefused.length);
  assert.equal(call.rulesOut, run.sessionRules.length);
  assert.deepEqual(run.errors.map(String), []);
  if (errorStyle === 'webkit') {
    // One cheap retry per refused rule instead of bisecting the batch.
    const adds = run.dnrCalls.filter((c) => (c.addRules || []).length).length;
    assert.ok(adds <= expectedRefused.length + 2, `${adds} add calls for ${expectedRefused.length} refused rules`);
  }
});

// --- Content scripts -------------------------------------------------------

const ARTICLE = 'https://www.nytimes.com/2024/05/01/world/some-article.html';

function pageLoaded(run, tabId, url) {
  for (const listener of run.api.tabs.onUpdated.listeners)
    listener(tabId, { status: 'complete' }, { id: tabId, url, status: 'complete', active: true });
}

const injections = (run, tabId) => run.scriptCalls.filter((c) => c.target && c.target.tabId === tabId && (c.files || []).includes('contentScript.js'));

test('Safari build: content scripts are injected on an enabled site, like in Chrome', async () => {
  const safari = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4] });
  const chrome = await runBackground({ extDir: chromeDir, flavor: 'chrome' });
  assert.ok([...safari.sandbox.enabledSites].includes('nytimes.com'), 'nytimes.com should be enabled after install');
  for (const r of [safari, chrome]) {
    pageLoaded(r, 7, ARTICLE);
    await r.settle(1200);
  }
  const s = injections(safari, 7);
  const c = injections(chrome, 7);
  assert.equal(s.length, 1, 'contentScript.js should be injected once');
  assert.deepEqual(s[0].files, ['lib/empty.js', 'contentScript.js', 'cs_local/contentScript_en.js']);
  assert.deepEqual(s, c);
  assert.deepEqual(safari.errors.map(String), []);
});

test('Safari build: nothing is injected when Safari hides the tab URL (no site access)', async () => {
  const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4] });
  pageLoaded(run, 9, ''); // Safari reports an empty URL for sites the extension may not access
  await run.settle(1200);
  assert.deepEqual(injections(run, 9), []);
  assert.deepEqual(run.scriptCalls.filter((c) => c.target && c.target.tabId === 9), []);
});

test('Safari build: the diagnostics message reports the background state', async () => {
  const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [17, 0] });
  const replies = [];
  for (const listener of run.api.runtime.onMessage.listeners)
    listener({ request: 'bpcSafariDiag', url: ARTICLE }, {}, (r) => replies.push(r));
  assert.equal(replies.length, 1, 'exactly one listener answers');
  const info = replies[0];
  assert.equal(info.backgroundLoaded, true);
  assert.equal(info.siteEnabled, true);
  assert.equal(info.siteDomain, 'nytimes.com');
  assert.equal(info.selfHosted, true);
  assert.equal(info.chromiumCodePath, true);
  assert.ok(info.enabledSites > 500);
  assert.deepEqual([...info.errors], []);
  assert.equal(info.lastAddCall.rulesOut, run.sessionRules.length);
  assert.equal(info.legacyDomainKeys, true);
  // Also kept in storage for when the background page is not running.
  assert.equal(run.store.bpc_safari_report.lastAddCall.rulesOut, run.sessionRules.length);
  const other = [];
  for (const listener of run.api.runtime.onMessage.listeners)
    listener({ request: 'something_else' }, {}, (r) => other.push(r));
  assert.deepEqual(other, []);
});
