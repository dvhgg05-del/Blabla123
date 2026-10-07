import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as parseHTML } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { storage } from '@libs/storage';

// Toasty Translations (WordPress.com, Varia theme).
//   /all-translations/        -> lists the novels (Ongoing / Finished / ...)
//   /<novel-slug>/            -> cover, summary and a table of contents
//   /YYYY/MM/DD/<post-slug>/  -> one chapter per post
//
// Build note: LNReader compiles plugins to ES5 without downlevelIteration, so
// never spread a Set/Map/iterator in this file (it silently becomes []).

const SITE = 'https://toastytranslations.com';
const HOST = 'toastytranslations.com';
const CATALOGUE_PATH = '/all-translations/';
const CATALOGUE_TTL_MS = 10 * 60 * 1000;
const DATED_POST = /\/(\d{4})\/(\d{2})\/(\d{2})\//;

// Only these sections of the catalogue are real, readable translations.
const WANTED_SECTION = /^(?:ongoing|finished)\s+translations/i;
const SKIPPED_SECTION = /^(?:potential|cancel+ed|dropped|hiatus)/i;

// Widgets WordPress/Jetpack put inside .entry-content that are not story text.
const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  '.sharedaddy',
  '.jetpack-likes-widget-wrapper',
  '#jp-post-flair',
  '#jp-relatedposts',
  '.jp-relatedposts',
  '.wordads-ad-wrapper',
  '.wpcnt',
  '.wp-block-post-navigation-link',
  '.post-navigation',
];

const NAV_WORDS = [
  'previous',
  'prev',
  'next',
  'chapter',
  'table',
  'of',
  'contents',
  'index',
  'toc',
  'home',
  'back',
  'to',
  'novel',
  'page',
  'return',
  'main',
];

