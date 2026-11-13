#!/usr/bin/env node
// Drives the real Safari app through safaridriver with the Safari build of the
// extension loaded, and records what happens on the local stand-in sites.
//
//   node safari/engine/safari-app.mjs --extension <dir> --out <result.json>
//        [--driver-port 4477] [--wait 10] [--settle 5]
//        --url <url> [--url <url> ...] [--idle 40 --again <url> ...]
//
// Started by safari-app.sh, which also starts the stand-in sites and points
// the system at them. Safari loads the extension through WebDriver's "Load
// WebExtension" command (Safari 18.4 or later on macOS), as an unpacked
// extension that lives as long as the session.
//
// Unlike the engine test (host.m), nothing here stands in for Safari: tabs,
// windows, permissions and events are Safari's own. A WebDriver session only
// reaches the page, so the checks are about what a page and the server see.
//
// --idle leaves Safari alone for that many seconds after the first round of
// pages. Safari unloads the extension's background page after 30 seconds
// without events; the pages given with --again then have to wake it up.

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

const args = { 'driver-port': '4477', settle: '5', wait: '10', idle: '0', url: [], again: [] };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (key === 'url' || key === 'again') args[key].push(process.argv[i + 1]);
  else args[key] = process.argv[i + 1];
}
if (!args.extension || !args.out || !args.url.length) {
  console.error('usage: safari-app.mjs --extension <dir> --out <result.json> [--driver-port 4477] [--wait 10] [--settle 5] --url <url> ... [--idle 40 --again <url> ...]');
  process.exit(2);
}

const started = Date.now();
const result = { options: { settle: Number(args.settle), idle: Number(args.idle) }, events: [], pages: [] };
const event = (type, detail) => {
  const e = { t: Math.round((Date.now() - started) / 100) / 10, type, detail };
  result.events.push(e);
  console.log(`[${e.t}s] ${type} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 1200));
};
const sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));
const save = () => fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
// A picture of the screen next to the result file, to see what Safari shows.
const screenshot = (name) => {
  try {
    execFileSync('screencapture', ['-x', args.out.replace(/\.json$/, '') + `.${name}.png`], { timeout: 15000, stdio: 'ignore' });
  } catch (e) {
    event('no screenshot', String(e && e.message || e).slice(0, 200));
  }
};

// Safari asks the user before the extension may touch a website, in an alert
// that also stops the WebDriver session. The first one comes right after the
// first start, when the extension looks for updates on gitflic.ru. This
// answers the question the way the README tells users to: remember the choice
// for other websites and always allow. It needs the accessibility permission
// that CI machines give to osascript.
const ANSWER_QUESTIONS = `
on answerIn(theArea, placeName)
  tell application "System Events"
    repeat with theChoice in {"Always Allow on Every Website", "Always Allow", "Continue Session"}
      set choiceName to theChoice as text
      if exists (button choiceName of theArea) then
        set shownText to ""
        try
          set shownText to (value of static texts of theArea) as text
        end try
        try
          set theCheck to first checkbox of theArea
          if value of theCheck is 0 then click theCheck
          delay 0.3
        end try
        click button choiceName of theArea
        return "clicked " & choiceName & " in " & placeName & ": " & shownText
      end if
    end repeat
  end tell
  return ""
end answerIn

tell application "System Events"
  if not (exists process "Safari") then return "none"
  tell process "Safari"
    repeat with theWindow in windows
      -- The question is an alert window of its own, or a sheet on a window.
      set outcome to my answerIn(contents of theWindow, "window")
      if outcome is not "" then return outcome
      if exists sheet 1 of theWindow then
        set outcome to my answerIn(sheet 1 of theWindow, "sheet")
        if outcome is not "" then return outcome
      end if
    end repeat
  end tell
end tell
return "none"
`;
let answering = false;
let lastAnswer = '';
function answerQuestions() {
  if (answering) return;
  answering = true;
  execFile('osascript', ['-e', ANSWER_QUESTIONS], { timeout: 12000 }, (error, stdout, stderr) => {
    answering = false;
    const out = String(stdout || '').trim();
    const text = error ? 'osascript: ' + String(stderr || error.message).trim().slice(0, 300) : out;
    // Logged when it changes: a click or an error.
    if (text && text !== 'none' && text !== lastAnswer) {
      event('question', text.slice(0, 700));
      result.questions = (result.questions || 0) + (text.startsWith('clicked') ? 1 : 0);
      if (text.startsWith('clicked')) screenshot(`answered${result.questions}`);
    }
    lastAnswer = text;
  });
}

const base = `http://127.0.0.1:${args['driver-port']}`;
async function wd(method, path, body, timeoutSeconds = 60) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = { value: { error: 'not json', message: text.slice(0, 300) } };
    }
    return { status: res.status, value: json.value };
  } catch (e) {
    return { status: 0, value: { error: 'request failed', message: String(e && e.message || e) } };
  } finally {
    clearTimeout(timer);
  }
}
const failed = (r) => r.status !== 200 || (r.value && typeof r.value === 'object' && 'error' in r.value);

