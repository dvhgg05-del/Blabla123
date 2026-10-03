import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { load as parseHTML } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { storage } from '@libs/storage';

const SITE = 'https://global.novelpia.com';
const API = 'https://api-global.novelpia.com';

// /ranking renders every ranked title (200 at the time of writing) on ONE page
// and ignores ?page=. We fetch it once and page through it locally.
const RANKING_PAGE_SIZE = 50;
const RANKING_TTL_MS = 5 * 60 * 1000;

// IMPORTANT (build note): LNReader compiles plugins with `target: ES5` and no
// `downlevelIteration`. In that mode `[...someSet]` / `[...someMap.entries()]`
// is emitted as a helper that silently returns an EMPTY array for iterators.
// Never spread a Set/Map/iterator in this file; use plain arrays/objects.

// Tags seen on Novelpia Global listing pages. Add more names here if needed;
// they are matched case-insensitively against the tags printed on each card.
const TAGS = [
  'Academy',
  'Action',
  'Adventure',
  'Angst',
  'Apocalypse',
  'Business Management',
  'Character Growth',
  'Comedy',
  'Cyberpunk',
  'Drama',
  'Entertainment Business',
  'European Ambience',
  'Fantasy',
  'GL',
  'Game',
  'Game System',
  'Gender Bender',
  'Gender Switch',
  'Harem',
  'Hero',
  'Historical',
  'Hunter',
  'Isekai',
  'Kingdom Building',
  'Labyrinth',
  'Light Novel',
  'Magic',
  'Magical Girls',
  'Male Lead',
  'Martial Arts',
  'Military',
  'Miscellaneous',
  'Misunderstandings',
  'Modern',
  'Modern Fantasy',
  'Monsters',
  'Music',
  'Mystery',
  'Non-Humanoid Characters',
  'Obsession',
  'Overpowered',
  'Parody',
  'Past Lives',
  'Politics',
  'Pure Love',
  'Regression',
  'Reincarnation',
  'Returner',
  'Revenge',
  'Rich Protagonist',
  'Romance',
  'Romance Fantasy',
  'Romantic Comedy',
  'Saintess',
  'Salvation',
  'Sci-Fi',
  'Slice of Life',
  'Slow Burn',
  'Social Media',
  'Sports',
  'Streaming',
  'Three Kingdoms',
  'Tower Climbing',
  'Transmigration',
  'Unreliable Narrator',
  'Villain',
  'War',
  'Webtoon',
];

const BASE_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: SITE,
  Referer: `${SITE}/`,
  'X-Requested-With': 'XMLHttpRequest',
};

type HttpError = Error & { status?: number };

function httpError(status: number): HttpError {
  const error: HttpError = new Error(`Novelpia HTTP ${status}`);
  error.status = status;
  return error;
}

function statusOf(error: unknown): number {
  return Number((error as HttpError | undefined)?.status) || 0;
}

