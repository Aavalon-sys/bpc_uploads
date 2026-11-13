/*
 * Safari compatibility layer for Bypass Paywalls Clean.
 *
 * Loaded as the first background script of the Safari build (before sites.js
 * and background.js, see safari/build.mjs). It fills the gaps between the
 * Chrome (MV3) code path of the extension and Safari's WebExtension support:
 *
 *  - management.getSelf() does not exist in Safari: bpcSafari.getSelf() stands
 *    in for it (background.js call sites are rewritten at build time).
 *  - The offscreen API does not exist in Safari: the Safari background is a
 *    (non-persistent) page that has DOMParser, so bpcSafari.offscreenParse()
 *    does the work of options/offscreen.js in place.
 *  - declarativeNetRequest in Safari accepts a subset of what Chrome accepts,
 *    and one invalid rule makes the whole updateSessionRules() call fail.
 *    bpcSafari.updateSessionRules() adapts each rule first:
 *      * initiatorDomains / excludedInitiatorDomains -> domains /
 *        excludedDomains on Safari < 18.4,
 *      * removes empty excluded-domain lists: Chrome reads them as "no
 *        exclusion", Safari cannot compile them and then discards every
 *        rule (the general paywall-script rules have such a list whenever
 *        no site is disabled, which is the default),
 *      * drops responseHeaders (not supported by Safari),
 *      * removes request headers Safari refuses to modify (Safari 18 only
 *        accepts a fixed list, without X-Forwarded-For) and keeps the rest
 *        of the rule,
 *      * rewrites regexFilter patterns that WebKit cannot compile
 *        (alternation, {n,m}, \d \w \s, ...) into one or more equivalent
 *        patterns, each becoming its own rule,
 *    and, if Safari still rejects the batch, applies it in halves to isolate
 *    and skip the rules Safari refuses.
 *    Safari also reports success when the rule list then fails to compile: it
 *    silently restores the previous rules. Every update therefore carries a
 *    marker rule and is verified afterwards; a rolled back update is applied
 *    in halves to find the rule Safari cannot compile, which is remembered.
 *  - Safari sends no install event to an extension that is first loaded while
 *    Safari starts, so the default sites were never enabled there:
 *    bpcSafari.firstRun() does the first-time setup exactly once, with or
 *    without that event.
 *  - Earlier Safari builds stored site names with accented letters garbled,
 *    after which the options page disabled those sites:
 *    bpcSafari.repairSiteNames() puts such a stored list right.
 *  - Without X-Forwarded-For, a Googlebot rule claims to be Googlebot from an
 *    address that is not Google's. Sites that answer that with nothing or with
 *    a denial (washingtonpost.com) get the rule without its User-Agent; such
 *    sites are found as they are visited.
 */