// What a page can see: scripts that ran, probe elements, style elements the
// content script added, and the content script itself where the extension
// injects it into the page's own world.
const PAGE_PROBE = `
  const out = { url: location.href, title: document.title, userAgent: navigator.userAgent, cookie: document.cookie, ran: {}, probes: {} };
  for (const a of document.documentElement.attributes) if (a.name.startsWith('data-ran-')) out.ran[a.name.slice(9)] = a.value;
  for (const e of document.querySelectorAll('[data-probe]')) out.probes[e.getAttribute('data-probe')] = { display: getComputedStyle(e).display, text: e.textContent.trim().slice(0, 60) };
  out.styles = [...document.querySelectorAll('head > style[id]')].map((s) => s.id);
  out.world = { contentScript: typeof ext_chromium !== 'undefined', extChromium: typeof ext_chromium !== 'undefined' ? ext_chromium : null,
    csLocal: typeof cs_default === 'function', hasChrome: typeof chrome === 'object', hasBrowser: typeof browser === 'object' };
  return JSON.stringify(out);
`;

async function main() {
  // A Safari left over from an earlier session cannot be paired again.
  try {
    execFileSync('pkill', ['-x', 'Safari'], { stdio: 'ignore' });
    await sleep(2);
  } catch (e) {
    // not running
  }
  const driver = spawn('safaridriver', ['-p', args['driver-port']], { stdio: ['ignore', 'pipe', 'pipe'] });
  driver.on('error', (e) => event('safaridriver', String(e && e.message || e)));
  const questions = setInterval(answerQuestions, 2000);
  let sessionId = null;
  try {
    let status = null;
    for (let i = 0; i < 50 && !(status && status.status === 200); i++) {
      await sleep(0.2);
      status = await wd('GET', '/status', undefined, 5);
    }
    event('safaridriver status', status);
    if (!status || status.status !== 200) {
      result.skipped = 'safaridriver did not start on this machine';
      return;
    }

    const session = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } }, 90);
    if (failed(session)) {
      result.skipped = 'Safari gave no WebDriver session: ' + JSON.stringify(session.value).slice(0, 300);
      return;
    }
    sessionId = session.value.sessionId;
    result.capabilities = session.value.capabilities;
    event('session', result.capabilities);
    const s = `/session/${sessionId}`;

    // Load WebExtension. Safari 27 wants {type: "path", path}; the proposed
    // standard says {type: "path", value}.
    let loaded = null;
    let refusal = null;
    for (const body of [{ type: 'path', path: args.extension }, { type: 'path', value: args.extension }]) {
      const res = await wd('POST', `${s}/webextension`, body, 90);
      event('load extension', { body, response: res });
      if (!failed(res)) {
        loaded = res.value;
        break;
      }
      refusal = res;
    }
    result.extension = loaded;
    if (!loaded) {
      // An unknown command is an older Safari; anything else is about the extension.
      const text = JSON.stringify(refusal && refusal.value).slice(0, 300);
      if (refusal && (refusal.status === 404 || /unknown command|unsupported operation/i.test(text))) result.skipped = 'this Safari cannot load an extension through WebDriver: ' + text;
      else result.fatal = 'Safari did not load the extension: ' + text;
      return;
    }
    // First start of the extension: default sites, rules, and Safari's question
    // about website access (see ANSWER_QUESTIONS).
    await sleep(Number(args.wait));
    screenshot('loaded');
    event('windows after the first start', (await wd('GET', `${s}/window/handles`, undefined, 15)).value);
    await wd('POST', `${s}/timeouts`, { pageLoad: 20000, script: 15000 }, 15);

    let failures = 0;
    const visit = async (url, phase) => {
      const page = { requested: url };
      if (phase) page.phase = phase;
      const nav = await wd('POST', `${s}/url`, { url }, 30);
      page.finished = !failed(nav);
      if (!page.finished) page.navigationError = JSON.stringify(nav.value).slice(0, 300);
      event('navigate', { url, ok: page.finished, error: page.navigationError });
      await sleep(Number(args.settle));
      const probe = await wd('POST', `${s}/execute/sync`, { script: PAGE_PROBE, args: [] }, 20);
      try {
        page.page = JSON.parse(probe.value);
      } catch (e) {
        page.page = { error: JSON.stringify(probe.value).slice(0, 300) };
      }
      result.pages.push(page);
      save();
      if (result.pages.length === 1 || !page.finished) screenshot(`page${result.pages.length}`);
      failures = page.finished ? 0 : failures + 1;
      if (failures >= 2) throw new Error('Safari stopped answering WebDriver commands');
    };
    for (const url of args.url) await visit(url);

    if (Number(args.idle) > 0 && args.again.length) {
      event('idle', `${args.idle} s`);
      await sleep(Number(args.idle));
      for (const url of args.again) await visit(url, 'after idle');
    }
  } catch (e) {
    result.fatal = String(e && e.message || e);
    event('fatal', result.fatal);
  } finally {
    clearInterval(questions);
    if (result.fatal) screenshot('fatal');
    if (sessionId) await wd('DELETE', `/session/${sessionId}`, undefined, 20);
    driver.kill();
    save();
  }
}

await main();
console.log(`result written to ${args.out}${result.fatal ? ' (' + result.fatal + ')' : ''}${result.skipped ? ' (skipped: ' + result.skipped + ')' : ''}`);