function setting(key: string): string {
  const value = storage.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function requestHeaders(
  extra: Record<string, string> = {},
  withLoginAt = true,
): Record<string, string> {
  const headers = { ...BASE_HEADERS, ...extra };
  const loginAt = setting('loginAt');
  const userKey = setting('userKey');
  const tKey = setting('tKey');

  if (loginAt && withLoginAt) headers['login-at'] = loginAt;

  const cookies: string[] = [];
  if (userKey) cookies.push(`USERKEY=${userKey}`);
  if (tKey) cookies.push(`TKEY=${tKey}`);
  if (cookies.length) {
    cookies.push('last_login=basic');
    headers.Cookie = cookies.join('; ');
  }

  return headers;
}

async function getJson(url: string, withLoginAt = true): Promise<any> {
  const response = await fetchApi(url, {
    headers: requestHeaders({}, withLoginAt),
  });
  if (!response.ok) throw httpError(response.status);

  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch (_error) {
    // Typically a Cloudflare challenge / maintenance page served as HTML.
    throw new Error(
      'Novelpia returned a non-JSON response (blocked or under maintenance?)',
    );
  }
}

// Public novel data does not need the session token, and an expired LOGINAT
// can make otherwise-public endpoints fail. Try anonymously first and only
// fall back to the session token when the site asks for authorisation.
async function getNovelJson(url: string): Promise<any> {
  try {
    return await getJson(url, false);
  } catch (error) {
    const status = statusOf(error);
    if ((status === 401 || status === 403) && setting('loginAt')) {
      return getJson(url, true);
    }
    throw error;
  }
}

async function getText(url: string): Promise<string> {
  const response = await fetchApi(url, {
    headers: requestHeaders({
      Accept: 'text/html,application/xhtml+xml',
    }),
  });
  if (!response.ok) throw httpError(response.status);
  return response.text();
}

function normalizeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${SITE}${url}`;
  return url;
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function novelIdFromPath(path: string): string {
  return path.match(/(?:^|\/)novel\/(\d+)(?:\D|$)/)?.[1] ?? '';
}

function episodeIdFromPath(path: string): string {
  return path.match(/(?:^|\/)viewer\/(\d+)(?:\D|$)/)?.[1] ?? '';
}

function extractTags(payload: any): string {
  const result = payload?.result ?? {};
  const novel = result?.novel ?? {};
  const items = Array.isArray(result.tag_list)
    ? result.tag_list
    : Array.isArray(novel.tag_list)
      ? novel.tag_list
      : [];

  const names: string[] = [];
  for (const item of items) {
    const name =
      typeof item === 'string'
        ? item
        : firstString(item?.tag_name, item?.name, item?.title);
    if (name && names.indexOf(name) === -1) names.push(name);
  }
  return names.join(',');
}

/* ------------------------------------------------------------------ */
/* Listing parsing                                                      */
/* ------------------------------------------------------------------ */

// Ranking cards render the rank badge and movement marker ("1—", "15▼ 1",
// "31New") inside the same anchor as the title.
const RANK_TOKEN = '\\d{1,3}\\s*(?:▲|▼|New|—|–|-)\\s*\\d{0,3}';
const RANK_ONLY = new RegExp(`^\\s*${RANK_TOKEN}\\s*$`, 'i');
const RANK_SUFFIX = new RegExp(`\\s*${RANK_TOKEN}\\s*$`, 'i');

function cleanListingName(value: unknown): string {
  return cleanText(value)
    .replace(/\s+/g, ' ')
    .replace(/^\s*#?\d+\s*(?:▲|▼|New|—|–|-)\s*/i, '')
    .trim();
}

const COUNT_LABEL = /^\d[\d.,]*\s*[KkMm]?\s*(?:chapters?|episodes?|ch\.?)$/i;

function isRankOnly(value: string): boolean {
  return (
    !value ||
    /^\d+$/.test(value) ||
    RANK_ONLY.test(value) ||
    COUNT_LABEL.test(value)
  );
}

type ListingGroup = {
  path: string;
  id: string;
  names: string[];
  altNames: string[];
  explicit: string[];
  dedicated: string[];
  covers: string[];
};

// The ranking page has one anchor with "<title><rank><movement>" and another
// with just "<title>" for every novel. Prefer the clean one; if only the noisy
// one exists, strip the rank suffix from it.
function pickTitle(group: ListingGroup): string {
  // Exact titles first: the cover's alt text and .absolute-tit. Then the
  // card's title element. Both beat guessing from link text, which on some
  // cards also holds the rank, chapter count and tag/view numbers.
  for (const title of group.explicit.concat(group.dedicated)) {
    if (!isRankOnly(title)) return title;
  }

  const unique: string[] = [];
  for (const name of group.names) {
    if (unique.indexOf(name) === -1) unique.push(name);
  }

  const stripped = (name: string) => name.replace(RANK_SUFFIX, '').trim();

  // A name is "noisy" when another candidate plus a rank token spells it out.
  const pure = unique.filter(
    name =>
      !unique.some(
        other =>
          other !== name &&
          name.startsWith(other) &&
          RANK_ONLY.test(name.slice(other.length)),
      ),
  );

  // With several candidates, the survivors of the check above are the clean
  // ones. With a single candidate there is nothing to compare against, so it
  // may still carry the rank suffix and has to be stripped directly.
  const pool =
    unique.length === 1
      ? [stripped(unique[0])].filter(Boolean)
      : pure.length
        ? pure
        : unique.map(stripped).filter(Boolean);

  if (pool.length) {
    return pool.slice().sort((a, b) => b.length - a.length)[0];
  }

  for (const alt of group.altNames) {
    if (!isRankOnly(alt)) return alt;
  }
  return '';
}

function smallestSrcsetCandidate(srcset?: string): string | undefined {
  if (!srcset) return undefined;
  const candidates = srcset
    .split(',')
    .map(part => part.trim())
    .map(part => {
      const [url, descriptor] = part.split(/\s+/, 2);
      const width = descriptor?.endsWith('w')
        ? Number(descriptor.slice(0, -1))
        : Number.MAX_SAFE_INTEGER;
      return { url, width };
    })
    .filter(item => !!item.url)
    .sort((a, b) => a.width - b.width);
  return candidates[0]?.url;
}

function imageFromElement(
  $: ReturnType<typeof parseHTML>,
  el: any,
): string | undefined {
  const $el = $(el);
  const candidates = [
    $el.attr('data-src'),
    $el.attr('data-original'),
    $el.attr('data-lazy-src'),
    $el.attr('data-lazy'),
    $el.attr('data-image'),
    smallestSrcsetCandidate($el.attr('data-srcset')),
    smallestSrcsetCandidate($el.attr('srcset')),
    $el.attr('src'),
  ];

  for (const candidate of candidates) {
    if (!candidate || /^(?:data|blob):/i.test(candidate.trim())) continue;
    if (/^(?:https?:)?\/\//i.test(candidate.trim())) {
      return normalizeUrl(candidate.trim());
    }
  }

  const style = $el.attr('style') ?? '';
  const bg = style.match(/url\(["']?([^"')]+)["']?\)/i)?.[1];
  return /^(?:https?:)?\/\//i.test(bg ?? '') ? normalizeUrl(bg) : undefined;
}

// Site chrome that is never a cover (logos, banners, social icons, avatars).
const NON_COVER = /\/(?:common|banner|img\/layout|img\/banner)\/|icon_/i;

// Covers live at gn.novelpia.com/upload/novel/<novelId>/...  Use that to pick
// the card's OWN cover and never borrow a neighbouring card's image.
function pickCover(group: ListingGroup): string {
  const own = `/upload/novel/${group.id}/`;
  const exact = group.covers.filter(url => url.indexOf(own) !== -1)[0];
  if (exact) return exact;

  for (const url of group.covers) {
    if (NON_COVER.test(url)) continue;
    const owner = url.match(/\/upload\/novel\/(\d+)\//)?.[1];
    if (owner && owner !== group.id) continue;
    return url;
  }
  return defaultCover;
}

type ParsedListing = {
  items: Plugin.NovelItem[];
  tagsByPath: Record<string, string[]>;
};

function parseListing(html: string): ParsedListing {
  const $ = parseHTML(html);
  const order: ListingGroup[] = [];
  const byPath: Record<string, ListingGroup> = {};

  // Mark each ancestor (up to 3 levels) with the novel id it links to, or "*"
  // when it links to more than one. An ancestor marked with exactly this id is
  // the card itself; "*" means it is a list/container holding other cards.
  // One linear pass instead of re-scanning containers for every link.
  const MARK = '__npId';
  $('a[href*="/novel/"]').each((_, anchor) => {
    const id = ($(anchor).attr('href') ?? '').match(/\/novel\/(\d+)/)?.[1];
    if (!id) return;
    let node: any = (anchor as any).parent;
    for (let level = 1; level <= 3 && node; level++) {
      const current = node[MARK];
      if (current === undefined) node[MARK] = id;
      else if (current !== id) node[MARK] = '*';
      node = node.parent;
    }
  });

  $('a[href*="/novel/"]').each((_, anchor) => {
    const $a = $(anchor);
    const id = ($a.attr('href') ?? '').match(/\/novel\/(\d+)/)?.[1];
    if (!id) return;

    const path = `/novel/${id}`;
    let group = byPath[path];
    if (!group) {
      group = {
        path,
        id,
        names: [],
        altNames: [],
        explicit: [],
        dedicated: [],
        covers: [],
      };
      byPath[path] = group;
      order.push(group);
    }

    const name = cleanListingName(
      firstString(
        $a.find('.nv-tit').first().text(),
        $a.attr('title'),
        $a.text(),
      ),
    );
    if (!isRankOnly(name)) group.names.push(name);

    const alt = cleanListingName($a.find('img[alt]').first().attr('alt'));
    if (alt) {
      group.altNames.push(alt);
      group.explicit.push(alt);
    }
    const strong = cleanListingName($a.find('.absolute-tit').first().text());
    if (strong) group.explicit.push(strong);
    const dedicated = cleanListingName(
      $a.find('.novel-tit, .nv-tit').first().text(),
    );
    if (dedicated) group.dedicated.push(dedicated);

    const add = (image?: string) => {
      if (image && group.covers.indexOf(image) === -1) group.covers.push(image);
    };
    const collect = (node: any) => {
      $(node)
        .find('img, source')
        .each((__, child) => {
          add(imageFromElement($, child));
        });
      add(imageFromElement($, node));
    };

    let node: any = anchor;
    for (let level = 0; level <= 3 && node; level++) {
      if (level > 0 && node[MARK] !== id) break;
      collect(node);
      node = node.parent;
    }
  });

  const items: Plugin.NovelItem[] = [];
  for (const group of order) {
    const name = pickTitle(group);
    if (!name) continue;
    items.push({ name, path: group.path, cover: pickCover(group) });
  }

  // /novels cards list their tags as plain <span>s (no class) inside
  // `.tags`; the separators between them carry a class.
  const tagsByPath: Record<string, string[]> = {};
  $('.nv-list-item').each((_, card) => {
    const id = (
      $(card).find('a[href*="/novel/"]').first().attr('href') ?? ''
    ).match(/\/novel\/(\d+)/)?.[1];
    if (!id) return;
    const tags: string[] = [];
    $(card)
      .find('.tags span')
      .each((__, span) => {
        if ($(span).attr('class')) return;
        const tag = cleanText($(span).text());
        if (tag && tags.indexOf(tag) === -1) tags.push(tag);
      });
    tagsByPath[`/novel/${id}`] = tags;
  });

  return { items, tagsByPath };
}

function parseNovelItemLinks(html: string): Plugin.NovelItem[] {
  return parseListing(html).items;
}

async function fetchListing(url: string): Promise<Plugin.NovelItem[]> {
  return parseNovelItemLinks(await getText(url));
}

// Some listings silently serve page 1 (or the last page) again when asked for
// a page that does not exist, which would make infinite scroll repeat forever.
// Remember the first item of page 1 and stop when a later page starts with it.
const firstPathOfPageOne: Record<string, string> = {};

async function fetchPagedListing(
  key: string,
  url: string,
  page: number,
): Promise<Plugin.NovelItem[]> {
  const items = await fetchListing(url);
  if (page <= 1) {
    if (items.length) firstPathOfPageOne[key] = items[0].path;
    return items;
  }
  const first = firstPathOfPageOne[key];
  if (first && items.length && items[0].path === first) return [];
  return items;
}

/* ------------------------------------------------------------------ */
/* Tag include / exclude                                                */
/* ------------------------------------------------------------------ */

// Novelpia's listing has no multi-tag filter, so tags are matched here against
// the tags printed on each /novels card. Because most novels do not match, a
// single LNReader "page" may need several site pages: scan ahead until about
// one screenful of matches is found (or TAG_SCAN_MAX site pages were read).
const TAG_PAGE_TARGET = 30;
const TAG_SCAN_MAX = 6;

type TagScan = {
  site: number;
  last: number;
  done: boolean;
  firstPath: string;
  buffer: Plugin.NovelItem[];
  seen: Record<string, boolean>;
};
const tagScans: Record<string, TagScan> = {};

function matchesTags(
  tags: string[],
  include: string[],
  exclude: string[],
): boolean {
  const have = tags.map(tag => tag.toLowerCase());
  return (
    include.every(tag => have.indexOf(tag.toLowerCase()) !== -1) &&
    !exclude.some(tag => have.indexOf(tag.toLowerCase()) !== -1)
  );
}

async function fetchTaggedListing(
  key: string,
  urlForPage: (sitePage: number) => string,
  include: string[],
  exclude: string[],
  page: number,
): Promise<Plugin.NovelItem[]> {
  let scan = tagScans[key];
  if (page <= 1 || !scan) {
    if (page > 1) return [];
    scan = {
      site: 0,
      last: 0,
      done: false,
      firstPath: '',
      buffer: [],
      seen: {},
    };
    tagScans[key] = scan;
  } else if (scan.last !== page - 1) {
    return [];
  }

  let scanned = 0;
  while (
    scan.buffer.length < TAG_PAGE_TARGET &&
    !scan.done &&
    scanned < TAG_SCAN_MAX
  ) {
    scan.site += 1;
    scanned += 1;

    const { items, tagsByPath } = parseListing(
      await getText(urlForPage(scan.site)),
    );
    if (!items.length) {
      scan.done = true;
      break;
    }
    // A site that ignores/clamps ?page= re-serves page 1: stop instead of looping.
    if (scan.site === 1) scan.firstPath = items[0].path;
    else if (items[0].path === scan.firstPath) {
      scan.done = true;
      break;
    }

    for (const item of items) {
      if (scan.seen[item.path]) continue;
      scan.seen[item.path] = true;
      if (matchesTags(tagsByPath[item.path] ?? [], include, exclude)) {
        scan.buffer.push(item);
      }
    }
  }

  scan.last = page;
  return scan.buffer.splice(0, TAG_PAGE_TARGET);
}

let rankingCache: { at: number; items: Plugin.NovelItem[] } | null = null;

async function fetchRanking(): Promise<Plugin.NovelItem[]> {
  if (rankingCache && Date.now() - rankingCache.at < RANKING_TTL_MS) {
    return rankingCache.items;
  }
  const items = await fetchListing(`${SITE}/ranking`);
  if (items.length) rankingCache = { at: Date.now(), items };
  return items;
}

/* ------------------------------------------------------------------ */
/* Novel / chapters                                                     */
/* ------------------------------------------------------------------ */

async function fetchEpisodes(novelId: string): Promise<Plugin.ChapterItem[]> {
  // Keep the older /list endpoint as a fallback because the response shape
  // differs between Novelpia revisions.
  const urls = [
    `${API}/v1/novel/episode/cursor-list?novel_no=${encodeURIComponent(novelId)}&rows=9999&sort=ASC`,
    `${API}/v1/novel/episode/list?novel_no=${encodeURIComponent(novelId)}&rows=9999&sort=ASC`,
  ];

  let lastError: unknown;
  for (const url of urls) {
    try {
      const payload = await getNovelJson(url);
      const list = payload?.result?.list;
      if (!Array.isArray(list)) {
        throw new Error('Novelpia episode response has no result.list');
      }

      const seen: Record<string, boolean> = {};
      const chapters: Plugin.ChapterItem[] = [];

      list.forEach((row: any, index: number) => {
        const episodeNo = Number(row?.episode_no);
        if (!Number.isFinite(episodeNo)) return;

        const path = `/viewer/${episodeNo}`;
        if (seen[path]) return;
        seen[path] = true;

        const chapterNo = Number(row?.epi_num);
        const title = firstString(row?.epi_title) || `Episode ${index + 1}`;
        const releaseTime = firstString(
          row?.epi_open_dt,
          row?.open_dt,
          row?.open_date,
          row?.reg_dt,
        );

        chapters.push({
          name: row?.epi_num != null ? `${row.epi_num} - ${title}` : title,
          path,
          chapterNumber: Number.isFinite(chapterNo) ? chapterNo : index + 1,
          ...(releaseTime ? { releaseTime } : {}),
        });
      });

      // LNReader expects oldest -> newest. Guard against a descending reply.
      if (chapters.length > 1) {
        const firstNo = chapters[0].chapterNumber ?? 0;
        const lastNo = chapters[chapters.length - 1].chapterNumber ?? 0;
        if (firstNo > lastNo) chapters.reverse();
      }
      return chapters;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to load Novelpia chapters');
}

function collectTicketsFromPayload(payload: any): string[] {
  const candidates: string[] = [];
  const visit = (value: any): void => {
    if (typeof value === 'string') {
      const direct = value.match(
        /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
      if (direct) candidates.push(direct[0]);
      const embedded = value.match(/[?&]_t=([^&\s]+)/);
      if (embedded?.[1]) candidates.push(decodeURIComponent(embedded[1]));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      Object.keys(value).forEach(key => {
        const item = value[key];
        if (
          (key === '_t' || key === 't' || key === 'token') &&
          typeof item === 'string'
        ) {
          candidates.push(item);
        }
        visit(item);
      });
    }
  };

  visit(payload);
  return candidates.filter(Boolean);
}

// The viewer page embeds short-lived tickets inside __NUXT_DATA__. It can hold
// more than one JWT-looking string (session tokens, prev/next tickets), so
// return all of them and let the caller try each against the content endpoint.
function extractViewerTickets(html: string): string[] {
  const $ = parseHTML(html);
  const nuxt = $('script#__NUXT_DATA__').html() ?? '';
  const found: string[] = [];
  const pattern = /eyJhb[A-Za-z0-9_\-.]+/g;
  let match = pattern.exec(nuxt);
  while (match && found.length < 4) {
    if (found.indexOf(match[0]) === -1) found.push(match[0]);
    match = pattern.exec(nuxt);
  }
  return found;
}

function contentFragments(data: any): string[] {
  if (!data || typeof data !== 'object') return [];
  return Object.keys(data)
    .filter(key => key.startsWith('epi_content'))
    .sort((a, b) => {
      if (a === 'epi_content') return b === 'epi_content' ? 0 : -1;
      if (b === 'epi_content') return 1;
      const an = Number(a.match(/(\d+)$/)?.[1] ?? 0);
      const bn = Number(b.match(/(\d+)$/)?.[1] ?? 0);
      return an - bn;
    })
    .map(key => data[key])
    .filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
}

function normalizeChapterHtml(html: string, episodeNo: string): string {
  const $ = parseHTML(`<div id="novelpia-root">${html}</div>`, null, false);
  const root = $('#novelpia-root');

  root.find('img').each((_, el) => {
    const $img = $(el);
    let src = firstString($img.attr('src'), $img.attr('data-src'));
    if (!src) {
      const filename = $img.attr('data-filename');
      if (filename) {
        src = `https://gn.novelpia.com/upload/episode/${episodeNo}/${filename}`;
      }
    }
    const normalized = normalizeUrl(src);
    if (normalized) $img.attr('src', normalized);

    for (const attr of [
      'data-src',
      'data-filename',
      'loading',
      'draggable',
      'onerror',
      'style',
    ]) {
      $img.removeAttr(attr);
    }
  });

  root.find('.next-epi-btn, script, style, nav').remove();
  return root.html() ?? '';
}

