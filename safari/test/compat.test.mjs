// Unit tests of safari-compat.js glue that the background simulation does not
// reach: error capture and the diagnostics message without background.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { garble } from './harness.mjs';

const compatFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'safari-compat.js');

function loadCompat(initialStorage = {}) {
  const windowListeners = {};
  const messageListeners = [];
  const stored = { ...initialStorage };
  let optionsOpened = 0;
  const sandbox = {
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15' },
    console,
    setTimeout,
    addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    browser: {
      runtime: {
        id: 'x',
        getManifest: () => ({ name: 'Bypass Paywalls Clean', version: '1' }),
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        openOptionsPage: () => { optionsOpened++; return Promise.resolve(); },
      },
      storage: {
        local: {
          set: (o) => { Object.assign(stored, o); return Promise.resolve(); },
          get: (keys) => Promise.resolve(Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]]))),
        },
      },
      declarativeNetRequest: {},
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(compatFile, 'utf8'), sandbox, { filename: compatFile });
  return { sandbox, windowListeners, messageListeners, stored, optionsOpened: () => optionsOpened };
}

test('uncaught background errors are recorded and reported', () => {
  const { sandbox, windowListeners, messageListeners } = loadCompat();
  windowListeners.error[0]({ message: 'TypeError: x is undefined', filename: 'safari-web-extension://id/background.js', lineno: 42 });
  windowListeners.unhandledrejection[0]({ reason: new Error('boom') });
  const errors = sandbox.bpcSafari.report.errors;
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /TypeError: x is undefined @ background\.js:42/);
  assert.match(errors[1].message, /unhandled rejection: boom/);

  let reply;
  messageListeners[0]({ request: 'bpcSafariDiag', url: 'https://example.com/' }, {}, (r) => { reply = r; });
  assert.equal(reply.backgroundLoaded, false); // background.js is not loaded in this test
  assert.equal(reply.errors.length, 2);
  assert.deepEqual([...reply.safariVersion], [18, 4]);
  assert.equal(reply.legacyDomainKeys, false);
});

test('only the diagnostics request is answered', () => {
  const { messageListeners } = loadCompat();
  let called = false;
  const ret = messageListeners[0]({ request: 'clear_cookies' }, {}, () => { called = true; });
  assert.equal(called, false);
  assert.equal(ret, undefined);
});

test('first run: defaults are set exactly once per profile', async () => {
  const { sandbox, stored } = loadCompat();
  let calls = 0;
  const setDefaults = () => { calls++; stored.sites = { A: 'a.com' }; };
  // The install event and the start-up timer may both ask.
  const [a, b] = await Promise.all([sandbox.bpcSafari.firstRun(setDefaults), sandbox.bpcSafari.firstRun(setDefaults)]);
  assert.deepEqual([a, b], [true, true]);
  assert.equal(calls, 1);
  assert.ok(stored.bpc_safari_first_run);

  // Next start of the background page (or a repeated install event): nothing happens.
  const later = loadCompat(stored);
  assert.equal(await later.sandbox.bpcSafari.firstRun(() => assert.fail('must not run again')), false);
});

test('first run: sites stored by an earlier build are kept', async () => {
  // Builds before the first-run marker stored sites on the install event.
  const { sandbox, stored } = loadCompat({ sites: { A: 'a.com' } });
  assert.equal(await sandbox.bpcSafari.firstRun(() => assert.fail('must not overwrite stored sites')), false);
  assert.ok(stored.bpc_safari_first_run, 'marker is written so the check is not repeated');
  assert.deepEqual(stored.sites, { A: 'a.com' });
});

test('first run: an empty site list from an earlier build is initialised', async () => {
  // What users of the earlier builds have when Safari never sent the install event.
  const { sandbox, stored } = loadCompat({ sites: {} });
  let calls = 0;
  assert.equal(await sandbox.bpcSafari.firstRun(() => { calls++; }), true);
  assert.equal(calls, 1);
  assert.ok(stored.bpc_safari_first_run);
});

test('the options page is opened once when several callers ask at start-up', async () => {
  const { sandbox, optionsOpened } = loadCompat();
  await Promise.all([sandbox.bpcSafari.openOptionsPage(), sandbox.bpcSafari.openOptionsPage(), sandbox.bpcSafari.openOptionsPage()]);
  assert.equal(optionsOpened(), 1);
});

