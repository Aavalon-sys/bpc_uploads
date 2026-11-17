#!/usr/bin/env node
// Local stand-in for a few supported news sites, used by the WebKit engine
// test (safari/engine/run.sh).
//
//   node server.mjs --cert cert.pem --key key.pem --log requests.jsonl
//                   [--https-port 18443] [--proxy-port 18080]
//
// The proxy port is an HTTP proxy that the test's web views are configured to
// use: it answers every request itself and tunnels every CONNECT to the local
// HTTPS server, whatever the host name. The real sites are never contacted
// and no DNS or /etc/hosts change is needed. For the Safari app test, which
// cannot give Safari a proxy of its own, http://127.0.0.1:<proxy-port>/proxy.pac
// is a proxy auto-configuration that sends only the stand-in sites here.
//
// Every request is appended to the log as one JSON line, which is how the
// test sees the headers WebKit really sent and which scripts were fetched.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// What each test page contains. `blocked` scripts match a block rule of the
// extension for that site and must never be requested; `ok` is a control.
export const SITES = {
  'www.nbcnews.com': {
    rule: 'Googlebot user agent + Google referer',
    scripts: { ok: '/ok.js?n=ok' },
    blocked: [],
  },
  // Three sites that, like the real washingtonpost.com, refuse a request that
  // claims to be Googlebot but does not come from Google's address (Safari
  // cannot send the X-Forwarded-For header that makes it look as if it did).
  'www.washingtonpost.com': {
    rule: 'known to refuse a fake Googlebot: Google referer + blocked script, no Googlebot user agent; the article comes from the crawler\'s copy',
    scripts: { ok: '/ok.js?n=ok', tetro: '/x/tetro-client/a.js?n=tetro' },
    blocked: ['tetro'],
    refusesCrawler: 'stall',
    crawler: 'never sent',
    // Everybody gets the first two paragraphs; Google's crawler, which is a
    // request with its user agent and its address, gets all nine.
    article: { free: 2, all: 9 },
  },
  'www.dallasnews.com': {
    rule: 'never answers a fake Googlebot: the extension finds out and loads the page without the user agent',
    scripts: { ok: '/ok.js?n=ok' },
    blocked: [],
    refusesCrawler: 'stall',
    crawler: 'found out',
  },
  'www.ajc.com': {
    rule: 'answers a fake Googlebot with a denial page: the extension finds out and loads the page without the user agent',
    scripts: { ok: '/ok.js?n=ok' },
    blocked: [],
    refusesCrawler: 'deny',
    crawler: 'found out',
  },
  'www.nytimes.com': {
    rule: 'custom user agent + blocked script (rewritten regex)',
    scripts: { ok: '/ok.js?n=ok', meter: '/meter.js?n=meter' },
    blocked: ['meter'],
  },
  'www.ft.com': {
    rule: 'Google referer, cookies not allowed',
    scripts: { ok: '/ok.js?n=ok' },
    blocked: [],
  },
  'www.wsj.com': {
    rule: 'custom referer',
    scripts: { ok: '/ok.js?n=ok' },
    blocked: [],
  },
  'www.hola.com': {
    rule: 'blocked script + general paywall-script rule + element hidden by the content script',
    // `general` matches a rule that applies to every site ("/paywall/evercookie_get.js").
    scripts: { ok: '/ok.js?n=ok', evolok: '/evolok/ev-em.min.js?n=evolok', general: '/paywall/evercookie_get.js?n=general' },
    blocked: ['evolok', 'general'],
    hidden: ['ad'],
    body: '<div data-ad-title="test" data-probe="ad">ADVERT (the content script hides this)</div>',
  },
  'www.la-croix.com': {
    rule: 'content scripts injected into the page\'s own world (world: "MAIN") hide the advert',
    scripts: { ok: '/ok.js?n=ok' },
    blocked: [],
    // The site code runs in the page world; the extension's content world stays empty.
    world: 'MAIN',
    hidden: ['ad'],
    body: '<div data-gam="banner" data-probe="ad">ADVERT (the content script hides this)</div>',
  },
  // The Hill Insider (2026): the whole article is in the page, and a dialog
  // that the site opens over it stops the page from scrolling.
  'thehill.com': {
    rule: 'Hill Insider dialog over the full article: its script is blocked, the dialog hidden and the page scrolls again',
    scripts: { ok: '/ok.js?n=ok', bcwall: '/wp-content/plugins/lakana/inc/blueconic/scripts/login-registration-bc-wall.js?n=bcwall' },
    blocked: ['bcwall'],
    bodyClass: 'single single-post is-premium the-hill',
    hidden: ['paywall-modal'],
    scrollable: true,
    paragraphs: 12,
    body: `<style>
  html.lr-modal-open { overflow: hidden; height: 100%; }
  .login-registration-modal { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, .8); display: flex; }
  .login-registration-modal[hidden] { display: none; }
  #aria-dialog-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, .5); display: none; }
  #aria-dialog-overlay.is-visible { display: block; }
</style>
<div class="article__text | body-copy | flow">
${Array.from({ length: 12 }, (_, i) => `<p data-n="${i + 1}">Paragraph ${i + 1} of the article says something long enough to count as running text, and then a little more to be safe.</p>`).join('\n')}
</div>
<div id="aria-dialog-overlay"></div>
<div class="lr-login-wrapper"><div id="login-registration-paywall" class="login-registration-modal" data-probe="paywall-modal" hidden><h3>Continue with The Hill Insider</h3></div></div>
<script>
  // What the site's login-registration plugin does on an Insider article.
  setTimeout(function () {
    document.getElementById('login-registration-paywall').removeAttribute('hidden');
    document.getElementById('aria-dialog-overlay').classList.add('is-visible');
    document.documentElement.classList.add('lr-modal-open');
    document.body.style.overflow = 'hidden';
  }, 300);
</script>`,
  },
  // Not a supported site: the extension must leave it alone.
  'www.bpc-control.test': {
    rule: 'control (unsupported site)',
    scripts: { ok: '/ok.js?n=ok', meter: '/meter.js?n=meter' },
    blocked: [],
    body: '<div data-ad-title="test" data-probe="ad">ADVERT (stays visible)</div>',
  },
};

