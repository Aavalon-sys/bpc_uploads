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
// and no DNS or /etc/hosts change is needed.
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
  'www.washingtonpost.com': {
    rule: 'Googlebot user agent + Google referer + blocked script',
    scripts: { ok: '/ok.js?n=ok', tetro: '/x/tetro-client/a.js?n=tetro' },
    blocked: ['tetro'],
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
    rule: 'blocked script + element hidden by the content script',
    scripts: { ok: '/ok.js?n=ok', evolok: '/evolok/ev-em.min.js?n=evolok' },
    blocked: ['evolok'],
    body: '<div data-ad-title="test" data-probe="ad">ADVERT (the content script hides this)</div>',
  },
  // Not a supported site: the extension must leave it alone.
  'www.bpc-control.test': {
    rule: 'control (unsupported site)',
    scripts: { ok: '/ok.js?n=ok', meter: '/meter.js?n=meter' },
    blocked: [],
    body: '<div data-ad-title="test" data-probe="ad">ADVERT (stays visible)</div>',
  },
};

function page(host) {
  const site = SITES[host] || { scripts: { ok: '/ok.js?n=ok' } };
  const scripts = Object.values(site.scripts).map((src) => `<script src="${src}"></script>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Engine test: ${host}</title>
${scripts}
</head><body>
<article><h1>Engine test page</h1><p data-probe="content">Article text for ${host}.</p></article>
${site.body || ''}
<script>document.documentElement.setAttribute('data-ran-inline', '1');</script>
</body></html>
`;
}

function handler(scheme, logFile) {
  return (req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const url = new URL(req.url, `${scheme}://${host}`);
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
    res.end(page(host));
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
  const proxy = http.createServer(handler('http', args.log));
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
