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
 *      * drops responseHeaders (not supported by Safari),
 *      * rewrites regexFilter patterns that WebKit cannot compile
 *        (alternation, {n,m}, \d \w \s, ...) into one or more equivalent
 *        patterns, each becoming its own rule,
 *    and, if Safari still rejects the batch, applies it in halves to isolate
 *    and skip the rules Safari refuses.
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

  // Safari reports invalid rules as "Rule with id N is invalid. ..."; when the
  // message names a rule of the batch, only that rule is dropped and the rest
  // is retried (each failed attempt is cheap, each successful one recompiles
  // the content blocker). Otherwise the batch is bisected.
  var MAX_ID_RETRIES = 500;
  function applyBatch(rules, removeRuleIds, result) {
    var pending = rules.slice();
    var retries = 0;

    function rejectedRuleIndex(err) {
      var m = /\bid\s+(\d+)\b/i.exec((err && err.message) || '');
      if (!m) return -1;
      var id = parseInt(m[1], 10);
      for (var k = 0; k < pending.length; k++) if (pending[k].id === id) return k;
      return -1;
    }

    function retry(err) {
      var idx = rejectedRuleIndex(err);
      if (idx >= 0 && retries++ < MAX_ID_RETRIES) {
        result.droppedRules.push({ id: pending[idx].id, reason: 'rejected by Safari: ' + err.message, rule: pending[idx] });
        pending.splice(idx, 1);
        if (!pending.length) return Promise.resolve();
        return callDnr('updateSessionRules', { addRules: pending }).catch(retry);
      }
      return addInChunks(pending, result.droppedRules);
    }

    return callDnr('updateSessionRules', { addRules: pending, removeRuleIds: removeRuleIds }).catch(function (err) {
      result.batchRejected = err.message;
      // Nothing was applied: do the removals on their own, then add again.
      return callDnr('updateSessionRules', { removeRuleIds: removeRuleIds }).catch(function () {}).then(function () {
        return retry(err);
      });
    });
  }

  // Adds rules, splitting the batch when Safari rejects it so that a single
  // bad rule cannot take the whole set down.
  function addInChunks(rules, droppedRules) {
    if (!rules.length) return Promise.resolve();
    return callDnr('updateSessionRules', { addRules: rules }).catch(function (err) {
      if (rules.length === 1) {
        droppedRules.push({ id: rules[0].id, reason: 'rejected by Safari: ' + err.message, rule: rules[0] });
        return;
      }
      var mid = Math.ceil(rules.length / 2);
      return addInChunks(rules.slice(0, mid), droppedRules).then(function () {
        return addInChunks(rules.slice(mid), droppedRules);
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
      batchRejected: false,
    };

    var existing = typeof dnr.getSessionRules === 'function'
      ? callDnr('getSessionRules').catch(function () { return []; })
      : Promise.resolve([]);

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
        out = out.concat(res.rules);
      });
      result.rulesOut = out.length;
      return applyBatch(out, removeRuleIds, result).then(function () {
        result.rulesOut = out.length - result.droppedRules.filter(function (d) { return /^rejected/.test(d.reason); }).length;
        report.calls++;
        report.lastCall = result;
        if (addRules.length) {
          report.lastAddCall = result;
          persistReport();
          console.info('BPC Safari: ' + result.rulesIn + ' rules requested, ' + result.rulesOut + ' applied (' +
            result.expandedRules + ' regex rules rewritten, ' + result.droppedRules.length + ' skipped)' +
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

  var bpcSafari = {
    getSelf: getSelf,
    updateSessionRules: updateSessionRules,
    offscreenParse: offscreenParse,
    report: report,
    // exposed for tests
    _diagnostics: diagnostics,
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
