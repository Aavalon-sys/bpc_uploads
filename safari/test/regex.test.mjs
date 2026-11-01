import test from 'node:test';
import assert from 'node:assert/strict';
import { compat, findMismatch } from './sampler.mjs';
import { webkitRegexProblem } from './webkit-rules.mjs';

const rewrite = (re, opts) => compat._rewriteRegex(re, opts);

test('alternation is expanded into separate patterns', () => {
  assert.deepEqual(rewrite('(\\.cxense\\.com\\/|\\.piano\\.io\\/)'), ['\\.cxense\\.com\\/', '\\.piano\\.io\\/']);
  assert.deepEqual(rewrite('\\.ftm\\.(nl|eu)\\/js\\/routing\\?'), ['\\.ftm\\.nl\\/js\\/routing\\?', '\\.ftm\\.eu\\/js\\/routing\\?']);
  assert.deepEqual(rewrite('(^|\\.)example\\.com'), ['^example\\.com', '\\.example\\.com']);
  assert.deepEqual(rewrite('x(a|b)?y'), ['xa?y', 'xb?y']);
  assert.deepEqual(rewrite('(\\/inc42\\.com\\/wp-admin\\/admin-ajax\\.php$|\\.ampproject\\.org\\/v0\\/amp-access-.+\\.js)'),
    ['\\/inc42\\.com\\/wp-admin\\/admin-ajax\\.php$', '\\.ampproject\\.org\\/v0\\/amp-access-.+\\.js']);
});

test('nested alternation produces the cartesian product', () => {
  assert.deepEqual(
    rewrite('(\\.(cedscdn|cedsdigital)\\.it\\/.+\\/(PaywallMeter|cmpConsentWall)\\.js|\\.ampproject\\.org\\/v0\\/amp-(access|subscriptions)-.+\\.m?js)'),
    [
      '\\.cedscdn\\.it\\/.+\\/PaywallMeter\\.js',
      '\\.cedscdn\\.it\\/.+\\/cmpConsentWall\\.js',
      '\\.cedsdigital\\.it\\/.+\\/PaywallMeter\\.js',
      '\\.cedsdigital\\.it\\/.+\\/cmpConsentWall\\.js',
      '\\.ampproject\\.org\\/v0\\/amp-access-.+\\.m?js',
      '\\.ampproject\\.org\\/v0\\/amp-subscriptions-.+\\.m?js',
    ]);
});

test('built-in classes and brace quantifiers are spelled out', () => {
  assert.deepEqual(rewrite('www\\.vogue\\.com\\/[-\\w]+$'), ['www\\.vogue\\.com\\/[\\-A-Za-z0-9_]+$']);
  assert.deepEqual(rewrite('\\/epoch\\.org\\.il\\/.+\\/\\d{5,}\\/'), ['\\/epoch\\.org\\.il\\/.+\\/[0-9][0-9][0-9][0-9][0-9]+\\/']);
  assert.deepEqual(rewrite('[a-z]{1}[0-9]{2,3}'), ['[a-z][0-9][0-9][0-9]?']);
  assert.deepEqual(rewrite('\\.telegram\\.hr\\/.+\\/(\\w+-){3,}'),
    ['\\.telegram\\.hr\\/.+\\/([A-Za-z0-9_]+-)([A-Za-z0-9_]+-)([A-Za-z0-9_]+-)+']);
  assert.deepEqual(rewrite('a\\Db[\\W]'), ['a[^0-9]b[^A-Za-z0-9_]']);
});

test('substitution patterns keep their capture groups', () => {
  const re = '.+\\.adelaidenow.com.au\\/subscribe\\/.+&dest=.+\\.com\\.au%2F([\\w-%]+)&.+';
  const [v] = rewrite(re, { keepCaptures: true });
  assert.equal(v, '.+\\.adelaidenow.com.au\\/subscribe\\/.+&dest=.+\\.com\\.au%2F([A-Za-z0-9_\\-%]+)&.+');
  const url = 'https://www.adelaidenow.com.au/subscribe/news/?a=1&dest=https%3A%2F%2Fwww.adelaidenow.com.au%2Fnews-story-123&b=2';
  assert.equal(url.replace(new RegExp(re), '$1'), url.replace(new RegExp(v), '$1'));
  assert.deepEqual(rewrite('(a|b)(c)', { keepCaptures: true }), ['(a)(c)', '(b)(c)']);
  assert.deepEqual(rewrite('(?:ab)?(c)', { keepCaptures: true }), ['(?:ab)?(c)']);
  assert.throws(() => rewrite('(\\w){2}', { keepCaptures: true }), /repeated capture group/);
  assert.throws(() => rewrite('a+?(b)', { keepCaptures: true }), /lazy/);
});