(function (root) {
  'use strict';

  var EXTRA_ID_BASE = 10000000; // upstream rule ids are small sequential numbers
  var EXTRA_ID_STRIDE = 64;     // max variants per upstream rule
  var MAX_VARIANTS = EXTRA_ID_STRIDE;

  function Unsupported(message) {
    this.name = 'Unsupported';
    this.message = message;
  }
  Unsupported.prototype = Object.create(Error.prototype);

  // ---------------------------------------------------------------------------
  // Regex handling
  // ---------------------------------------------------------------------------

  // Strict approximation of the regex subset WebKit content blockers compile.
  // Used to decide when to rewrite a pattern; Safari's own
  // declarativeNetRequest.isRegexSupported() is consulted as well.
  function webkitRegexProblem(re) {
    if (typeof re !== 'string' || re === '') return 'empty pattern';
    var inClass = false;
    for (var i = 0; i < re.length; i++) {
      var c = re[i];
      if (c.charCodeAt(0) > 0x7f) return 'non-ASCII character';
      if (c === '\\') {
        var n = re[i + 1];
        if (n === undefined) return 'trailing backslash';
        if ('dDwWsS'.indexOf(n) >= 0) return 'built-in character class \\' + n;
        if (!inClass && 'bB'.indexOf(n) >= 0) return 'word boundary';
        if (!inClass && /[1-9]/.test(n)) return 'back-reference';
        i++;
        continue;
      }
      if (inClass) {
        if (c === ']') inClass = false;
        continue;
      }
      if (c === '[') {
        inClass = true;
        if (re[i + 1] === '^') i++;
        if (re[i + 1] === ']') i++;
        continue;
      }
      if (c === '|') return 'disjunction';
      if (c === '{' && /^\{\d+(,\d*)?\}/.test(re.slice(i))) return 'brace quantifier';
      if (c === '(' && re[i + 1] === '?') {
        var rest = re.slice(i + 2, i + 4);
        if (rest[0] === '=' || rest[0] === '!' || rest === '<=' || rest === '<!') return 'lookaround';
      }
      if (c === '^' && i !== 0) return 'misplaced ^';
      if (c === '$' && i !== re.length - 1) return 'misplaced $';
      if ('*+?'.indexOf(c) >= 0 && re[i + 1] === '?' && i > 0) return 'non-greedy quantifier';
    }
    if (inClass) return 'unterminated character class';
    try {
      new RegExp(re);
    } catch (e) {
      return 'invalid JavaScript regex';
    }
    return null;
  }

  var CONTROL_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f', '\v': '\\v', '\0': '\\0' };

  function escapeChar(ch, inClass) {
    if (CONTROL_ESCAPES[ch]) return CONTROL_ESCAPES[ch];
    var special = inClass ? '\\]^-[' : '\\^$.|?*+()[]{}';
    return special.indexOf(ch) >= 0 ? '\\' + ch : ch;
  }

  function parseRegex(src) {
    var i = 0;

    function fail(msg) {
      throw new SyntaxError(msg + ' at ' + i + ' in ' + src);
    }

    function asciiChar(ch) {
      if (ch.charCodeAt(0) > 0x7f) throw new Unsupported('non-ASCII character');
      return ch;
    }

    function hexEscape(len) {
      var hex = src.substr(i, len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return null;
      i += len;
      return String.fromCharCode(parseInt(hex, 16));
    }

    // Escape outside a character class -> {type:'raw', text} atom.
    function parseEscape() {
      var n = src[i + 1];
      if (n === undefined) fail('trailing backslash');
      i += 2;
      switch (n) {
        case 'd': return { type: 'raw', text: '[0-9]' };
        case 'D': return { type: 'raw', text: '[^0-9]' };
        case 'w': return { type: 'raw', text: '[A-Za-z0-9_]' };
        case 'W': return { type: 'raw', text: '[^A-Za-z0-9_]' };
        case 's': return { type: 'raw', text: '[ ]' };   // URLs never contain other whitespace
        case 'S': return { type: 'raw', text: '[^ ]' };
        case 'b': case 'B': throw new Unsupported('word boundary');
        case 'c': throw new Unsupported('control escape');
        case 'k': throw new Unsupported('named back-reference');
        case 'p': case 'P': throw new Unsupported('unicode property escape');
        case 'x': case 'u': {
          var ch = hexEscape(n === 'x' ? 2 : 4);
          if (ch === null) return { type: 'raw', text: n }; // identity escape
          return { type: 'raw', text: escapeChar(asciiChar(ch), false) };
        }
        case 'n': case 'r': case 't': case 'f': case 'v':
          return { type: 'raw', text: '\\' + n };
        case '0':
          if (/[0-9]/.test(src[i] || '')) throw new Unsupported('octal escape');
          return { type: 'raw', text: '\\0' };
        default:
          if (/[1-9]/.test(n)) throw new Unsupported('back-reference');
          if (/[A-Za-z]/.test(n)) return { type: 'raw', text: n }; // identity escape
          return { type: 'raw', text: '\\' + asciiChar(n) }; // escaped punctuation, kept as written
      }
    }

    function readClassAtom() {
      var c = src[i];
      if (c === undefined) fail('unterminated character class');
      if (c !== '\\') {
        i++;
        return { kind: 'char', ch: asciiChar(c) };
      }
      var n = src[i + 1];
      if (n === undefined) fail('trailing backslash');
      i += 2;
      switch (n) {
        case 'd': return { kind: 'set', text: '0-9' };
        case 'w': return { kind: 'set', text: 'A-Za-z0-9_' };
        case 's': return { kind: 'set', text: ' ' };
        case 'D': case 'W': case 'S': return { kind: 'negset', of: n.toLowerCase() };
        case 'b': return { kind: 'char', ch: '\b' };
        case 'n': return { kind: 'char', ch: '\n' };
        case 'r': return { kind: 'char', ch: '\r' };
        case 't': return { kind: 'char', ch: '\t' };
        case 'f': return { kind: 'char', ch: '\f' };
        case 'v': return { kind: 'char', ch: '\v' };
        case '0': return { kind: 'char', ch: '\0' };
        case 'c': case 'p': case 'P': throw new Unsupported('unsupported escape in class');
        case 'x': case 'u': {
          var ch = hexEscape(n === 'x' ? 2 : 4);
          return { kind: 'char', ch: ch === null ? n : asciiChar(ch) };
        }
        default:
          return { kind: 'char', ch: asciiChar(n) };
      }
    }

    function parseClass() {
      i++; // [
      var negated = false;
      if (src[i] === '^') {
        negated = true;
        i++;
      }
      var items = [];
      while (src[i] !== ']') {
        if (i >= src.length) fail('unterminated character class');
        var item = readClassAtom();
        if (item.kind === 'char' && src[i] === '-' && src[i + 1] !== ']' && src[i + 1] !== undefined) {
          i++; // -
          var to = readClassAtom();
          if (to.kind === 'char') {
            if (to.ch.charCodeAt(0) < item.ch.charCodeAt(0)) fail('range out of order');
            items.push({ kind: 'range', from: item.ch, to: to.ch });
          } else {
            items.push(item, { kind: 'char', ch: '-' }, to);
          }
          continue;
        }
        items.push(item);
      }
      i++; // ]
      var negsets = items.filter(function (x) { return x.kind === 'negset'; });
      var base = { d: '0-9', w: 'A-Za-z0-9_', s: ' ' };
      if (negsets.length) {
        if (items.length !== 1) throw new Unsupported('negated escape inside a class');
        return { type: 'raw', text: '[' + (negated ? '' : '^') + base[negsets[0].of] + ']' };
      }
      if (!items.length) {
        if (negated) return { type: 'raw', text: '.' };
        throw new Unsupported('empty character class');
      }
      var body = '';
      items.forEach(function (it) {
        if (it.kind === 'char') body += escapeChar(it.ch, true);
        else if (it.kind === 'range') body += escapeChar(it.from, true) + '-' + escapeChar(it.to, true);
        else body += it.text;
      });
      return { type: 'raw', text: '[' + (negated ? '^' : '') + body + ']' };
    }

    function parseQuant() {
      var c = src[i];
      var q = null;
      if (c === '*') q = { min: 0, max: Infinity };
      else if (c === '+') q = { min: 1, max: Infinity };
      else if (c === '?') q = { min: 0, max: 1 };
      if (q) {
        i++;
      } else if (c === '{') {
        var m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
        if (!m) return null;
        var min = parseInt(m[1], 10);
        var max = m[2] === undefined ? min : (m[3] === '' ? Infinity : parseInt(m[3], 10));
        if (max < min) fail('quantifier range out of order');
        q = { min: min, max: max, braces: true };
        i += m[0].length;
      }
      if (q && src[i] === '?') {
        q.lazy = true;
        i++;
      }
      return q;
    }

    function parseAtom() {
      var c = src[i];
      if (c === '(') {
        i++;
        var capture = true;
        if (src[i] === '?') {
          var n = src[i + 1];
          if (n === ':') {
            capture = false;
            i += 2;
          } else if (n === '<' && src[i + 2] !== '=' && src[i + 2] !== '!') {
            var end = src.indexOf('>', i);
            if (end < 0) fail('unterminated group name');
            i = end + 1; // named group: treated as a plain capturing group
          } else {
            throw new Unsupported('lookaround');
          }
        }
        var alt = parseAlt();
        if (src[i] !== ')') fail('missing )');
        i++;
        return { type: 'group', capture: capture, alt: alt };
      }
      if (c === '[') return parseClass();
      if (c === '\\') return parseEscape();
      if (c === '.') {
        i++;
        return { type: 'raw', text: '.' };
      }
      if (c === '^') {
        i++;
        return { type: 'bol' };
      }
      if (c === '$') {
        i++;
        return { type: 'eol' };
      }
      if (c === '*' || c === '+' || c === '?') fail('nothing to repeat');
      if (c === '{' && /^\{\d+(,\d*)?\}/.test(src.slice(i))) fail('nothing to repeat');
      i++;
      return { type: 'raw', text: escapeChar(asciiChar(c), false) };
    }

    function parseSeq() {
      var terms = [];
      while (i < src.length && src[i] !== '|' && src[i] !== ')') {
        var atom = parseAtom();
        var quant = parseQuant();
        if (quant && (atom.type === 'bol' || atom.type === 'eol')) throw new Unsupported('quantified anchor');
        terms.push({ atom: atom, quant: quant });
      }
      return terms;
    }

    function parseAlt() {
      var alts = [parseSeq()];
      while (src[i] === '|') {
        i++;
        alts.push(parseSeq());
      }
      return { type: 'alt', alts: alts };
    }

    var ast = parseAlt();
    if (i !== src.length) fail('unbalanced )');
    return ast;
  }

  var SINGLE_ATOM = /^(?:\\.|[^\\\[\]()|*+?{}^$]|\[(?:\\.|[^\]\\])*\]|\.)$/;

  // Rewrites a JavaScript regex into a list of patterns without alternation,
  // brace quantifiers or built-in classes. The union of the variants matches
  // exactly the URLs the original matches. With keepCaptures (redirect rules
  // using regexSubstitution) capture-group numbering is preserved, or the
  // rewrite is refused.
  function rewriteRegex(src, options) {
    options = options || {};
    var keepCaptures = !!options.keepCaptures;
    var maxVariants = options.maxVariants || MAX_VARIANTS;

    function cap(list) {
      if (list.length > maxVariants) throw new Unsupported('more than ' + maxVariants + ' variants');
      return list;
    }

    function expandAlt(alt) {
      var out = [];
      alt.alts.forEach(function (seq) {
        out = cap(out.concat(expandSeq(seq)));
      });
      return out;
    }

    function expandSeq(seq) {
      var acc = [''];
      seq.forEach(function (term) {
        var parts = expandTerm(term);
        var next = [];
        acc.forEach(function (a) {
          parts.forEach(function (p) {
            next.push(a + p);
          });
        });
        acc = cap(next);
      });
      return acc;
    }

    function repeat(unit, quant, isCaptureGroup) {
      if (!quant) return unit;
      if (quant.lazy && keepCaptures) throw new Unsupported('lazy quantifier in a substitution pattern');
      if (unit === '') return '';
      if (!quant.braces) return unit + (quant.max === 1 ? '?' : quant.min === 0 ? '*' : '+');
      if (isCaptureGroup && keepCaptures && quant.max !== 1) throw new Unsupported('repeated capture group in a substitution pattern');
      if (quant.min > 32 || (quant.max !== Infinity && quant.max - quant.min > 32)) throw new Unsupported('repetition too large');
      var out = '';
      var k;
      if (quant.max === Infinity) {
        if (quant.min === 0) return unit + '*';
        for (k = 1; k < quant.min; k++) out += unit;
        return out + unit + '+';
      }
      for (k = 0; k < quant.min; k++) out += unit;
      for (k = quant.min; k < quant.max; k++) out += unit + '?';
      return out;
    }

    function expandTerm(term) {
      var atom = term.atom;
      var quant = term.quant;
      if (atom.type === 'bol') return ['^'];
      if (atom.type === 'eol') return ['$'];
      if (atom.type === 'raw') return [repeat(atom.text, quant, false)];
      // group
      var inner = expandAlt(atom.alt);
      if (inner.length > 1 && quant && quant.max > 1) throw new Unsupported('repeated alternation');
      return inner.map(function (text) {
        var keepParens = (keepCaptures && atom.capture) || (quant && !SINGLE_ATOM.test(text) && text !== '');
        var unit = text;
        if (keepParens) {
          // A group kept only for its quantifier must not add a capture when
          // capture numbering matters.
          unit = (keepCaptures && !atom.capture ? '(?:' : '(') + text + ')';
        }
        return repeat(unit, quant, atom.capture);
      });
    }

    var variants = expandAlt(parseRegex(src));
    var seen = {};
    return variants.filter(function (v) {
      if (seen[v]) return false;
      seen[v] = true;
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Browser glue
  // ---------------------------------------------------------------------------

  var api = (typeof browser === 'object' && browser) || (typeof chrome === 'object' && chrome) || null;
  var dnr = api && api.declarativeNetRequest;

  function safariVersion() {
    var ua = (root.navigator && root.navigator.userAgent) || '';
    var m = /Version\/(\d+)(?:\.(\d+))?/.exec(ua);
    return m ? [parseInt(m[1], 10), parseInt(m[2] || '0', 10)] : null;
  }

  function atLeast(v, major, minor) {
    return !!v && (v[0] > major || (v[0] === major && v[1] >= minor));
  }

  var version = safariVersion();
  // Safari < 18.4 only understands the older domains/excludedDomains names.
  var legacyDomainKeys = !atLeast(version, 18, 4);

  function lastErrorOf() {
    try {
      return api && api.runtime && api.runtime.lastError;
    } catch (e) {
      return null;
    }
  }

  // Calls a declarativeNetRequest method through its promise form (Safari's
  // browser.* namespace is promise based). A callback is never passed, so an
  // operation cannot run twice.
  function callDnr(method, arg) {
    try {
      var ret = arg === undefined ? dnr[method]() : dnr[method](arg);
      if (ret && typeof ret.then === 'function') return Promise.resolve(ret);
      var err = lastErrorOf();
      return err ? Promise.reject(new Error(err.message)) : Promise.resolve(ret);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  var regexCache = {};
  function regexSupported(re, caseSensitive) {
    if (webkitRegexProblem(re)) return Promise.resolve(false);
    if (!dnr || typeof dnr.isRegexSupported !== 'function') return Promise.resolve(true);
    var key = (caseSensitive ? '1' : '0') + re;
    if (!(key in regexCache)) {
      regexCache[key] = callDnr('isRegexSupported', { regex: re, isCaseSensitive: !!caseSensitive })
        .then(function (res) { return !!(res && res.isSupported); })
        .catch(function () { return true; }); // let updateSessionRules decide
    }
    return regexCache[key];
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function extraId(id, k) {
    return EXTRA_ID_BASE + id * EXTRA_ID_STRIDE + k;
  }

  function baseIdOf(id) {
    return id >= EXTRA_ID_BASE ? Math.floor((id - EXTRA_ID_BASE) / EXTRA_ID_STRIDE) : id;
  }

  // Returns {rules: [...], dropped: reason|null, expanded: bool}
  function adaptRule(rule) {
    var r = clone(rule);
    var c = r.condition || (r.condition = {});
    var a = r.action || {};
    // An empty list of excluded domains excludes nothing. Safari turns it into
    // an empty condition list, which its content blocker compiler rejects for
    // the whole rule set.
    ['excludedInitiatorDomains', 'excludedDomains', 'excludedRequestDomains'].forEach(function (key) {
      if (Array.isArray(c[key]) && !c[key].length) delete c[key];
    });
    if (legacyDomainKeys) {
      if (c.initiatorDomains) {
        c.domains = c.initiatorDomains;
        delete c.initiatorDomains;
      }
      if (c.excludedInitiatorDomains) {
        c.excludedDomains = c.excludedInitiatorDomains;
        delete c.excludedInitiatorDomains;
      }
    }
    if (a.type === 'modifyHeaders' && a.responseHeaders) {
      delete a.responseHeaders;
      if (!a.requestHeaders || !a.requestHeaders.length)
        return Promise.resolve({ rules: [], dropped: 'responseHeaders not supported by Safari' });
    }
    if (a.type === 'modifyHeaders' && a.requestHeaders && withoutRefusedHeaders(r) === 0)
      return Promise.resolve({ rules: [], dropped: 'only modifies request headers Safari refuses' });
    if (typeof c.regexFilter !== 'string') return Promise.resolve({ rules: [r], dropped: null });

    var caseSensitive = !!c.isUrlFilterCaseSensitive;
    var original = c.regexFilter;
    return regexSupported(original, caseSensitive).then(function (supported) {
      if (supported) return { rules: [r], dropped: null };
      var keepCaptures = a.type === 'redirect' && a.redirect && a.redirect.regexSubstitution !== undefined;
      var variants;
      try {
        variants = rewriteRegex(original, { keepCaptures: keepCaptures, maxVariants: MAX_VARIANTS });
      } catch (e) {
        return { rules: [], dropped: 'regex not rewritable (' + e.message + ')' };
      }
      return Promise.all(variants.map(function (v) { return regexSupported(v, caseSensitive); })).then(function (oks) {
        var good = variants.filter(function (v, k) { return oks[k]; });
        if (!good.length) return { rules: [], dropped: 'regex unsupported after rewrite' };
        var rules = good.map(function (v, k) {
          var nr = k === 0 ? r : clone(r);
          nr.condition.regexFilter = v;
          if (k > 0) nr.id = extraId(rule.id, k);
          return nr;
        });
        return { rules: rules, dropped: null, expanded: true, partial: good.length < variants.length };
      });
    });
  }

  var report = {
    safariVersion: version,
    legacyDomainKeys: legacyDomainKeys,
    startedAt: new Date().toISOString(),
    calls: 0,
    lastCall: null,
    lastAddCall: null, // last call that added rules
    errors: [], // uncaught errors of the background page (see recordError)
    crawler: [], // what happened to the crawler user agent of which site (see crawlerNote)
  };

  // Uncaught errors and rejections in the background page (this script runs
  // first, so errors in sites.js / background.js are caught too).
  function recordError(message) {
    report.errors.push({ at: new Date().toISOString(), message: String(message).slice(0, 600) });
    if (report.errors.length > 20) report.errors.shift();
  }
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('error', function (e) {
      recordError((e && (e.message || e.error)) + (e && e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : ''));
    });
    root.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      recordError('unhandled rejection: ' + (r && (r.message || r) || r));
    });
  }

  function callSummary(call) {
    if (!call) return null;
    var dropped = {};
    call.droppedRules.forEach(function (d) {
      dropped[d.reason] = (dropped[d.reason] || 0) + 1;
    });
    return {
      at: call.at,
      rulesIn: call.rulesIn,
      rulesOut: call.rulesOut,
      expandedRules: call.expandedRules,
      dropped: dropped,
      strippedHeaders: call.strippedHeaders,
      refusedHeaders: Object.keys(refusedHeaders),
      rollbacks: call.rollbacks,
      batchRejected: call.batchRejected,
    };
  }

  // Kept in storage so that the diagnostics page can show it even when the
  // non-persistent background page has been unloaded since.
  function persistReport() {
    try {
      if (api && api.storage && api.storage.local) {
        var p = api.storage.local.set({
          bpc_safari_report: {
            safariVersion: version,
            startedAt: report.startedAt,
            lastAddCall: callSummary(report.lastAddCall),
            errors: report.errors.slice(-5),
          },
        });
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) {
      // diagnostics only
    }
  }

  // State of the running background page, for safari-diagnostics.html.
  // enabledSites, self_hosted, ext_chromium, isSiteEnabled and matchUrlDomain
  // are globals of background.js.
  function diagnostics(url) {
    var info = {
      safariVersion: version,
      legacyDomainKeys: legacyDomainKeys,
      startedAt: report.startedAt,
      lastAddCall: callSummary(report.lastAddCall),
      errors: report.errors.slice(),
    };
    try {
      info.backgroundLoaded = typeof isSiteEnabled === 'function';
      info.enabledSites = typeof enabledSites !== 'undefined' ? enabledSites.length : null;
      info.selfHosted = typeof self_hosted !== 'undefined' ? self_hosted : null;
      info.chromiumCodePath = typeof ext_chromium !== 'undefined' ? ext_chromium : null;
      if (url && typeof isSiteEnabled === 'function') {
        info.siteEnabled = !!isSiteEnabled({ url: url });
        info.siteDomain = (typeof matchUrlDomain === 'function' && typeof enabledSites !== 'undefined' && matchUrlDomain(enabledSites, url)) || '';
      }
    } catch (e) {
      info.error = String(e && e.message || e);
    }
    // Sites that get no crawler user agent because Safari cannot send the crawler's address with it.
    info.crawlerRefusedBy = Object.keys(crawlerRefusedBy).filter(crawlerRefused);
    info.crawlerNotes = report.crawler.slice(-10);
    var host = hostOf(url);
    info.siteRefusesCrawler = !!host && !!refusedHeaders['x-forwarded-for'] && info.crawlerRefusedBy.some(function (domain) { return onSite(host, domain); });
    return info;
  }

  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message.request !== 'bpcSafariDiag') return undefined;
      sendResponse(diagnostics(message.url));
      return undefined;
    });
  }

  function summarize(res) {
    var dropped = {};
    res.droppedRules.forEach(function (d) {
      dropped[d.reason] = (dropped[d.reason] || 0) + 1;
    });
    return dropped;
  }

  // Request headers Safari refused to modify in this session (lower case).
  // Safari 18 only accepts a fixed list of header names and rejects the whole
  // update for any other ("The header `X-Forwarded-For` is not recognized.").
  var refusedHeaders = {};

  // --- A crawler's user agent without the crawler's address -----------------
  //
  // The Googlebot rules of the extension set three request headers: the
  // User-Agent of Googlebot, a Google Referer and X-Forwarded-For with an
  // address of Google's crawler. Safari refuses X-Forwarded-For, which leaves
  // a request that claims to be Googlebot but does not come from Google. Some
  // sites answer such a request with nothing at all (the page never loads, as
  // on washingtonpost.com) or with a denial page. For those sites the rule is
  // better off without the User-Agent: the page opens, and the other measures
  // for the site (blocked scripts, Referer, content script) still apply.
  //
  // Which sites do this is found out as it happens (see "Finding the sites
  // that refuse a crawler" below); the ones already known are listed here.
  var CRAWLER_UA = /Googlebot/i;
  var CRAWLER_REFUSED_BY = ['washingtonpost.com'];
  // domain -> {reason, since, until, times}: no crawler User-Agent for this
  // site until `until` (0: for good).
  var crawlerRefusedBy = {};
  CRAWLER_REFUSED_BY.forEach(function (domain) {
    crawlerRefusedBy[domain] = { reason: 'known', since: '', until: 0, times: 0 };
  });

  function isCrawlerHeader(h) {
    return !!h && String(h.header).toLowerCase() === 'user-agent' && CRAWLER_UA.test(String(h.value || ''));
  }

  // The site a header rule is for: "||example.com", or its first request domain.
  function ruleDomain(rule) {
    var c = (rule && rule.condition) || {};
    var m = /^\|\|([a-z0-9.-]+)/i.exec(String(c.urlFilter || ''));
    if (m) return m[1].toLowerCase();
    return Array.isArray(c.requestDomains) && c.requestDomains.length ? String(c.requestDomains[0]).toLowerCase() : '';
  }

  function crawlerRefused(domain) {
    var entry = Object.prototype.hasOwnProperty.call(crawlerRefusedBy, domain) ? crawlerRefusedBy[domain] : null;
    return !!entry && (!entry.until || entry.until > Date.now());
  }

  // Removes the refused headers from a modifyHeaders rule, in place, and with
  // X-Forwarded-For the User-Agent of a crawler for the sites that refuse it.
  // Returns the number of request headers left.
  function withoutRefusedHeaders(rule) {
    var headers = rule.action.requestHeaders || [];
    var kept = headers.filter(function (h) {
      return !refusedHeaders[String(h && h.header).toLowerCase()];
    });
    if (refusedHeaders['x-forwarded-for'] && kept.some(isCrawlerHeader) && crawlerRefused(ruleDomain(rule)))
      kept = kept.filter(function (h) { return !isCrawlerHeader(h); });
    if (kept.length !== headers.length) rule.action.requestHeaders = kept;
    return kept.length;
  }

  function refusedHeaderIn(err) {
    var m = /header `([^`]+)` (?:is not recognized|cannot be modified)/i.exec((err && err.message) || '');
    return m ? m[1].toLowerCase() : null;
  }

  // --- Verifying that an update really took effect ---------------------------
  //
  // After storing new rules Safari compiles all of them into one content
  // blocker. When that fails (one pattern it cannot compile is enough) it puts
  // the previous rules back and still reports success. Each update therefore
  // carries a marker rule, which matches no real request, and is checked for
  // afterwards.
  var MARKER_ID = 9000000; // above upstream ids, below the variant ids
  var markerCount = 0;

  function hashOf(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  // `stable` markers depend on the rules only, so that an unchanged rule set
  // produces an identical update and Safari can reuse its compiled list (the
  // background page restarts often). Retries use a fresh marker each time.
  function markerFor(rules, stable) {
    var tag = hashOf(JSON.stringify(rules)) + (stable ? '' : '-' + (++markerCount) + '-' + Date.now().toString(36));
    return {
      id: MARKER_ID,
      priority: 1,
      action: { type: 'allow' },
      condition: { urlFilter: '||bpc-safari-marker.invalid/' + tag, resourceTypes: ['main_frame'] },
    };
  }

  function isMarker(rule) {
    return !!rule && rule.id === MARKER_ID;
  }

  function wasCommitted(marker) {
    if (typeof dnr.getSessionRules !== 'function') return Promise.resolve(true);
    return callDnr('getSessionRules').then(function (rules) {
      return (rules || []).some(function (r) {
        return r.id === MARKER_ID && r.condition && r.condition.urlFilter === marker.condition.urlFilter;
      });
    }, function () {
      return true; // cannot tell: assume it worked
    });
  }

  // Rules Safari could not compile, remembered across restarts of the
  // background page (per Safari version) so that they are found only once.
  var REFUSED_KEY = 'bpc_safari_refused_2';
  var refusedRules = {};
  var refusedLoaded = null;

  function ruleKey(rule) {
    var c = rule.condition || {};
    var parts = Object.keys(c).sort().map(function (k) { return k + '=' + JSON.stringify(c[k]); });
    return (rule.action && rule.action.type) + '|' + parts.join('|');
  }

  // Sites found to refuse a crawler's User-Agent, and sites cleared of it.
  var CRAWLER_KEY = 'bpc_safari_crawler';
  var DAY_MS = 24 * 3600 * 1000;
  // domain -> time: the site failed with and without the User-Agent, so the
  // User-Agent is not the reason; not examined again for a week.
  var crawlerCleared = {};

  function loadRefused() {
    if (!refusedLoaded) {
      refusedLoaded = Promise.resolve().then(function () {
        return api.storage.local.get([REFUSED_KEY, CRAWLER_KEY]);
      }).then(function (items) {
        var crawler = (items && items[CRAWLER_KEY]) || {};
        var now = Date.now();
        Object.keys(crawler.refusedBy || {}).forEach(function (domain) {
          var entry = crawler.refusedBy[domain];
          // An entry past its time stays for a while: it says how often the site did this.
          if (crawlerRefusedBy[domain] || !entry || (entry.until && entry.until < now - 90 * DAY_MS)) return;
          crawlerRefusedBy[domain] = { reason: String(entry.reason || ''), since: String(entry.since || ''), until: Number(entry.until) || 0, times: Number(entry.times) || 0 };
        });
        Object.keys(crawler.cleared || {}).forEach(function (domain) {
          if (now - crawler.cleared[domain] < 7 * DAY_MS) crawlerCleared[domain] = crawler.cleared[domain];
        });
        var saved = items && items[REFUSED_KEY];
        if (!saved || saved.safari !== String(version)) return;
        (saved.rules || []).forEach(function (key) { refusedRules[key] = true; });
        (saved.headers || []).forEach(function (name) { refusedHeaders[name] = true; });
      }).catch(function () {});
    }
    return refusedLoaded;
  }

  function saveCrawler() {
    try {
      var found = {};
      Object.keys(crawlerRefusedBy).forEach(function (domain) {
        var entry = crawlerRefusedBy[domain];
        if (entry.reason !== 'known' && !entry.tentative) found[domain] = entry;
      });
      var record = {};
      record[CRAWLER_KEY] = { refusedBy: found, cleared: crawlerCleared };
      var p = api.storage.local.set(record);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
      // best effort
    }
  }

  function saveRefused() {
    try {
      var record = {};
      record[REFUSED_KEY] = { safari: String(version), rules: Object.keys(refusedRules).slice(-300), headers: Object.keys(refusedHeaders) };
      var p = api.storage.local.set(record);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
      // best effort
    }
  }

  // Adds rules, coping with the ways Safari refuses an update. Safari reports
  // an invalid rule as "Rule with id N is invalid. <reason>" and rejects the
  // whole call (a failed attempt is cheap, a successful one recompiles the
  // content blocker):
  //  - when the reason is a request header Safari refuses, that header is
  //    removed from the rules and the rest of each rule is kept;
  //  - otherwise, when the message names a rule of the list, that rule is
  //    dropped;
  //  - without a usable message the list is applied in halves until the
  //    refused rules are isolated.
  // An update Safari accepted but then rolled back is applied in halves too.
  var MAX_NAMED_RETRIES = 500;
  function addRulesTolerantly(rules, result) {
    if (!rules.length) return Promise.resolve();
    var marker = markerFor(rules, false);
    return callDnr('updateSessionRules', { addRules: rules.concat([marker]), removeRuleIds: [MARKER_ID] }).then(function () {
      return wasCommitted(marker).then(function (committed) {
        if (committed) {
          result.rulesOut += rules.length;
          return undefined;
        }
        return afterRollback(rules, result);
      });
    }, function (err) {
      return afterRejection(rules, result, err);
    });
  }

  // Safari accepted `rules` but could not compile the resulting rule list and
  // restored the previous state: find the rule(s) responsible.
  function afterRollback(rules, result) {
    result.rollbacks++;
    if (rules.length === 1) {
      refusedRules[ruleKey(rules[0])] = true;
      result.droppedRules.push({ id: rules[0].id, reason: 'Safari cannot compile this rule', rule: rules[0] });
      return Promise.resolve();
    }
    var mid = Math.ceil(rules.length / 2);
    return addRulesTolerantly(rules.slice(0, mid), result).then(function () {
      return addRulesTolerantly(rules.slice(mid), result);
    });
  }

  // Decides what to change after Safari rejected `rules` with `err`, then
  // tries again.
  function afterRejection(rules, result, err) {
    if (!result.batchRejected) result.batchRejected = err.message;

    var header = refusedHeaderIn(err);
    if (header) {
      refusedHeaders[header] = true;
      var changed = 0;
      var kept = rules.filter(function (rule) {
        if (!rule.action || rule.action.type !== 'modifyHeaders' || !rule.action.requestHeaders) return true;
        var before = rule.action.requestHeaders.length;
        var left = withoutRefusedHeaders(rule);
        if (left === before) return true;
        changed++;
        if (left) return true;
        result.droppedRules.push({ id: rule.id, reason: 'only modifies request headers Safari refuses', rule: rule });
        return false;
      });
      if (changed) {
        result.strippedHeaders[header] = (result.strippedHeaders[header] || 0) + changed;
        return addRulesTolerantly(kept, result);
      }
    }

    var named = /\bid\s+(\d+)\b/i.exec(err.message || '');
    if (named && result.namedRetries < MAX_NAMED_RETRIES) {
      var id = parseInt(named[1], 10);
      for (var k = 0; k < rules.length; k++) {
        if (rules[k].id === id) {
          result.namedRetries++;
          result.droppedRules.push({ id: id, reason: 'rejected by Safari: ' + err.message, rule: rules[k] });
          return addRulesTolerantly(rules.slice(0, k).concat(rules.slice(k + 1)), result);
        }
      }
    }

    if (rules.length === 1) {
      result.droppedRules.push({ id: rules[0].id, reason: 'rejected by Safari: ' + err.message, rule: rules[0] });
      return undefined;
    }
    var mid = Math.ceil(rules.length / 2);
    return addRulesTolerantly(rules.slice(0, mid), result).then(function () {
      return addRulesTolerantly(rules.slice(mid), result);
    });
  }

  function applyBatch(rules, removeRuleIds, result) {
    if (!rules.length) {
      // Nothing to add, so nothing to verify.
      if (!removeRuleIds.length) return Promise.resolve();
      return callDnr('updateSessionRules', { removeRuleIds: removeRuleIds });
    }
    var marker = markerFor(rules, true);
    var removals = removeRuleIds.concat([MARKER_ID]);
    // Whatever went wrong, nothing was applied: do the removals on their own,
    // then add again.
    function removeThen(next) {
      return callDnr('updateSessionRules', { removeRuleIds: removals }).catch(function () {}).then(next);
    }
    return callDnr('updateSessionRules', { addRules: rules.concat([marker]), removeRuleIds: removals }).then(function () {
      return wasCommitted(marker).then(function (committed) {
        if (committed) {
          result.rulesOut += rules.length;
          return undefined;
        }
        return removeThen(function () {
          return afterRollback(rules, result);
        });
      });
    }, function (err) {
      result.batchRejected = err.message;
      return removeThen(function () {
        return afterRejection(rules, result, err);
      });
    });
  }

  function doUpdateSessionRules(options) {
    options = options || {};
    var addRules = options.addRules || [];
    var removeRuleIds = (options.removeRuleIds || []).slice();
    var touched = {};
    removeRuleIds.forEach(function (id) { touched[id] = true; });
    addRules.forEach(function (rule) { touched[rule.id] = true; });

    var result = {
      at: new Date().toISOString(),
      rulesIn: addRules.length,
      rulesOut: 0,
      expandedRules: 0,
      partialRules: 0,
      droppedRules: [],
      strippedHeaders: {}, // refused header name -> number of rules it was removed from
      namedRetries: 0,
      rollbacks: 0, // updates Safari accepted and then silently undid
      batchRejected: false,
    };

    var existing = loadRefused().then(function () {
      return typeof dnr.getSessionRules === 'function' ? callDnr('getSessionRules').catch(function () { return []; }) : [];
    });

    return existing.then(function (current) {
      // Remove the extra variant rules belonging to every upstream id that is
      // being removed or replaced.
      (current || []).forEach(function (rule) {
        if (rule.id >= EXTRA_ID_BASE && touched[baseIdOf(rule.id)]) removeRuleIds.push(rule.id);
      });
      return Promise.all(addRules.map(adaptRule));
    }).then(function (adapted) {
      var out = [];
      adapted.forEach(function (res, k) {
        if (res.dropped) result.droppedRules.push({ id: addRules[k].id, reason: res.dropped, rule: addRules[k] });
        if (res.expanded) result.expandedRules++;
        if (res.partial) result.partialRules++;
        res.rules.forEach(function (rule) {
          if (refusedRules[ruleKey(rule)])
            result.droppedRules.push({ id: rule.id, reason: 'Safari cannot compile this rule', rule: rule });
          else
            out.push(rule);
        });
      });
      var knownBefore = Object.keys(refusedRules).length + Object.keys(refusedHeaders).length;
      return applyBatch(out, removeRuleIds, result).then(function () {
        crawlerDomainsCache = null;
        if (Object.keys(refusedRules).length + Object.keys(refusedHeaders).length !== knownBefore) saveRefused();
        report.calls++;
        report.lastCall = result;
        if (addRules.length) {
          report.lastAddCall = result;
          persistReport();
          console.info('BPC Safari: ' + result.rulesIn + ' rules requested, ' + result.rulesOut + ' applied (' +
            result.expandedRules + ' regex rules rewritten, ' + result.droppedRules.length + ' skipped)' +
            (Object.keys(refusedHeaders).length ? ' request headers Safari refuses: ' + Object.keys(refusedHeaders).join(', ') + '.' : '') +
            (result.droppedRules.length ? ' ' + JSON.stringify(summarize(result)) : ''));
        }
        return result;
      });
    });
  }

  var queue = Promise.resolve();
  function updateSessionRules(options, callback) {
    var run = queue.then(function () {
      if (!dnr) throw new Error('declarativeNetRequest is not available');
      return doUpdateSessionRules(options);
    });
    queue = run.catch(function () {});
    return run.then(function (res) {
      if (typeof callback === 'function') callback();
      return res;
    }, function (err) {
      console.error('BPC Safari: updateSessionRules failed', err);
      if (typeof callback === 'function') callback();
    });
  }

  // --- Finding the sites that refuse a crawler --------------------------------
  //
  // Only while Safari refuses X-Forwarded-For (see "A crawler's user agent
  // without the crawler's address" above). A main-frame navigation to a site
  // with a Googlebot rule is watched:
  //  - no answer within STALL_MS while the tab is still loading, or
  //  - the load ends on a short page that reads like a denial,
  // and the rule loses its User-Agent and the navigation is repeated once. If
  // the repeated load works, the site is remembered: for a day the first
  // time, for a month from the second time on (a network hiccup can look the
  // same once). If it fails the same way, the User-Agent was not the reason:
  // it comes back and the site is left alone for a week.
  var STALL_MS = 12000;
  var crawlerDomainsCache = null; // promise of the domains with a crawler rule installed
  var crawlerRulesTaken = {};     // domain -> the rules as they were with the User-Agent
  var crawlerFine = {};           // domain -> true: loaded with the User-Agent since this page started
  var navigations = {};           // tabId -> the main-frame navigation under way
  var repeats = {};               // tabId -> domain whose navigation is being repeated

  function hostOf(url) {
    var m = /^https?:\/\/([^\/?#:]+)/i.exec(String(url || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function onSite(host, domain) {
    return host === domain || host.slice(-domain.length - 1) === '.' + domain;
  }

  function crawlerDomains() {
    if (!crawlerDomainsCache) {
      crawlerDomainsCache = callDnr('getSessionRules').then(function (rules) {
        var domains = {};
        (rules || []).forEach(function (rule) {
          var headers = rule.action && rule.action.type === 'modifyHeaders' && rule.action.requestHeaders;
          if (headers && headers.some(isCrawlerHeader) && ruleDomain(rule)) domains[ruleDomain(rule)] = true;
        });
        return Object.keys(domains);
      }).catch(function () {
        crawlerDomainsCache = null;
        return [];
      });
    }
    return crawlerDomainsCache;
  }

  // The site with a crawler rule that `url` belongs to, or ''.
  function crawlerDomainFor(url, repeated) {
    var host = hostOf(url);
    if (!host || !dnr) return Promise.resolve('');
    return loadRefused().then(function () {
      if (!refusedHeaders['x-forwarded-for']) return '';
      if (repeated && onSite(host, repeated)) return repeated;
      return crawlerDomains().then(function (domains) {
        for (var k = 0; k < domains.length; k++)
          if (onSite(host, domains[k])) return domains[k];
        return '';
      });
    }).catch(function () {
      return '';
    });
  }

  // Takes the crawler's User-Agent out of the installed rules for a site
  // (send: false), or puts the rules back as they were (send: true).
  function setCrawlerIdentity(domain, send) {
    var run = queue.then(function () {
      return callDnr('getSessionRules');
    }).then(function (rules) {
      var remove = [];
      var add = [];
      if (send) {
        (crawlerRulesTaken[domain] || []).forEach(function (original) {
          remove.push(original.id);
          add.push(original);
        });
        delete crawlerRulesTaken[domain];
      } else {
        var originals = [];
        (rules || []).forEach(function (rule) {
          var headers = rule.action && rule.action.type === 'modifyHeaders' && rule.action.requestHeaders;
          if (!headers || !headers.some(isCrawlerHeader) || ruleDomain(rule) !== domain) return;
          originals.push(clone(rule));
          remove.push(rule.id);
          var changed = clone(rule);
          changed.action.requestHeaders = headers.filter(function (h) { return !isCrawlerHeader(h); });
          if (changed.action.requestHeaders.length) add.push(changed);
        });
        if (originals.length) crawlerRulesTaken[domain] = originals;
      }
      crawlerDomainsCache = null;
      if (!remove.length) return false;
      return callDnr('updateSessionRules', { removeRuleIds: remove, addRules: add }).then(function () { return true; });
    });
    queue = run.catch(function () {});
    return run.catch(function (e) {
      recordError('crawler identity for ' + domain + ': ' + (e && e.message || e));
      return false;
    });
  }

  function forgetNavigation(tabId) {
    var nav = navigations[tabId];
    if (nav) clearTimeout(nav.timer);
    delete navigations[tabId];
  }

  // Runs in the page: enough of it to tell a denial from an article.
  function pageSummary() {
    var text = (document.body && document.body.innerText) || '';
    return { title: String(document.title || ''), length: text.length, text: text.slice(0, 400) };
  }

  function looksDenied(page) {
    if (!page || typeof page.length !== 'number' || page.length > 1500) return false;
    return /access (is |was )?denied|forbidden|\b40[136]\b|\b429\b|request (was )?blocked|been blocked|unusual traffic|not a robot|captcha|verify (that )?you are (a )?human|just a moment|pardon our interruption|request unsuccessful|automated (access|requests)|bot detected/i
      .test(page.title + ' ' + page.text);
  }

  function crawlerNote(domain, text) {
    report.crawler.push({ at: new Date().toISOString(), domain: domain, note: text });
    if (report.crawler.length > 30) report.crawler.shift();
    console.info('BPC Safari: ' + domain + ': ' + text);
  }

  // The navigation got no answer, or a denial.
  function crawlerFailed(tabId, nav, reason) {
    forgetNavigation(tabId);
    var domain = nav.domain;
    var entry = crawlerRefusedBy[domain];
    if (nav.repeated) {
      // No better without the User-Agent: it was not the reason.
      if (entry && entry.tentative) {
        if (entry.times) {
          delete entry.tentative;
          entry.until = 1; // past its time; kept for the count
        } else delete crawlerRefusedBy[domain];
      }
      crawlerCleared[domain] = Date.now();
      saveCrawler();
      crawlerNote(domain, 'also fails without the crawler user agent (' + reason + '); sending it again');
      return setCrawlerIdentity(domain, true);
    }
    crawlerRefusedBy[domain] = { reason: reason, since: new Date().toISOString(), until: Date.now() + 5 * 60000, times: (entry && entry.times) || 0, tentative: true };
    crawlerNote(domain, reason + ' with the crawler user agent; trying again without it');
    return setCrawlerIdentity(domain, false).then(function () {
      repeats[tabId] = domain;
      return api.tabs.update(tabId, { url: nav.url });
    }).catch(function (e) {
      recordError('repeating the navigation to ' + domain + ': ' + (e && e.message || e));
    });
  }

  // The navigation ended on a page that is not a denial.
  function crawlerLoaded(nav) {
    var domain = nav.domain;
    var entry = crawlerRefusedBy[domain];
    if (!nav.repeated) {
      crawlerFine[domain] = true;
      return;
    }
    if (!entry || !entry.tentative) return;
    delete entry.tentative;
    entry.times++;
    entry.until = Date.now() + (entry.times >= 2 ? 30 : 1) * DAY_MS;
    saveCrawler();
    crawlerNote(domain, 'loads without the crawler user agent; not sending it for ' + (entry.times >= 2 ? '30 days' : 'a day'));
  }

  function inspectPage(tabId, nav) {
    forgetNavigation(tabId);
    return Promise.resolve().then(function () {
      return api.scripting.executeScript({ target: { tabId: tabId }, func: pageSummary });
    }).then(function (results) {
      var page = results && results[0] && results[0].result;
      if (looksDenied(page)) return crawlerFailed(tabId, nav, 'denied ("' + String(page.title).slice(0, 60) + '")');
      return crawlerLoaded(nav);
    }, function () {
      // The page cannot be looked at; a repeated load that got this far counts as loaded.
      if (nav.repeated) crawlerLoaded(nav);
    });
  }

  function stalled(tabId, nav) {
    if (navigations[tabId] !== nav || nav.committed) return undefined;
    // A load that ended without an answer (an error, or the user stopped it) is left alone.
    return Promise.resolve().then(function () {
      return api.tabs.get(tabId);
    }).then(function (tab) {
      if (navigations[tabId] !== nav || nav.committed) return undefined;
      if (!tab || tab.status !== 'loading') return forgetNavigation(tabId);
      return crawlerFailed(tabId, nav, 'no answer within ' + Math.round(STALL_MS / 1000) + ' s');
    }, function () {
      forgetNavigation(tabId);
    });
  }

  function onBeforeNavigate(details) {
    if (!details || details.frameId !== 0) return;
    var tabId = details.tabId;
    forgetNavigation(tabId);
    var repeated = repeats[tabId];
    delete repeats[tabId];
    var nav = navigations[tabId] = { url: details.url, domain: '', repeated: false, committed: false, completed: false, timer: null };
    crawlerDomainFor(details.url, repeated).then(function (domain) {
      if (navigations[tabId] !== nav) return;
      nav.domain = domain;
      nav.repeated = !!domain && domain === repeated;
      if (!domain || (!nav.repeated && (crawlerFine[domain] || crawlerCleared[domain] || crawlerRefused(domain)))) {
        forgetNavigation(tabId);
        return;
      }
      if (nav.completed) inspectPage(tabId, nav);
      else if (!nav.committed) nav.timer = setTimeout(function () { stalled(tabId, nav); }, STALL_MS);
    });
  }

  function onCommitted(details) {
    var nav = details && details.frameId === 0 ? navigations[details.tabId] : null;
    if (!nav) return;
    nav.committed = true;
    clearTimeout(nav.timer);
  }

  function onCompleted(details) {
    var nav = details && details.frameId === 0 ? navigations[details.tabId] : null;
    if (!nav) return;
    nav.committed = nav.completed = true;
    clearTimeout(nav.timer);
    if (nav.domain) inspectPage(details.tabId, nav);
  }

  if (api && api.webNavigation && api.webNavigation.onBeforeNavigate && api.webNavigation.onCommitted && api.webNavigation.onCompleted) {
    api.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    api.webNavigation.onCommitted.addListener(onCommitted);
    api.webNavigation.onCompleted.addListener(onCompleted);
    if (api.tabs && api.tabs.onRemoved) api.tabs.onRemoved.addListener(forgetNavigation);
  }

  function getSelf(callback) {
    var manifest = (api && api.runtime && api.runtime.getManifest && api.runtime.getManifest()) || {};
    var info = {
      id: api && api.runtime ? api.runtime.id : '',
      name: manifest.name,
      shortName: manifest.short_name,
      version: manifest.version,
      enabled: true,
      mayDisable: true,
      type: 'extension',
      installType: 'normal',
    };
    if (typeof callback === 'function') setTimeout(function () { callback(info); }, 0);
    return Promise.resolve(info);
  }

  // Does in the background page what options/offscreen.js does in Chrome's
  // offscreen document (Safari has no offscreen API but its background page
  // has a DOM).
  function offscreenParse(data) {
    return new Promise(function (resolve) {
      var parser = new DOMParser();
      var html = (data.html || '').replace(/<script[^>]*>/g, '<!--').replace(/<\/script>/g, '-->').replace(/onclick="[^"]+"/g, '');
      var doc = parser.parseFromString(html, 'text/html');
      var article = doc.querySelector(data.selector_source);
      data.html = article ? article.outerHTML : '';
      resolve(data);
    });
  }

  // Fallback for code paths that look the API up directly.
  [typeof chrome === 'object' ? chrome : null, typeof browser === 'object' ? browser : null].forEach(function (ns) {
    if (ns && !ns.management) {
      try {
        ns.management = { getSelf: getSelf };
      } catch (e) {
        // read-only namespace: background.js call sites are rewritten anyway
      }
    }
  });

  // First-time setup. Chrome sends runtime.onInstalled with reason "install"
  // exactly once. WebKit sends it whenever the extension is (re-)enabled while
  // the browser runs, and not at all when the extension is first loaded during
  // browser start-up, which left the list of enabled sites empty for good.
  // setDefaults (setDefaultOptions of background.js) therefore runs once per
  // profile: on the first call here, unless sites are already stored.
  var FIRST_RUN_KEY = 'bpc_safari_first_run';
  var firstRunPromise = null;
  function firstRun(setDefaults) {
    if (!firstRunPromise) {
      firstRunPromise = Promise.resolve().then(function () {
        return api.storage.local.get(['sites', FIRST_RUN_KEY]);
      }).then(function (items) {
        if (items[FIRST_RUN_KEY]) return false;
        var flag = {};
        flag[FIRST_RUN_KEY] = new Date().toISOString();
        return Promise.resolve(api.storage.local.set(flag)).then(function () {
          if (items.sites && Object.keys(items.sites).length) return false; // set up by an earlier build
          setDefaults();
          report.firstRun = flag[FIRST_RUN_KEY];
          return true;
        });
      }).catch(function (e) {
        recordError('first run failed: ' + (e && e.message || e));
        return false;
      });
    }
    return firstRunPromise;
  }

  // Site lists stored by earlier Safari builds. Released Safari versions read
  // the scripts of the background page as Latin-1, so those builds saw the
  // site names with accented letters garbled and stored them that way. The
  // options page reads the same names as UTF-8: it did not recognise the
  // garbled ones and, as it saves the list whenever it is opened, stored the
  // list without those sites. The scripts are ASCII-only now (asciiJs in
  // safari/build.mjs); this puts a stored list right, once per profile:
  //  - a garbled name becomes the name sites.js has for the same domain,
  //  - when every site the options page could not match is missing while
  //    nearly all other default sites are enabled, those sites are enabled
  //    again (a list the user cut down to a few sites is left alone),
  //  - sites_default, the names known to the last version, gets the same fix.
  var NAMES_KEY = 'bpc_safari_site_names';
  var hasOwn = function (object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
  };
  function hasNonAscii(text) {
    return /[^\x00-\x7f]/.test(String(text));
  }
  // compareKey() of background.js and options.js: names match without their " (...)" part.
  function plainName(name) {
    return String(name).toLowerCase().replace(/\s\(.*\)/, '');
  }
  function repairSiteNames(defaults) {
    return Promise.resolve().then(function () {
      return api.storage.local.get([NAMES_KEY, 'sites', 'sites_default', 'sites_custom', 'sites_updated', 'sites_excluded']);
    }).then(function (items) {
      if (items[NAMES_KEY]) return null;
      var result = { at: new Date().toISOString(), renamed: 0, restored: 0, known: 0 };
      var changes = {};
      var sites = items.sites && typeof items.sites === 'object' ? items.sites : {};
      var excluded = Array.isArray(items.sites_excluded) ? items.sites_excluded : [];
      // Names that do not come from sites.js are left alone.
      var foreign = function (name) {
        return hasOwn(items.sites_custom, name) || hasOwn(items.sites_updated, name);
      };
      var garbled = function (name) {
        return hasNonAscii(name) && !hasOwn(defaults, name) && !foreign(name);
      };
      var accented = Object.keys(defaults || {}).filter(function (name) {
        return hasNonAscii(name) && !foreign(name) && defaults[name] && typeof defaults[name].domain === 'string';
      });

      if (accented.length && Object.keys(sites).length) {
        var byDomain = {};
        accented.forEach(function (name) {
          if (!hasOwn(byDomain, defaults[name].domain)) byDomain[defaults[name].domain] = name;
        });
        var fixed = {};
        Object.keys(sites).forEach(function (key) {
          var name = key;
          if (garbled(key) && typeof sites[key] === 'string' && hasOwn(byDomain, sites[key]) && !hasOwn(sites, byDomain[sites[key]])) {
            name = byDomain[sites[key]];
            result.renamed++;
          }
          fixed[name] = sites[key];
        });
        // The sites setDefaultOptions() of background.js enables, in two parts:
        // those the options page could not match, and the others.
        var dropped = [];
        var others = [];
        Object.keys(defaults).forEach(function (name) {
          var domain = defaults[name] && defaults[name].domain;
          if (typeof domain !== 'string' || !domain || /^(###$|#options_(disable|optin)_)/.test(domain) || foreign(name)) return;
          (hasNonAscii(plainName(name)) ? dropped : others).push(name);
        });
        var stored = {};
        Object.keys(fixed).forEach(function (key) { stored[plainName(key)] = true; });
        var isStored = function (name) {
          return hasOwn(stored, plainName(name));
        };
        if (dropped.length && !dropped.some(isStored) && others.filter(isStored).length >= 0.9 * others.length) {
          dropped.forEach(function (name) {
            if (excluded.indexOf(defaults[name].domain) >= 0) return;
            fixed[name] = defaults[name].domain;
            result.restored++;
          });
        }
        if (result.renamed || result.restored) changes.sites = fixed;
      }

      if (Array.isArray(items.sites_default) && items.sites_default.some(garbled)) {
        var known = items.sites_default.filter(function (name) { return !garbled(name); });
        accented.forEach(function (name) {
          if (/^(#options_|###$)/.test(defaults[name].domain) || known.indexOf(name) >= 0) return;
          known.push(name);
          result.known++;
        });
        changes.sites_default = known;
      }

      changes[NAMES_KEY] = result;
      return Promise.resolve(api.storage.local.set(changes)).then(function () {
        report.siteNames = result;
        return result;
      });
    }).catch(function (e) {
      recordError('site name repair failed: ' + (e && e.message || e));
      return null;
    });
  }

  // background.js asks for the options page from several places during the
  // first start; open it once.
  var lastOptionsPage = 0;
  function openOptionsPage() {
    var now = Date.now();
    if (now - lastOptionsPage < 5000) return Promise.resolve();
    lastOptionsPage = now;
    return Promise.resolve(api.runtime.openOptionsPage()).catch(function () {});
  }

  var bpcSafari = {
    getSelf: getSelf,
    updateSessionRules: updateSessionRules,
    offscreenParse: offscreenParse,
    firstRun: firstRun,
    repairSiteNames: repairSiteNames,
    openOptionsPage: openOptionsPage,
    report: report,
    // exposed for tests
    _crawler: { refusedBy: crawlerRefusedBy, cleared: crawlerCleared, fine: crawlerFine, navigations: navigations, looksDenied: looksDenied, ruleDomain: ruleDomain, STALL_MS: STALL_MS },
    _diagnostics: diagnostics,
    _isMarker: isMarker,
    _MARKER_ID: MARKER_ID,
    _rewriteRegex: rewriteRegex,
    _parseRegex: parseRegex,
    _webkitRegexProblem: webkitRegexProblem,
    _adaptRule: adaptRule,
    _extraId: extraId,
    _baseIdOf: baseIdOf,
    _Unsupported: Unsupported,
  };

  root.bpcSafari = bpcSafari;
  if (typeof module === 'object' && module.exports) module.exports = bpcSafari;
})(typeof globalThis !== 'undefined' ? globalThis : this);
