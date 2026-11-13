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
import vm from 'node:vm';
import { asciiJs, build } from '../build.mjs';
import { garble, readAsWindows1252, runBackground } from './harness.mjs';
import { ACCEPTED_HEADER_NAMES, safariRuleProblems, uncompilable } from './webkit-rules.mjs';
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
// Request headers Safari refuses (X-Forwarded-For and the sites' own app headers).
const refused = (h) => !ACCEPTED_HEADER_NAMES.has(String(h.header).toLowerCase());
const acceptedRequestHeaders = (rule) => (rule.action.requestHeaders || []).filter((h) => !refused(h));
// Rules Safari cannot express at all: nothing but response headers or refused request headers.
const inexpressible = (rule) => rule.action.type === 'modifyHeaders' && !acceptedRequestHeaders(rule).length;
// The refused headers the extension's rules use: X-Forwarded-For (Googlebot and
// random-IP rules) and the app headers of two sites.
const REFUSED_HEADERS = ['app-identifier', 'device-type', 'ismobileapp', 'platform', 'renderingkind', 'x-access-token', 'x-forwarded-for'];
// Every rejected update must be about a refused header name, nothing else.
const onlyHeaderRefusals = (dnrErrors) => dnrErrors.flat().every((p) => /The header `[^`]+` is not recognized/.test(p));

let chromeRun;
test('Chrome release: baseline rules in a Chrome-like browser', async () => {
  chromeRun = await runBackground({ extDir: chromeDir, flavor: 'chrome' });
  assert.equal(chromeRun.loadError, null);
  assert.deepEqual(chromeRun.errors, []);
  assert.deepEqual(chromeRun.dnrErrors, []);
  assert.ok(chromeRun.sessionRules.length > 500, `only ${chromeRun.sessionRules.length} rules`);
  // With every site enabled (the default) the general paywall-script rules
  // have an empty list of excluded domains. Chrome accepts that; in Safari one
  // such rule makes the whole rule set fail to compile.
  const general = chromeRun.sessionRules.filter(uncompilable);
  assert.ok(general.length > 10, `${general.length} rules with an empty excluded list`);
  assert.ok(general.every((r) => r.action.type === 'block'));
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
  assert.equal(buildResult.info.patches.length, 10);
  assert.match(bg, /if \(details\.reason == "install"\) \{\r?\n\s*bpcSafari\.firstRun\(setDefaultOptions\);\r?\n\s*\} else if \(details\.reason == "update"\)/, 'install handler not patched');
  assert.ok(!bg.includes('ext_api.runtime.openOptionsPage()'));
  assert.match(bg, /setTimeout\(function \(\) \{\n  bpcSafari\.repairSiteNames\(defaultSites\)\.then\(function \(\) \{\n    bpcSafari\.firstRun\(setDefaultOptions\);\n  \}\);\n\}, 1500\);\n$/);
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
    // Safari rejects the first attempts because of request headers it does not
    // accept; each such header is removed and the update retried.
    assert.equal(run.dnrErrors.length, REFUSED_HEADERS.length, 'one rejected update per refused header');
    assert.equal(run.silentRollbacks(), 0, 'an update was accepted and then silently undone');
    assert.deepEqual(run.sessionRules.filter(uncompilable), []);
    // The general paywall-script rules are kept, without their empty exclusion list.
    const generalIds = chromeRun.sessionRules.filter(uncompilable).map((r) => r.id);
    for (const id of generalIds)
      assert.ok(run.sessionRules.some((r) => baseId(r.id) === id && !('excludedInitiatorDomains' in r.condition) && !('excludedDomains' in r.condition)), `general rule ${id} is missing`);
    assert.ok(onlyHeaderRefusals(run.dnrErrors), JSON.stringify(run.dnrErrors.map((e) => e[0])));

    const report = run.sandbox.bpcSafari.report;
    const addCall = report.lastAddCall;
    assert.ok(addCall && addCall.rulesIn === chromeRun.sessionRules.length, 'compat layer did not see the full rule set');
    assert.match(String(addCall.batchRejected), /The header `[^`]+` is not recognized/);
    assert.deepEqual(Object.keys(addCall.strippedHeaders).sort(), REFUSED_HEADERS);
    assert.ok(addCall.strippedHeaders['x-forwarded-for'] > 40, 'the Googlebot rules carry X-Forwarded-For');
    for (const rule of run.sessionRules) {
      assert.deepEqual(safariRuleProblems(rule, version), [], JSON.stringify(rule).slice(0, 300));
      const keys = Object.keys(rule.condition);
      if (version[0] < 18 || (version[0] === 18 && version[1] < 4))
        assert.ok(!keys.includes('initiatorDomains') && !keys.includes('excludedInitiatorDomains'));
    }

    // Every Chrome rule is present, except the ones Safari cannot express:
    // rules that only set response headers or only headers Safari refuses.
    const chromeRules = new Map(chromeRun.sessionRules.map((r) => [r.id, r]));
    const byBase = new Map();
    for (const rule of run.sessionRules) {
      const id = baseId(rule.id);
      assert.ok(chromeRules.has(id), `rule ${rule.id} has no Chrome counterpart`);
      if (!byBase.has(id)) byBase.set(id, []);
      byBase.get(id).push(rule);
    }
    const missing = [...chromeRules.values()].filter((r) => !byBase.has(r.id));
    assert.deepEqual(missing.filter((r) => !inexpressible(r)).map((r) => r.id), []);
    assert.deepEqual([...chromeRules.values()].filter((r) => inexpressible(r) && byBase.has(r.id)).map((r) => r.id), []);
    const dropped = [...addCall.droppedRules]; // copy out of the VM realm
    assert.deepEqual(dropped.map((d) => d.id).sort((a, b) => a - b), missing.map((r) => r.id).sort((a, b) => a - b));
    assert.ok(dropped.every((d) => /responseHeaders|only modifies request headers Safari refuses/.test(d.reason)), JSON.stringify(dropped.map((d) => d.reason)));
    // The Googlebot identity survives without the refused X-Forwarded-For header.
    const googlebot = run.sessionRules.filter((r) => (r.action.requestHeaders || []).some((h) => /Googlebot/.test(h.value || '')));
    assert.ok(googlebot.length > 30, `${googlebot.length} Googlebot rules`);
    for (const r of googlebot)
      assert.deepEqual(r.action.requestHeaders.map((h) => h.header).filter((h) => h !== 'Cookie'), ['User-Agent', 'Referer'], `headers of rule ${r.id}`);
    assert.equal(addCall.rulesOut, run.sessionRules.length);

    // Same matching behaviour: rewritten regexes accept exactly the same URLs.
    for (const [id, rules] of byBase) {
      const orig = chromeRules.get(id);
      const strip = (r) => {
        const c = structuredClone(r.condition);
        delete c.regexFilter;
        if (c.domains) { c.initiatorDomains = c.domains; delete c.domains; }
        if (c.excludedDomains) { c.excludedInitiatorDomains = c.excludedDomains; delete c.excludedDomains; }
        // An empty exclusion list and no exclusion list mean the same.
        if (c.excludedInitiatorDomains && !c.excludedInitiatorDomains.length) delete c.excludedInitiatorDomains;
        return c;
      };
      // Same action, apart from the request headers Safari refuses.
      const action = (r) => {
        const a = structuredClone(r.action);
        delete a.responseHeaders;
        if (a.requestHeaders) a.requestHeaders = a.requestHeaders.filter((h) => !refused(h));
        return a;
      };
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
  const rejectedAtStart = run.dnrErrors.length;
  assert.ok(onlyHeaderRefusals(run.dnrErrors));
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

  const chromeIds = new Set(chrome.currentRules().filter((r) => !inexpressible(r)).map((r) => r.id));
  const safariBase = new Set(after.map((r) => baseId(r.id)));
  assert.deepEqual([...safariBase].sort((a, b) => a - b), [...chromeIds].sort((a, b) => a - b));
  // Refused headers are remembered: later updates are not rejected again.
  assert.equal(run.dnrErrors.length, rejectedAtStart, 'an update after start-up was rejected');

  // And back to everything: same as a fresh install.
  run.api.storage.local.set({ sites: allSites });
  await run.settle(800);
  assert.equal(run.currentRules().length, before.length);
  assert.equal(run.dnrErrors.length, rejectedAtStart, 'an update after start-up was rejected');
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
    assert.ok(adds <= expectedRefused.length + REFUSED_HEADERS.length + 2, `${adds} add calls for ${expectedRefused.length} refused rules`);
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

// --- First-time setup ------------------------------------------------------

test('Safari build: the default sites are enabled even when Safari sends no install event', async () => {
  // WebKit sends no runtime.onInstalled when the extension is first loaded
  // during browser start-up; the Chrome code then leaves every site disabled.
  const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4], fireInstalled: false, settleMs: 3500 });
  assert.deepEqual(run.errors.map(String), []);
  assert.ok(Object.keys(run.store.sites || {}).length > 500, 'default sites were not stored');
  assert.ok([...run.sandbox.enabledSites].length > 500, 'no sites enabled');
  assert.ok(run.sessionRules.length > 700, `${run.sessionRules.length} rules`);
  assert.ok(run.store.bpc_safari_first_run, 'first run not recorded');
  assert.equal(run.optionsOpened, 1, 'the options page should open once');
});

