// Random string sampler for the regex subset understood by safari-compat.js,
// used to check that rewritten patterns match exactly the same URLs as the
// original pattern (verified with the JavaScript regex engine).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const compat = require('../src/safari-compat.js');

export function rng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const classCache = new Map();
function charsOf(text) {
  if (!classCache.has(text)) {
    const re = new RegExp('^' + text + '$');
    classCache.set(text, PRINTABLE.filter((c) => re.test(c)));
  }
  return classCache.get(text);
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', 0: '\0' };

function sampleAtom(atom, r) {
  if (atom.type === 'bol' || atom.type === 'eol') return '';
  if (atom.type === 'group') return sampleAlt(atom.alt, r);
  const t = atom.text;
  if (t === '.' || t.startsWith('[')) {
    const cs = charsOf(t);
    return cs.length ? cs[Math.floor(r() * cs.length)] : '';
  }
  if (t.startsWith('\\')) return ESCAPES[t[1]] ?? t[1];
  return t;
}

function sampleTerm({ atom, quant }, r) {
  let n = 1;
  if (quant) {
    const max = quant.max === Infinity ? quant.min + 3 : quant.max;
    n = quant.min + Math.floor(r() * (max - quant.min + 1));
  }
  let s = '';
  for (let k = 0; k < n; k++) s += sampleAtom(atom, r);
  return s;
}

function sampleAlt(alt, r) {
  const seq = alt.alts[Math.floor(r() * alt.alts.length)];
  return seq.map((t) => sampleTerm(t, r)).join('');
}

export function samples(pattern, count, r) {
  const ast = compat._parseRegex(pattern);
  const out = [];
  for (let k = 0; k < count; k++) out.push(sampleAlt(ast, r));
  return out;
}

// Returns null when the union of `variants` agrees with `original` on all
// sampled strings, or the first counter-example.
export function findMismatch(original, variants, { seed = 7, count = 300 } = {}) {
  const r = rng(seed);
  const R = new RegExp(original);
  const Vs = variants.map((v) => new RegExp(v));
  const strings = samples(original, count, r);
  const per = Math.ceil(count / Math.max(variants.length, 1)) + 5;
  for (const v of variants) strings.push(...samples(v, per, r));
  const contexts = (s) => [s, 'https://www.example.com/' + s, s + '/x.js?y=1', 'a' + s + 'b', s.slice(1), s.slice(0, -1)];
  for (const s of strings) {
    for (const x of contexts(s)) {
      const a = R.test(x);
      const b = Vs.some((V) => V.test(x));
      if (a !== b) return { input: x, original: a, variants: b };
    }
  }
  return null;
}
