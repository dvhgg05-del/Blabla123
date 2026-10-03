import { fetchApi } from '@libs/fetch';
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

function requestHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers = { ...BASE_HEADERS, ...extra };

  const loginAt = setting('loginAt');
  const userKey = setting('userKey');
  const tKey = setting('tKey');

  if (loginAt) {
    headers['login-at'] = loginAt;
  }

  const cookies: string[] = [];

  if (userKey) {
    cookies.push(`USERKEY=${userKey}`);
  }

  if (tKey) {
    cookies.push(`TKEY=${tKey}`);
  }

  if (cookies.length) {
    cookies.push('last_login=basic');
    headers.Cookie = cookies.join('; ');
  }

  return headers;
}

async function getJson(url: string): Promise<any> {
  const response = await fetchApi(url, {
    headers: requestHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Novelpia HTTP ${response.status}`);
  }

  return response.json();
}

async function getText(url: string): Promise<string> {
  const response = await fetchApi(url, {
    headers: requestHeaders({
      Accept: 'text/html,application/xhtml+xml',
    }),
  });

  if (!response.ok) {
    throw new Error(`Novelpia HTTP ${response.status}`);
  }

  return response.text();
}

function normalizeUrl(url?: string): string | undefined {
  if (!url) return undefined;

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  if (url.startsWith('/')) {
    return `${SITE}${url}`;
  }

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
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function novelIdFromPath(path: string): string {
  return path.match(/(?:^|\/)novel\/(\d+)/)?.[1] ?? '';
}

function episodeIdFromPath(path: string): string {
  return path.match(/(?:^|\/)viewer\/(\d+)/)?.[1] ?? '';
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

    if (name && !names.includes(name)) {
      names.push(name);
    }
  }

  return names.join(',');
}

function cleanListingName(value: unknown): string {
  return cleanText(value)
    .replace(
      /^\s*#?\d+\s*(?:▲|▼|New|—|-)\s*/i,
      '',
    )
    .replace(/^\s*\d+\s*$/, '')
    .trim();
}

function isRankingOnlyText(value: string): boolean {
  return /^(?:#?\d+)(?:\s*(?:▲|▼|—|-|New)(?:\s*\d+)?)?$/i.test(
    cleanText(value).replace(/\s+/g, ' ').trim(),
  );
}

function parseNovelItemLinks(html: string): Plugin.NovelItem[] {
  const $ = parseHTML(html);

  const groups = new Map<
    string,
    {
      names: string[];
      cover?: string;
    }
  >();

  $('a[href*="/novel/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') ?? '';

    const id = href.match(
      /(?:^|\/)novel\/(\d+)/,
    )?.[1];

    if (!id) {
      return;
    }

    const path = `/novel/${id}`;

    const group = groups.get(path) ?? {
      names: [],
    };

    const candidates = [
      $a.find('.nv-tit').first().text(),
      $a.attr('title'),
      $a.text(),
    ];

    for (const raw of candidates) {
      const name = cleanListingName(raw);

      if (
        name &&
        !isRankingOnlyText(name) &&
        !group.names.includes(name)
      ) {
        group.names.push(name);
      }
    }

    const img = $a.find('img').first();

    const cover = normalizeUrl(
      firstString(
        img.attr('src'),
        img.attr('data-src'),
        img.attr('data-original'),
        img.attr('data-lazy-src'),
        img.attr('data-image'),
      ),
    );

    if (cover && !group.cover) {
      group.cover = cover;
    }

    groups.set(path, group);
  });

  const result: Plugin.NovelItem[] = [];

  for (const [path, group] of groups) {
    const name = [...new Set(group.names)].sort(
      (a, b) => b.length - a.length,
    )[0];

    if (name) {
      result.push({
        name,
        path,
        cover: group.cover ?? defaultCover,
      });
    }
  }

  return result;
}

async function fetchListing(
  url: string,
): Promise<Plugin.NovelItem[]> {
  const html = await getText(url);
  return parseNovelItemLinks(html);
}

async function fetchEpisodes(
  novelId: string,
): Promise<Plugin.ChapterItem[]> {
  const urls = [
    `${API}/v1/novel/episode/cursor-list?novel_no=${encodeURIComponent(
      novelId,
    )}&rows=9999&sort=ASC`,

    `${API}/v1/novel/episode/list?novel_no=${encodeURIComponent(
      novelId,
    )}&rows=9999&sort=ASC`,
  ];

  let lastError: unknown;

  for (const url of urls) {
    try {
      const payload = await getJson(url);
      const list = payload?.result?.list;

      if (!Array.isArray(list)) {
        throw new Error(
          'Novelpia episode response has no result.list',
        );
      }

      return list.flatMap(
        (row: any, index: number) => {
          const episodeNo = Number(row?.episode_no);

          if (!Number.isFinite(episodeNo)) {
            return [];
          }

          const chapterNo = Number(row?.epi_num);

          const title =
            firstString(row?.epi_title) ||
            `Episode ${index + 1}`;

          const releaseTime = firstString(
            row?.epi_open_dt,
            row?.open_dt,
            row?.open_date,
            row?.reg_dt,
          );

          return [
            {
              name:
                row?.epi_num != null
                  ? `${row.epi_num} - ${title}`
                  : title,

              path: `/viewer/${episodeNo}`,

              chapterNumber: Number.isFinite(chapterNo)
                ? chapterNo
                : index + 1,

              ...(releaseTime
                ? { releaseTime }
                : {}),
            },
          ];
        },
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        'Unable to load Novelpia chapters',
      );
}

function extractTicketFromPayload(
  payload: any,
): string {
  const candidates: string[] = [];

  const visit = (value: any): void => {
    if (typeof value === 'string') {
      const direct = value.match(
        /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );

      if (direct) {
        candidates.push(direct[0]);
      }

      const embedded = value.match(
        /[?&]_t=([^&\s]+)/,
      );

      if (embedded?.[1]) {
        candidates.push(
          decodeURIComponent(embedded[1]),
        );
      }

      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (
      value &&
      typeof value === 'object'
    ) {
      Object.entries(value).forEach(
        ([key, item]) => {
          if (
            (key === '_t' ||
              key === 't' ||
              key === 'token') &&
            typeof item === 'string'
          ) {
            candidates.push(item);
          }

          visit(item);
        },
      );
    }
  };

  visit(payload);

  return candidates.find(Boolean) ?? '';
}

function extractViewerTicket(
  html: string,
): string {
  const $ = parseHTML(html);

  const nuxt =
    $('script#__NUXT_DATA__').html() ?? '';

  const matches = nuxt.match(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  );

  return matches?.[0] ?? '';
}

function contentFragments(
  data: any,
): string[] {
  if (
    !data ||
    typeof data !== 'object'
  ) {
    return [];
  }

  return Object.keys(data)
    .filter((key) =>
      key.startsWith('epi_content'),
    )
    .sort((a, b) => {
      if (a === 'epi_content') {
        return b === 'epi_content'
          ? 0
          : -1;
      }

      if (b === 'epi_content') {
        return 1;
      }

      const an = Number(
        a.match(/(\d+)$/)?.[1] ?? 0,
      );

      const bn = Number(
        b.match(/(\d+)$/)?.[1] ?? 0,
      );

      return an - bn;
    })
    .map((key) => data[key])
    .filter(
      (
        value,
      ): value is string =>
        typeof value === 'string' &&
        value.length > 0,
    );
}

function normalizeChapterHtml(
  html: string,
  episodeNo: string,
): string {
  const $ = parseHTML(
    `<div id="novelpia-root">${html}</div>`,
    null,
    false,
  );

  const root = $('#novelpia-root');

  root.find('img').each((_, el) => {
    const $img = $(el);

    let src = firstString(
      $img.attr('src'),
      $img.attr('data-src'),
      $img.attr('data-original'),
      $img.attr('data-lazy-src'),
    );

    if (!src) {
      const filename =
        $img.attr('data-filename');

      if (filename) {
        src =
          `https://gn.novelpia.com/upload/episode/${episodeNo}/${filename}`;
      }
    }

    const normalized =
      normalizeUrl(src);

    if (normalized) {
      $img.attr('src', normalized);
    }

    for (const attr of [
      'data-src',
      'data-original',
      'data-lazy-src',
      'data-filename',
      'loading',
      'draggable',
      'onerror',
      'style',
    ]) {
      $img.removeAttr(attr);
    }
  });

  root
    .find(
      '.next-epi-btn, script, style, nav',
    )
    .remove();

  return root.html() ?? '';
}

