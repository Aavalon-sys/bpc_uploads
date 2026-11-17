// Checks the site fixes of the Safari build (SITE_FIXES in build.mjs) in a
// real browser, on local copies of the pages they are for.
//
// It needs Playwright with a browser. Where that is not installed, as on the
// CI machine that runs the other tests, it is skipped: the WebKit engine test
// and the Safari app test (safari/engine) cover The Hill as well.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';

let playwright = null;
try {
  playwright = createRequire(import.meta.url)('playwright');
} catch (e) {
  // not installed
}

// The style the extension gives The Hill, from the built sites.js.
function hillStyle() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-site-fixes-'));
  try {
    build({ out });
    const sandbox = { chrome: { runtime: { getManifest: () => ({ key: 'x' }) } } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(out, 'sites.js'), 'utf8'), sandbox);
    return sandbox.defaultSites['The Hill'].cs_code[0].add_style;
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

const paragraph = (i) => `<p data-n="${i}">Paragraph ${i} of the article says something long enough to count as running text, and then a little more to be safe.</p>`;

// A The Hill article as the site builds it (see the page source in the pull
// request): the whole text, the Insider dialog after it, and a script that
// opens the dialog and stops the page from scrolling.
function hillPage({ premium = true, opens = 'paywall' } = {}) {
  return `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>The Hill</title>
<style>
  html.lr-modal-open { overflow: hidden; height: 100%; }
  .login-registration-modal { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, .8); display: flex; }
  .login-registration-modal[hidden] { display: none; }
  #aria-dialog-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, .5); display: none; z-index: 999; }
  #aria-dialog-overlay.is-visible { display: block; }
  p { margin: 0 0 400px; }
</style></head>
<body class="single single-post${premium ? ' is-premium' : ''} the-hill">
<div id="page" class="site"><article class="article__content"><h1 class="page-title">Senate Democrats prepare to flex new oversight powers against Musk</h1>
<div class="article__text | body-copy | flow">${Array.from({ length: 12 }, (_, i) => paragraph(i + 1)).join('\n')}</div></article></div>
<div id="aria-dialog-overlay"></div>
<div class="lr-login-wrapper">
  <div id="login-registration-signup" class="login-registration-modal" hidden><h2>Sign In or create a new account.</h2></div>
  <div id="login-registration-paywall" class="login-registration-modal" hidden><h3>Continue with The Hill Insider</h3></div>
</div>
<script>
  setTimeout(function () {
    document.getElementById('login-registration-${opens}').removeAttribute('hidden');
    document.getElementById('aria-dialog-overlay').classList.add('is-visible');
    document.documentElement.classList.add('lr-modal-open');
    document.body.style.overflow = 'hidden';
    document.documentElement.setAttribute('data-opened', '1');
  }, 50);
</script></body></html>`;
}

const STATE = `({
  paywall: getComputedStyle(document.getElementById('login-registration-paywall')).display,
  signup: getComputedStyle(document.getElementById('login-registration-signup')).display,
  overlay: getComputedStyle(document.getElementById('aria-dialog-overlay')).display,
  overflow: [getComputedStyle(document.documentElement).overflowY, getComputedStyle(document.body).overflowY],
  shown: [...document.querySelectorAll('p[data-n]')].filter((p) => p.offsetParent !== null).length,
})`;

test('site fixes in a browser', { skip: playwright ? false : 'Playwright is not installed' }, async (t) => {
  const css = hillStyle();
  const pages = {
    '/premium': hillPage(),
    '/free-sign-in': hillPage({ premium: false, opens: 'signup' }),
    '/premium-sign-in': hillPage({ opens: 'signup' }),
  };
  const server = http.createServer((req, res) => {
    res.writeHead(pages[req.url] ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pages[req.url] || '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await playwright.chromium.launch();
  t.after(async () => {
    await browser.close();
    server.close();
  });
  // Opens a page, waits for its script, and adds the extension's style like the content script does.
  const open = async (pathname, withStyle) => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(origin + pathname);
    await page.waitForFunction(() => document.documentElement.getAttribute('data-opened') === '1');
    if (withStyle) await page.evaluate((text) => { const s = document.createElement('style'); s.id = 'add6'; s.innerText = text; document.head.appendChild(s); }, css);
    const state = await page.evaluate(STATE);
    // Scrolling the way a reader does (a script may scroll a page that does not let the reader).
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(400);
    state.scrolled = await page.evaluate('window.scrollY');
    return state;
  };

  await t.test('The Hill: without the extension the dialog covers the article and the page does not scroll', async () => {
    const state = await open('/premium', false);
    assert.equal(state.paywall, 'flex');
    assert.deepEqual(state.overflow, ['hidden', 'hidden']);
    assert.equal(state.scrolled, 0);
  });

  await t.test('The Hill: with it the dialog is gone and the whole article can be read', async () => {
    const state = await open('/premium', true);
    assert.equal(state.paywall, 'none');
    assert.equal(state.overlay, 'none');
    assert.ok(!state.overflow.includes('hidden'), JSON.stringify(state.overflow));
    assert.ok(state.scrolled > 0, 'the page scrolls');
    assert.equal(state.shown, 12);
  });

  await t.test('The Hill: the sign-in dialog of a free article still works as the site wants', async () => {
    const state = await open('/free-sign-in', true);
    assert.equal(state.signup, 'flex');
    assert.equal(state.overlay, 'block');
    assert.deepEqual(state.overflow, ['hidden', 'hidden']);
    // On an Insider article the sign-in dialog shows too, but the page stays scrollable.
    const premium = await open('/premium-sign-in', true);
    assert.equal(premium.signup, 'flex');
  });
});