type Cheerio$ = ReturnType<typeof parseHTML>;

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeUrl(url?: string): string | undefined {
  const value = (url ?? '').trim();
  if (!value) return undefined;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${SITE}${value}`;
  return value;
}

function isOwnHost(url: string): boolean {
  const host = url
    .replace(/^https?:\/\//i, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
  return host === HOST || host === `www.${HOST}`;
}

// Site-relative path (keeps the query-less path) for this blog, else null.
function toPath(href?: string): string | null {
  const value = (href ?? '').trim().replace(/#.*$/, '');
  if (!value || /^(?:javascript|mailto|tel):/i.test(value)) return null;
  if (value.startsWith('//')) return toPath(`https:${value}`);
  if (/^https?:\/\//i.test(value)) {
    if (!isOwnHost(value)) return null;
    return value.replace(/^https?:\/\/[^/]+/i, '').replace(/\?.*$/, '') || '/';
  }
  return (value.startsWith('/') ? value : `/${value}`).replace(/\?.*$/, '');
}

function slugOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

async function getHtml(url: string): Promise<string> {
  const response = await fetchApi(url);
  if (!response.ok) {
    throw new Error(`Toasty Translations returned HTTP ${response.status}`);
  }
  return response.text();
}

// Photon-style resize; the site's own images already use ?w=720.
function coverUrl(url?: string): string {
  const normalized = normalizeUrl(url);
  if (!normalized) return defaultCover;
  const bare = normalized.replace(/\?.*$/, '');
  return /\/wp-content\/uploads\//.test(bare) ? `${bare}?w=400` : normalized;
}

function releaseDateFromPath(path: string): string | undefined {
  const match = path.match(DATED_POST);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function chapterNumberOf(name: string): number | undefined {
  const match = name.match(/^\s*(\d+(?:\.\d+)?)\s*[.)\-:]/);
  return match ? Number(match[1]) : undefined;
}

// Text of a paragraph with <br> turned into line breaks.
function paragraphLines($: Cheerio$, paragraph: any): string[] {
  const html = ($(paragraph).html() ?? '').replace(/<br\s*\/?>/gi, '\n');
  return parseHTML(`<div>${html}</div>`, null, false)
    .root()
    .text()
    .split('\n')
    .map(line => cleanText(line))
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                            */
/* ------------------------------------------------------------------ */

type NovelPageInfo = { name: string; cover: string; summary: string };

function readNovelPage($: Cheerio$): NovelPageInfo {
  const name = cleanText(
    $('.entry-title').first().text() || $('h1').first().text(),
  );

  const image = $('.entry-content img').first();
  const cover = coverUrl(
    image.attr('data-orig-file') ??
      image.attr('src') ??
      $("meta[property='og:image']").first().attr('content'),
  );

  // "Summary (Taken from MangaDex):" label, then the text after a <br>.
  let summary = '';
  $('.entry-content > p').each((_, paragraph) => {
    if (summary) return;
    const lines = paragraphLines($, paragraph);
    if (!lines.length || !/^summary\b/i.test(lines[0])) return;
    const rest = /:\s*$/.test(lines[0])
      ? lines.slice(1)
      : [lines[0].replace(/^summary[^:]*:\s*/i, '')].concat(lines.slice(1));
    summary = rest.filter(Boolean).join('\n');
  });

  return { name, cover, summary };
}

let catalogueCache: { at: number; items: Plugin.NovelItem[] } | null = null;
const finishedPaths: Record<string, boolean> = {};

async function loadCatalogue(): Promise<Plugin.NovelItem[]> {
  if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) {
    return catalogueCache.items;
  }

  const $ = parseHTML(await getHtml(`${SITE}${CATALOGUE_PATH}`));
  const found: { name: string; path: string; finished: boolean }[] = [];
  const seen: Record<string, boolean> = {};

  let wanted = false;
  let finished = false;
  $('.entry-content')
    .first()
    .children()
    .each((_, child) => {
      const $child = $(child);
      const tag = (child as any).name;
      if (tag === 'p') {
        const label = cleanText($child.text());
        if (WANTED_SECTION.test(label)) {
          wanted = true;
          finished = /^finished/i.test(label);
        } else if (SKIPPED_SECTION.test(label)) {
          wanted = false;
        }
      } else if (tag === 'ul' && wanted) {
        $child.find('li a').each((__, a) => {
          const path = toPath($(a).attr('href'));
          // Novel pages only; dated URLs are single posts.
          if (!path || DATED_POST.test(path) || path === '/' || seen[path]) {
            return;
          }
          seen[path] = true;
          found.push({ name: cleanText($(a).text()), path, finished });
        });
      }
    });

  // One request per novel for its cover and exact title. A failure only costs
  // that novel its cover, not the whole list.
  const items = await Promise.all(
    found.map(async entry => {
      finishedPaths[entry.path] = entry.finished;
      try {
        const info = readNovelPage(
          parseHTML(await getHtml(`${SITE}${entry.path}`)),
        );
        return {
          name: info.name || entry.name,
          path: entry.path,
          cover: info.cover,
        };
      } catch (_error) {
        return { name: entry.name, path: entry.path, cover: defaultCover };
      }
    }),
  );

  if (items.length) catalogueCache = { at: Date.now(), items };
  return items;
}

/* ------------------------------------------------------------------ */
/* Chapter list                                                         */
/* ------------------------------------------------------------------ */

type TocEntry = { name: string; path?: string; number?: number };
type FeedPost = { name: string; path: string };

// The table of contents is a set of bullet lists. Chapters that are not
// published yet appear as plain text without a link.
function readToc($: Cheerio$): TocEntry[] {
  const entries: TocEntry[] = [];
  const seen: Record<string, boolean> = {};

  $('.entry-content ul li').each((_, li) => {
    if ($(li).closest('.sharedaddy').length) return;
    const link = $(li).find('a').first();
    const name = cleanText(link.length ? link.text() : $(li).text());
    if (!name) return;

    const path = link.length ? toPath(link.attr('href')) : null;
    if (path) {
      // Only chapter posts: dated URLs on this blog.
      if (!DATED_POST.test(path) || seen[path]) return;
      seen[path] = true;
      entries.push({ name, path, number: chapterNumberOf(name) });
    } else if (!link.length && chapterNumberOf(name) !== undefined) {
      entries.push({ name, number: chapterNumberOf(name) });
    }
  });
  return entries;
}

// Post cards on the home page / category archive: <article class="category-
// <slug>"> with an h2.entry-title link.
function readFeed(html: string, slug: string): FeedPost[] {
  const $ = parseHTML(html);
  const posts: FeedPost[] = [];
  $('article').each((_, article) => {
    const classes = ($(article).attr('class') ?? '').split(/\s+/);
    if (classes.indexOf(`category-${slug}`) === -1) return;
    const link = $(article).find('.entry-title a').first();
    const path = toPath(link.attr('href'));
    const name = cleanText(link.text());
    if (path && name) posts.push({ name, path });
  });
  return posts;
}

// OPTIONAL (off by default): the novel page's table of contents is edited by
// hand and can lag behind the real posts. Unlinked entries there are normally
// unreleased placeholders, so by default only linked chapters are listed. When
// the setting is on, chapters that exist as posts but are not yet linked are
// recovered from the category archive, or the home page's latest posts.
async function loadFeed(slug: string): Promise<FeedPost[]> {
  const sources = [`${SITE}/category/${slug}/`, `${SITE}/`];
  for (const url of sources) {
    try {
      const posts = readFeed(await getHtml(url), slug);
      if (posts.length) return posts;
    } catch (_error) {
      // try the next source
    }
  }
  return [];
}

function mergeFeed(entries: TocEntry[], feed: FeedPost[]): TocEntry[] {
  const merged = entries.slice();
  const have: Record<string, boolean> = {};
  merged.forEach(entry => {
    if (entry.path) have[entry.path] = true;
  });

  feed.forEach(post => {
    if (have[post.path]) return;
    const pending = merged.filter(
      entry => !entry.path && entry.name === post.name,
    )[0];
    if (pending) {
      pending.path = post.path;
    } else if (chapterNumberOf(post.name) !== undefined) {
      merged.push({
        name: post.name,
        path: post.path,
        number: chapterNumberOf(post.name),
      });
    } else {
      return;
    }
    have[post.path] = true;
  });
  return merged;
}

function orderChapters(entries: TocEntry[]): Plugin.ChapterItem[] {
  const linked = entries.filter(entry => !!entry.path);
  const numbered = linked.every(entry => entry.number !== undefined);
  const ordered = numbered
    ? linked
        .map((entry, index) => ({ entry, index }))
        .sort(
          (x, y) =>
            (x.entry.number as number) - (y.entry.number as number) ||
            x.index - y.index,
        )
        .map(item => item.entry)
    : linked;

  return ordered.map((entry, index) => {
    const path = entry.path as string;
    const releaseTime = releaseDateFromPath(path);
    return {
      name: entry.name,
      path,
      chapterNumber: numbered ? (entry.number as number) : index + 1,
      ...(releaseTime ? { releaseTime } : {}),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Chapter text                                                         */
/* ------------------------------------------------------------------ */

// A paragraph made only of "Previous | Table of Contents | Next" links.
function isNavigationLine(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= 8 &&
    words.every(word => NAV_WORDS.indexOf(word) !== -1)
  );
}

function hasContent(html: string): boolean {
  return /<img\b/i.test(html) || cleanText(html.replace(/<[^>]*>/g, '')) !== '';
}

function tidyImages($: Cheerio$, root: any): void {
  $(root)
    .find('img')
    .each((_, el) => {
      const $img = $(el);
      const src = normalizeUrl(
        $img.attr('data-orig-file') ??
          $img.attr('data-lazy-src') ??
          $img.attr('src'),
      );
      if (src) $img.attr('src', src);
      // WordPress adds a lot of data-* bookkeeping to every image.
      Object.keys((el as any).attribs ?? {}).forEach(attr => {
        if (/^data-/.test(attr)) $img.removeAttr(attr);
      });
      ['srcset', 'sizes', 'loading', 'style', 'width', 'height'].forEach(
        attr => {
          $img.removeAttr(attr);
        },
      );
    });
}

function includeUnlinked(): boolean {
  const value = storage.get('includeUnlinked');
  return value === true || value === 'true';
}

class ToastyTranslations implements Plugin.PluginBase {
  id = 'toastytranslations';
  name = 'Toasty Translations';
  icon = 'src/en/toastytranslations/icon.png';
  site = SITE;
  version = '1.1.0';

  pluginSettings = {
    includeUnlinked: {
      value: false,
      label:
        'Also list chapters that are posted but not yet linked in the novel page',
      type: 'Switch',
    },
  };

  async popularNovels(pageNo: number): Promise<Plugin.NovelItem[]> {
    // A handful of novels: everything fits on the first page.
    if (Number(pageNo) > 1) return [];
    return loadCatalogue();
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (Number(pageNo) > 1) return [];
    const words = searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    const items = await loadCatalogue();
    return items.filter(item => {
      const title = item.name.toLowerCase();
      return words.every(word => title.indexOf(word) !== -1);
    });
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const path = toPath(novelPath) ?? novelPath;
    const $ = parseHTML(await getHtml(this.resolveUrl(path)));
    const info = readNovelPage($);

    const toc = readToc($);
    // Unlinked table-of-contents entries are placeholders unless the reader
    // opts in to chapters that were posted but not linked yet.
    const feed = includeUnlinked() ? await loadFeed(slugOf(path)) : [];
    const chapters = orderChapters(mergeFeed(toc, feed));

    return {
      path,
      name: info.name || slugOf(path),
      cover: info.cover,
      summary: info.summary,
      status: finishedPaths[path] ? NovelStatus.Completed : NovelStatus.Ongoing,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const $ = parseHTML(await getHtml(this.resolveUrl(chapterPath)));

    NOISE_SELECTORS.forEach(selector => {
      $(selector).remove();
    });

    const content = $('article .entry-content').first().length
      ? $('article .entry-content').first()
      : $('.entry-content').first();

    content.find('p, div').each((_, el) => {
      const $el = $(el);
      if ($el.find('img').length || !$el.find('a').length) return;
      if (isNavigationLine($el.text())) $el.remove();
    });

    const html = (content.html() ?? '').trim();
    if (!hasContent(html))
      throw new Error('No chapter text found on this page');

    const $root = parseHTML(`<div id="toasty-root">${html}</div>`, null, false);
    tidyImages($root, $root('#toasty-root'));
    return $root('#toasty-root').html() ?? html;
  }

  resolveUrl = (path: string) =>
    /^https?:\/\//i.test(path)
      ? path
      : `${SITE}${path.startsWith('/') ? '' : '/'}${path}`;
}

export default new ToastyTranslations();