class NovelpiaGlobal
  implements Plugin.PluginBase {
  id = 'novelpiaglobal';

  name = 'Novelpia Global';

  icon =
    'src/en/novelpiaglobal/icon.png';

  site = SITE;

  version = '2.0.0';

  filters: Filters | undefined =
    undefined;

  pluginSettings = {
    loginAt: {
      value: '',
      label:
        'LOGINAT session token (optional)',
      type: 'Text',
    },

    userKey: {
      value: '',
      label:
        'USERKEY cookie (optional)',
      type: 'Text',
    },

    tKey: {
      value: '',
      label:
        'TKEY cookie (optional)',
      type: 'Text',
    },
  };

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
    }: Plugin.PopularNovelsOptions<
      typeof this.filters
    >,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(
      1,
      Number(pageNo) || 1,
    );

    if (!showLatestNovels) {
      const ranked =
        await fetchListing(
          `${SITE}/ranking`,
        );

      const start =
        (page - 1) * 50;

      const end = page * 50;

      return ranked.slice(
        start,
        end,
      );
    }

    return fetchListing(
      `${SITE}/novels?content_type=2&page=${page}&sort_col=new_epi_open_dt`,
    );
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const term = searchTerm.trim();

    if (!term) {
      return [];
    }

    const page = Math.max(
      1,
      Number(pageNo) || 1,
    );

    const encoded =
      encodeURIComponent(term);

    const candidates = [
      `${SITE}/search?search_type=title&search_val=${encoded}&page=${page}`,
      `${SITE}/search?keyword=${encoded}&page=${page}`,
      `${SITE}/search?search_val=${encoded}&page=${page}`,
    ];

    let lastError: unknown;

    for (const url of candidates) {
      try {
        const novels =
          await fetchListing(url);

        if (novels.length) {
          return novels;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (
      lastError instanceof Error
    ) {
      throw lastError;
    }

    return [];
  }

  async parseNovel(
    novelPath: string,
  ): Promise<Plugin.SourceNovel> {
    const novelId =
      novelIdFromPath(novelPath);

    if (!novelId) {
      throw new Error(
        `Invalid Novelpia novel path: ${novelPath}`,
      );
    }

    const payload = await getJson(
      `${API}/v1/novel?novel_no=${encodeURIComponent(
        novelId,
      )}`,
    );

    const result =
      payload?.result ?? {};

    const novel =
      result?.novel ?? {};

    const story = cleanText(
      novel?.novel_story ??
        novel?.story ??
        novel?.description,
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

    const complete =
      String(
        novel?.flag_complete ?? '0',
      ) === '1';

    return {
      path: novelPath,

      name:
        firstString(
          novel?.novel_name,
          novel?.name,
          novel?.title,
        ) || `Novel ${novelId}`,

      cover,

      author:
        firstString(
          result?.writer_list?.[0]
            ?.writer_name,
        ) || 'Unknown Author',

      genres: extractTags(payload),

      status: complete
        ? NovelStatus.Completed
        : NovelStatus.Ongoing,

      summary: story,

      chapters:
        await fetchEpisodes(novelId),
    };
  }

  async parseChapter(
    chapterPath: string,
  ): Promise<string> {
    const episodeNo =
      episodeIdFromPath(chapterPath);

    if (!episodeNo) {
      throw new Error(
        `Invalid Novelpia chapter path: ${chapterPath}`,
      );
    }

    const viewerHtml =
      await getText(
        `${SITE}/viewer/${episodeNo}`,
      );

    let token =
      extractViewerTicket(
        viewerHtml,
      );

    if (!token) {
      const ticketPayload =
        await getJson(
          `${API}/v1/novel/episode?episode_no=${encodeURIComponent(
            episodeNo,
          )}`,
        );

      token =
        extractTicketFromPayload(
          ticketPayload,
        );
    }

    if (!token) {
      throw new Error(
        `Novelpia did not provide a chapter ticket for ${episodeNo}`,
      );
    }

    const contentPayload =
      await getJson(
        `${API}/v1/novel/episode/content?_t=${encodeURIComponent(
          token,
        )}`,
      );

    const fragments =
      contentFragments(
        contentPayload?.result?.data,
      );

    if (!fragments.length) {
      throw new Error(
        `Novelpia returned no content for chapter ${episodeNo}`,
      );
    }

    const $ =
      parseHTML(viewerHtml);

    const chapterNumber =
      $('.in-chapter-number')
        .first()
        .text()
        .trim();

    const chapterTitle =
      $('.in-chapter-title')
        .first()
        .text()
        .trim();

    const heading =
      [
        chapterNumber,
        chapterTitle,
      ]
        .filter(Boolean)
        .join(' - ') ||
      `Episode ${episodeNo}`;

    return (
      `<h1>${cleanText(
        heading,
      )}</h1>` +
      normalizeChapterHtml(
        fragments.join(''),
        episodeNo,
      )
    );
  }

  resolveUrl = (
    path: string,
  ) =>
    `${SITE}${
      path.startsWith('/')
        ? ''
        : '/'
    }${path}`;

  imageRequestInit:
    Plugin.ImageRequestInit = {
      headers: {
        Referer: `${SITE}/`,
      },
    };
}

export default new NovelpiaGlobal();