test('Safari build: a repeated install event does not reset the chosen sites', async () => {
  // WebKit sends the install event again whenever the extension is re-enabled.
  const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4] });
  assert.equal(run.optionsOpened, 1, 'the options page should open once on first install');
  const chosen = Object.fromEntries(Object.entries(run.store.sites).slice(0, 5));
  run.api.storage.local.set({ sites: chosen });
  await run.settle(800);
  for (const listener of run.api.runtime.onInstalled.listeners) listener({ reason: 'install' });
  await run.settle(2500);
  assert.deepEqual(Object.keys(run.store.sites).sort(), Object.keys(chosen).sort());
  assert.equal(run.optionsOpened, 1);
});

// --- Updates Safari accepts and then silently undoes -----------------------

test('Safari build: a rule Safari cannot compile is found, skipped and remembered', async () => {
  // Safari stores new rules, compiles all of them into one content blocker and,
  // when that fails, restores the previous rules while reporting success.
  const poison = (rule) => rule.condition.regexFilter === '\\.poool\\.fr\\/';
  const normal = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4] });
  const expected = normal.sessionRules.filter((r) => !poison(r));
  assert.ok(expected.length < normal.sessionRules.length && expected.length > 700);

  const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4], silentRefusal: poison, settleMs: 2500 });
  assert.deepEqual(run.errors.map(String), []);
  assert.ok(run.silentRollbacks() > 0, 'the mock never rolled an update back');
  // Without verification the extension would now have no rules at all.
  assert.deepEqual(run.sessionRules.map((r) => r.id).sort((a, b) => a - b), expected.map((r) => r.id).sort((a, b) => a - b));
  const call = run.sandbox.bpcSafari.report.lastAddCall;
  assert.equal(call.rulesOut, expected.length);
  assert.ok(call.rollbacks > 0);
  const skipped = [...call.droppedRules].filter((d) => d.reason === 'Safari cannot compile this rule');
  assert.equal(skipped.length, normal.sessionRules.length - expected.length);
  assert.ok(skipped.every((d) => poison(d.rule)));
  const remembered = run.store.bpc_safari_refused_2;
  assert.equal(remembered.rules.length, new Set(skipped.map((d) => JSON.stringify(d.rule.condition))).size);
  assert.ok(remembered.headers.includes('x-forwarded-for'));

  // Next start of the background page: nothing has to be found again.
  const again = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4], silentRefusal: poison, initialStore: run.store });
  assert.equal(again.silentRollbacks(), 0);
  assert.deepEqual(again.dnrErrors, [], 'refused headers were not remembered');
  assert.equal(again.sessionRules.length, expected.length);
  assert.equal(again.sandbox.bpcSafari.report.lastAddCall.rollbacks, 0);

  // A Safari update may fix it: what was learned is tied to the Safari version.
  const upgraded = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [26, 0], initialStore: run.store });
  assert.equal(upgraded.sessionRules.length, normal.sessionRules.length);
});