// An article the way washingtonpost.com lays it out: one wrapper per paragraph,
// and after the article what the page shows to everybody.
function article(site, whole) {
  const count = whole ? site.article.all : site.article.free;
  const paragraphs = Array.from({ length: count }, (_, i) => `<div class="article-body" data-qa="article-body"><p data-n="${i + 1}">Paragraph ${i + 1} of the article says something long enough to count as running text, and then a little more to be safe.</p></div>`).join('\n');
  return `<div class="meteredContent grid-center">
${paragraphs}
</div>
<section class="readers"><h2>What readers are saying</h2><p>The conversation explores the subject of the article. Participants share memories and experiences, and some comments reflect on it.</p></section>`;
}

function page(host, crawler = false) {
  const site = SITES[host] || { scripts: { ok: '/ok.js?n=ok' } };
  const scripts = Object.values(site.scripts).map((src) => `<script src="${src}"></script>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Engine test: ${host}</title>
${scripts}
</head><body${site.bodyClass ? ` class="${site.bodyClass}"` : ''}>
<article><h1>Engine test page</h1><p data-probe="content">Article text for ${host}.</p>
${site.article ? article(site, crawler) : ''}</article>
${site.body || ''}
<script>document.documentElement.setAttribute('data-ran-inline', '1');</script>
</body></html>
`;
}

// Proxy auto-configuration for the Safari app test: only the stand-in sites go
// through the local proxy, everything else on the machine stays direct.
function pac(proxyPort) {
  return `function FindProxyForURL(url, host) {
  var hosts = ${JSON.stringify(Object.keys(SITES))};
  return hosts.indexOf(host) >= 0 ? "PROXY 127.0.0.1:${proxyPort}" : "DIRECT";
}
`;
}

function handler(scheme, logFile, proxyPort) {
  return (req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const url = new URL(req.url, `${scheme}://${host}`);
    if (scheme === 'http' && url.pathname === '/proxy.pac' && host === '127.0.0.1') {
      res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'cache-control': 'no-store' });
      res.end(pac(proxyPort));
      return;
    }
    fs.appendFileSync(logFile, JSON.stringify({
      t: new Date().toISOString(),
      scheme,
      host,
      method: req.method,
      path: url.pathname + url.search,
      userAgent: req.headers['user-agent'] || null,
      referer: req.headers.referer || null,
      cookie: req.headers.cookie ?? null,
      xForwardedFor: req.headers['x-forwarded-for'] || null,
      dest: req.headers['sec-fetch-dest'] || null,
    }) + '\n');

    // A site that checks where Googlebot comes from: no answer at all, or a denial.
    const site = SITES[host];
    if (site && site.refusesCrawler && /Googlebot/i.test(req.headers['user-agent'] || '') && !req.headers['x-forwarded-for']) {
      if (site.refusesCrawler === 'stall') return;
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You don\'t have permission to access this page on this server.</p><p>Reference #18.2f3a1602.1700000000.1a2b3c4d</p></body></html>\n');
      return;
    }

    if (url.pathname.endsWith('.js')) {
      const name = (url.searchParams.get('n') || 'script').replace(/[^a-z0-9]/gi, '');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`document.documentElement.setAttribute('data-ran-${name}', '1');\n`);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': 'bpc_engine=1; Path=/; Max-Age=3600',
    });
    // Google's crawler, as far as a server can tell: its user agent from its address.
    res.end(page(host, /Googlebot/i.test(req.headers['user-agent'] || '') && req.headers['x-forwarded-for'] === '66.249.66.1'));
  };
}

function main() {
  const args = { 'https-port': '18443', 'proxy-port': '18080' };
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  if (!args.cert || !args.key || !args.log) {
    console.error('usage: server.mjs --cert cert.pem --key key.pem --log requests.jsonl [--https-port 18443] [--proxy-port 18080]');
    process.exit(2);
  }
  const httpsPort = Number(args['https-port']);
  fs.writeFileSync(args.log, '');
  https.createServer({ cert: fs.readFileSync(args.cert), key: fs.readFileSync(args.key) }, handler('https', args.log))
    .listen(httpsPort, '127.0.0.1', () => console.log(`https on ${httpsPort}`));

  // Plain requests sent to the proxy are answered directly; CONNECT is
  // tunnelled to the HTTPS server above regardless of the requested host.
  const proxy = http.createServer(handler('http', args.log, Number(args['proxy-port'])));
  proxy.on('connect', (req, client, head) => {
    const upstream = net.connect(httpsPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on('error', close);
    client.on('error', close);
  });
  proxy.listen(Number(args['proxy-port']), '127.0.0.1', () => console.log(`proxy on ${args['proxy-port']}`));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()))
  main();