test('patterns that cannot be expressed are refused', () => {
  assert.throws(() => rewrite('(a|b)+c'), /repeated alternation/);
  assert.throws(() => rewrite('^((?!\\/epaper\\.).)*$'), /lookaround/);
  assert.throws(() => rewrite('\\bword'), /word boundary/);
  assert.throws(() => rewrite('(a)\\1'), /back-reference/);
  assert.throws(() => rewrite('(a|b|c|d)(e|f|g|h)(i|j|k|l)(m|n)'), /variants/);
});

test('lazy quantifiers become greedy when only matching matters', () => {
  assert.deepEqual(rewrite('a.+?b'), ['a.+b']);
});

// A sample of real patterns from the extension (sites.js, version 4.4.8.3).
const REAL = [
  '(paywall\\.folha\\.uol\\.com\\.br\\/|\\.(tinypass|matheranalytics)\\.com\\/|\\.poool\\.fr\\/|\\.ampproject\\.org\\/v0\\/amp-subscriptions-.+\\.js)',
  '(\\.nytimes\\.com\\/(meter\\.js|svc\\/onsite-messaging\\/query)|mwcm\\.nyt\\.com\\/.+\\.js|cooking\\.nytimes\\.com\\/api\\/.+\\/access)',
  '\\.(elmercurio\\.com|emol\\.cl)\\/(.+\\/)?js\\/(.+\\/)?(modal|merPramV\\d|(FuncionesComun|PramModal)\\.min)\\.js',
  '\\.ampproject\\.org\\/.+\\/amp-(access|(.+-)?ad|analytics|fx-flying-carpet|subscriptions)-.+\\.m?js',
  '(\\.blueconic\\.net\\/|[a-z]{1}[0-9]{2,3}\\.[\\w-]+\\.(co(m|\\.uk)|net|org)\\/script\\.js)',
  '(\\.winnipegfreepress\\.com\\/(api\\/v\\d\\/auth\\/identify|.+\\/gdpr\\.js)|\\.cxense\\.com\\/)',
  '\\.straitstimes\\.com\\/(opinion\\/|.+(\\w+-){3,}.+\\?rel=plus)',
  '\\.bizjournals\\.com\\/.+\\/(news|stories)\\/.+\\.html\\?rel=plus',
  '(\\.poool\\.fr\\/|\\.lequipe\\.fr\\/assets\\/js\\/.*[wW]all.+\\.js)',
  '\\/evolok\\/(.+\\/)?ev-(em|widgets)\\.min\\.js',
  '\\.rugbypass\\.com\\/plus\\/\\w',
  '(\\.businessinsider\\.com\\/chunks\\/scripts\\/\\d.+\\.js|\\.sophi\\.io\\/)',
  '(\\.sophi\\.io\\/|reader\\.(.+\\.)?cleveland\\.com\\/pugpig-websmartbanner\\.js)',
  '(cdn|loader)\\..+\\.com\\/prod\\/.+\\/loader\\.min\\.js',
  '\\/epoch\\.org\\.il\\/.+\\/\\d{5,}\\/',
  '.+\\.theaustralian.com.au\\/subscribe\\/.+&dest=.+\\.com\\.au%2F([\\w-%]+)&.+',
];

test('rewritten real patterns are WebKit-compatible and match the same URLs', () => {
  for (const re of REAL) {
    const variants = rewrite(re);
    assert.ok(variants.length >= 1, re);
    for (const v of variants) assert.equal(webkitRegexProblem(v), null, `${re} -> ${v}`);
    assert.equal(findMismatch(re, variants), null, re);
  }
});

test('the strict WebKit model in the extension agrees with the test model', () => {
  const cases = REAL.concat(REAL.flatMap((re) => rewrite(re)), ['a|b', 'a{2}', '^a$', 'a^', '$a', '[\\d]', '(?=a)', 'a*?', 'é']);
  for (const re of cases) assert.equal(compat._webkitRegexProblem(re), webkitRegexProblem(re), re);
});

test('the equivalence check itself detects wrong rewrites', () => {
  assert.notEqual(findMismatch('(a|b)c', ['ac']), null);
  assert.notEqual(findMismatch('a\\d+', ['a[0-8]+']), null);
  assert.notEqual(findMismatch('ab{2,3}c', ['abbc']), null);
});
