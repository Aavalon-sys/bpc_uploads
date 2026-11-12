// Runs the extension's background scripts inside a Node VM with a mocked
// WebExtension API, so the declarativeNetRequest rules it generates can be
// inspected without a browser.
//
// flavor 'chrome': Chrome-like API (management + offscreen present, the
//                  background is a service worker that calls importScripts).
// flavor 'safari': Safari-like API (no management, no offscreen, background
//                  scripts listed in manifest.background.scripts) with a DNR
//                  mock that rejects a whole update when one rule is invalid,
//                  using the approximate WebKit rule/regex checks in
//                  webkit-rules.mjs.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { safariRuleProblems, uncompilable, webkitRegexProblem } from './webkit-rules.mjs';

// The rule the Safari build adds to every update to verify it took effect.
const MARKER_ID = 9000000;

function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    listeners,
  };
}

export async function runBackground({
  extDir,
  flavor = 'chrome',
  safariVersion = [17, 0],
  userAgent,
  settleMs = 1500,
  extraRuleCheck = null, // (rule) => problem string or null, to simulate other Safari refusals
  errorStyle = 'plain', // 'webkit': "Rule with id N is invalid. ..." like Safari reports it
  fireInstalled = true, // false: like an extension first loaded while Safari starts (no install event)
  silentRefusal = null, // (rule) => true: Safari accepts the update, cannot compile it and silently restores the old rules
  initialStore = null, // extension storage left by an earlier run
} = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const store = initialStore ? structuredClone(initialStore) : {};
  let silentRollbacks = 0;
  const dnrCalls = [];
  const dnrErrors = [];
  const scriptCalls = [];
  const sessionRules = new Map();
  const errors = [];
  const logs = [];
  const timers = new Set();
  let optionsOpened = 0;
  // Callbacks run asynchronously, like in a browser; exceptions are recorded.
  const later = (fn) => setImmediate(() => {
    try { fn(); } catch (e) { errors.push(e); }
  });

  const runtime = {
    id: 'bpc-test-id',
    lastError: undefined,
    onInstalled: makeEvent(),
    onMessage: makeEvent(),
    onStartup: makeEvent(),
    getManifest: () => structuredClone(manifest),
    getURL: (p) => `${flavor}-extension://bpc-test-id/${String(p).replace(/^\//, '')}`,
    getPlatformInfo: (cb) => {
      const info = { os: 'mac', arch: 'arm' };
      if (cb) later(() => cb(info));
      return Promise.resolve(info);
    },
    openOptionsPage: (cb) => {
      optionsOpened++;
      if (cb) later(cb);
      return Promise.resolve();
    },
    sendMessage: () => Promise.resolve(),
    reload: () => {},
  };

  const storageChanged = makeEvent();
  const storage = {
    onChanged: storageChanged,
    local: {
      get(defaults, cb) {
        let result = {};
        if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
          for (const [k, v] of Object.entries(defaults))
            result[k] = k in store ? structuredClone(store[k]) : v;
        } else if (typeof defaults === 'string') {
          if (defaults in store) result[defaults] = structuredClone(store[defaults]);
        } else if (Array.isArray(defaults)) {
          for (const k of defaults) if (k in store) result[k] = structuredClone(store[k]);
        } else {
          result = structuredClone(store);
        }
        if (cb) later(() => cb(result));
        return Promise.resolve(result);
      },
      set(obj, cb) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: store[k], newValue: structuredClone(v) };
          store[k] = structuredClone(v);
        }
        later(() => {
          for (const l of storageChanged.listeners) {
            try { l(structuredClone(changes), 'local'); } catch (e) { errors.push(e); }
          }
          if (cb) cb();
        });
        return Promise.resolve();
      },
      remove(keys, cb) {
        for (const k of [].concat(keys)) delete store[k];
        if (cb) later(cb);
        return Promise.resolve();
      },
    },
  };

  function applyDnrUpdate(opts) {
    const add = (opts && opts.addRules) || [];
    const remove = new Set((opts && opts.removeRuleIds) || []);
    const problems = [];
    const seen = new Set();
    const problem = (id, text) => problems.push(errorStyle === 'webkit' ? `Rule with id ${id} is invalid. ${text}` : `rule ${id}: ${text}`);
    for (const rule of add) {
      if (seen.has(rule.id)) problem(rule.id, 'duplicate id in addRules');
      seen.add(rule.id);
      if (!remove.has(rule.id) && sessionRules.has(rule.id)) problem(rule.id, 'id already exists');
      if (flavor === 'safari')
        for (const p of safariRuleProblems(rule, safariVersion)) problem(rule.id, p);
      const extra = extraRuleCheck && extraRuleCheck(rule);
      if (extra) problem(rule.id, extra);
    }
    if (problems.length) return problems;
    if (add.some((rule) => (flavor === 'safari' && uncompilable(rule)) || (silentRefusal && silentRefusal(rule)))) {
      // Stored, failed to compile, rolled back: nothing changes, no error.
      silentRollbacks++;
      return null;
    }
    for (const id of remove) sessionRules.delete(id);
    for (const rule of add) sessionRules.set(rule.id, structuredClone(rule));
    return null;
  }

  const declarativeNetRequest = {
    updateSessionRules(opts, cb) {
      dnrCalls.push(structuredClone(opts));
      const problems = applyDnrUpdate(opts);
      if (problems) {
        dnrErrors.push(problems);
        const err = new Error(problems[0]);
        if (cb) {
          later(() => {
            runtime.lastError = { message: err.message };
            try { cb(); } finally { runtime.lastError = undefined; }
          });
          return undefined;
        }
        // Rejected but marked as handled: callers that ignore the result behave
        // like in a browser (the error is only logged) without failing Node.
        const rejected = Promise.reject(err);
        rejected.catch(() => {});
        return rejected;
      }
      if (cb) { later(cb); return undefined; }
      return Promise.resolve();
    },
    getSessionRules(arg1, arg2) {
      const cb = typeof arg1 === 'function' ? arg1 : arg2;
      const rules = [...sessionRules.values()].map((r) => structuredClone(r));
      if (cb) { later(() => cb(rules)); return undefined; }
      return Promise.resolve(rules);
    },
    isRegexSupported(opts, cb) {
      const reason = webkitRegexProblem(opts.regex);
      const result = reason ? { isSupported: false, reason: 'syntaxError' } : { isSupported: true };
      if (cb) { later(() => cb(result)); return undefined; }
      return Promise.resolve(result);
    },
  };

  const api = {
    runtime,
    storage,
    declarativeNetRequest,
    tabs: {
      onUpdated: makeEvent(),
      onActivated: makeEvent(),
      query: (q, cb) => { if (cb) later(() => cb([])); return Promise.resolve([]); },
      get: (id, cb) => { if (cb) later(() => cb({ id })); return Promise.resolve({ id }); },
      reload: () => Promise.resolve(),
      update: () => Promise.resolve(),
      create: () => Promise.resolve(),
      sendMessage: () => Promise.resolve(),
      executeScript: () => {},
    },
    windows: { onFocusChanged: makeEvent() },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
      setIcon: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
    },
    cookies: {
      getAllCookieStores: (cb) => { const s = [{ id: '0', tabIds: [] }]; if (cb) later(() => cb(s)); return Promise.resolve(s); },
      getAll: (o, cb) => { if (cb) later(() => cb([])); return Promise.resolve([]); },
      remove: () => Promise.resolve(),
    },
    permissions: {
      contains: (p, cb) => { if (cb) later(() => cb(true)); return Promise.resolve(true); },
      request: (p, cb) => { if (cb) later(() => cb(true)); return Promise.resolve(true); },
      remove: (p, cb) => { if (cb) later(() => cb(true)); return Promise.resolve(true); },
    },
    scripting: {
      executeScript: (details) => {
        scriptCalls.push(JSON.parse(JSON.stringify(details, (k, v) => (typeof v === 'function' ? '[function]' : v))));
        return Promise.resolve([{ frameId: 0, result: undefined }]);
      },
    },
    webRequest: {
      onBeforeRequest: makeEvent(),
      onHeadersReceived: makeEvent(),
      onBeforeSendHeaders: makeEvent(),
      OnBeforeSendHeadersOptions: {},
    },
    extension: { inIncognitoContext: false },
  };
  if (flavor === 'safari') {
    // Make sure the build does not depend on adding properties to the API
    // namespace (the compat layer's management polyfill then has no effect).
    Object.preventExtensions(api);
  }
  if (flavor === 'chrome') {
    api.management = {
      getSelf: (cb) => { const r = { installType: 'normal' }; if (cb) later(() => cb(r)); return Promise.resolve(r); },
    };
    api.offscreen = {
      Reason: { DOM_PARSER: 'DOM_PARSER' },
      createDocument: () => Promise.resolve(),
      closeDocument: () => Promise.resolve(),
    };
  }

  const ua = userAgent || (flavor === 'safari'
    ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${safariVersion.join('.')} Safari/605.1.15`
    : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');

  const sandbox = {
    console: {
      log: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push('[warn] ' + a.join(' ')),
      error: (...a) => logs.push('[error] ' + a.join(' ')),
      info: (...a) => logs.push(a.join(' ')),
      debug: () => {},
    },
    navigator: { userAgent: ua, language: 'en-US', languages: ['en-US'] },
    fetch: () => Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('offline')), text: () => Promise.resolve('') }),
    setTimeout: (fn, ms, ...args) => { const t = setTimeout(() => { timers.delete(t); try { fn(...args); } catch (e) { errors.push(e); } }, ms); t.unref(); timers.add(t); return t; },
    clearTimeout: (t) => { clearTimeout(t); timers.delete(t); },
    setInterval: (fn, ms) => { const t = setInterval(() => { try { fn(); } catch (e) { errors.push(e); } }, ms); t.unref(); timers.add(t); return t; },
    clearInterval: (t) => { clearInterval(t); timers.delete(t); },
    queueMicrotask,
    structuredClone,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    chrome: api,
  };
  if (flavor === 'safari') sandbox.browser = api;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const runFile = (rel) => {
    const file = path.join(extDir, rel.replace(/^\//, ''));
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  };
  if (flavor === 'chrome') sandbox.importScripts = (...files) => files.forEach(runFile);

  let loadError = null;
  try {
    const bg = manifest.background || {};
    if (bg.service_worker && flavor === 'chrome') runFile(bg.service_worker);
    else for (const s of bg.scripts || []) runFile(s);
  } catch (e) {
    loadError = e;
  }

  // Simulate a fresh install: the browser fires runtime.onInstalled.
  if (!loadError && fireInstalled) {
    later(() => {
      for (const l of runtime.onInstalled.listeners) {
        try { l({ reason: 'install' }); } catch (e) { errors.push(e); }
      }
    });
  }
  await new Promise((r) => setTimeout(r, settleMs));

  return {
    api,
    settle: (ms = settleMs) => new Promise((r) => setTimeout(r, ms)),
    currentRules: () => [...sessionRules.values()].filter((r) => r.id !== MARKER_ID).map((r) => structuredClone(r)),
    currentMarker: () => structuredClone(sessionRules.get(MARKER_ID) || null),
    silentRollbacks: () => silentRollbacks,
    manifest,
    loadError,
    errors,
    logs,
    dnrCalls,
    dnrErrors,
    scriptCalls,
    // Without the marker rule the Safari build adds to verify its updates.
    sessionRules: [...sessionRules.values()].filter((r) => r.id !== MARKER_ID),
    optionsOpened,
    store,
    sandbox,
  };
}
