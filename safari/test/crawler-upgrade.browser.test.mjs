// Runs crawlerUpgrade() of safari-compat.js, the code that puts the article
// from the crawler's copy into a page, in a real browser against local pages.
//
// It needs Playwright with a browser (any engine). Where that is not
// installed, as on the CI machine that runs the other tests, it is skipped:
// the WebKit engine test and the Safari app test (safari/engine) cover the
// same code in Safari's own engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const compatFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'safari-compat.js');

let playwright = null;
try {
  playwright = createRequire(import.meta.url)('playwright');
} catch (e) {
  // not installed
}

// crawlerUpgrade as source text, the way scripting.executeScript ships it.
function upgradeSource() {
  const sandbox = { navigator: { userAgent: 'Version/18.4 Safari' }, console, setTimeout, clearTimeout, addEventListener() {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(compatFile, 'utf8'), sandbox);
  return sandbox.bpcSafari._crawler.upgrade.toString();
}

const sentence = (i) => `Paragraph ${i} of the article says something long enough to count as running text, and then a little more to be safe.`;
const paragraphs = (from, to, wrap = (p) => p) => Array.from({ length: to - from + 1 }, (_, k) => wrap(`<p data-n="${from + k}">${sentence(from + k)}</p>`)).join('\n');
const FURNITURE = '<nav><p>Navigation text that is long enough to look like a paragraph but is part of the page furniture, not of the article.</p></nav>';
const READERS = '<section class="readers"><h2>What readers are saying</h2><p>The conversation explores the subject of the article. Participants share memories and experiences, and some comments reflect on it.</p></section>';

// Each page has the free beginning for everybody and the whole article for the crawler.
const PAGES = {
  // One wrapper per paragraph, like on washingtonpost.com.
  '/wrapped': (full) => `<main><article><div class="meteredContent">
    ${paragraphs(1, full ? 9 : 2, (p) => `<div class="article-body" data-qa="article-body">${p}</div>`)}
    ${full ? '<div class="article-body"><img data-src="/picture.png" alt="x"><script>window.ranFromCopy = true;</script><a href="#" onclick="window.clicked = true">link</a></div>' : ''}
    </div>${READERS}</article></main>`,
  // Paragraphs straight in the article element.
  '/plain': (full) => `<div id="story" class="story">${paragraphs(1, full ? 8 : 2)}</div>${READERS}`,
  // The short version uses another class on the same element, and other text.
  '/renamed': (full) => (full
    ? `<div id="article-body" class="body">${paragraphs(1, 8)}</div>`
    : `<div id="article-body" class="body teaser"><p>${sentence(1).replace('Paragraph', 'Teaser')}</p></div>${READERS}`),
  // Nothing to gain: the page already has everything.
  '/complete': () => `<article class="a">${paragraphs(1, 6)}</article>`,
  // The copy has no element the page could be matched to.
  '/unrelated': (full) => (full ? `<div>${paragraphs(1, 9)}</div>` : `<section>${'<p>' + sentence(50) + '</p>'}</section>`),
  // The crawler is refused.
  '/refused': (full) => (full ? null : `<article class="a">${paragraphs(1, 2)}</article>`),
};

function serve() {
  const requests = [];
  const server = http.createServer((req, res) => {
    // Chromium does not let a script set User-Agent (WebKit does), so the address alone decides here.
    const full = req.headers['x-forwarded-for'] === '66.249.66.1';
    requests.push({ path: req.url, userAgent: req.headers['user-agent'], forwardedFor: req.headers['x-forwarded-for'] || null });
    const page = PAGES[req.url.split('?')[0]];
    const body = page && page(full);
    if (!body) {
      res.writeHead(page ? 403 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Access Denied</title>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body>${FURNITURE}${body}</body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, origin: `http://127.0.0.1:${server.address().port}` })));
}

const CONFIG = { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', forwardedFor: '66.249.66.1', timeout: 5000 };
// What a reader sees: the numbers of the article paragraphs that are displayed.
const SHOWN = `[...document.querySelectorAll('p[data-n]')].filter((p) => p.offsetParent !== null).map((p) => Number(p.dataset.n))`;

test('the article from the crawler\'s copy, in a browser', { skip: playwright ? false : 'Playwright is not installed' }, async (t) => {
  const source = upgradeSource();
  const { server, requests, origin } = await serve();
  const browser = await playwright.chromium.launch();
  t.after(async () => {
    await browser.close();
    server.close();
  });
  const upgrade = async (page) => page.evaluate(`(${source})(${JSON.stringify(CONFIG)})`);
  const open = async (pathname) => {
    const page = await browser.newPage();
    await page.goto(origin + pathname);
    return page;
  };

  await t.test('the request carries the crawler\'s user agent and address', async () => {
    const page = await open('/wrapped');
    requests.length = 0;
    await upgrade(page);
    // The page itself is asked for once more; the copy's picture is another request.
    const again = requests.filter((r) => r.path === '/wrapped');
    assert.equal(again.length, 1);
    assert.equal(again[0].forwardedFor, '66.249.66.1');
    if (browser.browserType().name() === 'webkit') assert.match(again[0].userAgent, /Googlebot/);
  });

  await t.test('one wrapper per paragraph: the whole article is shown', async () => {
    const page = await open('/wrapped');
    assert.deepEqual(await page.evaluate(SHOWN), [1, 2]);
    const note = await upgrade(page);
    assert.equal(note.outcome, 'article replaced', JSON.stringify(note));
    assert.equal(note.by, 'text');
    assert.equal(note.article, 'div.meteredContent');
    assert.deepEqual(await page.evaluate(SHOWN), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(note.before, { paragraphs: 3, characters: note.before.characters });
    assert.equal(note.after.paragraphs, 10);
    // The rest of the page stays where it was, after the article.
    assert.equal(await page.evaluate(`document.querySelector('[data-bpc-safari-crawler="article"]').nextElementSibling.className`), 'readers');
    assert.equal(await page.evaluate(`document.documentElement.getAttribute('data-bpc-safari-crawler')`), 'replaced');
    // Nothing from the copy runs, and its lazy picture gets an address.
    assert.equal(await page.evaluate('window.ranFromCopy'), undefined);
    assert.equal(await page.evaluate(`document.querySelector('[data-bpc-safari-crawler="article"] script')`), null);
    assert.equal(await page.evaluate(`document.querySelector('[data-bpc-safari-crawler="article"] a').getAttribute('onclick')`), null);
    assert.equal(await page.evaluate(`document.querySelector('[data-bpc-safari-crawler="article"] img').getAttribute('src')`), '/picture.png');
    // A second call in the same page does nothing.
    assert.equal(await upgrade(page), null);
    assert.deepEqual(await page.evaluate(SHOWN), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  await t.test('paragraphs straight in the article element', async () => {
    const page = await open('/plain');
    const note = await upgrade(page);
    assert.equal(note.outcome, 'article replaced', JSON.stringify(note));
    assert.equal(note.article, 'div#story.story');
    assert.deepEqual(await page.evaluate(SHOWN), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  await t.test('a short version with other text is matched by the element\'s name', async () => {
    const page = await open('/renamed');
    const note = await upgrade(page);
    assert.equal(note.outcome, 'article replaced', JSON.stringify(note));
    assert.equal(note.by, 'name');
    assert.deepEqual(await page.evaluate(SHOWN), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.teaser')).display`), 'none');
  });

  await t.test('the page\'s scripts undoing the change are undone', async () => {
    const page = await open('/wrapped');
    await upgrade(page);
    // A script of the page shows its own element again and throws the new one out.
    await page.evaluate(`document.querySelector('.meteredContent:not([data-bpc-safari-crawler="article"])').style.display = ''; document.querySelector('[data-bpc-safari-crawler="article"]').remove();`);
    assert.deepEqual(await page.evaluate(SHOWN), [1, 2]);
    await page.waitForTimeout(900);
    assert.deepEqual(await page.evaluate(SHOWN), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // It replaces its element by a new one of the same kind.
    await page.evaluate(`{ const old = document.querySelector('.meteredContent:not([data-bpc-safari-crawler="article"])'); const next = old.cloneNode(true); next.removeAttribute('style'); old.replaceWith(next); }`);
    await page.waitForTimeout(900);
    assert.deepEqual(await page.evaluate(SHOWN), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  await t.test('pages that are left as they are', async () => {
    const complete = await open('/complete');
    assert.equal((await upgrade(complete)).outcome, 'no more text in the copy');
    assert.deepEqual(await complete.evaluate(SHOWN), [1, 2, 3, 4, 5, 6]);
    assert.equal(await complete.evaluate(`document.documentElement.getAttribute('data-bpc-safari-crawler')`), 'unchanged');

    const unrelated = await open('/unrelated');
    const note = await upgrade(unrelated);
    assert.equal(note.outcome, 'article element not found in the page', JSON.stringify(note));
    assert.equal(await unrelated.evaluate(`document.querySelectorAll('[data-bpc-safari-crawler="article"]').length`), 0);

    const refused = await open('/refused');
    assert.equal((await upgrade(refused)).outcome, 'request failed: status 403');
    assert.deepEqual(await refused.evaluate(SHOWN), [1, 2]);

    // Inside a frame nothing is done.
    const framed = await open('/complete');
    await framed.setContent(`<iframe src="${origin}/wrapped"></iframe>`);
    const frame = framed.frames().find((f) => f.url().endsWith('/wrapped')) || (await framed.waitForEvent('framenavigated'));
    await frame.waitForLoadState();
    assert.equal(await frame.evaluate(`(${source})(${JSON.stringify(CONFIG)})`), null);
  });
});
