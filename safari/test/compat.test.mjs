// Unit tests of safari-compat.js glue that the background simulation does not
// reach: error capture and the diagnostics message without background.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

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