function chapterAccessError(status: number, episodeNo: string): Error {
  if (status === 401 || status === 403) {
    return new Error(
      `Novelpia refused chapter ${episodeNo} (HTTP ${status}). It may be locked; ` +
        'if your account can read it, add LOGINAT / USERKEY / TKEY in the plugin settings.',
    );
  }
  if (status >= 500) {
    return new Error(
      `Novelpia could not serve chapter ${episodeNo} (HTTP ${status}). ` +
        'Premium or ad-locked chapters need a session that has unlocked them.',
    );
  }
  return new Error(
    `Novelpia did not return chapter ${episodeNo} (HTTP ${status})`,
  );
}

class NovelpiaGlobal implements Plugin.PluginBase {
  id = 'novelpiaglobal';
  name = 'Novelpia Global';
  icon = 'src/en/novelpiaglobal/icon.png';
  site = SITE;
  version = '1.7.0';
  // Novelpia's /novels page has no sort control. These are the listing
  // links the site itself uses (tab=1, tab=3, flag_complete=1).
  filters = {
    browse: {
      type: FilterTypes.Picker,
      label: 'Browse',
      value: 'ranking',
      options: [
        { label: 'Ranking (top 200)', value: 'ranking' },
        { label: 'All novels', value: 'all' },
        { label: 'Premium Originals', value: 'originals' },
        { label: 'Edited Collection', value: 'edited' },
        { label: 'Completed Stories', value: 'completed' },
      ],
    },
    tags: {
      type: FilterTypes.ExcludableCheckboxGroup,
      label: 'Tags (tap: include, again: exclude, again: off)',
      value: { include: [], exclude: [] },
      options: TAGS.map(tag => ({ label: tag, value: tag })),
    },
  } satisfies Filters;