// --- Site lists stored by earlier builds -----------------------------------
// Released Safari versions read the background scripts as Latin-1 (Windows
// 1252), so earlier builds stored the accented site names garbled, and the
// options page then saved the list without the sites it could not match.

const DEFAULTS = {
  '* BPC settings': { domain: '###' },
  'Enable new sites by default': { domain: '#options_enable_new_sites' },
  'Check for update rules at startup': { domain: '#options_optin_update_rules' },
  '* Default sites': { domain: '###' },
  ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Site ${i}`, { domain: `site${i}.com` }])),
  'Télérama.fr': { domain: 'telerama.fr' },
  'El Español': { domain: 'elespanol.com' },
  'Ärzte Zeitung': { domain: 'aerztezeitung.de' },
  'O Globo (& Valor Econômico)': { domain: 'oglobo.globo.com' },
  'German group (Köln)': { domain: '###_de_group', group: ['a.de', 'b.de'] },
};
const ACCENTED = ['Télérama.fr', 'El Español', 'Ärzte Zeitung'];
// What setDefaultOptions() of background.js stores, and the names background.js records as known.
const enabledByDefault = (names) => Object.fromEntries(names.filter((n) => !/^(###$|#options_(disable|optin)_)/.test(DEFAULTS[n].domain)).map((n) => [n, DEFAULTS[n].domain]));
const knownNames = (names) => names.filter((n) => !/^(#options_|###$)/.test(DEFAULTS[n].domain));
const ALL = Object.keys(DEFAULTS);

test('garble() reads UTF-8 the way Safari did', () => {
  assert.equal(garble('Télérama.fr'), 'TÃ©lÃ©rama.fr');
  assert.equal(garble('Ärzte Zeitung'), 'Ã„rzte Zeitung');
  assert.equal(garble('plain'), 'plain');
});

test('stored sites: garbled names get the names of sites.js back', async () => {
  // Safari sent no install event: the background stored its own (garbled) view.
  const garbledSites = Object.fromEntries(Object.entries(enabledByDefault(ALL)).map(([name, domain]) => [garble(name), domain]));
  const { sandbox, stored } = loadCompat({ sites: garbledSites, sites_default: knownNames(ALL).map(garble) });
  const result = await sandbox.bpcSafari.repairSiteNames(DEFAULTS);
  assert.deepEqual({ renamed: result.renamed, restored: result.restored, known: result.known }, { renamed: 5, restored: 0, known: 5 });
  assert.deepEqual({ ...stored.sites }, enabledByDefault(ALL));
  assert.deepEqual(Object.keys(stored.sites), Object.keys(enabledByDefault(ALL)), 'the order of the list is kept');
  assert.deepEqual([...stored.sites_default].sort(), knownNames(ALL).sort());
  assert.ok(stored.bpc_safari_site_names);
  assert.equal(sandbox.bpcSafari.report.siteNames, result);
});

test('stored sites: the sites the options page dropped are enabled again', async () => {
  // The options page matched every name but the accented ones and saved the rest.
  const kept = enabledByDefault(ALL.filter((n) => !ACCENTED.includes(n)));
  const { sandbox, stored } = loadCompat({ sites: kept, sites_default: knownNames(ALL).map(garble), sites_excluded: ['elespanol.com'] });
  const result = await sandbox.bpcSafari.repairSiteNames(DEFAULTS);
  assert.equal(result.renamed, 0);
  assert.equal(result.restored, 2, 'an excluded site stays off');
  assert.deepEqual(Object.keys(stored.sites).sort(), ALL.filter((n) => n in enabledByDefault(ALL) && n !== 'El Español').sort());
  assert.equal(stored.sites['Télérama.fr'], 'telerama.fr');
});

test('stored sites: a few disabled sites do not stop the repair', async () => {
  const kept = enabledByDefault(ALL.filter((n) => !ACCENTED.includes(n) && n !== 'Site 3' && n !== 'Site 4'));
  const { sandbox, stored } = loadCompat({ sites: kept });
  const result = await sandbox.bpcSafari.repairSiteNames(DEFAULTS);
  assert.equal(result.restored, 3);
  assert.ok(!('Site 3' in stored.sites) && !('Site 4' in stored.sites), 'sites the user disabled stay off');
});

test('stored sites: a list the user cut down is left alone', async () => {
  const chosen = { 'Site 1': 'site1.com', 'Site 2': 'site2.com' };
  const { sandbox, stored } = loadCompat({ sites: { ...chosen } });
  const result = await sandbox.bpcSafari.repairSiteNames(DEFAULTS);
  assert.deepEqual({ renamed: result.renamed, restored: result.restored }, { renamed: 0, restored: 0 });
  assert.deepEqual(stored.sites, chosen);
});

test('stored sites: accented sites the user kept are not joined by the others', async () => {
  // Some accented names are stored correctly: the user ticked them in the options page.
  const kept = enabledByDefault(ALL.filter((n) => n !== 'El Español' && n !== 'Ärzte Zeitung'));
  const { sandbox, stored } = loadCompat({ sites: { ...kept } });
  const result = await sandbox.bpcSafari.repairSiteNames(DEFAULTS);
  assert.equal(result.restored, 0);
  assert.deepEqual(stored.sites, kept);
});

test('stored sites: nothing to do in a new profile or with a correct list', async () => {
  const fresh = loadCompat();
  const first = await fresh.sandbox.bpcSafari.repairSiteNames(DEFAULTS);
  assert.deepEqual({ renamed: first.renamed, restored: first.restored, known: first.known }, { renamed: 0, restored: 0, known: 0 });
  assert.ok(!('sites' in fresh.stored), 'an empty list must stay empty for the first-time setup');
  assert.ok(fresh.stored.bpc_safari_site_names);

  const good = loadCompat({ sites: enabledByDefault(ALL), sites_default: knownNames(ALL) });
  const second = await good.sandbox.bpcSafari.repairSiteNames(DEFAULTS);
  assert.deepEqual({ renamed: second.renamed, restored: second.restored, known: second.known }, { renamed: 0, restored: 0, known: 0 });
  assert.deepEqual(good.stored.sites, enabledByDefault(ALL));
  assert.deepEqual(good.stored.sites_default, knownNames(ALL));
});

test('stored sites: the repair runs once per profile', async () => {
  const kept = enabledByDefault(ALL.filter((n) => !ACCENTED.includes(n)));
  const { sandbox, stored } = loadCompat({ sites: kept });
  assert.equal((await sandbox.bpcSafari.repairSiteNames(DEFAULTS)).restored, 3);
  // The user then disables the accented sites on purpose.
  stored.sites = { ...kept };
  const later = loadCompat(stored);
  assert.equal(await later.sandbox.bpcSafari.repairSiteNames(DEFAULTS), null);
  assert.deepEqual(later.stored.sites, kept);
});

test('stored sites: custom and updated sites keep their names', async () => {
  const custom = { 'Zeitung für Alle': { domain: 'custom.de' } };
  const updated = { 'Nouveauté': { domain: 'nouveaute.fr' } };
  const sites = { ...enabledByDefault(ALL), 'Zeitung für Alle': 'custom.de', 'Nouveauté': 'nouveaute.fr' };
  // background.js merges the updated sites into defaultSites before the repair runs.
  const defaults = { ...DEFAULTS, ...updated };
  const { sandbox, stored } = loadCompat({ sites: { ...sites }, sites_custom: custom, sites_updated: updated, sites_default: [...knownNames(ALL), 'Zeitung für Alle'] });
  const result = await sandbox.bpcSafari.repairSiteNames(defaults);
  assert.deepEqual({ renamed: result.renamed, restored: result.restored, known: result.known }, { renamed: 0, restored: 0, known: 0 });
  assert.deepEqual(stored.sites, sites);
  assert.deepEqual(stored.sites_default, [...knownNames(ALL), 'Zeitung für Alle']);
});

test('stored sites: a storage failure is recorded, not thrown', async () => {
  const { sandbox } = loadCompat();
  sandbox.browser.storage.local.get = () => Promise.reject(new Error('storage is gone'));
  assert.equal(await sandbox.bpcSafari.repairSiteNames(DEFAULTS), null);
  assert.match(JSON.stringify(sandbox.bpcSafari.report.errors), /site name repair failed: storage is gone/);
});

// --- Sites that refuse a crawler's user agent --------------------------------
// Safari cannot send X-Forwarded-For, so a Googlebot rule claims to be Googlebot
// from the user's own address. A site that answers that with nothing, or with
// a denial, is found when it is visited and gets the rule without the user agent.

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const crawlerRule = (id, domain) => ({
  id,
  priority: 1,
  action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: GOOGLEBOT }, { header: 'Referer', operation: 'set', value: 'https://www.google.com/' }] },
  condition: { urlFilter: '||' + domain, resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script'] },
});
const ARTICLE_PAGE = { title: 'An article', length: 6000, text: 'A long article about something.' };
const DENIAL_PAGE = { title: 'Access Denied', length: 140, text: "Access Denied You don't have permission to access this page on this server." };
const XFF_REFUSED = { bpc_safari_refused_2: { safari: '18,4', rules: [], headers: ['x-forwarded-for'] } };
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

// The compat layer with a browser in which navigations can be played out.
function crawlerWorld({ stored = XFF_REFUSED, rules = [crawlerRule(1, 'example-news.com'), crawlerRule(2, 'other-news.com')] } = {}) {
  const world = { timers: [], tabUpdates: [], dnrUpdates: [], tabStatus: 'loading', page: ARTICLE_PAGE, stored: structuredClone(stored) };
  const listeners = { onBeforeNavigate: [], onCommitted: [], onCompleted: [], onRemoved: [] };
  const sessionRules = new Map(rules.map((r) => [r.id, structuredClone(r)]));
  const event = (name) => ({ addListener: (fn) => listeners[name].push(fn) });
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const sandbox = {
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15' },
    console: { info() {}, log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, fired: false }; world.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    addEventListener() {},
    browser: {
      runtime: { id: 'x', getManifest: () => ({ name: 'Bypass Paywalls Clean', version: '1' }), onMessage: { addListener() {} } },
      storage: {
        local: {
          set: (o) => { Object.assign(world.stored, plain(o)); return Promise.resolve(); },
          get: (keys) => Promise.resolve(Object.fromEntries(keys.filter((k) => k in world.stored).map((k) => [k, plain(world.stored[k])]))),
        },
      },
      declarativeNetRequest: {
        getSessionRules: () => Promise.resolve([...sessionRules.values()].map(plain)),
        updateSessionRules: (o) => {
          world.dnrUpdates.push(plain(o));
          (o.removeRuleIds || []).forEach((id) => sessionRules.delete(id));
          (o.addRules || []).forEach((r) => sessionRules.set(r.id, plain(r)));
          return Promise.resolve();
        },
      },
      webNavigation: { onBeforeNavigate: event('onBeforeNavigate'), onCommitted: event('onCommitted'), onCompleted: event('onCompleted') },
      tabs: {
        onRemoved: event('onRemoved'),
        get: (id) => Promise.resolve({ id, status: world.tabStatus }),
        update: (id, properties) => { world.tabUpdates.push({ id, ...plain(properties) }); return Promise.resolve({ id }); },
      },
      scripting: { executeScript: () => Promise.resolve([{ frameId: 0, result: world.page }]) },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(compatFile, 'utf8'), sandbox, { filename: compatFile });
  world.crawler = sandbox.bpcSafari._crawler;
  world.bpcSafari = sandbox.bpcSafari;
  world.rule = (id) => (sessionRules.has(id) ? plain(sessionRules.get(id)) : null);
  world.headers = (id) => (world.rule(id) ? world.rule(id).action.requestHeaders.map((h) => h.header) : null);
  world.fire = async (name, details) => { listeners[name].forEach((fn) => fn(details)); await flush(); };
  // The timers that wait for the first answer of a navigation.
  world.waiting = () => world.timers.filter((t) => !t.cleared && !t.fired && t.ms === world.crawler.STALL_MS);
  world.timeOut = async () => {
    const [timer] = world.waiting();
    assert.ok(timer, 'no navigation is being waited for');
    timer.fired = true;
    timer.fn();
    await flush();
  };
  // One main-frame navigation from start to finish.
  world.load = async (tabId, url) => {
    await world.fire('onBeforeNavigate', { tabId, frameId: 0, url });
    await world.fire('onCommitted', { tabId, frameId: 0, url });
    await world.fire('onCompleted', { tabId, frameId: 0, url });
  };
  return world;
}
const NEWS = 'https://www.example-news.com/2026/article.html';

test('crawler: a site that never answers gets the rule without the user agent, and the page is loaded again', async () => {
  const world = crawlerWorld();
  await world.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  assert.equal(world.waiting().length, 1, 'the navigation is watched');
  assert.deepEqual(world.headers(1), ['User-Agent', 'Referer']);

  await world.timeOut();
  assert.deepEqual(world.headers(1), ['Referer'], 'the rule lost the crawler user agent');
  assert.deepEqual(world.headers(2), ['User-Agent', 'Referer'], 'other sites keep theirs');
  assert.deepEqual(world.tabUpdates, [{ id: 5, url: NEWS }]);
  assert.equal(world.crawler.refusedBy['example-news.com'].tentative, true);
  assert.ok(!('bpc_safari_crawler' in world.stored), 'nothing is remembered before the repeated load worked');

  // The repeated navigation loads.
  await world.load(5, NEWS);
  const entry = world.crawler.refusedBy['example-news.com'];
  assert.equal(entry.tentative, undefined);
  assert.equal(entry.times, 1);
  assert.match(entry.reason, /no answer within 12 s/);
  assert.ok(Math.abs(entry.until - (Date.now() + 24 * 3600 * 1000)) < 60000, 'remembered for a day the first time');
  assert.deepEqual(Object.keys(world.stored.bpc_safari_crawler.refusedBy), ['example-news.com']);
  assert.deepEqual(world.tabUpdates.length, 1, 'the page is repeated once');
  assert.deepEqual(world.headers(1), ['Referer']);

  // Later visits are not watched any more.
  await world.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  assert.equal(world.waiting().length, 0);
});

test('crawler: a denial page has the same effect', async () => {
  const world = crawlerWorld();
  world.page = DENIAL_PAGE;
  await world.load(7, NEWS);
  assert.deepEqual(world.headers(1), ['Referer']);
  assert.deepEqual(world.tabUpdates, [{ id: 7, url: NEWS }]);
  world.page = ARTICLE_PAGE;
  await world.load(7, NEWS);
  assert.match(world.crawler.refusedBy['example-news.com'].reason, /denied \("Access Denied"\)/);
  assert.equal(world.crawler.refusedBy['example-news.com'].times, 1);
});

test('crawler: when the page fails without the user agent too, the user agent comes back', async () => {
  const world = crawlerWorld();
  await world.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  await world.timeOut();
  assert.deepEqual(world.headers(1), ['Referer']);
  // The repeated navigation gets no answer either: the network, not the user agent.
  await world.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  await world.timeOut();
  assert.deepEqual(world.headers(1), ['User-Agent', 'Referer'], 'the rule is as it was');
  assert.deepEqual(world.rule(1), crawlerRule(1, 'example-news.com'));
  assert.ok(!('example-news.com' in world.crawler.refusedBy));
  assert.ok(world.crawler.cleared['example-news.com'] > Date.now() - 60000);
  assert.ok(world.stored.bpc_safari_crawler.cleared['example-news.com']);
  assert.equal(world.tabUpdates.length, 1, 'no third attempt');
  // Not examined again for now.
  await world.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  assert.equal(world.waiting().length, 0);

  // The same with a denial both times (a site that blocks this visitor whatever it sends).
  const denied = crawlerWorld();
  denied.page = DENIAL_PAGE;
  await denied.load(3, NEWS);
  await denied.load(3, NEWS);
  assert.deepEqual(denied.headers(1), ['User-Agent', 'Referer']);
  assert.ok(denied.crawler.cleared['example-news.com']);
  assert.equal(denied.tabUpdates.length, 1);
});

test('crawler: a load that ended, was replaced or answered in time is left alone', async () => {
  // The user stopped the load, or it failed: the tab is not loading any more.
  const stopped = crawlerWorld();
  await stopped.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  stopped.tabStatus = 'complete';
  await stopped.timeOut();
  assert.deepEqual(stopped.headers(1), ['User-Agent', 'Referer']);
  assert.deepEqual(stopped.tabUpdates, []);

  // The user went somewhere else in the same tab.
  const replaced = crawlerWorld();
  await replaced.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  await replaced.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: 'https://unrelated.example/' });
  assert.equal(replaced.waiting().length, 0);

  // The tab was closed.
  const closed = crawlerWorld();
  await closed.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  await closed.fire('onRemoved', 5);
  assert.equal(closed.waiting().length, 0);

  // The site answers and shows an article: fine with the user agent, and not watched again.
  const fine = crawlerWorld();
  await fine.load(5, NEWS);
  assert.deepEqual(fine.headers(1), ['User-Agent', 'Referer']);
  assert.deepEqual(fine.tabUpdates, []);
  assert.equal(fine.crawler.fine['example-news.com'], true);
  await fine.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  assert.equal(fine.waiting().length, 0);

  // Frames inside a page, and sites without a crawler rule, are not watched.
  const other = crawlerWorld();
  await other.fire('onBeforeNavigate', { tabId: 5, frameId: 3, url: NEWS });
  await other.fire('onBeforeNavigate', { tabId: 6, frameId: 0, url: 'https://unrelated.example/' });
  await other.fire('onBeforeNavigate', { tabId: 7, frameId: 0, url: 'https://example-news.com.evil.example/' });
  assert.equal(other.waiting().length, 0);
});

test('crawler: nothing is watched while Safari accepts X-Forwarded-For', async () => {
  const world = crawlerWorld({ stored: {} });
  await world.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  assert.equal(world.waiting().length, 0);
  world.page = DENIAL_PAGE;
  await world.load(5, NEWS);
  assert.deepEqual(world.headers(1), ['User-Agent', 'Referer']);
  assert.deepEqual(world.tabUpdates, []);
});

test('crawler: the second time a site does it, it is remembered for a month', async () => {
  const day = 24 * 3600 * 1000;
  // Found once before; that day is over, so the user agent is being sent again.
  const stored = { ...XFF_REFUSED, bpc_safari_crawler: { refusedBy: { 'example-news.com': { reason: 'no answer within 12 s', since: '2026-11-01T00:00:00.000Z', until: Date.now() - 2 * day, times: 1 } }, cleared: {} } };
  const world = crawlerWorld({ stored });
  await world.fire('onBeforeNavigate', { tabId: 5, frameId: 0, url: NEWS });
  assert.equal(world.waiting().length, 1, 'watched again after the day is over');
  await world.timeOut();
  await world.load(5, NEWS);
  const entry = world.crawler.refusedBy['example-news.com'];
  assert.equal(entry.times, 2);
  assert.ok(Math.abs(entry.until - (Date.now() + 30 * day)) < 60000);

  // A remembered site is not sent the user agent when the rules are next built.
  const later = crawlerWorld({ stored: world.stored, rules: [] });
  await later.bpcSafari.updateSessionRules({ addRules: [crawlerRule(1, 'example-news.com'), crawlerRule(2, 'other-news.com'), crawlerRule(3, 'washingtonpost.com')] });
  assert.deepEqual(later.headers(1), ['Referer']);
  assert.deepEqual(later.headers(2), ['User-Agent', 'Referer']);
  assert.deepEqual(later.headers(3), ['Referer'], 'washingtonpost.com is known from the start');
});

test('crawler: what reads like a denial and what does not', () => {
  const { crawler } = crawlerWorld();
  for (const page of [
    DENIAL_PAGE,
    { title: '403 Forbidden', length: 30, text: 'nginx' },
    { title: 'Just a moment...', length: 80, text: 'Checking your browser before accessing the site.' },
    { title: 'example.com', length: 200, text: 'Please verify you are a human to continue.' },
    { title: '', length: 90, text: 'Your request was blocked. Reference #18.2f3a' },
  ]) assert.equal(crawler.looksDenied(page), true, JSON.stringify(page));
  for (const page of [
    ARTICLE_PAGE,
    { title: 'Access denied to protesters at city hall', length: 9000, text: 'A long article ...' },
    { title: 'Short page', length: 300, text: 'Subscribe to read the rest of this story.' },
    null,
    { title: 'x' },
  ]) assert.equal(crawler.looksDenied(page), false, JSON.stringify(page));
  assert.equal(crawler.ruleDomain(crawlerRule(1, 'Example-News.com')), 'example-news.com');
  assert.equal(crawler.ruleDomain({ condition: { requestDomains: ['a.example'] } }), 'a.example');
  assert.equal(crawler.ruleDomain({ condition: { regexFilter: 'x' } }), '');
});

test('crawler: the diagnostics name the sites that get no crawler user agent', async () => {
  const world = crawlerWorld();
  await world.bpcSafari.updateSessionRules({ addRules: [crawlerRule(3, 'washingtonpost.com')] });
  const info = world.bpcSafari._diagnostics('https://www.washingtonpost.com/world/2026/article/');
  assert.deepEqual([...info.crawlerRefusedBy], ['washingtonpost.com']);
  assert.equal(info.siteRefusesCrawler, true);
  assert.equal(world.bpcSafari._diagnostics('https://www.example-news.com/').siteRefusesCrawler, false);
});
