import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
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

function getSetting(key: string): string {
  const value = storage.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers = { ...BASE_HEADERS, ...extra };
  const loginAt = getSetting('loginAt');
  const userKey = getSetting('userKey');
  const tKey = getSetting('tKey');

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
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(
      `Novelpia HTTP ${response.status} for ${url}`,
    );
  }

  return response.json();
}

async function getText(url: string): Promise<string> {
  const response = await fetchApi(url, {
    headers: authHeaders({
      Accept: 'text/html,application/xhtml+xml',
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Novelpia HTTP ${response.status} for ${url}`,
    );
  }

  return response.text();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (
      typeof value === 'string' &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return '';
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function normalizeUrl(url?: string): string {
  if (!url) {
    return '';
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  if (url.startsWith('/')) {
    return `${SITE}${url}`;
  }

  return url;
}

function novelIdFromPath(path: string): string {
  const match = String(path || '').match(
    /(?:^|\/)novel\/(\d+)/,
  );

  if (match) {
    return match[1];
  }

  const raw = String(path || '').match(/^\/?(\d+)$/);

  return raw ? raw[1] : '';
}

function episodeIdFromPath(path: string): string {
  const match = String(path || '').match(
    /(?:^|\/)viewer\/(\d+)/,
  );

  if (match) {
    return match[1];
  }

  const raw = String(path || '').match(/^\/?(\d+)$/);

  return raw ? raw[1] : '';
}

function extractTags(payload: any): string {
  const result = payload?.result ?? {};
  const novel = result?.novel ?? {};

  const raw = Array.isArray(result.tag_list)
    ? result.tag_list
    : Array.isArray(novel.tag_list)
      ? novel.tag_list
      : [];

  const names: string[] = [];

  for (const item of raw) {
    const name =
      typeof item === 'string'
        ? item
        : firstString(
            item?.tag_name,
            item?.name,
            item?.title,
          );

    if (
      name &&
      !names.includes(name)
    ) {
      names.push(name);
    }
  }

  return names.join(',');
}

function novelInfo(payload: any) {
  const result = payload?.result ?? {};
  const novel = result?.novel ?? {};
  const complete =
    String(novel?.flag_complete ?? '0') === '1';

  const writers = result?.writer_list;

  return {
    name:
      firstString(
        novel?.novel_name,
        novel?.name,
        novel?.title,
      ) ||
      `Novel ${novel?.novel_no ?? ''}`.trim(),

    author:
      (
        Array.isArray(writers) &&
        writers.length
          ? firstString(
              writers[0]?.writer_name,
              writers[0]?.name,
              writers[0]?.title,
            )
          : ''
      ) || 'Unknown Author',

    summary: cleanText(
      novel?.novel_story ??
        novel?.story ??
        novel?.description ??
        '',
    ),

    genres: extractTags(payload),

    status: complete
      ? NovelStatus.Completed
      : NovelStatus.Ongoing,

    cover:
      normalizeUrl(
        firstString(
          novel?.novel_img,
          novel?.novel_full_img,
          novel?.cover,
          novel?.image,
        ),
      ) || defaultCover,
  };
}

/**
 * Extract only the novel IDs from the listing page.
 *
 * Novelpia's ranking/favourite cards can contain:
 *
 *   <a href="/novel/79">1—</a>
 *   <a href="/novel/79">Actual Novel Title</a>
 *
 * Earlier versions incorrectly treated the rank text as the title.
 *
 * Here we intentionally collect IDs first and then obtain the real
 * title/cover from the official /v1/novel endpoint.
 */
function parseNovelLinks(html: string): string[] {
  const $ = parseHTML(html);

  const ids: string[] = [];
  const seen = new Set<string>();

  $('a[href*="/novel/"]').each((_, el) => {
    const href =
      $(el).attr('href') || '';

    const match = href.match(
      /(?:^|\/)novel\/(\d+)/,
    );

    if (!match) {
      return;
    }

    const id = match[1];

    if (seen.has(id)) {
      return;
    }

    seen.add(id);
    ids.push(id);
  });

  return ids;
}

async function fetchNovelItemsFromIds(
  ids: string[],
  limit = 20,
): Promise<Plugin.NovelItem[]> {
  const selected =
    ids.slice(0, limit);

  const results:
    Array<Plugin.NovelItem | null> =
    new Array(selected.length).fill(null);

  /**
   * Small batches prevent a large burst of requests.
   *
   * The title and cover are obtained from the official metadata API
   * instead of trying to infer them from the ranking card HTML.
   */
  const batchSize = 6;

  for (
    let start = 0;
    start < selected.length;
    start += batchSize
  ) {
    const batch =
      selected.slice(
        start,
        start + batchSize,
      );

    const values =
      await Promise.all(
        batch.map(
          async (
            id,
          ): Promise<Plugin.NovelItem | null> => {
            try {
              const payload =
                await getJson(
                  `${API}/v1/novel?novel_no=${encodeURIComponent(
                    id,
                  )}`,
                );

              const info =
                novelInfo(payload);

              return {
                name: info.name,
                path: `/novel/${id}`,
                cover: info.cover,
              };
            } catch {
              /**
               * Do not allow one failed metadata request
               * to make the entire listing disappear.
               */
              return {
                name: `Novel ${id}`,
                path: `/novel/${id}`,
                cover: defaultCover,
              };
            }
          },
        ),
      );

    values.forEach(
      (value, offset) => {
        results[start + offset] =
          value;
      },
    );
  }

  return results.filter(
    (
      item,
    ): item is Plugin.NovelItem =>
      item !== null,
  );
}

async function fetchListing(
  url: string,
  limit = 20,
): Promise<Plugin.NovelItem[]> {
  const html =
    await getText(url);

  const ids =
    parseNovelLinks(html);

  return fetchNovelItemsFromIds(
    ids,
    limit,
  );
}

function normalizeChapterRow(
  row: any,
  index: number,
): Plugin.ChapterItem | null {
  const episodeNo =
    Number(row?.episode_no);

  if (
    !Number.isFinite(
      episodeNo,
    )
  ) {
    return null;
  }

  const chapterNumber =
    Number(row?.epi_num);

  const title =
    row?.epi_num != null
      ? `${row.epi_num} - ${
          firstString(
            row?.epi_title,
          ) ||
          `Episode ${index + 1}`
        }`
      : firstString(
          row?.epi_title,
        ) ||
        `Episode ${index + 1}`;

  const releaseTime =
    firstString(
      row?.epi_open_dt,
      row?.open_dt,
      row?.open_date,
      row?.created_at,
      row?.reg_dt,
    );

  return {
    name: title,

    path:
      `/viewer/${episodeNo}`,

    chapterNumber:
      Number.isFinite(
        chapterNumber,
      )
        ? chapterNumber
        : index + 1,

    releaseTime:
      releaseTime ||
      undefined,
  };
}

async function fetchEpisodes(
  novelId: string,
): Promise<Plugin.ChapterItem[]> {
  /**
   * Newer Novelpia installations expose cursor-list.
   *
   * Keep the older episode/list endpoint as fallback because
   * your scraper already confirms that endpoint works.
   */
  const urls = [
    `${API}/v1/novel/episode/cursor-list?novel_no=${encodeURIComponent(
      novelId,
    )}&rows=9999&sort=ASC`,

    `${API}/v1/novel/episode/list?novel_no=${encodeURIComponent(
      novelId,
    )}&rows=9999&sort=ASC`,
  ];

  let lastError:
    unknown;

  for (const url of urls) {
    try {
      const data =
        await getJson(url);

      const list =
        data?.result?.list;

      if (!Array.isArray(list)) {
        throw new Error(
          'Episode list missing result.list',
        );
      }

      const chapters =
        list
          .map(
            (
              row: any,
              index: number,
            ) =>
              normalizeChapterRow(
                row,
                index,
              ),
          )
          .filter(
            (
              chapter:
                | Plugin.ChapterItem
                | null,
            ): chapter is Plugin.ChapterItem =>
              chapter !== null,
          );

      if (
        chapters.length ||
        url.includes('/episode/list')
      ) {
        return chapters;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        'Unable to fetch Novelpia episode list',
      );
}

function collectTicketStrings(
  value: any,
  output: string[],
): void {
  if (
    typeof value ===
    'string'
  ) {
    const jwt =
      value.match(
        /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );

    if (jwt) {
      output.push(
        jwt[0],
      );
    }

    const embedded =
      value.match(
        /[?&]_t=([^&\s]+)/,
      );

    if (embedded?.[1]) {
      try {
        output.push(
          decodeURIComponent(
            embedded[1],
          ),
        );
      } catch {
        output.push(
          embedded[1],
        );
      }
    }

    return;
  }

  if (Array.isArray(value)) {
    value.forEach(
      (item) =>
        collectTicketStrings(
          item,
          output,
        ),
    );

    return;
  }

  if (
    value &&
    typeof value ===
      'object'
  ) {
    Object.entries(
      value,
    ).forEach(
      ([key, item]) => {
        if (
          (
            key === '_t' ||
            key === 't' ||
            key === 'token'
          ) &&
          typeof item ===
            'string' &&
          item
        ) {
          output.push(
            item,
          );
        }

        collectTicketStrings(
          item,
          output,
        );
      },
    );
  }
}

function extractTicket(
  payload: any,
): string {
  const candidates: string[] =
    [];

  collectTicketStrings(
    payload,
    candidates,
  );

  return (
    candidates.find(Boolean) ||
    ''
  );
}

function extractViewerToken(
  html: string,
): string {
  const match =
    String(html || '').match(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    );

  return match?.[0] || '';
}

function contentFragments(
  data: any,
): string[] {
  if (
    !data ||
    typeof data !==
      'object'
  ) {
    return [];
  }

  return Object.keys(
    data,
  )
    .filter(
      (key) =>
        key.startsWith(
          'epi_content',
        ),
    )
    .sort(
      (a, b) => {
        if (
          a === 'epi_content' &&
          b !== 'epi_content'
        ) {
          return -1;
        }

        if (
          b === 'epi_content' &&
          a !== 'epi_content'
        ) {
          return 1;
        }

        const aNum =
          Number(
            a.match(
              /(\d+)$/,
            )?.[1] || 0,
          );

        const bNum =
          Number(
            b.match(
              /(\d+)$/,
            )?.[1] || 0,
          );

        return aNum - bNum;
      },
    )
    .map(
      (key) => data[key],
    )
    .filter(
      (
        value,
      ): value is string =>
        typeof value ===
          'string' &&
        value.length > 0,
    );
}

function normalizeChapterHtml(
  html: string,
  episodeNo: string,
): string {
  const $ = parseHTML(
    `<div id="novelpia-root">${
      html || ''
    }</div>`,
    null,
    false,
  );

  const root =
    $('#novelpia-root');

  root.find('img').each(
    (_, el) => {
      const image = $(el);

      let src =
        firstString(
          image.attr('src'),
          image.attr(
            'data-src',
          ),
          image.attr(
            'data-original',
          ),
          image.attr(
            'data-lazy-src',
          ),
        );

      if (!src) {
        const filename =
          image.attr(
            'data-filename',
          );

        if (filename) {
          src =
            `https://gn.novelpia.com/upload/episode/${episodeNo}/${filename}`;
        }
      }

      if (src) {
        image.attr(
          'src',
          normalizeUrl(src),
        );
      }

      for (
        const attr of [
          'data-src',
          'data-original',
          'data-lazy-src',
          'data-filename',
          'loading',
          'draggable',
          'onerror',
          'style',
        ]
      ) {
        image.removeAttr(
          attr,
        );
      }
    },
  );

  root
    .find(
      '.next-epi-btn',
    )
    .remove();

  root
    .find(
      'script, style, nav',
    )
    .remove();

  return (
    root.html() || ''
  );
}

