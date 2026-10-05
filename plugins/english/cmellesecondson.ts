import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as parseHTML } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

// Single-novel source for CMelle's translation of
// "How to Survive as the Second Son of a Mage Family" (WordPress blog).
// Converted from a declarative selector definition and checked against saved
// copies of the blog's index and archive pages.
//
// Build note: LNReader compiles plugins to ES5 without downlevelIteration, so
// never spread a Set/Map/iterator in this file (it silently becomes []).

const SITE = 'https://cmelle711.wordpress.com';
const NOVEL_PATH = '/how-to-survive-as-the-second-son-of-a-mage-family-7/';
const FALLBACK_NAME = 'How to Survive as the Second Son of a Mage Family';

const SELECTORS = {
  title: '.entry-content h2.wp-block-heading',
  cover: "meta[property='og:image']",
  canonical: "link[rel='canonical']",
  description: '.wp-block-column > .wp-block-group.is-layout-constrained',
  chapters: '.entry-content details li',
  contentPrimary: '.entry-content > div.wp-block-group',
  contentFallbacks: ['.entry-content'],
  remove: [
    'h2.wp-block-heading:first-child',
    '.wp-block-comments',
    '.wp-block-buttons',
  ],
};

// Typical WordPress/Jetpack furniture that is never story text.
const BOILERPLATE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  '.sharedaddy',
  '.jetpack-likes-widget-wrapper',
  '#jp-relatedposts',
  '.jp-relatedposts',
  '.wpcnt',
  '.wp-block-post-navigation-link',
  '.wp-block-post-comments-form',
  '.wp-block-latest-posts',
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
];

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

