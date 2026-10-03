import { fetchApi, fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters } from '@libs/filterInputs';
import { load as parseHTML } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { storage } from '@libs/storage';

const SITE = 'https://global.novelpia.com';
const API = 'https://api-global.novelpia.com';

const BASE_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: SITE,
  Referer: `${SITE}/`,
  'X-Requested-With': 'XMLHttpRequest',
};

function setting(key: string): string {
  const value = storage.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers = { ...BASE_HEADERS, ...extra };
  const loginAt = setting('loginAt');
  const userKey = setting('userKey');
  const tKey = setting('tKey');

  if (loginAt) headers['login-at'] = loginAt;

  const cookies: string[] = [];
  if (userKey) cookies.push(`USERKEY=${userKey}`);
  if (tKey) cookies.push(`TKEY=${tKey}`);
  if (cookies.length) {
    cookies.push('last_login=basic');
    headers.Cookie = cookies.join('; ');
  }

  return headers;
}

async function getJson(url: string): Promise<any> {
  const response = await fetchApi(url, { headers: requestHeaders() });
  if (!response.ok) {
    throw new Error(`Novelpia HTTP ${response.status}`);
  }
  return response.json();
}

async function getText(url: string): Promise<string> {
  const text = await fetchText(url, {
    headers: requestHeaders({
      Accept: 'text/html,application/xhtml+xml',
    }),
  });
  if (!text) throw new Error(`Novelpia returned an empty HTML response: ${url}`);
  return text;
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
    const name = typeof item === 'string'
      ? item
      : firstString(item?.tag_name, item?.name, item?.title);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(',');
}

