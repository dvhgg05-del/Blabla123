// Smoke-tests the COMPILED fenrealmblabla bundle in .dist before it is committed.
// No network: fetch is stubbed. Simulates the site's CURRENT behaviour:
//   chapter text is AES-GCM encrypted and only released after /api/read-token.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const baseDir = path.resolve(process.env.BASE_DIR ?? 'base');
const cheerio = createRequire(path.join(baseDir, 'package.json'))('cheerio');
const bundlePath = path.resolve('.dist/plugins/english/fenrealmblabla.js');

let handler;
const calls = [];
const mkHeaders = h => ({ get: k => h[k.toLowerCase()] ?? null });
const res = (body, ok = true, status = 200, headers = {}) => ({
  ok,
  status,
  headers: mkHeaders(headers),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});


const stubs = {
  cheerio,
  '@libs/defaultCover': { defaultCover: 'DEFAULT_COVER' },
  '@libs/novelStatus': {
    NovelStatus: { Unknown: 'Unknown', Ongoing: 'Ongoing', Completed: 'Completed', OnHiatus: 'On Hiatus', Cancelled: 'Cancelled' },
  },
  '@libs/filterInputs': { FilterTypes: { Picker: 'Picker', CheckboxGroup: 'Checkbox' } },
  '@libs/storage': { storage: { get: () => undefined } },
  '@libs/fetch': {
    fetchApi: async (url, init) => {
      calls.push({ url, init: init || {} });
      return handler(url, init || {});
    },
  },
};

// Simulate a bare plugin host: no TextEncoder/TextDecoder/atob/btoa.
for (const g of ['TextEncoder', 'TextDecoder', 'atob', 'btoa']) {
  Object.defineProperty(globalThis, g, { value: undefined, configurable: true, writable: true });
}
const bundleSrc = fs.readFileSync(bundlePath, 'utf8');
assert.ok(!bundleSrc.includes('@libs/aes'), 'bundle must be self-contained (no @libs/aes)');

// The Android plugin host is not a browser: make sure we do not rely on these.
for (const g of ['TextEncoder', 'TextDecoder', 'atob', 'btoa']) delete globalThis[g];

const mod = { exports: {} };
new Function('require', 'module', 'exports', bundleSrc)(
  id => {
    if (id in stubs) return stubs[id];
    throw new Error(`Unstubbed require in bundle: ${id}`);
  },
  mod,
  mod.exports,
);
const plugin = mod.exports.default;
assert.strictEqual(plugin.id, 'fenrealmblabla');

// Waits (request spacing, 429 back-off) are seconds in real life: make them instant.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = fn => realSetTimeout(fn, 0);

// ---- helpers to fake the site's encryption (v2 scheme, single-string content)
const sha256 = s => crypto.createHash('sha256').update(s).digest();
const b64url = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeToken = (cid) =>
  b64url(JSON.stringify({ vid: 'viewer-1', cid, exp: Math.floor(Date.now() / 1000) + 600 })) + '.sig';
const encrypt = (plain, token, id) => {
  const key = sha256(`${token}:viewer-1:${id}:fr-content-v2`);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
};

// ---- 1) Full flow: mint token -> locked/encrypted answer -> decrypt -> clean
const ZW = '\u200d\u200b\u200c';
const decoy = '<div aria-hidden="true">e4y3Jepddbi6Ia61I7i7990debk589xaT100Nb40caXa</div>';
const trail = '<a href="https://fenrirealm.com/api/v2/chapters/trail/AAAA" style="position:absolute;width:1px;height:1px" aria-hidden="true" data-noprefetch="">Related</a>';
const filler = Array.from({ length: 300 }, (_, i) => `<p>Filler line ${i} of the chapter.</p>`).join('');
const plainHtml =
  '<div class="reader-area">' + decoy +
  '<p tabindex="0">Chapter 110 : Title — “Café ★ 😀”</p>' + decoy +
  `<p tabindex="0">At ${ZW}the banquet, an attack occurred.</p>` + filler + trail + '</div>';

