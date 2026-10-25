// Smoke-tests the COMPILED fenrealmblabla bundle in .dist before it is committed.
// No network: fetch is stubbed. Covers the things that broke the old plugin
// ("Verifying access…" shown as chapter text) and the content clean-up.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const baseDir = path.resolve(process.env.BASE_DIR ?? 'base');
const cheerio = createRequire(path.join(baseDir, 'package.json'))('cheerio');
const bundlePath = path.resolve('.dist/plugins/english/fenrealmblabla.js');

let handler;
const calls = [];
const res = (body, ok = true, status = 200) => ({
  ok,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
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
      calls.push(url);
      return handler(url, init);
    },
  },
};

const mod = { exports: {} };
new Function('require', 'module', 'exports', fs.readFileSync(bundlePath, 'utf8'))(
  id => {
    if (id in stubs) return stubs[id];
    throw new Error(`Unstubbed require in bundle: ${id}`);
  },
  mod,
  mod.exports,
);
const plugin = mod.exports.default;

// Retries wait seconds in real life; make them instant here.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = fn => realSetTimeout(fn, 0);

assert.strictEqual(plugin.id, 'fenrealmblabla');

// 1) Real-shaped chapter: decoys, zero-width fingerprint, honeypot links.
const ZW = '\u200d\u200b\u200c\u200c\u200b\u200b\u200c\u200b';
const decoy = '<div aria-hidden="true" class="c48a000b00b3b">e4y3Jepddbi6Ia61I7i7990debk589xaT100Nb40caXaB1G1ZbX6p0ObSb06g709M8y596x5Lc1aE899P0S5Ifs5I0nbZ2hdb5H6V6l3I4j0o3i0a</div>';
const trail = '<a href="https://fenrirealm.com/api/v2/chapters/trail/AAAA.BBBB" style="position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)" aria-hidden="true" tabindex="-1" rel="nofollow noopener" data-noprefetch="">Related</a>';
const chapterHtml =
  '<div class="reader-area" id="reader-area-1">' +
  decoy + '<p tabindex="0">Chapter 39 : Title</p>' +
  decoy + `<p tabindex="0">At ${ZW}the banquet, an attack occurred.</p>` +
  decoy + '<p tabindex="0">“Judging by your expression, you are not joking.”</p>' +
  trail + trail + '</div>';

handler = async () => res({ content: chapterHtml });
let html = await plugin.parseChapter('novel/39~~1');
const $ = cheerio.load(html);
const paras = $('p').map((_, e) => $(e).text()).get();
assert.deepStrictEqual(paras, [
  'Chapter 39 : Title',
  'At the banquet, an attack occurred.',
  '“Judging by your expression, you are not joking.”',
]);
assert.ok(!/[\u200B-\u200D\u2060\uFEFF]/.test(html), 'zero-width characters leaked');
assert.ok(!html.includes('aria-hidden') && !html.includes('/trail/'), 'decoy/honeypot leaked');
assert.ok(calls.every(u => !u.includes('/trail/')), 'honeypot URL was requested');

// 2) The verification placeholder must never be returned as chapter text.
calls.length = 0;
handler = async url =>
  url.includes('/api/new/v2/chapters/') ? res({ content: 'Verifying access…' }) : res('<html></html>');
await assert.rejects(() => plugin.parseChapter('novel/34~~55'), /Verifying access.*WebView/s);
assert.strictEqual(calls.filter(u => u.includes('/api/new/v2/chapters/')).length, 3, 'expected 1 try + 2 retries');

// 3) ...but real text after the check clears is returned.
let n = 0;
handler = async url => {
  if (url.includes('/api/new/v2/chapters/')) return res({ content: ++n < 2 ? 'Verifying access…' : '<p>Real text.</p>' });
  return res('<html></html>');
};
assert.ok((await plugin.parseChapter('novel/34~~55')).includes('Real text.'));

// 4) Chapter paths match the site's URLs so WebView opens the right page.
handler = async url => {
  if (url.endsWith('/series/nv/chapters'))
    return res([
      { id: 3, number: 2, title: 'Chapter 2 : Second', created_at: '2026-03-02', group: null },
      { id: 1, number: 1, title: 'Chapter 1', created_at: '2026-03-01', group: null },
      { id: 9, number: 1, title: 'Intro', locked: { price: 5 }, group: { index: 2, slug: 'vol-2' } },
    ]);
  if (url.endsWith('/series/nv')) return res({ title: 'My Novel', slug: 'nv', cover: 'storage/1/a.jpg', status: 'on-going', description: '<p>One</p>' });
  return res('', false, 404);
};
const novel = await plugin.parseNovel('nv');
assert.deepStrictEqual(novel.chapters.map(c => c.path), ['nv/1~~1', 'nv/2~~3', 'nv/vol-2/1~~9']);
assert.strictEqual(novel.cover, 'https://fenrirealm.com/storage/1/a.jpg');
assert.strictEqual(plugin.resolveUrl('nv/vol-2/1~~9'), 'https://fenrirealm.com/series/nv/vol-2/1');

console.log('fenrealmblabla smoke test passed');