// Site-relative path when the link points at this blog, otherwise the full URL.
function toPath(href?: string): string {
  const value = (href ?? '').trim().replace(/#.*$/, '');
  if (!value) return '';
  if (/^(?:javascript|mailto|tel):/i.test(value)) return '';
  if (value.startsWith('//')) return toPath(`https:${value}`);
  if (/^https?:\/\//i.test(value)) {
    const host = value
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .toLowerCase();
    return host === SITE.replace('https://', '')
      ? value.replace(/^https?:\/\/[^/]+/i, '') || '/'
      : value;
  }
  return value.startsWith('/') ? value : `/${value}`;
}

async function getHtml(url: string): Promise<string> {
  const response = await fetchApi(url);
  if (!response.ok) {
    throw new Error(`CMelle blog returned HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

type NovelHeader = { name: string; cover: string; path: string };

function readHeader($: ReturnType<typeof parseHTML>): NovelHeader {
  const name = cleanText($(SELECTORS.title).first().text()) || FALLBACK_NAME;
  const cover =
    normalizeUrl($(SELECTORS.cover).first().attr('content')) ?? defaultCover;
  const path =
    toPath($(SELECTORS.canonical).first().attr('href')) || NOVEL_PATH;
  return { name, cover, path };
}

// A paragraph that only holds "Previous | Table of Contents | Next" style links.
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

function removeBoilerplate($: ReturnType<typeof parseHTML>): void {
  BOILERPLATE_SELECTORS.forEach(selector => {
    $(selector).remove();
  });

  $('.entry-content p, .entry-content div.wp-block-group > div').each(
    (_, el) => {
      const $el = $(el);
      if ($el.find('img').length) return;
      if ($el.find('a').length && isNavigationLine($el.text())) $el.remove();
    },
  );
}

function htmlOf($: ReturnType<typeof parseHTML>, selector: string): string {
  let out = '';
  $(selector).each((_, el) => {
    out += $(el).html() ?? '';
  });
  return out.trim();
}

function hasContent(html: string): boolean {
  return /<img\b/i.test(html) || cleanText(html.replace(/<[^>]*>/g, '')) !== '';
}

function finishImages($: ReturnType<typeof parseHTML>, root: any): void {
  $(root)
    .find('img')
    .each((_, el) => {
      const $img = $(el);
      const src = normalizeUrl(
        $img.attr('data-lazy-src') ?? $img.attr('data-src') ?? $img.attr('src'),
      );
      if (src) $img.attr('src', src);
      ['srcset', 'sizes', 'loading', 'data-lazy-src', 'data-src'].forEach(
        attr => {
          $img.removeAttr(attr);
        },
      );
    });
}

// First "Author:/Alternative name:/Raw:" lines of the synopsis block.
const META_LINE = /^(author|alternative name|raw)\s*:\s*(.+)$/i;

// Text of a paragraph with <br> turned into line breaks.
function paragraphLines(
  $: ReturnType<typeof parseHTML>,
  paragraph: any,
): string[] {
  const html = ($(paragraph).html() ?? '').replace(/<br\s*\/?>/gi, '\n');
  return parseHTML(`<div>${html}</div>`, null, false)
    .root()
    .text()
    .split('\n')
    .map(line => cleanText(line))
    .filter(Boolean);
}

type RawChapter = { name: string; path: string; number?: number };

function numberIn(text: string): number | undefined {
  const match = text.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}

// The blog's index has a typo: the "Chapter 117" entry links to chapter 171's
// URL, which would hide a real chapter. When two entries share a link, the one
// whose number matches the link keeps it and the other gets its own number in
// the URL (the blog names its posts "...-chapter-<n>/").
function repairDuplicateLinks(chapters: RawChapter[]): void {
  const byPath: Record<string, RawChapter[]> = {};
  chapters.forEach(chapter => {
    (byPath[chapter.path] = byPath[chapter.path] ?? []).push(chapter);
  });

  Object.keys(byPath).forEach(path => {
    const group = byPath[path];
    if (group.length < 2) return;
    const slug = path.match(/(\d+)\/?$/)?.[1];
    if (!slug) return;
    group.forEach(chapter => {
      if (chapter.number !== undefined && String(chapter.number) !== slug) {
        chapter.path = path.replace(/(\d+)(\/?)$/, `${chapter.number}$2`);
      }
    });
  });
}

class CMelleSecondSon implements Plugin.PluginBase {
  id = 'cmellesecondson';
  name = 'CMelle - Second Son of a Mage Family';
  icon = 'src/en/cmellesecondson/icon.png';
  site = SITE;
  version = '1.1.0';

  async popularNovels(pageNo: number): Promise<Plugin.NovelItem[]> {
    // The source is a single novel, so there is only ever one page.
    if (Number(pageNo) > 1) return [];
    const header = readHeader(parseHTML(await getHtml(`${SITE}${NOVEL_PATH}`)));
    return [{ name: header.name, path: header.path, cover: header.cover }];
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (Number(pageNo) > 1) return [];
    const words = searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    const header = readHeader(parseHTML(await getHtml(`${SITE}${NOVEL_PATH}`)));
    const title = header.name.toLowerCase();
    return words.every(word => title.indexOf(word) !== -1)
      ? [{ name: header.name, path: header.path, cover: header.cover }]
      : [];
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const $ = parseHTML(await getHtml(this.resolveUrl(novelPath)));
    const header = readHeader($);

    // The synopsis block starts with "Author: / Alternative name: / Raw:"
    // lines, followed by the synopsis paragraphs.
    const meta: Record<string, string> = {};
    const synopsis: string[] = [];
    $(SELECTORS.description)
      .first()
      .find('p')
      .each((_, paragraph) => {
        const kept: string[] = [];
        paragraphLines($, paragraph).forEach(line => {
          const match = line.match(META_LINE);
          if (match) meta[match[1].toLowerCase()] = match[2].trim();
          else kept.push(line);
        });
        if (kept.length) synopsis.push(kept.join('\n'));
      });

    const footer: string[] = [];
    if (meta['alternative name']) {
      footer.push(`Alternative name: ${meta['alternative name']}`);
    }
    if (meta.raw) footer.push(`Raw: ${meta.raw}`);
    const summary = synopsis
      .concat(footer.length ? [footer.join('\n')] : [])
      .join('\n\n');

    const raw: RawChapter[] = [];
    $(SELECTORS.chapters).each((_, li) => {
      const link = $(li).find('a').first();
      const path = toPath(link.attr('href'));
      const name = cleanText(link.text());
      if (path && name) raw.push({ name, path, number: numberIn(name) });
    });
    repairDuplicateLinks(raw);

    const seen: Record<string, boolean> = {};
    const unique = raw.filter(chapter => {
      if (seen[chapter.path]) return false;
      seen[chapter.path] = true;
      return true;
    });

    // Order by the chapter number in the name, which holds whichever way the
    // page lists them. (The source definition said "reverse", but the page
    // lists Chapter 1 first.) Without numbers, keep the page order.
    const allNumbered = unique.every(chapter => chapter.number !== undefined);
    const ordered = allNumbered
      ? unique
          .map((chapter, index) => ({ chapter, index }))
          .sort(
            (x, y) =>
              (x.chapter.number as number) - (y.chapter.number as number) ||
              x.index - y.index,
          )
          .map(entry => entry.chapter)
      : unique;

    const chapters: Plugin.ChapterItem[] = ordered.map((chapter, index) => ({
      name: chapter.name,
      path: chapter.path,
      chapterNumber: allNumbered ? (chapter.number as number) : index + 1,
    }));

    return {
      path: novelPath,
      name: header.name,
      cover: header.cover,
      author: meta.author,
      summary,
      status: NovelStatus.Ongoing,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const $ = parseHTML(await getHtml(this.resolveUrl(chapterPath)));

    SELECTORS.remove.forEach(selector => {
      $(selector).remove();
    });
    removeBoilerplate($);

    const selectors = [SELECTORS.contentPrimary].concat(
      SELECTORS.contentFallbacks,
    );
    let html = '';
    for (const selector of selectors) {
      html = htmlOf($, selector);
      if (hasContent(html)) break;
    }
    if (!hasContent(html)) {
      throw new Error('No chapter text found on this page');
    }

    const $content = parseHTML(
      `<div id="cmelle-root">${html}</div>`,
      null,
      false,
    );
    finishImages($content, $content('#cmelle-root'));
    return $content('#cmelle-root').html() ?? html;
  }

  resolveUrl = (path: string) =>
    /^https?:\/\//i.test(path)
      ? path
      : `${SITE}${path.startsWith('/') ? '' : '/'}${path}`;
}

export default new CMelleSecondSon();
