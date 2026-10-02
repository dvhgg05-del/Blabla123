// Novelpia Global - LNReader v3 plugin
// Supports public/free chapters and user-provided Novelpia session credentials.
// Premium/ad-unlock automation is intentionally not implemented.
//
// Source:
//   https://global.novelpia.com/
// API base:
//   https://api-global.novelpia.com
//
// The plugin uses the same API architecture documented by the project's
// Novelpia scraper: novel metadata -> episode list -> viewer/ticket -> content.

'use strict';

const { fetchApi } = require('@libs/fetch');
const { storage } = require('@libs/storage');

const SITE = 'https://global.novelpia.com';
const API = 'https://api-global.novelpia.com';
const COVER_FALLBACK =
  'https://raw.githubusercontent.com/LNReader/lnreader-plugins/master/public/static/siteNotAvailable.png';

const BASE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: SITE,
  Referer: SITE + '/',
  'X-Requested-With': 'XMLHttpRequest',
};

function cleanText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function firstString(...values) {
  return values.find(v => typeof v === 'string' && v.trim())?.trim() || '';
}

function novelIdFromPath(path) {
  const match = String(path || '').match(/\/novel\/(\d+)/);
  if (match) return match[1];
  const raw = String(path || '').match(/^\/?(\d+)$/);
  return raw ? raw[1] : '';
}

function episodeIdFromPath(path) {
  const match = String(path || '').match(/\/viewer\/(\d+)/);
  if (match) return match[1];
  const raw = String(path || '').match(/^\/?(\d+)$/);
  return raw ? raw[1] : '';
}

function normalizeUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return SITE + url;
  return url;
}

function getSetting(key) {
  const value = storage.get(key);
  return typeof value === 'string' ? value.trim() : value;
}

function authHeaders(extra) {
  const headers = { ...BASE_HEADERS, ...(extra || {}) };

  const loginAt = getSetting('loginAt');
  const userKey = getSetting('userKey');
  const tKey = getSetting('tKey');

  if (loginAt) headers['login-at'] = loginAt;

  const cookies = [];
  if (userKey) cookies.push(`USERKEY=${userKey}`);
  if (tKey) cookies.push(`TKEY=${tKey}`);
  if (cookies.length) cookies.push('last_login=basic');
  if (cookies.length) headers.Cookie = cookies.join('; ');

  return headers;
}