const TOKEN = makeToken(259870);
handler = async (url, init) => {
  if (url.endsWith('/series/i-decided/chapters')) return res([{ id: 259870, number: 110, title: 'Chapter 110' }, { id: 259869, number: 109, title: 'Chapter 109' }]);
  if (url.endsWith('/api/read-token') && init.method === 'POST') {
    return res({ active: true, token: TOKEN, expires_at: Math.floor(Date.now() / 1000) + 600 });
  }
  if (url.endsWith('/api/new/v2/chapters/259870')) {
    const cookie = (init.headers || {}).Cookie || '';
    if (!cookie.includes(TOKEN)) return res({ id: 259870, content: '', content_format: 'locked', locked: { price: 0 } });
    return res({ id: 259870, content_format: 'encrypted', content_scheme: 'fragmented-v2', content: encrypt(plainHtml, TOKEN, 259870) });
  }
  return res('', false, 404);
};
let html = await plugin.parseChapter('series/i-decided/110');
const $ = cheerio.load(html);
const texts = $('p').map((_, e) => $(e).text()).get();
assert.strictEqual(texts.length, 302);
assert.deepStrictEqual(texts.slice(0, 2), ['Chapter 110 : Title — “Café ★ 😀”', 'At the banquet, an attack occurred.']);
assert.ok(!html.includes('aria-hidden') && !html.includes('/trail/'), 'decoy/honeypot leaked');
assert.ok(!/[\u200B-\u200D\u2060\uFEFF]/.test(html), 'zero-width chars leaked');
const chapterCall = calls.find(c => c.url.endsWith('/chapters/259870'));
assert.strictEqual(chapterCall.init.headers['X-Accepts-Encrypted-Content'], '3');
assert.ok(chapterCall.init.headers.Cookie.startsWith('fr_read='), 'read token cookie not sent');
assert.ok(calls.every(c => !c.url.includes('/trail/')), 'honeypot URL was requested');

// ---- 1b) old stored paths ("slug/110~~id") still work (id is used directly)
plugin.cachedReadToken = null;
const html2 = await plugin.parseChapter('i-decided/110~~259870');
assert.ok(html2.includes('banquet'));

// ---- 2) A free chapter that says "locked" without a price is NOT reported as paid
plugin.cachedReadToken = null;
handler = async url => {
  if (url.endsWith('/api/read-token')) return res({ active: false }, true);
  if (url.includes('/chapters/')) return res({ id: 5, content: '', content_format: 'locked', locked: { price: 0 } });
  return res('<html></html>');
};
await assert.rejects(() => plugin.parseChapter('series/nv/1~~5'), err => {
  assert.ok(/fenrealmblabla v\d/.test(err.message), 'error lacks version tag');
  assert.ok(!/\(paid\)/.test(err.message), 'free chapter wrongly called paid: ' + err.message);
  assert.ok(/WebView/.test(err.message));
  return true;
});

// ---- 3) A really paid chapter says so
plugin.cachedReadToken = null;
handler = async url => {
  if (url.endsWith('/api/read-token')) return res({ active: false }, true);
  if (url.includes('/chapters/')) return res({ id: 6, content: '', content_format: 'locked', locked: { price: 30 } });
  return res('<html></html>');
};
await assert.rejects(() => plugin.parseChapter('series/nv/2~~6'), /locked \(paid\)/);

// ---- 4) Plain (unprotected) content still works
plugin.cachedReadToken = null;
handler = async url => {
  if (url.endsWith('/api/read-token')) return res({ active: false }, true);
  if (url.includes('/chapters/7')) return res({ id: 7, content_format: 'html', content: '<p>Plain text.</p>' });
  return res('', false, 404);
};
assert.ok((await plugin.parseChapter('series/nv/3~~7')).includes('Plain text.'));