function cleanListingName(value: unknown): string {
  return cleanText(value)
    .replace(/^\s*#?\d+\s*(?:▲|▼|New|—|-)\s*/i, '')
    .replace(/^\s*\d+\s*$/, '')
    .trim();
}

function smallestSrcsetCandidate(srcset?: string): string | undefined {
  if (!srcset) return undefined;
  const candidates = srcset
    .split(',')
    .map(part => part.trim())
    .map(part => {
      const [url, descriptor] = part.split(/\s+/, 2);
      const width = descriptor?.endsWith('w') ? Number(descriptor.slice(0, -1)) : Number.MAX_SAFE_INTEGER;
      return { url, width };
    })
    .filter(item => !!item.url)
    .sort((a, b) => a.width - b.width);
  return candidates[0]?.url;
}

function imageFromElement($: ReturnType<typeof parseHTML>, el: any): string | undefined {
  const $el = $(el);
  const candidates = [
    $el.attr('data-src'),
    $el.attr('data-original'),
    $el.attr('data-lazy-src'),
    $el.attr('data-image'),
    smallestSrcsetCandidate($el.attr('data-srcset')),
    smallestSrcsetCandidate($el.attr('srcset')),
    $el.attr('src'),
  ];

  for (const candidate of candidates) {
    if (!candidate || /^(?:data|blob):/i.test(candidate.trim())) continue;
    const normalized = normalizeUrl(candidate.trim());
    if (normalized && /^https?:\/\//i.test(normalized)) return normalized;
  }

  const style = $el.attr('style') ?? '';
  const bg = style.match(/url\([\"']?([^\"')]+)[\"']?\)/i)?.[1];
  return normalizeUrl(bg);
}

function isRankingOnlyText(value: string): boolean {
  const t = cleanText(value).replace(/\s+/g, ' ').trim();
  return /^(?:#?\d+)(?:\s*(?:▲|▼|—|-|New)(?:\s*\d+)?)?$/i.test(t);
}

function parseNovelItemLinks(html: string): Plugin.NovelItem[] {
  const $ = parseHTML(html);
  const groups = new Map<string, { names: string[]; cover?: string }>();

  $('a').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') ?? '';
    const id = href.match(/(?:^|\/)novel\/(\d+)/)?.[1];
    if (!id) return;

    const path = `/novel/${id}`;
    const group = groups.get(path) ?? { names: [] };

    // The ranking page exposes the rank and title as separate anchors that
    // share the same novel URL. Keep all meaningful text and select the
    // longest candidate, which reliably drops entries such as "1—".
    const candidates = [
      $a.find('.nv-tit').first().text(),
      $a.attr('title'),
      $a.text(),
    ];
    for (const raw of candidates) {
      const name = cleanListingName(raw);
      if (name && !isRankingOnlyText(name) && !group.names.includes(name)) {
        group.names.push(name);
      }
    }

    // Covers are normally close to the title link. Look only at the link and
    // two parents; this is much cheaper than scanning every image on the page.
    if (!group.cover) {
      const nodes: any[] = [el];
      let parent = $a.parent().get(0);
      for (let level = 0; level < 2 && parent; level++) {
        nodes.push(parent);
        parent = $(parent).parent().get(0);
      }
      for (const node of nodes) {
        const image = $(node).find('img, source').map((__, child) => imageFromElement($, child)).get().find(Boolean);
        if (image) {
          group.cover = image as string;
          break;
        }
        const own = imageFromElement($, node);
        if (own) {
          group.cover = own;
          break;
        }
      }
    }

    groups.set(path, group);
  });

  return [...groups.entries()].flatMap(([path, group]) => {
    const name = [...new Set(group.names)].sort((a, b) => b.length - a.length)[0];
    if (!name) return [];
    return [{ name, path, cover: group.cover ?? defaultCover }];
  });
}

async function fetchListing(url: string): Promise<Plugin.NovelItem[]> {
  return parseNovelItemLinks(await getText(url));
}

async function fetchEpisodes(novelId: string): Promise<Plugin.ChapterItem[]> {
  // This endpoint is the one used by the current Global Novelpia parser.
  // Keep the older /list endpoint as a fallback because the supplied scraper
  // already supports both response shapes across Novelpia revisions.
  const urls = [
    `${API}/v1/novel/episode/cursor-list?novel_no=${encodeURIComponent(novelId)}&rows=9999&sort=ASC`,
    `${API}/v1/novel/episode/list?novel_no=${encodeURIComponent(novelId)}&rows=9999&sort=ASC`,
  ];

  let lastError: unknown;
  for (const url of urls) {
    try {
      const payload = await getJson(url);
      const list = payload?.result?.list;
      if (!Array.isArray(list)) throw new Error('Novelpia episode response has no result.list');

      return list.flatMap((row: any, index: number) => {
        const episodeNo = Number(row?.episode_no);
        if (!Number.isFinite(episodeNo)) return [];

        const chapterNo = Number(row?.epi_num);
        const title = firstString(row?.epi_title) || `Episode ${index + 1}`;
        const releaseTime = firstString(
          row?.epi_open_dt,
          row?.open_dt,
          row?.open_date,
          row?.reg_dt,
        );

        return [{
          name: row?.epi_num != null ? `${row.epi_num} - ${title}` : title,
          path: `/viewer/${episodeNo}`,
          chapterNumber: Number.isFinite(chapterNo) ? chapterNo : index + 1,
          ...(releaseTime ? { releaseTime } : {}),
        }];
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unable to load Novelpia chapters');
}

function extractTicketFromPayload(payload: any): string {
  const candidates: string[] = [];
  const visit = (value: any): void => {
    if (typeof value === 'string') {
      const direct = value.match(/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
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
      Object.entries(value).forEach(([key, item]) => {
        if ((key === '_t' || key === 't' || key === 'token') && typeof item === 'string') {
          candidates.push(item);
        }
        visit(item);
      });
    }
  };

  visit(payload);
  return candidates.find(Boolean) ?? '';
}

function extractViewerTicket(html: string): string {
  // The current site puts the short-lived ticket inside __NUXT_DATA__.
  const $ = parseHTML(html);
  const nuxt = $('script#__NUXT_DATA__').html() ?? '';
  const match = nuxt.match(/eyJhb[A-Za-z0-9_\-.]+/);
  return match?.[0] ?? '';
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
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function normalizeChapterHtml(html: string, episodeNo: string): string {
  const $ = parseHTML(`<div id="novelpia-root">${html}</div>`, null, false);
  const root = $('#novelpia-root');

  root.find('img').each((_, el) => {
    const $img = $(el);
    let src = firstString($img.attr('src'), $img.attr('data-src'));
    if (!src) {
      const filename = $img.attr('data-filename');
      if (filename) src = `https://gn.novelpia.com/upload/episode/${episodeNo}/${filename}`;
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

class NovelpiaGlobal implements Plugin.PluginBase {
  id = 'novelpiaglobal';
  name = 'Novelpia Global';
  icon = 'src/en/novelpiaglobal/icon.png';
  site = SITE;
  version = '1.4.1';
  filters: Filters | undefined = undefined;

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
    { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, Number(pageNo) || 1);

    if (!showLatestNovels) {
      // The live ranking page accepts these parameters and returns the ranked
      // novel cards server-side.
      return fetchListing(
        `${SITE}/ranking?flag=0&sort=live&page=${page}`,
      );
    }

    // These are the parameters used by the site's current Premium Novels
    // listing for newest-episode ordering. Keeping the full parameter set is
    // important because Novelpia's defaults can change with account/session.
    return fetchListing(
      `${SITE}/novels?page=${page}&flag_complete=&sort_col=new_epi_open_dt&flag_cate=&flag_detail_trans=2&content_type=2`,
    );
  }

  async searchNovels(searchTerm: string, pageNo: number): Promise<Plugin.NovelItem[]> {
    const term = searchTerm.trim();
    if (!term) return [];

    const page = Math.max(1, Number(pageNo) || 1);
    const encoded = encodeURIComponent(term);

    const candidates = [
      `${SITE}/search?search_type=title&search_val=${encoded}&page=${page}`,
      `${SITE}/search?keyword=${encoded}&page=${page}`,
      `${SITE}/search?search_val=${encoded}&page=${page}`,
    ];

    let lastError: unknown;
    for (const url of candidates) {
      try {
        const novels = await fetchListing(url);
        if (novels.length) return novels;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) throw lastError;
    return [];
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const novelId = novelIdFromPath(novelPath);
    if (!novelId) throw new Error(`Invalid Novelpia novel path: ${novelPath}`);

    const payload = await getJson(`${API}/v1/novel?novel_no=${encodeURIComponent(novelId)}`);
    const result = payload?.result ?? {};
    const novel = result?.novel ?? {};
    const story = cleanText(novel?.novel_story ?? novel?.story ?? novel?.description);
    const cover = normalizeUrl(firstString(
      novel?.novel_full_img,
      novel?.novel_img,
      novel?.cover,
      novel?.image,
    )) ?? defaultCover;
    const complete = String(novel?.flag_complete ?? '0') === '1';

    return {
      path: novelPath,
      name: firstString(novel?.novel_name, novel?.name, novel?.title) || `Novel ${novelId}`,
      cover,
      author: firstString(result?.writer_list?.[0]?.writer_name) || 'Unknown Author',
      genres: extractTags(payload),
      status: complete ? NovelStatus.Completed : NovelStatus.Ongoing,
      summary: story,
      chapters: await fetchEpisodes(novelId),
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const episodeNo = episodeIdFromPath(chapterPath);
    if (!episodeNo) throw new Error(`Invalid Novelpia chapter path: ${chapterPath}`);

    const viewerHtml = await getText(`${SITE}/viewer/${episodeNo}`);
    let token = extractViewerTicket(viewerHtml);

    if (!token) {
      const ticketPayload = await getJson(`${API}/v1/novel/episode?episode_no=${encodeURIComponent(episodeNo)}`);
      token = extractTicketFromPayload(ticketPayload);
    }

    if (!token) throw new Error(`Novelpia did not provide a chapter ticket for ${episodeNo}`);

    const contentPayload = await getJson(
      `${API}/v1/novel/episode/content?_t=${encodeURIComponent(token)}`,
    );
    const fragments = contentFragments(contentPayload?.result?.data);
    if (!fragments.length) {
      throw new Error(`Novelpia returned no content for chapter ${episodeNo}`);
    }

    const $ = parseHTML(viewerHtml);
    const chapterNumber = $('.in-chapter-number').first().text().trim();
    const chapterTitle = $('.in-chapter-title').first().text().trim();
    const heading = [chapterNumber, chapterTitle].filter(Boolean).join(' - ') || `Episode ${episodeNo}`;

    return `<h1>${cleanText(heading)}</h1>${normalizeChapterHtml(fragments.join(''), episodeNo)}`;
  }

  resolveUrl = (path: string) => `${SITE}${path.startsWith('/') ? '' : '/'}${path}`;

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: {
      Referer: `${SITE}/`,
      Origin: SITE,
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  };
}

export default new NovelpiaGlobal();