function escapeHtml(
  value: string,
): string {
  return String(
    value || '',
  )
    .replace(
      /&/g,
      '&amp;',
    )
    .replace(
      /</g,
      '&lt;',
    )
    .replace(
      />/g,
      '&gt;',
    )
    .replace(
      /"/g,
      '&quot;',
    )
    .replace(
      /'/g,
      '&#39;',
    );
}

async function fetchChapterHtml(
  chapterPath: string,
): Promise<string> {
  const episodeNo =
    episodeIdFromPath(
      chapterPath,
    );

  if (!episodeNo) {
    throw new Error(
      `Invalid Novelpia chapter path: ${chapterPath}`,
    );
  }

  /**
   * First obtain the viewer page.
   *
   * The current Novelpia reader can contain the short-lived
   * JWT ticket inside __NUXT_DATA__.
   */
  const viewerHtml =
    await getText(
      `${SITE}/viewer/${episodeNo}`,
    );

  let number = '';
  let title = '';

  try {
    const $ =
      parseHTML(
        viewerHtml,
      );

    number =
      $(
        '.in-chapter-number',
      )
        .first()
        .text()
        .trim();

    title =
      $(
        '.in-chapter-title',
      )
        .first()
        .text()
        .trim();
  } catch {
    // Heading is optional.
  }

  let token =
    extractViewerToken(
      viewerHtml,
    );

  /**
   * Fallback to the official episode ticket endpoint.
   *
   * Your scraper confirms this endpoint:
   *
   * GET /v1/novel/episode?episode_no=...
   */
  if (!token) {
    const ticket =
      await getJson(
        `${API}/v1/novel/episode?episode_no=${encodeURIComponent(
          episodeNo,
        )}`,
      );

    token =
      extractTicket(
        ticket,
      );
  }

  if (!token) {
    throw new Error(
      `Could not obtain a Novelpia chapter ticket for episode ${episodeNo}`,
    );
  }

  /**
   * Finally obtain the real chapter content.
   *
   * GET /v1/novel/episode/content?_t=...
   */
  const content =
    await getJson(
      `${API}/v1/novel/episode/content?_t=${encodeURIComponent(
        token,
      )}`,
    );

  const parts =
    contentFragments(
      content?.result?.data,
    );

  if (!parts.length) {
    throw new Error(
      `Novelpia returned no epi_content for episode ${episodeNo}`,
    );
  }

  const heading =
    [
      number,
      title,
    ]
      .filter(Boolean)
      .join(' - ') ||
    `Episode ${episodeNo}`;

  return (
    `<h1>${escapeHtml(
      heading,
    )}</h1>` +
    normalizeChapterHtml(
      parts.join(''),
      episodeNo,
    )
  );
}