// ---- 5) Paths are the WEBSITE paths: the app opens site + '/' + path
handler = async url => {
  if (url.endsWith('/series/nv/chapters'))
    return res([
      { id: 3, number: 2, slug: 'chapter-2', title: 'Chapter 2 : Second', created_at: '2026-03-02', group: null },
      { id: 1, number: 1, title: 'Chapter 1', created_at: '2026-03-01', group: null },
      { id: 9, number: 1, slug: 'chapter-1', title: 'Intro', locked: { price: 5 }, group: { index: 2, slug: 'vol-2' } },
    ]);
  if (url.endsWith('/series/nv')) return res({ title: 'My Novel', slug: 'nv', cover: 'storage/1/a.jpg', status: 'completed', description: '<p>One</p>' });
  return res('', false, 404);
};
const novel = await plugin.parseNovel('series/nv');
const hostUrl = p => 'https://fenrirealm.com/' + p; // what the app's WebView opens
assert.strictEqual(hostUrl(novel.path), 'https://fenrirealm.com/series/nv');
assert.deepStrictEqual(novel.chapters.map(c => hostUrl(c.path)), [
  'https://fenrirealm.com/series/nv/1',
  'https://fenrirealm.com/series/nv/2',
  'https://fenrirealm.com/series/nv/vol-2/1',
]);
assert.ok(novel.chapters.every(c => !c.path.includes('~~')), 'id suffix would break the web link');
assert.strictEqual(novel.cover, 'https://fenrirealm.com/storage/1/a.jpg');
// old library entry (plain slug) still opens the novel
assert.strictEqual((await plugin.parseNovel('nv')).path, 'series/nv');
// resolveUrl agrees with the website for every stored format
for (const p of ['nv', 'series/nv']) assert.strictEqual(plugin.resolveUrl(p), 'https://fenrirealm.com/series/nv');
for (const p of ['series/nv/2', 'nv/2~~3']) assert.strictEqual(plugin.resolveUrl(p), 'https://fenrirealm.com/series/nv/2');
assert.strictEqual(plugin.resolveUrl('series/nv/vol-2/1'), 'https://fenrirealm.com/series/nv/vol-2/1');

// ---- 6) Errors carry the plugin version so the installed build is identifiable
handler = async () => res('', false, 500);
await assert.rejects(() => plugin.parseChapter('series/nv/1~~5'), /\[fenrealmblabla v\d+\.\d+\.\d+\]/);

// ---- 7) HTTP 429 "Too Many Attempts": wait + retry instead of failing at once
plugin.cachedReadToken = null;
let hits = 0;
handler = async url => {
  if (url.endsWith('/api/read-token')) return res({ active: false });
  if (url.includes('/chapters/42')) {
    hits++;
    return hits <= 2
      ? res({ message: 'Too Many Attempts.' }, false, 429, { 'retry-after': '1' })
      : res({ id: 42, content_format: 'html', content: '<p>Back after the wait.</p>' });
  }
  return res('', false, 404);
};
assert.ok((await plugin.parseChapter('series/nv/9~~42')).includes('Back after the wait.'));
assert.strictEqual(hits, 3, 'expected 2 retries after the 429s');

// ...and if the site keeps refusing, say so clearly (no endless loop)
hits = 0;
handler = async url => {
  if (url.endsWith('/api/read-token')) return res({ active: false });
  if (url.includes('/chapters/43')) { hits++; return res({}, false, 429); }
  return res('', false, 404);
};
await assert.rejects(() => plugin.parseChapter('series/nv/10~~43'), /Rate limited.*\[fenrealmblabla v/s);
assert.strictEqual(hits, 3, 'should stop after 1 try + 2 retries');

// ---- 8) Parallel chapter loads are queued one at a time (no request bursts)
let inFlight = 0, maxInFlight = 0;
handler = async url => {
  if (url.endsWith('/api/read-token')) return res({ active: false });
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise(r => realSetTimeout(r, 5));
  inFlight--;
  return res({ id: 1, content_format: 'html', content: '<p>ok</p>' });
};
await Promise.all([1, 2, 3, 4].map(n => plugin.parseChapter(`series/nv/${n}~~${n}`)));
assert.strictEqual(maxInFlight, 1, 'chapters must not be fetched in parallel');

console.log('fenrealmblabla smoke test passed');