test('Safari build: an unchanged rule set produces an identical update', async () => {
  // The background page restarts often; Safari reuses its compiled rule list
  // only when the rules are exactly the same, marker rule included.
  // The very first start has to learn which headers Safari refuses.
  const first = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4] });
  const second = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4], initialStore: first.store });
  const third = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4], initialStore: second.store });
  assert.ok(second.currentMarker(), 'no marker rule');
  assert.match(second.currentMarker().condition.urlFilter, /^\|\|bpc-safari-marker\.invalid\/[a-z0-9]+$/);
  const lastAdd = (run) => run.dnrCalls.filter((c) => (c.addRules || []).length > 100).pop();
  assert.deepEqual(lastAdd(third).addRules, lastAdd(second).addRules);
  assert.equal(second.dnrErrors.length, 0);
  assert.equal(third.dnrErrors.length, 0);
});

// --- Character encoding ----------------------------------------------------
// Released Safari versions read the scripts of the background page as
// Windows-1252 (the harness does the same for the Safari flavor), which
// garbled the site names with accented letters in sites.js. The Safari build
// therefore writes every script without non-ASCII characters.

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const isAscii = (text) => !/[^\x00-\x7f]/.test(text);
// compareKey() of the extension: names match without their " (...)" part.
const plainName = (name) => name.toLowerCase().replace(/\s\(.*\)/, '');