async function getJson(url, extra) {
  const response = await fetchApi(url, {
    headers: authHeaders(extra),
  });
  if (!response.ok) {
    throw new Error(`Novelpia HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function extractTags(payload) {
  const result = payload?.result || {};
  const novel = result?.novel || {};
  const raw = Array.isArray(result.tag_list)
    ? result.tag_list
    : Array.isArray(novel.tag_list)
      ? novel.tag_list
      : [];

  const names = [];
  for (const item of raw) {
    const name =
      typeof item === 'string'
        ? item
        : firstString(item?.tag_name, item?.name, item?.title);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function firstAuthor(payload) {
  const writers = payload?.result?.writer_list;
  if (!Array.isArray(writers) || !writers.length) return 'Unknown Author';
  return firstString(
    writers[0]?.writer_name,
    writers[0]?.name,
    writers[0]?.title,
  ) || 'Unknown Author';
}

function novelInfo(payload) {
  const result = payload?.result || {};
  const novel = result?.novel || {};
  const complete = String(novel?.flag_complete ?? '0') === '1';

  return {
    result,
    novel,
    name: firstString(
      novel?.novel_name,
      novel?.name,
      novel?.title,
    ) || `Novel ${novel?.novel_no || ''}`.trim(),
    author: firstAuthor(payload),
    summary: cleanText(novel?.novel_story || novel?.story || novel?.description || ''),
    genres: extractTags(payload).join(','),
    status: complete ? 'Completed' : 'Ongoing',
    cover: normalizeUrl(
      firstString(
        novel?.novel_full_img,
        novel?.novel_img,
        novel?.cover,
        novel?.image,
      ),
    ) || COVER_FALLBACK,
    chapterCount: Number(
      result?.info?.epi_cnt ||
      novel?.count_epi ||
      novel?.episode_count ||
      0,
    ) || 0,
  };
}

function normalizeChapterRow(row, index) {
  const episodeNo = Number(row?.episode_no);
  if (!Number.isFinite(episodeNo)) return null;

  const epiNumRaw = row?.epi_num;
  const chapterNumber = Number(epiNumRaw);
  const name = firstString(
    row?.epi_title && row?.epi_num != null
      ? `${row.epi_num} - ${row.epi_title}`
      : '',
    row?.epi_title,
  ) || `Episode ${index + 1}`;

  const releaseRaw = firstString(
    row?.epi_open_dt,
    row?.open_dt,
    row?.open_date,
    row?.created_at,
    row?.reg_dt,
  );

  return {
    name,
    path: `/viewer/${episodeNo}`,
    chapterNumber: Number.isFinite(chapterNumber) ? chapterNumber : index + 1,
    releaseTime: releaseRaw || undefined,
  };
}

async function fetchEpisodes(novelId) {
  // Current Global Novelpia WebToEpub parser uses cursor-list with 9999 rows.
  const urls = [
    `${API}/v1/novel/episode/cursor-list?novel_no=${encodeURIComponent(novelId)}&rows=9999&sort=ASC`,
    `${API}/v1/novel/episode/list?novel_no=${encodeURIComponent(novelId)}&rows=9999&sort=ASC`,
  ];

  let lastError;
  for (const url of urls) {
    try {
      const data = await getJson(url);
      const list = data?.result?.list;
      if (!Array.isArray(list)) throw new Error('Episode list missing result.list');
      const chapters = list
        .map((row, i) => normalizeChapterRow(row, i))
        .filter(Boolean);

      if (chapters.length || url.includes('/episode/list')) return chapters;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to fetch Novelpia episode list');
}

function collectTicketStrings(value, output) {
  if (typeof value === 'string') {
    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
      output.push(value);
    }
    const match = value.match(/[?&]_t=([^&\s]+)/);
    if (match) output.push(decodeURIComponent(match[1]));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTicketStrings(item, output);
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '_t' || key === 't' || key === 'token') {
        if (typeof item === 'string' && item) output.push(item);
      }
      collectTicketStrings(item, output);
    }
  }
}

function extractTicket(payload) {
  const candidates = [];
  collectTicketStrings(payload, candidates);
  return candidates.find(Boolean) || '';
}

function extractViewerToken(html) {
  // __NUXT_DATA__ contains the short-lived API ticket on the current site.
  const match = String(html || '').match(/eyJhb[^"'\s<]+/);
  return match ? match[0] : '';
}

function contentFragments(data) {
  if (!data || typeof data !== 'object') return [];

  const keys = Object.keys(data)
    .filter(key => key.startsWith('epi_content'))
    .sort((a, b) => {
      const aNum = Number((a.match(/(\d+)$/) || ['', '0'])[1]);
      const bNum = Number((b.match(/(\d+)$/) || ['', '0'])[1]);

      // Base "epi_content" comes first, followed by numbered fragments.
      if (a === 'epi_content' && b !== 'epi_content') return -1;
      if (b === 'epi_content' && a !== 'epi_content') return 1;
      return aNum - bNum;
    });

  return keys
    .map(key => data[key])
    .filter(value => typeof value === 'string' && value);
}

function normalizeChapterHtml(html, episodeNo) {
  // Cheerio is deliberately required only here so metadata/search remain light.
  const { load } = require('cheerio');
  const $ = load(`<div id="novelpia-root">${html || ''}</div>`, null, false);
  const root = $('#novelpia-root');

  root.find('img').each((_, el) => {
    const image = $(el);

    let src =
      image.attr('src') ||
      image.attr('data-src') ||
      '';

    if (!src) {
      const filename = image.attr('data-filename');
      if (filename) {
        src = `https://gn.novelpia.com/upload/episode/${episodeNo}/${filename}`;
      }
    }

    if (src) image.attr('src', normalizeUrl(src));

    for (const attr of [
      'data-src',
      'data-filename',
      'loading',
      'draggable',
      'onerror',
      'style',
    ]) {
      image.removeAttr(attr);
    }
  });

  root.find('.next-epi-btn').remove();
  root.find('script, style, nav').remove();

  return root.html() || '';
}

