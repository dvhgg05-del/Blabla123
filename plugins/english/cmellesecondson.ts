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

// ---------------------------------------------------------------------------
// Fetching.
//
// WordPress.com sometimes answers the app with HTTP 403: LNReader's default
// request headers ("Accept: */*", "Sec-Fetch-Mode: cors") look like a script,
// not a browser opening a page. So the page is requested the way a browser
// does it first, and if the blog still refuses (403/429/5xx or a network
// error) the same page is read through WordPress.com's public REST API, which
// is meant for programs and is not subject to that filtering. The API's
// content is wrapped in the same ".entry-content" shell the theme uses, so
// every selector below works unchanged on either source.
// ---------------------------------------------------------------------------

const SITE_HOST = SITE.replace('https://', '');
const API_BASE = `https://public-api.wordpress.com/wp/v2/sites/${SITE_HOST}`;

const BROWSER_HEADERS: Record<string, string> = {
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'max-age=0',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

// Headers for image downloads. The app applies imageRequestInit to its own
// cover/image requests; the same headers are used to test cover addresses.
const IMAGE_HEADERS: Record<string, string> = {
  'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': `${SITE}/`,
};

type PageAttempt = { html?: string; status?: number; error?: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestPage(url: string): Promise<PageAttempt> {
  try {
    const response = await fetchApi(url, { headers: BROWSER_HEADERS });
    if (response.ok) {
      return { html: await response.text(), status: response.status };
    }
    return { status: response.status };
  } catch (error) {
    return { error: errorText(error) };
  }
}

// "/some-page/?x=1" or "https://cmelle711.wordpress.com/some-page/" -> "some-page".
// Empty for links that point at another site.
function slugOf(url: string): string {
  const path = toPath(url).replace(/\?.*$/, '');
  if (path.charAt(0) !== '/') return '';
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

type WpPost = {
  link?: string;
  jetpack_featured_media_url?: string;
  content?: { rendered?: string };
};

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

// Rebuilds just enough of the page (canonical link, cover, entry content) for
// the selectors in SELECTORS.
function pageFromApi(post: WpPost): string {
  const head: string[] = [];
  if (post.link) {
    head.push(`<link rel="canonical" href="${escapeAttr(post.link)}">`);
  }
  if (post.jetpack_featured_media_url) {
    head.push(
      `<meta property="og:image" content="${escapeAttr(
        post.jetpack_featured_media_url,
      )}">`,
    );
  }
  return (
    `<html><head>${head.join('')}</head><body>` +
    `<div class="entry-content">${post.content?.rendered ?? ''}</div>` +
    '</body></html>'
  );
}

async function requestViaApi(
  url: string,
): Promise<{ html?: string; error: string }> {
  const slug = slugOf(url);
  if (!slug) return { error: 'no page name in the address' };

  // The novel index and the chapters are normally WordPress pages, but a
  // blog can also publish them as posts, so both are tried.
  const problems: string[] = [];
  for (const kind of ['pages', 'posts']) {
    const endpoint =
      `${API_BASE}/${kind}?slug=${slug}` +
      '&_fields=link,content,jetpack_featured_media_url';
    try {
      const response = await fetchApi(endpoint, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        problems.push(`${kind}: HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      const post: WpPost | undefined = Array.isArray(data)
        ? data[0]
        : undefined;
      const rendered = post?.content?.rendered;
      if (post && typeof rendered === 'string' && rendered !== '') {
        return { html: pageFromApi(post), error: '' };
      }
      problems.push(`${kind}: not found`);
    } catch (error) {
      problems.push(`${kind}: ${errorText(error)}`);
    }
  }
  return { error: problems.join(', ') };
}

async function getHtml(url: string): Promise<string> {
  const page = await requestPage(url);
  if (page.html !== undefined) return page.html;

  // A page that really does not exist is a genuine error; the API cannot help.
  if (page.status === 404 || page.status === 410) {
    throw new Error(`CMelle blog returned HTTP ${page.status} for ${url}`);
  }

  const api = await requestViaApi(url);
  if (api.html !== undefined) return api.html;

  const direct = page.status ? `HTTP ${page.status}` : page.error;
  throw new Error(
    `CMelle blog refused the request (${direct}) for ${url}; ` +
      `the WordPress.com API fallback failed too (${api.error}).`,
  );
}

// The blog's images live on the same domain that filters the app, so a cover
// can be found yet fail to download (blank cover). The same picture is also
// reachable through WordPress's image CDN (i0.wp.com) and, for uploads, the
// legacy "<site>.files.wordpress.com" address. Returns every address worth
// trying, the original first.
function coverCandidates(url: string): string[] {
  const match = url.match(/^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!match) return [url];
  const host = match[1].toLowerCase();
  const pathname = match[2] || '';
  const query = match[3] || '';
  const onBlog = host === SITE_HOST;
  const onFiles = /\.files\.wordpress\.com$/.test(host);
  if (!onBlog && !onFiles) return [url];

  const candidates = [
    url,
    `https://i0.wp.com/${host}${pathname}${query ? `${query}&` : '?'}ssl=1`,
  ];
  const upload = onBlog
    ? pathname.match(/^\/wp-content\/uploads\/(.+)$/)
    : null;
  if (upload) {
    candidates.push(
      `https://${SITE_HOST.replace('.wordpress.com', '.files.wordpress.com')}/${
        upload[1]
      }${query}`,
    );
  }
  return candidates;
}

const confirmedCovers: Record<string, string> = {};

// Picks the first cover address the app can really download. If none can be
// confirmed, the CDN copy is returned: it does not depend on the blog's own
// filtering, so it is the most likely to work.
async function reachableCover(url: string): Promise<string> {
  const candidates = coverCandidates(url);
  if (candidates.length < 2) return url;
  if (confirmedCovers[url]) return confirmedCovers[url];

  for (const candidate of candidates) {
    try {
      const response = await fetchApi(candidate, {
        headers: {
          ...IMAGE_HEADERS,
          'Sec-Fetch-Dest': 'image',
          'Sec-Fetch-Mode': 'no-cors',
        },
      });
      const type = response.headers?.get?.('content-type') ?? '';
      if (response.ok && (!type || /^image\//i.test(type))) {
        confirmedCovers[url] = candidate;
        return candidate;
      }
    } catch (error) {
      // network error: try the next address
    }
  }
  return candidates[1];
}

type NovelHeader = { name: string; cover: string; path: string };

// The cover is the page's social-preview image. When the page has none (and
// the API route never has the <meta> tag), WordPress itself would have used
// the first image in the content, so that is the fallback.
function readCover($: ReturnType<typeof parseHTML>): string | undefined {
  const preview = normalizeUrl($(SELECTORS.cover).first().attr('content'));
  if (preview) return preview;
  const image = $('.entry-content img').first();
  return normalizeUrl(
    image.attr('data-lazy-src') ?? image.attr('data-src') ?? image.attr('src'),
  );
}

function readHeader($: ReturnType<typeof parseHTML>): NovelHeader {
  const name = cleanText($(SELECTORS.title).first().text()) || FALLBACK_NAME;
  const cover = readCover($) ?? defaultCover;
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

// Text of a paragraph with <br> turned into line breaks. Only basic selector
// calls are used (no .root()) so it works in the app's HTML engine too.
function paragraphLines(
  $: ReturnType<typeof parseHTML>,
  paragraph: any,
): string[] {
  const html = ($(paragraph).html() ?? '').replace(/<br\s*\/?>/gi, '\n');
  return parseHTML(
    `<div id="lines">${html}</div>`,
    null,
    false,
  )('#lines')
    .first()
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
  version = '1.2.2';
  imageRequestInit: Plugin.ImageRequestInit = { headers: IMAGE_HEADERS };

  async popularNovels(pageNo: number): Promise<Plugin.NovelItem[]> {
    // The source is a single novel, so there is only ever one page.
    if (Number(pageNo) > 1) return [];
    const header = readHeader(parseHTML(await getHtml(`${SITE}${NOVEL_PATH}`)));
    const cover = await reachableCover(header.cover);
    return [{ name: header.name, path: header.path, cover }];
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
    if (!words.every(word => title.indexOf(word) !== -1)) return [];
    const cover = await reachableCover(header.cover);
    return [{ name: header.name, path: header.path, cover }];
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
      cover: await reachableCover(header.cover),
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