test('asciiJs keeps the meaning of strings and regular expressions', () => {
  const samples = [
    String.raw`'Télérama.fr' + "El Español"`,
    // escaped character, character after an escaped backslash, and both
    String.raw`["\é", "\\é", "\\\é", '\„\”', 'a\\\\é']`,
    String.raw`'。•©' + ' é ' + '😀'.length + '\😀'`,
    'var t = `À lire: ${1 + 1} \\é`; t',
    String.raw`'Ärger. „Öl” ist da! Über 9.Zürich?Ja'.replace(/(?:^|[A-Za-z\"\“\”\)])(\.+|\?|!)(?=[A-ZÖÜ\„\”\d][A-Za-zÀ-ÿ\„\d]{1,})/gm, "$&|")`,
    String.raw`'motÉcole “quoteÀ'.replace(/(([a-z]{2,}|[\"\“]))(?=[A-Z](?=[A-Za-zÀ-ÿ]+))/gm, "$&|")`,
    String.raw`[/é+/.test('ééé'), /[^À-ÿ]/.test('é'), /é😀/u.test('é😀'), /[\é]/.test('é')].join() // “comment” é`,
    String.raw`/* Ünïcödé comment */ ({ 'Kölner Stadt-Anzeiger': 1, "Ärzte Zeitung": 2 })`,
  ];
  for (const sample of samples) {
    const ascii = asciiJs(sample);
    assert.ok(isAscii(ascii), ascii);
    assert.equal(JSON.stringify(vm.runInNewContext(ascii)), JSON.stringify(vm.runInNewContext(sample)), sample);
  }
  assert.equal(asciiJs(String.raw`'\é' + "\\é"`), "'\\u00e9' + \"\\\\\\u00e9\"");
  assert.equal(asciiJs('plain ASCII \\n stays'), 'plain ASCII \\n stays');
  assert.equal(asciiJs(String.fromCharCode(0xfeff) + 'var a;'), 'var a;', 'a byte order mark is dropped');
});

test('Safari build: every script is free of non-ASCII characters and still parses', () => {
  const scripts = walk(safariDir).filter((f) => f.endsWith('.js'));
  assert.ok(scripts.length > 15);
  for (const file of scripts) {
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.every((b) => b < 0x80), `${path.relative(safariDir, file)} has non-ASCII characters`);
    assert.doesNotThrow(() => new vm.Script(bytes.toString('latin1'), { filename: file }));
  }
  assert.deepEqual(buildResult.info.nonAsciiScripts, []);
  for (const f of ['sites.js', 'contentScript.js']) assert.ok(buildResult.info.asciiScripts.includes(f), f);
  // Only the encoding changed: the scripts of the Chrome release that are not patched read the same.
  for (const rel of ['sites.js', 'cs_local/contentScript_en.js', 'cs_local/contentScript_fr.js', 'cs_local/contentScript_de.js']) {
    const original = fs.readFileSync(path.join(chromeDir, rel), 'utf8');
    assert.ok(!isAscii(original), `${rel} of the Chrome release is expected to have non-ASCII characters`);
    assert.equal(fs.readFileSync(path.join(safariDir, rel), 'utf8'), asciiJs(original), rel);
  }
});