  pluginSettings = {
    loginAt: {
      value: '',
      label: 'LOGINAT session token (optional)',
      type: 'Text',
    },
    userKey: {
      value: '',
      label: 'USERKEY cookie (optional)',
      type: 'Text',
    },
    tKey: {
      value: '',
      label: 'TKEY cookie (optional)',
      type: 'Text',
    },
  };

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, Number(pageNo) || 1);

    const chosen = String(filters?.browse?.value || 'ranking');
    // The Latest button always lists /novels; if a category is picked it
    // applies there too.
    const browse = showLatestNovels && chosen === 'ranking' ? 'all' : chosen;

    const include = (filters?.tags?.value?.include ?? []).slice();
    const exclude = (filters?.tags?.value?.exclude ?? []).slice();
    const tagging = include.length > 0 || exclude.length > 0;

    // Ranking cards only show one tag, so tag filters use the /novels listing.
    if (browse === 'ranking' && !tagging) {
      const ranked = await fetchRanking();
      const start = (page - 1) * RANKING_PAGE_SIZE;
      return ranked.slice(start, start + RANKING_PAGE_SIZE);
    }

    const category: Record<string, string> = {
      originals: '&tab=1',
      edited: '&tab=3',
      completed: '&flag_complete=1',
      // Unchanged from earlier versions for the plain "all" listing.
      all: '&content_type=2&sort_col=new_epi_open_dt',
    };

    const mode = browse === 'ranking' ? 'all' : browse;
    const params = category[mode] ?? category.all;
    const urlForPage = (sitePage: number) =>
      `${SITE}/novels?page=${sitePage}${params}`;

    if (tagging) {
      return fetchTaggedListing(
        `${mode}|+${include.slice().sort().join(',')}|-${exclude.slice().sort().join(',')}`,
        urlForPage,
        include,
        exclude,
        page,
      );
    }

    return fetchPagedListing(`novels:${mode}`, urlForPage(page), page);
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const term = searchTerm.trim();
    if (!term) return [];

    const page = Math.max(1, Number(pageNo) || 1);
    const encoded = encodeURIComponent(term);
    const key = `search:${term.toLowerCase()}`;

    const candidates = [
      `${SITE}/search?search_type=title&search_val=${encoded}&page=${page}`,
      `${SITE}/search?keyword=${encoded}&page=${page}`,
      `${SITE}/search?search_val=${encoded}&page=${page}`,
    ];

    let lastError: unknown;
    for (const url of candidates) {
      try {
        const novels = await fetchPagedListing(key, url, page);
        if (novels.length) return novels;
      } catch (error) {
        lastError = error;
      }
    }

    // The site's search results may be rendered client-side, in which case the
    // HTML above has no result cards. Fall back to matching the (cached)
    // ranking list so the most popular titles are still findable.
    if (page === 1) {
      try {
        const needle = term.toLowerCase();
        const hits = (await fetchRanking()).filter(
          novel => novel.name.toLowerCase().indexOf(needle) !== -1,
        );
        if (hits.length) return hits;
      } catch (error) {
        lastError = lastError ?? error;
      }
      if (lastError instanceof Error) throw lastError;
    }
    return [];
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const novelId = novelIdFromPath(novelPath);
    if (!novelId) throw new Error(`Invalid Novelpia novel path: ${novelPath}`);

    const payload = await getNovelJson(
      `${API}/v1/novel?novel_no=${encodeURIComponent(novelId)}`,
    );
    const result = payload?.result ?? {};
    const novel = result?.novel ?? {};
    const story = cleanText(
      novel?.novel_story ?? novel?.story ?? novel?.description,
    );
    const cover =
      normalizeUrl(
        firstString(
          novel?.novel_full_img,
          novel?.novel_img,
          novel?.cover,
          novel?.image,
        ),
      ) ?? defaultCover;
    const complete = String(novel?.flag_complete ?? '0') === '1';

    return {
      path: novelPath,
      name:
        firstString(novel?.novel_name, novel?.name, novel?.title) ||
        `Novel ${novelId}`,
      cover,
      author:
        firstString(result?.writer_list?.[0]?.writer_name) || 'Unknown Author',
      genres: extractTags(payload),
      status: complete ? NovelStatus.Completed : NovelStatus.Ongoing,
      summary: story,
      chapters: await fetchEpisodes(novelId),
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const episodeNo = episodeIdFromPath(chapterPath);
    if (!episodeNo) {
      throw new Error(`Invalid Novelpia chapter path: ${chapterPath}`);
    }

    // The viewer page is optional: it carries a ticket and the chapter title,
    // but the API can mint a ticket on its own.
    let viewerHtml = '';
    try {
      viewerHtml = await getText(`${SITE}/viewer/${episodeNo}`);
    } catch (_error) {
      viewerHtml = '';
    }

    const tried: string[] = [];
    let contentPayload: any;
    let lastStatus = 0;

    const attempt = async (token: string): Promise<boolean> => {
      if (!token || tried.indexOf(token) !== -1) return false;
      tried.push(token);
      try {
        contentPayload = await getJson(
          `${API}/v1/novel/episode/content?_t=${encodeURIComponent(token)}`,
        );
        return true;
      } catch (error) {
        lastStatus = statusOf(error) || lastStatus;
        return false;
      }
    };

    // 1) tickets embedded in the viewer page
    for (const token of extractViewerTickets(viewerHtml)) {
      if (await attempt(token)) break;
    }

    // 2) mint a fresh ticket (also the recovery path when a ticket expired)
    if (!contentPayload) {
      try {
        const ticketPayload = await getJson(
          `${API}/v1/novel/episode?episode_no=${encodeURIComponent(episodeNo)}`,
        );
        for (const token of collectTicketsFromPayload(ticketPayload)) {
          if (await attempt(token)) break;
        }
      } catch (error) {
        lastStatus = statusOf(error) || lastStatus;
      }
    }

    if (!contentPayload) throw chapterAccessError(lastStatus, episodeNo);

    const fragments = contentFragments(contentPayload?.result?.data);
    if (!fragments.length) {
      throw new Error(`Novelpia returned no content for chapter ${episodeNo}`);
    }

    // Only add a heading when the real chapter title is available; a bare
    // "Episode 1234567" (the global episode id) is just noise.
    const $ = parseHTML(viewerHtml);
    const chapterNumber = $('.in-chapter-number').first().text().trim();
    const chapterTitle = $('.in-chapter-title').first().text().trim();
    const heading = [chapterNumber, chapterTitle].filter(Boolean).join(' - ');
    const headingHtml = heading ? `<h1>${cleanText(heading)}</h1>` : '';

    return `${headingHtml}${normalizeChapterHtml(fragments.join(''), episodeNo)}`;
  }

  resolveUrl = (path: string) =>
    `${SITE}${path.startsWith('/') ? '' : '/'}${path}`;

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: {
      Referer: `${SITE}/`,
      Origin: SITE,
      Accept:
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  };
}

export default new NovelpiaGlobal();
