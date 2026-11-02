// Runs safari-diagnostics.js against a fake page and browser API to check the
// conclusions it shows for typical situations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'safari-diagnostics.js');
const ARTICLE = 'https://www.nytimes.com/2024/05/01/world/some-article.html';

function fakePage() {
  const elements = {};
  const el = (id) => (elements[id] = elements[id] || {
    id, value: '', textContent: '', children: [], listeners: {},
    appendChild(child) { this.children.push(child); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    select() {},
  });
  ['verdict', 'report', 'copy', 'reload'].forEach(el);
  return {
    elements,
    document: {
      getElementById: (id) => el(id),
      createElement: () => ({ className: '', textContent: '' }),
      execCommand: () => true,
    },
  };
}

async function runDiagnostics(api, search = '?tab=7&url=' + encodeURIComponent(ARTICLE)) {
  const page = fakePage();
  const sandbox = {
    document: page.document,
    location: { search, href: 'safari-web-extension://id/safari-diagnostics.html' + search },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1' },
    URL, URLSearchParams, JSON, Promise, Array, Object, String, Number, Date,
    browser: api,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(script, 'utf8'), sandbox, { filename: script });
  await new Promise((r) => setTimeout(r, 50));
  const verdict = page.elements.verdict.children.map((li) => `${li.className}: ${li.textContent}`);
  return { verdict, report: page.elements.report.value };
}

function api({ siteAccess = true, origins = ['<all_urls>'], background, injected = true, sites = 700 } = {}) {
  return {
    runtime: {
      getManifest: () => ({ name: 'Bypass Paywalls Clean', version: '4.4.8.4', update_url: 'x', key: 'k' }),
      sendMessage: () => (background instanceof Error ? Promise.reject(background) : Promise.resolve(background)),
    },
    permissions: {
      getAll: () => Promise.resolve({ permissions: ['storage', 'scripting'], origins }),
      contains: () => Promise.resolve(siteAccess),
    },
    storage: { local: { get: () => Promise.resolve({ sites: Object.fromEntries(Array.from({ length: sites }, (_, i) => [`s${i}`, `d${i}.com`])), optIn: false }) } },
    declarativeNetRequest: {
      getSessionRules: () => Promise.resolve([{ id: 1, action: { type: 'block' }, condition: { domains: ['nytimes.com'] } }, { id: 2, action: { type: 'modifyHeaders' }, condition: { urlFilter: '||example.com' } }]),
      getMatchedRules: () => Promise.resolve({ rulesInfo: [] }),
    },
    scripting: {
      executeScript: () => (siteAccess
        ? Promise.resolve([{ result: { contentScript: injected, href: ARTICLE } }])
        : Promise.reject(new Error('Invalid call to scripting.executeScript(). this extension does not have access to this tab.'))),
    },
  };
}

const healthy = { backgroundLoaded: true, enabledSites: 930, siteEnabled: true, siteDomain: 'nytimes.com', errors: [], lastAddCall: { rulesIn: 770, rulesOut: 1081, dropped: {}, batchRejected: false } };

test('no site access: tells the user to allow the website, with macOS and iOS steps', async () => {
  const { verdict, report } = await runDiagnostics(api({ siteAccess: false, origins: [], background: healthy }));
  assert.ok(verdict.some((v) => v.startsWith('bad: ') && v.includes('没有访问当前网站的权限') && v.includes('iPhone/iPad')), verdict.join('\n'));
  assert.ok(verdict.some((v) => v.includes('无法检测当前页面') && v.includes('does not have access')), verdict.join('\n'));
  assert.match(report, /access to current site: false/);
  assert.match(report, /session rules mentioning nytimes\.com: \["1:block"\]/);
});

test('everything fine: reports the injected content script', async () => {
  const { verdict, report } = await runDiagnostics(api({ background: healthy }));
  assert.deepEqual(verdict.filter((v) => !v.startsWith('ok: ')), []);
  assert.ok(verdict.some((v) => v.includes('已注入')));
  assert.match(report, /granted origins: 1 \(all websites\)/);
  assert.match(report, /session rules: \{"total":2,"byType":\{"block":1,"modifyHeaders":1\}\}/);
});

test('background not answering, no sites enabled, script missing', async () => {
  const { verdict } = await runDiagnostics(api({ background: new Error('Could not establish connection'), sites: 0, injected: false }));
  const text = verdict.join('\n');
  assert.match(text, /bad: .*后台页没有响应.*Could not establish connection/);
  assert.match(text, /bad: .*一个站点都没有启用/);
  assert.match(text, /bad: .*脚本没有注入/);
});

test('opened without a tab: asks to open it from the popup and skips the tab checks', async () => {
  const { verdict, report } = await runDiagnostics(api({ origins: ['*://*.nytimes.com/*'], background: healthy }), '');
  assert.match(report, /current site: \(not opened from the popup\)/);
  assert.doesNotMatch(report, /content script probe/);
  assert.ok(verdict.some((v) => v.startsWith('warn: ') && v.includes('只授予了 1 个网站')), verdict.join('\n'));
});