// defaultSites as sites.js defines it, with the script read by the given function.
function defaultSitesOf(dir, read) {
  const sandbox = { chrome: { runtime: { getManifest: () => ({ key: 'x' }) } } };
  vm.createContext(sandbox);
  vm.runInContext(read(fs.readFileSync(path.join(dir, 'sites.js'))), sandbox);
  // Regular expressions by their escaped source, so that both spellings compare equal.
  return JSON.parse(JSON.stringify(sandbox.defaultSites, (key, value) => (Object.prototype.toString.call(value) === '[object RegExp]' ? `/${asciiJs(value.source)}/${value.flags}` : value)));
}

test('Safari build: sites.js read as Windows-1252 holds the sites of the Chrome release', () => {
  const chromeSites = defaultSitesOf(chromeDir, (bytes) => bytes.toString('utf8'));
  const safariSites = defaultSitesOf(safariDir, readAsWindows1252);
  assert.deepEqual(Object.keys(safariSites), Object.keys(chromeSites));
  assert.deepEqual(safariSites, chromeSites);
  const accented = Object.keys(chromeSites).filter((name) => !isAscii(name));
  assert.ok(accented.length >= 30, `${accented.length} accented site names`);
  // What used to happen: the Chrome release's sites.js read the way Safari reads it.
  const garbledSites = defaultSitesOf(chromeDir, readAsWindows1252);
  assert.deepEqual(Object.keys(garbledSites).filter((name) => !isAscii(name)).sort(), accented.map(garble).sort());
});

test('Safari build: accented site names are stored intact, with and without the install event', async () => {
  assert.ok(chromeRun, 'baseline test must run first');
  const expected = Object.keys(chromeRun.store.sites).sort();
  assert.ok(expected.filter((name) => !isAscii(name)).length >= 30);
  for (const fireInstalled of [true, false]) {
    const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4], fireInstalled, settleMs: 3500 });
    assert.deepEqual(run.errors.map(String), []);
    assert.deepEqual(Object.keys(run.store.sites).sort(), expected, `fireInstalled=${fireInstalled}`);
    assert.deepEqual([...run.store.sites_default].sort(), [...chromeRun.store.sites_default].sort());
    assert.deepEqual([...run.sandbox.enabledSites].sort(), [...chromeRun.sandbox.enabledSites].sort());
    const repair = run.store.bpc_safari_site_names;
    assert.ok(repair, 'the stored list was not checked');
    assert.deepEqual([repair.renamed, repair.restored, repair.known], [0, 0, 0]);
  }
});

test('Safari build: a site list stored by an earlier build is put right', async () => {
  assert.ok(chromeRun, 'baseline test must run first');
  const good = chromeRun.store;
  const accented = Object.keys(good.sites).filter((name) => !isAscii(name));
  const unmatched = accented.filter((name) => !isAscii(plainName(name)));
  assert.ok(unmatched.length >= 30 && unmatched.length < accented.length, 'some accented names only differ inside "(...)"');
  const earlier = {
    // No install event: the background stored the names as it read them.
    garbled: Object.fromEntries(Object.entries(good.sites).map(([name, domain]) => [garble(name), domain])),
    // Install event: the options page opened and saved the list without the names it could not match.
    dropped: Object.fromEntries(Object.entries(good.sites).filter(([name]) => !unmatched.includes(name))),
  };
  for (const [state, sites] of Object.entries(earlier)) {
    const initialStore = {
      sites,
      sites_default: good.sites_default.map(garble),
      ext_version_old: good.ext_version_old,
      bpc_safari_first_run: '2026-01-01T00:00:00.000Z',
    };
    const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4], fireInstalled: false, settleMs: 4000, initialStore });
    assert.deepEqual(run.errors.map(String), [], state);
    assert.deepEqual(Object.keys(run.store.sites).sort(), Object.keys(good.sites).sort(), state);
    assert.deepEqual({ ...run.store.sites }, { ...good.sites }, state);
    assert.deepEqual([...run.store.sites_default].sort(), [...good.sites_default].sort(), state);
    const repair = run.store.bpc_safari_site_names;
    assert.deepEqual([repair.renamed, repair.restored], state === 'garbled' ? [accented.length, 0] : [0, unmatched.length], state);
    // The background noticed the change and enabled the sites.
    assert.deepEqual([...run.sandbox.enabledSites].sort(), [...chromeRun.sandbox.enabledSites].sort(), state);
    assert.equal(run.optionsOpened, 0, 'no options page for a repair');
  }
});

