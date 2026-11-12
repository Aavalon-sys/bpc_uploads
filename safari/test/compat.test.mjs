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
