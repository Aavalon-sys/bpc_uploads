#!/usr/bin/env node
// Summarises the results of safari/engine/run.sh and checks them.
//
//   node safari/engine/report.mjs <output-dir> [--no-fail]
//
// For every scenario it reads <name>.json (written by the WebKit host) and
// <name>.requests.jsonl (written by the local test server).

import fs from 'node:fs';
import path from 'node:path';
import { SITES } from './server.mjs';

const dir = process.argv[2];
const noFail = process.argv.includes('--no-fail');
if (!dir) {
  console.error('usage: report.mjs <output-dir> [--no-fail]');
  process.exit(2);
}

const GOOGLEBOT = /Googlebot\/2\.1/;
const EXPECTED_HEADERS = {
  // X-Forwarded-For is part of the Chrome rule too, but Safari refuses to set it.
  'www.washingtonpost.com': { userAgent: GOOGLEBOT, referer: /^https:\/\/www\.google\.com\/$/ },
  'www.nytimes.com': { userAgent: /Google-InspectionTool/ },
  'www.ft.com': { referer: /^https:\/\/www\.google\.com\/$/ },
  'www.wsj.com': { referer: /^https:\/\/www\.drudgereport\.com\/$/ },
};

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readRequests(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (e) {
    return [];
  }
}

const failures = [];
const check = (scenario, ok, message) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(`${scenario}: ${message}`);
};

function describeBackground(label, bg) {
  if (!bg || bg.error) {
    console.log(`  ${label}: ${bg ? bg.error : 'not available'}`);
    return;
  }
  const c = bg.compat || {};
  console.log(`  ${label}: loaded=${bg.backgroundLoaded} enabledSites=${bg.enabledSites} storedSites=${bg.storedSites} sessionRules=${bg.sessionRules} ${JSON.stringify(bg.sessionRulesByType || {})}`);
  console.log(`      compat: version=${JSON.stringify(c.safariVersion)} legacyDomainKeys=${c.legacyDomainKeys} lastAddCall=${JSON.stringify(c.lastAddCall)} errors=${JSON.stringify(c.errors)}`);
  for (const u of (c.lastAddCall && c.lastAddCall.uncompilable) || []) console.log(`      SKIPPED rule ${u.id}: ${u.reason} ${JSON.stringify(u.rule)}`);
  console.log(`      remembered as refused: ${JSON.stringify(bg.refused)}`);
  console.log(`      manifest keys: ${(bg.manifestKeys || []).join(',')} | chrome=${bg.hasChrome} browser=${bg.hasBrowser} extChromium=${bg.extChromium} selfHosted=${bg.selfHosted}`);
  console.log(`      permissions: ${JSON.stringify(bg.permissions)} origins=${bg.origins} ${JSON.stringify(bg.originsSample)}`);
  console.log(`      storage keys: ${(bg.storageKeys || []).join(',')}`);
  console.log(`      tabs: ${JSON.stringify(bg.tabs)}`);
  console.log(`      user agent: ${bg.userAgent}`);
  if (Array.isArray(bg.spy)) {
    console.log(`      scripting.executeScript / tabs.sendMessage calls made by the extension (${bg.spy.length}):`);
    for (const c of bg.spy.slice(0, 40)) {
      const a = c.args && c.args[0];
      const what = c.api === 'executeScript' ? JSON.stringify({ tab: a && a.target && a.target.tabId, files: a && a.files, world: a && a.world }) : JSON.stringify(c.args).slice(0, 260);
      console.log(`        ${c.api} ${what} => ${c.rejected !== undefined ? 'REJECTED ' + c.rejected : c.threw !== undefined ? 'THREW ' + c.threw : c.resolved !== undefined ? 'ok ' + String(c.resolved).slice(0, 260) : 'pending/' + c.returned}`);
    }
  } else console.log(`      call spy: ${JSON.stringify(bg.spy)}`);
  if (Array.isArray(bg.tabEvents)) {
    console.log(`      tabs.onUpdated events seen by the extension (${bg.tabEvents.length}):`);
    for (const e of bg.tabEvents.slice(0, 40)) console.log(`        tab ${e.tabId} ${JSON.stringify(e.changeInfo)} url=${JSON.stringify(e.url)} status=${e.status}`);
  }
}