async function fetchChapterHtml(chapterPath) {
  const episodeNo = episodeIdFromPath(chapterPath);
  if (!episodeNo) throw new Error(`Invalid Novelpia chapter path: ${chapterPath}`);

  const viewerUrl = `${SITE}/viewer/${episodeNo}`;
  const viewerResponse = await fetchApi(viewerUrl, {
    headers: authHeaders({
      Accept: 'text/html,application/xhtml+xml',
    }),
  });

  if (!viewerResponse.ok) {
    throw new Error(`Novelpia viewer returned HTTP ${viewerResponse.status}`);
  }

  const viewerHtml = await viewerResponse.text();

  let number = '';
  let title = '';
  try {
    const { load } = require('cheerio');
    const $ = load(viewerHtml);
    number = $('.in-chapter-number').first().text().trim();
    title = $('.in-chapter-title').first().text().trim();
    if (!number && !title) {
      const fallback = $('.in-ch-txt').first().text().trim();
      if (fallback) title = fallback;
    }
  } catch (_) {
    // Chapter title is optional; content can still be returned.
  }

  let token = extractViewerToken(viewerHtml);

  // Fallback to the ticket endpoint used by the supplied Novelpia scraper.
  if (!token) {
    const ticket = await getJson(
      `${API}/v1/novel/episode?episode_no=${encodeURIComponent(episodeNo)}`,
    );
    token = extractTicket(ticket);
  }

  if (!token) {
    throw new Error(
      `Could not obtain a Novelpia chapter ticket for episode ${episodeNo}`,
    );
  }

  const content = await getJson(
    `${API}/v1/novel/episode/content?_t=${encodeURIComponent(token)}`,
  );

  const parts = contentFragments(content?.result?.data);
  if (!parts.length) {
    throw new Error(`Novelpia returned no epi_content for episode ${episodeNo}`);
  }

  const html = normalizeChapterHtml(parts.join(''), episodeNo);
  const headingText =
    [number, title].filter(Boolean).join(' - ') ||
    `Episode ${episodeNo}`;

  return `<h1>${escapeHtml(headingText)}</h1>${html}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseNovelLinks(html) {
  const { load } = require('cheerio');
  const $ = load(html);
  const novels = [];
  const seen = new Set();

  $('a[href*="/novel/"]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    if (!href) return;

    const match = href.match(/\/novel\/(\d+)/);
    if (!match) return;

    const path = `/novel/${match[1]}`;
    if (seen.has(path)) return;

    const title =
      a.find('.nv-tit').first().text().trim() ||
      a.attr('title')?.trim() ||
      a.text().trim();

    if (!title) return;

    seen.add(path);
    novels.push({
      name: title,
      path,
    });
  });

  return novels;
}

async function fetchNovelListing(url) {
  const response = await fetchApi(url, {
    headers: authHeaders({
      Accept: 'text/html,application/xhtml+xml',
    }),
  });
  if (!response.ok) throw new Error(`Novelpia listing HTTP ${response.status}`);
  return response.text();
}

class NovelpiaGlobalPlugin {
  id = 'novelpiaglobal';
  name = 'Novelpia Global';
  icon = 'src/en/novelpiaglobal/icon.png';
  site = SITE;
  version = '1.0.0';

  // User can paste the three values produced by the supplied Novelpia scraper
  // (.api.json). This is preferable to storing a Novelpia password in LNReader.
  pluginSettings = {
    loginAt: {
      value: '',
      label: 'LOGINAT session token',
      type: 'Text',
    },
    userKey: {
      value: '',
      label: 'USERKEY cookie',
      type: 'Text',
    },
    tKey: {
      value: '',
      label: 'TKEY cookie',
      type: 'Text',
    },
  };

  async popularNovels(pageNo, { showLatestNovels = true } = {}) {
    const page = Math.max(1, Number(pageNo) || 1);

    // The current site exposes its novel catalog at /novels. The parameters
    // below request the Premium/new-episode listing rather than a random page.
    const url =
      `${SITE}/novels?content_type=2&page=${page}` +
      `&sort_col=${showLatestNovels ? 'new_epi_open_dt' : 'favourite'}`;

    try {
      const html = await fetchNovelListing(url);
      return parseNovelLinks(html);
    } catch (_) {
      return [];
    }
  }

  async searchNovels(searchTerm, pageNo = 1) {
    const term = String(searchTerm || '').trim();
    if (!term) return [];

    const page = Math.max(1, Number(pageNo) || 1);
    const url =
      `${SITE}/search?search_type=title&search_val=${encodeURIComponent(term)}` +
      `&page=${page}`;

    try {
      const html = await fetchNovelListing(url);
      const results = parseNovelLinks(html);

      // Novelpia's search page is server-rendered, but filtering locally makes
      // the source tolerant of changes to the site's search query type.
      const needle = term.toLowerCase();
      return results.filter(item => item.name.toLowerCase().includes(needle));
    } catch (_) {
      return [];
    }
  }

  async parseNovel(novelPath) {
    const novelId = novelIdFromPath(novelPath);
    if (!novelId) throw new Error(`Invalid Novelpia novel path: ${novelPath}`);

    const payload = await getJson(
      `${API}/v1/novel?novel_no=${encodeURIComponent(novelId)}`,
    );

    const info = novelInfo(payload);
    const chapters = await fetchEpisodes(novelId);

    return {
      path: `/novel/${novelId}`,
      name: info.name,
      cover: info.cover,
      author: info.author,
      genres: info.genres,
      summary: info.summary,
      status: info.status,
      chapters,
    };
  }

  async parseChapter(chapterPath) {
    return fetchChapterHtml(chapterPath);
  }

  resolveUrl = (path, isNovel = false) =>
    `${SITE}${path.startsWith('/') ? '' : '/'}${path}`;

  imageRequestInit = {
    headers: {
      Referer: SITE + '/',
    },
  };
}

module.exports.default = new NovelpiaGlobalPlugin();