test('Safari build: a site list the user cut down keeps its sites', async () => {
  assert.ok(chromeRun, 'baseline test must run first');
  const chosen = Object.fromEntries(Object.entries(chromeRun.store.sites).filter(([name]) => isAscii(name)).slice(0, 40));
  const initialStore = { sites: chosen, sites_default: [...chromeRun.store.sites_default], ext_version_old: chromeRun.store.ext_version_old, bpc_safari_first_run: '2026-01-01T00:00:00.000Z' };
  const run = await runBackground({ extDir: safariDir, flavor: 'safari', safariVersion: [18, 4], fireInstalled: false, settleMs: 3500, initialStore });
  assert.deepEqual(run.errors.map(String), []);
  assert.deepEqual(Object.keys(run.store.sites).sort(), Object.keys(chosen).sort());
});

// --- Scripts injected into the page's own JavaScript world -----------------
// For some sites the background injects the content scripts with
// world: "MAIN". A page in Safari has no `chrome` and no `browser` object.

// A page without extension objects; timers are collected, not run.
function pageWorld(hostname) {
  const timers = [];
  const window = {
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15' },
    location: { hostname, href: `https://${hostname}/2026/01/article`, pathname: '/2026/01/article', search: '', origin: `https://${hostname}` },
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => {},
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, documentElement: {}, head: null, body: null, cookie: '' },
    addEventListener: () => {},
  };
  window.window = window;
  window.self = window;
  window.top = window;
  return { sandbox: vm.createContext(window), timers };
}
const runIn = (world, dir, files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), world.sandbox, { filename: f }));
const PAGE_WORLD_SCRIPTS = [['contentScript.js', 'cs_local/contentScript_en.js'], ['contentScript.js', 'cs_local/contentScript_fr.js'], ['contentScript_once_var.js']];

test('Safari build: the background still injects into the page world for the same sites', () => {
  const bg = fs.readFileSync(path.join(safariDir, 'background.js'), 'utf8');
  // The only two places; when upstream adds another script here, it needs the same care.
  assert.equal((bg.match(/world: "MAIN"|script_world = "MAIN"/g) || []).length, 2);
  assert.match(bg, /files: \["contentScript_once_var\.js"\],\r?\n\s*injectImmediately: true,\r?\n\s*world: "MAIN"/);
  assert.match(bg, /files: \[lib_file, "contentScript\.js", cs_local_file\],\r?\n\s*injectImmediately: true,\r?\n\s*world: script_world/);
});

test('Chrome release: the page-world scripts need a chrome object', () => {
  for (const files of PAGE_WORLD_SCRIPTS)
    assert.throws(() => runIn(pageWorld('www.hbr.org'), chromeDir, files), /chrome is not defined/, files.join(' + '));
});

test('Safari build: the page-world scripts start in a page without chrome and browser', () => {
  for (const files of PAGE_WORLD_SCRIPTS) {
    const world = pageWorld('www.hbr.org');
    assert.doesNotThrow(() => runIn(world, safariDir, files), files.join(' + '));
    if (files[0] !== 'contentScript.js') continue;
    // Without a runtime the content script runs its site code right away, like in Chrome's page world.
    assert.equal(world.sandbox.ext_chromium, true);
    assert.equal(typeof world.sandbox.cs_default, 'function');
    assert.equal(world.timers.length, 5);
    assert.doesNotThrow(() => world.timers.forEach((fn) => fn()));
  }
  // In the extension's own world nothing changes: the runtime is found and used.
  const messages = [];
  const world = pageWorld('www.hbr.org');
  world.sandbox.chrome = { runtime: { getManifest: () => ({ key: 'k' }), onMessage: { addListener: (fn) => messages.push(fn) } }, storage: {} };
  runIn(world, safariDir, PAGE_WORLD_SCRIPTS[0]);
  assert.equal(world.sandbox.ext_chromium, true);
  assert.equal(messages.length, 1, 'the content script waits for the background message');
  assert.equal(world.timers.length, 0);
});