class NovelpiaGlobal
  implements Plugin.PluginBase {
  id =
    'novelpiaglobal';

  name =
    'Novelpia Global';

  icon =
    'src/en/novelpiaglobal/icon.png';

  site =
    SITE;

  version =
    '2.2.0';

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
      showLatestNovels =
        false,
    }: Plugin.PopularNovelsOptions<undefined>,
  ): Promise<
    Plugin.NovelItem[]
  > {
    const page =
      Math.max(
        1,
        Number(pageNo) || 1,
      );

    /**
     * Popular:
     *
     * This uses the older Novelpia listing URL that was
     * previously confirmed to return entries in Tsundoku.
     *
     * We intentionally do NOT parse the title from the card.
     * We first obtain the novel IDs and then request official
     * metadata from /v1/novel.
     */
    if (
      showLatestNovels
    ) {
      return fetchListing(
        `${SITE}/novels?content_type=2&page=${page}&sort_col=new_epi_open_dt`,
        20,
      );
    }

    return fetchListing(
      `${SITE}/novels?content_type=2&page=${page}&sort_col=favourite`,
      20,
    );
  }

  async searchNovels(
    searchTerm: string,
    pageNo = 1,
  ): Promise<
    Plugin.NovelItem[]
  > {
    const term =
      String(
        searchTerm || '',
      ).trim();

    if (!term) {
      return [];
    }

    const page =
      Math.max(
        1,
        Number(pageNo) || 1,
      );

    const url =
      `${SITE}/search?search_type=title&search_val=${encodeURIComponent(
        term,
      )}&page=${page}`;

    return fetchListing(
      url,
      20,
    );
  }

  async parseNovel(
    novelPath: string,
  ): Promise<Plugin.SourceNovel> {
    const novelId =
      novelIdFromPath(
        novelPath,
      );

    if (!novelId) {
      throw new Error(
        `Invalid Novelpia novel path: ${novelPath}`,
      );
    }

    const payload =
      await getJson(
        `${API}/v1/novel?novel_no=${encodeURIComponent(
          novelId,
        )}`,
      );

    const info =
      novelInfo(
        payload,
      );

    const chapters =
      await fetchEpisodes(
        novelId,
      );

    return {
      path:
        `/novel/${novelId}`,

      name:
        info.name,

      cover:
        info.cover,

      author:
        info.author,

      genres:
        info.genres,

      summary:
        info.summary,

      status:
        info.status,

      chapters:
        chapters,
    };
  }

  async parseChapter(
    chapterPath: string,
  ): Promise<string> {
    return fetchChapterHtml(
      chapterPath,
    );
  }

  resolveUrl = (
    path: string,
    _isNovel = false,
  ) =>
    `${SITE}${
      path.startsWith('/')
        ? ''
        : '/'
    }${path}`;

  imageRequestInit:
    Plugin.ImageRequestInit = {
      headers: {
        Referer:
          `${SITE}/`,
      },
    };
}

export default new NovelpiaGlobal();