function scenario(name, expect, { optional = false } = {}) {
  const result = readJSON(path.join(dir, `${name}.json`));
  const requests = readRequests(path.join(dir, `${name}.requests.jsonl`));
  if (!result && optional && !fs.existsSync(path.join(dir, `${name}.host.log`))) {
    console.log(`\n=== Scenario "${name}" was not run on this machine ===`);
    return;
  }
  console.log(`\n=== Scenario "${name}" ===`);
  if (!result) {
    console.log('  no result file');
    failures.push(`${name}: the WebKit host produced no result`);
    const log = path.join(dir, `${name}.host.log`);
    if (fs.existsSync(log)) console.log(fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n'));
    return;
  }
  console.log(`  ${result.os}, WebKit ${result.webkit}, options ${JSON.stringify(result.options)}`);
  if (result.fatal) {
    console.log(`  FATAL: ${result.fatal}`);
    failures.push(`${name}: ${result.fatal}`);
    return;
  }
  console.log(`  extension: ${JSON.stringify(result.extension)}`);
  describeBackground('background after start', result.backgroundAfterStart);
  describeBackground('background at end', result.backgroundAtEnd);
  console.log(`  context errors (${(result.contextErrors || []).length}):`);
  for (const e of (result.contextErrors || []).slice(0, 25)) console.log(`      ${e}`);
  console.log(`  events: ${(result.events || []).map((e) => `${e.t}s ${e.type}${typeof e.detail === 'string' ? ' ' + e.detail.replace(/^[a-z-]+:\/\/[^/]+/, '') : ''}`).join(' | ')}`);

  for (const page of result.pages || []) {
    const url = new URL(page.requested);
    const site = SITES[url.hostname] || { scripts: {}, blocked: [] };
    const mine = requests.filter((r) => r.host === url.hostname);
    const doc = mine.find((r) => r.path === url.pathname);
    const fetched = Object.fromEntries(Object.entries(site.scripts).map(([n, src]) => [n, mine.some((r) => r.path === src)]));
    const p = page.page || {};
    const cw = page.contentWorld || {};
    console.log(`\n  -- ${url.hostname} (${site.rule || '?'})`);
    console.log(`     finished=${page.finished} error=${page.navigationError || '-'} hasAccess=${page.hasAccess}`);
    console.log(`     document request: ${doc ? JSON.stringify({ userAgent: doc.userAgent, referer: doc.referer, cookie: doc.cookie, xForwardedFor: doc.xForwardedFor }) : 'NOT RECEIVED'}`);
    console.log(`     scripts fetched: ${JSON.stringify(fetched)} | ran in page: ${JSON.stringify(p.ran)}`);
    console.log(`     page: ${p.error ? 'ERROR ' + p.error : JSON.stringify({ probes: p.probes, cookie: p.cookie })}`);
    console.log(`     content world: ${JSON.stringify(cw)}`);
    const later = mine.filter((r) => r.path.startsWith('/ok.js'));
    if (later.length) console.log(`     ok.js request: ${JSON.stringify({ userAgent: later[0].userAgent, referer: later[0].referer, cookie: later[0].cookie })}`);

    if (!expect) continue;
    const supported = url.hostname !== 'www.bpc-control.test';
    check(name, page.finished && !page.navigationError && !!doc, `${url.hostname}: page loaded`);
    if (expect === 'working' && supported) {
      for (const [header, pattern] of Object.entries(EXPECTED_HEADERS[url.hostname] || {}))
        check(name, !!doc && pattern.test(doc[header] || ''), `${url.hostname}: document request has ${header} matching ${pattern} (got ${JSON.stringify(doc && doc[header])})`);
      for (const blocked of site.blocked)
        check(name, fetched[blocked] === false && !(p.ran || {})[blocked], `${url.hostname}: script "${blocked}" is blocked`);
      check(name, fetched.ok === true && (p.ran || {}).ok === '1', `${url.hostname}: control script still loads`);
      check(name, cw.contentScript === true, `${url.hostname}: content script injected`);
      if (url.hostname === 'www.hola.com')
        check(name, p.probes && p.probes.ad && p.probes.ad.display === 'none', `${url.hostname}: content script hid the advert (display=${p.probes && p.probes.ad && p.probes.ad.display})`);
    } else {
      // Unsupported site, or the extension has no access: nothing may change.
      check(name, !!doc && !GOOGLEBOT.test(doc.userAgent || '') && !/google|drudge/.test(doc.referer || ''), `${url.hostname}: request headers untouched`);
      check(name, cw.contentScript !== true, `${url.hostname}: no content script`);
      if (!supported)
        check(name, Object.values(fetched).every(Boolean), `${url.hostname}: no script blocked`);
    }
  }

  if (result.diagnosticsPage) {
    console.log(`\n  diagnostics page (tab ${JSON.stringify(result.diagnosticsTabId)}):`);
    for (const line of result.diagnosticsPage.verdict || [JSON.stringify(result.diagnosticsPage)]) console.log(`      ${line}`);
    for (const line of result.diagnosticsPage.report || []) console.log(`      | ${line.slice(0, 300)}`);
  }

  if (expect === 'working') {
    const bg = result.backgroundAtEnd || {};
    check(name, bg.backgroundLoaded === true, 'background scripts loaded');
    check(name, bg.enabledSites > 500, `sites are enabled (${bg.enabledSites})`);
    check(name, bg.sessionRules > 700, `blocking/header rules are installed (${bg.sessionRules})`);
    const believed = bg.compat && bg.compat.lastAddCall ? bg.compat.lastAddCall.rulesOut : null;
    // One more than the extension's own count: the marker rule that verifies each update.
    check(name, believed !== null && bg.sessionRules === believed + 1, `the rules the extension believes it installed are really there (${believed} + marker vs ${bg.sessionRules})`);
    check(name, !(bg.compat && bg.compat.errors && bg.compat.errors.length), `no uncaught errors in the background page`);
  }
}

scenario('enabled', 'working');
scenario('legacy', 'working');
scenario('launch', 'working');
scenario('noaccess', 'untouched');
scenario('private', 'untouched');
// With the WebKit that ships inside a newer Safari, when the machine has one.
scenario('staged-enabled', 'working', { optional: true });
scenario('staged-launch', 'working', { optional: true });

console.log(`\n=== ${failures.length ? failures.length + ' check(s) failed' : 'all checks passed'} ===`);
for (const f of failures) console.log(`  - ${f}`);
if (failures.length && !noFail) process.exit(1);
