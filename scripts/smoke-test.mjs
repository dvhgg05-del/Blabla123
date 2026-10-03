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

let rankingHtml = '';
for (let i = 1; i <= 120; i++) rankingHtml += card(i, `Title ${i}`, i, i % 2 ? '▲ 3' : '▼ 1');

const stubs = {
  cheerio,
  '@libs/defaultCover': { defaultCover: 'DEFAULT_COVER' },
  '@libs/novelStatus': { NovelStatus: { Ongoing: 'Ongoing', Completed: 'Completed' } },
  '@libs/filterInputs': { FilterTypes: {} },
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

console.log(`Smoke test passed for ${plugin.name} v${plugin.version}`);
