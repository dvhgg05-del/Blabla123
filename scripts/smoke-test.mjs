// Smoke-tests the COMPILED bundle in .dist before it is committed.
// The bundle is ES5 output, so source that looks fine can still misbehave
// (e.g. spreading a Set/Map silently yields []). This catches that class of bug.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const baseDir = path.resolve(process.env.BASE_DIR ?? 'base');
const cheerio = createRequire(path.join(baseDir, 'package.json'))('cheerio');
const bundlePath = path.resolve('.dist/plugins/english/novelpiaglobal.js');

const card = (id, title, rank, delta) =>
  `<div><a href="/novel/${id}">${title}<b>${rank}</b><i>${delta}</i></a>` +
  `<a href="/novel/${id}">${title}</a>` +
  `<img data-src="//gn.novelpia.com/upload/novel/${id}/c?mode=n_thumb"></div>`;

// Real card shape (rank, title and tag/view stats inside ONE anchor).
const realCard = (id, title, rank) =>
  `<a class="novel-box-wrp" href="/novel/${id}?sid=main1"><div class="cover"><img alt="${title}" src="https://gn.novelpia.com/upload/novel/${id}/x_ori.file?mode=n_thumb"></div>` +
  `<div class="novel-notice-wrp"><div class="ranking">${rank}</div><div class="novel-tit">${title}</div><div class="novel-tag"><span>#Fantasy</span><span>36.7K</span><span>112</span></div></div></a>`;

let rankingHtml = '';
for (let i = 1; i <= 120; i++) rankingHtml += card(i, `Title ${i}`, i, i % 2 ? '▲ 3' : '▼ 1');

const stubs = {
  cheerio,
  '@libs/defaultCover': { defaultCover: 'DEFAULT_COVER' },
  '@libs/novelStatus': { NovelStatus: { Ongoing: 'Ongoing', Completed: 'Completed' } },
  '@libs/filterInputs': { FilterTypes: { Picker: 'Picker', ExcludableCheckboxGroup: 'XCheckbox' } },
  '@libs/storage': { storage: { get: () => undefined } },
  '@libs/fetch': {
    fetchApi: async () => ({
      ok: true,
      status: 200,
      text: async () => `<html><body>${rankingHtml}</body></html>`,
    }),
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
const opts = { showLatestNovels: false, filters: undefined };

const page1 = await plugin.popularNovels(1, opts);
assert.ok(page1.length > 0, 'Popular returned no novels (listing parser is broken in the compiled bundle)');
assert.strictEqual(page1.length, 50, 'Popular page 1 should hold 50 items');
assert.strictEqual(page1[0].name, 'Title 1', `Rank suffix leaked into title: "${page1[0].name}"`);
assert.strictEqual(page1[0].path, '/novel/1');
assert.ok(page1[0].cover.startsWith('https://gn.novelpia.com/upload/novel/1/'), 'Cover not extracted');

const page2 = await plugin.popularNovels(2, opts);
assert.strictEqual(page2[0].path, '/novel/51', 'Popular page 2 repeats page 1');
assert.strictEqual((await plugin.popularNovels(4, opts)).length, 0, 'Popular never ends');

// second pass with the real single-anchor card shape
rankingHtml = '';
for (let i = 1; i <= 60; i++) rankingHtml += realCard(i, `Real Title ${i}`, i);
const fresh = await plugin.popularNovels(1, { showLatestNovels: true, filters: undefined });
assert.strictEqual(fresh[0].name, 'Real Title 1', `Real card title polluted: "${fresh[0].name}"`);

// tag include / exclude on the real /novels card shape
const tagCard = (id, tags) =>
  `<div class="nv-list-item"><a class="nv-list-cover-box" href="/novel/${id}"><img src="https://gn.novelpia.com/upload/novel/${id}/c?mode=n_thumb"></a>` +
  `<a class="title" href="/novel/${id}"><p>Tagged ${id}</p></a><div class="tags">` +
  tags.map(x => `<span>${x}</span><span class="mx-[10px]">.</span>`).join('') + '</div></div>';
rankingHtml = tagCard(1, ['Fantasy', 'Harem']) + tagCard(2, ['Fantasy']) + tagCard(3, ['Harem', 'Comedy']);
const tagOpts = (include, exclude) => ({
  showLatestNovels: false,
  filters: { browse: { value: 'all' }, tags: { value: { include, exclude } } },
});
const inc = await plugin.popularNovels(1, tagOpts(['Harem'], []));
assert.deepStrictEqual(inc.map(n => n.path), ['/novel/1', '/novel/3'], 'tag include is broken');
const exc = await plugin.popularNovels(1, tagOpts([], ['Harem']));
assert.deepStrictEqual(exc.map(n => n.path), ['/novel/2'], 'tag exclude is broken');

console.log(`Smoke test passed for ${plugin.name} v${plugin.version}`);

// ---- second plugin: CMelle single-novel WordPress source -------------------
const cmellePath = path.resolve('.dist/plugins/english/cmellesecondson.js');
const cmelleHtml = `<html><head><link rel="canonical" href="https://cmelle711.wordpress.com/how-to-survive-as-the-second-son-of-a-mage-family-7/"><meta property="og:image" content="https://cmelle711.wordpress.com/c.jpg"></head><body><div class="entry-content"><h2 class="wp-block-heading">How to Survive as the Second Son of a Mage Family</h2><details><ul><li><a href="/ch-2/">Chapter 2</a></li><li><a href="/ch-1/">Chapter 1</a></li></ul></details></div></body></html>`;
const cmelleMod = { exports: {} };
new Function('require', 'module', 'exports', fs.readFileSync(cmellePath, 'utf8'))(
  id => {
    const table = {
      cheerio,
      '@libs/defaultCover': { defaultCover: 'DEFAULT_COVER' },
      '@libs/novelStatus': { NovelStatus: { Unknown: 'Unknown' } },
      '@libs/fetch': { fetchApi: async () => ({ ok: true, status: 200, text: async () => cmelleHtml }) },
    };
    if (id in table) return table[id];
    throw new Error(`Unstubbed require in CMelle bundle: ${id}`);
  },
  cmelleMod,
  cmelleMod.exports,
);
const cmelle = cmelleMod.exports.default;
const novels = await cmelle.popularNovels(1);
assert.strictEqual(novels.length, 1, 'CMelle Popular should return the single novel');
const detail = await cmelle.parseNovel(novels[0].path);
assert.deepStrictEqual(detail.chapters.map(c => c.name), ['Chapter 1', 'Chapter 2'], 'CMelle chapters must be oldest-first');
console.log(`Smoke test passed for ${cmelle.name} v${cmelle.version}`);

