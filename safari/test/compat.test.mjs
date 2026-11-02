// Unit tests of safari-compat.js glue that the background simulation does not
// reach: error capture and the diagnostics message without background.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const compatFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'safari-compat.js');

function loadCompat() {
  const windowListeners = {};
  const messageListeners = [];
  const stored = {};
  const sandbox = {
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15' },
    console,
    setTimeout,
    addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    browser: {
      runtime: { id: 'x', getManifest: () => ({ name: 'Bypass Paywalls Clean', version: '1' }), onMessage: { addListener: (fn) => messageListeners.push(fn) } },
      storage: { local: { set: (o) => { Object.assign(stored, o); return Promise.resolve(); } } },
      declarativeNetRequest: {},
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(compatFile, 'utf8'), sandbox, { filename: compatFile });
  return { sandbox, windowListeners, messageListeners, stored };
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
