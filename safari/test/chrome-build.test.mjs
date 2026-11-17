// The Chrome release with the site fixes (chrome/build.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChrome } from '../../chrome/build.mjs';
import { applySiteFixes } from '../build.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function unzip(zip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-chrome-test-'));
  execFileSync('unzip', ['-q', zip, '-d', dir]);
  return dir;
}
function files(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
}

test('Chrome build: only sites.js and the version name differ from upstream', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-chrome-out-'));
  const res = buildChrome({ out });
  const upstream = unzip(path.join(repo, 'bypass-paywalls-chrome-clean-master.zip'));
  const fixed = unzip(res.zip);
  try {
    assert.deepEqual(files(fixed), files(upstream));
    for (const f of files(upstream)) {
      const a = fs.readFileSync(path.join(upstream, f));
      const b = fs.readFileSync(path.join(fixed, f));
      if (f === 'bypass-paywalls-chrome-clean-master/sites.js') assert.equal(b.toString('utf8'), applySiteFixes(a.toString('utf8')), f);
      else if (f === 'bypass-paywalls-chrome-clean-master/manifest.json') {
        const ma = JSON.parse(a), mb = JSON.parse(b);
        assert.equal(mb.version, ma.version);
        assert.match(mb.version_name, /site fixes: thehill\.com/);
        delete mb.version_name;
        assert.deepEqual(mb, ma);
      } else assert.ok(a.equals(b), f);
    }
    const sites = fs.readFileSync(path.join(fixed, files(fixed).find((f) => f.endsWith('sites.js'))), 'utf8');
    assert.match(sites, /login-registration-bc-wall/);
    assert.match(sites, /#login-registration-paywall\{display:none !important\}/);
  } finally {
    for (const d of [out, upstream, fixed]) fs.rmSync(d, { recursive: true, force: true });
  }
});
