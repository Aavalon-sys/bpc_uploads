#!/usr/bin/env node
// Summarises the results of safari/engine/run.sh and checks them.
//
//   node safari/engine/report.mjs <output-dir> [--no-fail] [--app]
//
// For every scenario it reads <name>.json (written by the WebKit host) and
// <name>.requests.jsonl (written by the local test server). With --app it
// reports the run in the real Safari app instead (safari-app.sh), where only
// what a page and the server can see is known.

import fs from 'node:fs';
import path from 'node:path';
import { SITES } from './server.mjs';

const dir = process.argv[2];
const noFail = process.argv.includes('--no-fail');
const appRun = process.argv.includes('--app');
if (!dir) {
  console.error('usage: report.mjs <output-dir> [--no-fail]');
  process.exit(2);
}

const GOOGLEBOT = /Googlebot\/2\.1/;
const GOOGLE = /^https:\/\/www\.google\.com\/$/;
const EXPECTED_HEADERS = {
  // X-Forwarded-For is part of the Chrome rule too, but Safari refuses to set it.
  'www.nbcnews.com': { userAgent: GOOGLEBOT, referer: GOOGLE },
  // Sites that refuse a Googlebot without Google's address: the rest of the rule still applies.
  'www.washingtonpost.com': { referer: GOOGLE },
  'www.dallasnews.com': { referer: GOOGLE },
  'www.ajc.com': { referer: GOOGLE },
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
// Sites stored per scenario: the same list whichever way the extension was first started.
const storedSites = {};
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
  console.log(`      no crawler user agent for: ${JSON.stringify(bg.crawler && bg.crawler.refusedBy)} stored: ${JSON.stringify(bg.crawler && bg.crawler.stored)}`);
  for (const n of (bg.crawler && bg.crawler.notes) || []) console.log(`        ${n.at} ${n.domain}: ${n.note}`);
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
  const app = expect === 'app';
  if (app) console.log(`  Safari ${JSON.stringify(result.capabilities)}, options ${JSON.stringify(result.options)}`);
  else console.log(`  ${result.os}, WebKit ${result.webkit}, options ${JSON.stringify(result.options)}`);
  if (result.skipped) {
    // The machine could not run the test at all; that says nothing about the extension.
    console.log(`  NOT RUN: ${result.skipped}`);
    console.log(`::warning title=Safari app test not run::${result.skipped}`);
    return;
  }
  if (result.fatal) {
    console.log(`  FATAL: ${result.fatal}`);
    for (const e of result.events || []) console.log(`      ${e.t}s ${e.type} ${JSON.stringify(e.detail).slice(0, 600)}`);
    for (const line of result.driverLog || []) console.log(`      driver | ${line}`);
    failures.push(`${name}: ${result.fatal}`);
    return;
  }
  console.log(`  extension: ${JSON.stringify(result.extension)}`);
  if (!app) {
    describeBackground('background after start', result.backgroundAfterStart);
    describeBackground('background at end', result.backgroundAtEnd);
    console.log(`  context errors (${(result.contextErrors || []).length}):`);
    for (const e of (result.contextErrors || []).slice(0, 25)) console.log(`      ${e}`);
  }
  console.log(`  events: ${(result.events || []).map((e) => `${e.t}s ${e.type}${typeof e.detail === 'string' ? ' ' + e.detail.replace(/^[a-z-]+:\/\/[^/]+/, '') : ''}`).join(' | ')}`);

  for (const page of result.pages || []) {
    const url = new URL(page.requested);
    const site = SITES[url.hostname] || { scripts: {}, blocked: [] };
    const mine = requests.filter((r) => r.host === url.hostname);
    // A second visit to a site has a query string of its own. Where the
    // extension loaded the page again, the last request is the one that counts.
    const docs = mine.filter((r) => r.path === url.pathname + url.search);
    const doc = docs[docs.length - 1];
    const label = url.hostname + (page.phase ? ` (${page.phase})` : '');
    const fetched = Object.fromEntries(Object.entries(site.scripts).map(([n, src]) => [n, mine.some((r) => r.path === src)]));
    const p = page.page || {};
    const cw = page.contentWorld || {};
    console.log(`\n  -- ${label}: ${site.rule || '?'}`);
    console.log(`     finished=${page.finished} error=${page.navigationError || '-'} hasAccess=${page.hasAccess}`);
    console.log(`     document request${docs.length > 1 ? ` (last of ${docs.length})` : ''}: ${doc ? JSON.stringify({ userAgent: doc.userAgent, referer: doc.referer, cookie: doc.cookie, xForwardedFor: doc.xForwardedFor }) : 'NOT RECEIVED'}`);
    console.log(`     scripts fetched: ${JSON.stringify(fetched)} | ran in page: ${JSON.stringify(p.ran)}`);
    console.log(`     page: ${p.error ? 'ERROR ' + p.error : JSON.stringify({ probes: p.probes, cookie: p.cookie })}`);
    console.log(`     page world: ${JSON.stringify(p.world)}`);
    if (app) console.log(`     style elements the content script added: ${JSON.stringify(p.styles)}`);
    else console.log(`     content world: ${JSON.stringify(cw)}`);
    // A WebDriver session cannot look into the extension's content world; the
    // style elements the content script adds to every supported page can be seen.
    const injected = app ? (p.styles || []).length > 0 : cw.contentScript === true;
    const later = mine.filter((r) => r.path.startsWith('/ok.js'));
    if (later.length) console.log(`     ok.js request: ${JSON.stringify({ userAgent: later[0].userAgent, referer: later[0].referer, cookie: later[0].cookie })}`);

    if (!expect) continue;
    const supported = url.hostname !== 'www.bpc-control.test';
    check(name, page.finished && !page.navigationError && !!doc, `${label}: page loaded`);
    if ((expect === 'working' || app) && supported) {
      for (const [header, pattern] of Object.entries(EXPECTED_HEADERS[url.hostname] || {}))
        check(name, !!doc && pattern.test(doc[header] || ''), `${label}: document request has ${header} matching ${pattern} (got ${JSON.stringify(doc && doc[header])})`);
      if (site.crawler === 'never sent')
        check(name, mine.length > 0 && mine.every((r) => !GOOGLEBOT.test(r.userAgent || '')), `${label}: no request claims to be Googlebot (${mine.filter((r) => GOOGLEBOT.test(r.userAgent || '')).length} of ${mine.length} did)`);
      if (site.crawler === 'found out') {
        // The first visit in a profile finds out; after that the site is remembered.
        const first = !page.phase;
        if (first) check(name, docs.length >= 2 && GOOGLEBOT.test(docs[0].userAgent || ''), `${label}: the first request claimed to be Googlebot and was refused (${docs.length} document requests)`);
        check(name, !!doc && !GOOGLEBOT.test(doc.userAgent || ''), `${label}: the page was then loaded without the Googlebot user agent (got ${JSON.stringify(doc && doc.userAgent)})`);
        check(name, (p.probes || {}).content !== undefined, `${label}: the article is shown, not the denial`);
      }
      for (const blocked of site.blocked)
        check(name, fetched[blocked] === false && !(p.ran || {})[blocked], `${label}: script "${blocked}" is blocked`);
      check(name, fetched.ok === true && (p.ran || {}).ok === '1', `${label}: control script still loads`);
      if (site.world === 'MAIN') {
        const world = p.world || {};
        check(name, world.contentScript === true && world.csLocal === true, `${label}: content scripts injected into the page world`);
        check(name, world.extChromium === true, `${label}: the page-world scripts take the Chromium code path`);
      } else check(name, injected, `${label}: content script injected`);
      for (const probe of site.removed || [])
        check(name, !!p.probes && !(probe in p.probes), `${label}: content script removed the "${probe}" element`);
      if (url.hostname === 'www.hola.com')
        check(name, p.probes && p.probes.ad && p.probes.ad.display === 'none', `${label}: content script hid the advert (display=${p.probes && p.probes.ad && p.probes.ad.display})`);
    } else {
      // Unsupported site, or the extension has no access: nothing may change.
      check(name, !!doc && !GOOGLEBOT.test(doc.userAgent || '') && !/google|drudge/.test(doc.referer || ''), `${label}: request headers untouched`);
      check(name, !injected && !(p.world && p.world.contentScript), `${label}: no content script`);
      if (!supported)
        check(name, Object.values(fetched).every(Boolean), `${label}: no script blocked`);
    }
  }

  if (result.diagnosticsPage) {
    console.log(`\n  diagnostics page (tab ${JSON.stringify(result.diagnosticsTabId)}):`);
    for (const line of result.diagnosticsPage.verdict || [JSON.stringify(result.diagnosticsPage)]) console.log(`      ${line}`);
    for (const line of result.diagnosticsPage.report || []) console.log(`      | ${line.slice(0, 300)}`);
  }

  if (expect === 'working') {
    const bg = result.backgroundAtEnd || {};
    if (result.options && result.options.idle) {
      check(name, result.backgroundUnloadedWhileIdle === true, `the background page was unloaded while idle (${result.options.idle} s), so the pages above had to wake it up`);
      const last = (bg.compat && bg.compat.lastAddCall) || {};
      check(name, last.batchRejected === false, `a later start of the background page installs the rules without a refused attempt (${JSON.stringify(last.batchRejected)})`);
    }
    // The sites that refused the Googlebot user agent in this run are remembered, the known one is listed.
    const found = (result.pages || []).map((pg) => new URL(pg.requested).hostname).filter((h) => (SITES[h] || {}).crawler === 'found out').map((h) => h.replace(/^www\./, ''));
    const refusedBy = (bg.crawler && bg.crawler.refusedBy) || [];
    const rememberedSites = Object.keys((bg.crawler && bg.crawler.stored && bg.crawler.stored.refusedBy) || {});
    check(name, refusedBy.includes('washingtonpost.com') && found.every((d) => refusedBy.includes(d) && rememberedSites.includes(d)), `sites that refuse a fake Googlebot get no crawler user agent (${JSON.stringify(refusedBy)}; found in this run: ${JSON.stringify(found)})`);
    check(name, bg.backgroundLoaded === true, 'background scripts loaded');
    check(name, bg.enabledSites > 500, `sites are enabled (${bg.enabledSites})`);
    check(name, bg.sessionRules > 700, `blocking/header rules are installed (${bg.sessionRules})`);
    const believed = bg.compat && bg.compat.lastAddCall ? bg.compat.lastAddCall.rulesOut : null;
    // One more than the extension's own count: the marker rule that verifies each update.
    check(name, believed !== null && bg.sessionRules === believed + 1, `the rules the extension believes it installed are really there (${believed} + marker vs ${bg.sessionRules})`);
    check(name, !(bg.compat && bg.compat.errors && bg.compat.errors.length), `no uncaught errors in the background page`);
    // Safari reads the background scripts as Windows-1252: "Télérama.fr" used to
    // arrive as "TÃ©lÃ©rama.fr", and the options page then dropped such sites.
    const names = bg.storedSiteNames || [];
    const accented = names.filter((n) => /[^\x00-\x7f]/.test(n.toLowerCase().replace(/\s\(.*\)/, '')));
    const garbled = names.filter((n) => /Ã[^\x00-\x7f]/.test(n));
    check(name, accented.length >= 30 && !garbled.length, `site names with accented letters are stored intact (${accented.length} stored, ${garbled.length} garbled${garbled.length ? ': ' + garbled.slice(0, 3).join(', ') : ''})`);
    storedSites[name] = bg.storedSites;
  }
}

