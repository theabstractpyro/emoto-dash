import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../js/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

function filesUnder(dir) {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const p = join(dir, name);
    return statSync(join(root, p)).isDirectory() ? filesUnder(p) : [p.split('\\').join('/')];
  });
}

test('version is identical everywhere it appears', () => {
  assert.match(read('sw.js'), new RegExp(`const VERSION = 'emoto-dash-v${APP_VERSION.replace(/\./g, '\\.')}'`));
  assert.equal(JSON.parse(read('package.json')).version, APP_VERSION);
  assert.match(read('index.html'), new RegExp(`<meta name="app-version" content="${APP_VERSION.replace(/\./g, '\\.')}">`));
});

test('offline cache lists every app file', () => {
  const sw = read('sw.js');
  for (const f of [...filesUnder('js'), ...filesUnder('css'), ...filesUnder('icons'), 'index.html', 'manifest.webmanifest']) {
    assert.ok(sw.includes(`'${f}'`), `${relative(root, f)} missing from sw.js FILES`);
  }
});