if (appRun) {
  // The real Safari app, driven through safaridriver (safari-app.sh).
  scenario('safari-app', 'app');
  const app = readJSON(path.join(dir, 'safari-app.json')) || {};
  if (!app.skipped && !app.fatal) {
    console.log('\n=== Safari app ===');
    check('safari-app', (app.questions || 0) >= 1, `Safari asked for website access and the question was answered (${app.questions || 0})`);
    const later = (app.pages || []).filter((p) => p.phase);
    if (app.options && app.options.idle) check('safari-app', later.length >= 2 && later.every((p) => p.finished), `pages were visited again after ${app.options.idle} s without events (${later.length})`);
  }
} else {
  scenario('enabled', 'working');
  scenario('legacy', 'working');
  scenario('launch', 'working');
  scenario('idle', 'working');
  scenario('noaccess', 'untouched');
  scenario('private', 'untouched');
  // With the WebKit that ships inside a newer Safari, when the machine has one.
  scenario('staged-enabled', 'working', { optional: true });
  scenario('staged-launch', 'working', { optional: true });

  console.log('\n=== All scenarios ===');
  const counts = [...new Set(Object.values(storedSites))];
  check('all', counts.length === 1, `every scenario stored the same number of sites (${JSON.stringify(storedSites)})`);
}

console.log(`\n=== ${failures.length ? failures.length + ' check(s) failed' : 'all checks passed'} ===`);
for (const f of failures) console.log(`  - ${f}`);
if (failures.length && !noFail) process.exit(1);
