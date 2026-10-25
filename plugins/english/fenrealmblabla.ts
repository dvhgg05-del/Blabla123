import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as loadCheerio } from 'cheerio';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { storage } from '@libs/storage';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

// Fenrir Realm (Blabla build)
//
//   Site       : https://fenrirealm.com  (SvelteKit SPA, nothing is server-rendered)
//   Novel list : /api/new/v2/series?page=..          (JSON)
//   Novel info : /api/new/v2/series/<slug>           (JSON)
//   Chapters   : /api/new/v2/series/<slug>/chapters  (JSON)
//   Chapter    : /api/new/v2/chapters/<id>           (JSON, `content` field)
//   Web URL    : /series/<slug>/<number>             (or /series/<slug>/<vol-x>/<number>)
//
// What changed on the site (Oct 2026): the chapter endpoint no longer hands out
// text right away. Until the page's own script has "verified access" it answers
// with the placeholder "Verifying access…". The old plugin returned that
// placeholder as if it were the chapter, which is what the reader showed.
//
// What this plugin does about it:
//   1. Never treats the placeholder as chapter text. It is detected and, after a
//      couple of polite retries, turned into an actionable error message.
//   2. Makes the request look like what a reader's browser does first: it visits
//      the chapter page once (Referer + same cookie jar), waits a moment and asks
//      again. If the check is only a short server-side warm-up, this is enough.
//   3. If the check needs the site's JavaScript, the only thing that can finish
//      it is a real browser. Open the chapter in the app's WebView once; the
//      cookies it receives are shared with the plugin's requests.
//   4. Cleans the delivered text: decoy blocks, zero-width tracking characters,
//      hidden "trail" links (honeypots that flag scrapers) and attribution lines.
//      Hidden links are never requested.
//
// Build note: LNReader compiles plugins to ES5 without downlevelIteration, so
// never spread a Set/Map/iterator in this file (it silently becomes []).

const SITE = 'https://fenrirealm.com';
const API = SITE + '/api/new/v2';

// Zero-width / invisible characters used to fingerprint a reader's copy.
const INVISIBLE_RE = /[\u200B-\u200D\u2060-\u2064\uFEFF\u00AD\u180E]/g;

// Placeholder texts the site serves instead of a chapter.
const GATE_RE = /verifying access|checking your browser|just a moment/i;
const LOCKED_RE = /chapter content is locked|content is locked or unavailable/i;

// Anything that looks like an actual HTML tag.
const HTML_TAG_RE =
  /<\/?(?:p|div|span|br|b|i|u|s|em|strong|a|h[1-6]|ul|ol|li|blockquote|hr|img|pre|section|article|center|font|small|sup|sub)\b[^>]*>/i;

// Inline styles that hide an element from a human reader.
const HIDDEN_STYLE_RE =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?![.\d])|clip\s*:\s*rect|clip-path\s*:\s*inset|width\s*:\s*1px/i;

// Waits (ms) before each retry when the verification placeholder is returned.
const GATE_RETRY_DELAYS = [2500, 4000];

type APINovel = {
  title: string;
  slug: string;
  cover?: string;
  description?: string;
  status?: string;
  genres?: { name: string }[];
  user?: {
    username?: string;
    name?: string;
  };
};

type APIChapter = {
  id: number;
  locked?: { price: number } | null;
  group?: null | {
    index: number;
    slug: string;
  };
  title?: string;
  slug?: string;
  number: number;
  created_at?: string;
};

type TipTapMark = { type: string; attrs?: { href?: string } };
type TipTapNode = {
  type: string;
  text?: string;
  marks?: TipTapMark[];
  attrs?: { level?: number; src?: string; alt?: string; href?: string };
  content?: TipTapNode[];
};

type ApiAttempt = {
  html?: string;
  gated?: boolean;
  locked?: boolean;
};

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const stripInvisible = (s: string) => s.replace(INVISIBLE_RE, '');

const toHtmlText = (s: string) =>
  stripInvisible(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Renders a TipTap/ProseMirror JSON tree to simple HTML. */
function renderNode(node: TipTapNode): string {
  if (!node) return '';
  const children = (node.content || []).map(renderNode).join('');

  switch (node.type) {
    case 'text': {
      let text = escapeHtml(stripInvisible(node.text || ''));
      const marks = node.marks || [];
      for (let i = 0; i < marks.length; i++) {
        const mark = marks[i];
        if (mark.type === 'bold') text = `<b>${text}</b>`;
        else if (mark.type === 'italic') text = `<i>${text}</i>`;
        else if (mark.type === 'underline') text = `<u>${text}</u>`;
        else if (mark.type === 'strike') text = `<s>${text}</s>`;
        else if (mark.type === 'link' && mark.attrs && mark.attrs.href)
          text = `<a href="${escapeHtml(mark.attrs.href)}">${text}</a>`;
      }
      return text;
    }
    case 'hardBreak':
      return '<br>';
    case 'horizontalRule':
      return '<hr>';
    case 'paragraph':
      return children.trim() ? `<p>${children}</p>` : '';
    case 'heading': {
      const level = Math.min(
        Math.max((node.attrs && node.attrs.level) || 2, 1),
        6,
      );
      return `<h${level}>${children}</h${level}>`;
    }
    case 'blockquote':
      return `<blockquote>${children}</blockquote>`;
    case 'bulletList':
      return `<ul>${children}</ul>`;
    case 'orderedList':
      return `<ol>${children}</ol>`;
    case 'listItem':
      return `<li>${children}</li>`;
    case 'codeBlock':
      return `<pre>${children}</pre>`;
    case 'image':
      return node.attrs && node.attrs.src
        ? `<img src="${escapeHtml(node.attrs.src)}" alt="${escapeHtml(
            node.attrs.alt || '',
          )}">`
        : '';
    case 'doc':
      return children;
    default:
      // systemWindow and any other custom node: keep the text, drop the wrapper.
      return node.content && node.content.length
        ? `<div>${children}</div>`
        : '';
  }
}

/**
 * Cleans chapter HTML as delivered by Fenrir Realm and returns the readable
 * paragraphs only.
 */
function cleanChapterHtml(html: string): string {
  const $ = loadCheerio(html);

  // Scripts, widgets and anything that is never story text.
  $(
    'script, style, noscript, iframe, template, svg, button, form, input',
  ).remove();

  // Decoy blocks (random character soup) are marked aria-hidden.
  $('[aria-hidden="true"], [hidden]').remove();

  // Hidden "trail" anchors are honeypots for scrapers. Drop them, never follow.
  $('a[href*="/chapters/trail/"], a[data-noprefetch]').remove();

  // Attribution / copy-reference widgets.
  $('.reader-attribution, [data-fr-attr]').remove();

  // Anything else hidden through inline CSS.
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    if (HIDDEN_STYLE_RE.test(style)) $(el).remove();
  });

  // Prefer the reader container when present.
  const readerArea = $('.reader-area, [id^="reader-area"]').first();
  const root = readerArea.length ? readerArea : $('body').first();

  // Drop empty paragraphs and watermark lines.
  root.find('p, div, span, small').each((_, el) => {
    const text = toHtmlText($(el).text());
    if (
      /^(copy reference|bookmark)\s*:/i.test(text) &&
      $(el).find('p').length === 0
    ) {
      $(el).remove();
    }
  });
  root.find('p').each((_, el) => {
    if (!toHtmlText($(el).text()) && $(el).find('img').length === 0) {
      $(el).remove();
    }
  });
  root.find('[tabindex]').removeAttr('tabindex');

  return stripInvisible(root.html() || '').trim();
}

/** Turns the `content` value of the chapter API into clean HTML. */
function contentToHtml(content: unknown): string {
  if (content === null || content === undefined) return '';

  if (typeof content === 'object') {
    return renderNode(content as TipTapNode).trim();
  }

  const raw = String(content);
  const trimmed = raw.trim();
  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(renderNode).join('').trim();
      }
      if (parsed && typeof parsed === 'object') {
        return renderNode(parsed as TipTapNode).trim();
      }
    } catch {
      // not JSON after all, treat it as HTML below
    }
  }

  // Plain text with no real markup (a stray "<" in dialogue is not a tag).
  if (!HTML_TAG_RE.test(trimmed)) {
    return trimmed
      .split(/\n{1,}/)
      .map(line => stripInvisible(line).trim())
      .filter(Boolean)
      .map(line => `<p>${escapeHtml(line)}</p>`)
      .join('\n');
  }

  return cleanChapterHtml(raw);
}

class FenrealmBlablaPlugin implements Plugin.PluginBase {
  id = 'fenrealmblabla';
  name = 'Fenrir Realm (Blabla)';
  icon = 'src/en/fenrealmblabla/icon.png';
  site = SITE;
  version = '1.0.0';
  imageRequestInit?: Plugin.ImageRequestInit | undefined = undefined;

  hideLocked = storage.get('hideLocked');
  pluginSettings = {
    hideLocked: {
      value: '',
      label: 'Hide locked chapters',
      type: 'Switch',
    },
  };

  // This plugin does not read localStorage / sessionStorage.
  webStorageUtilized?: boolean;

  private fullUrl(path?: string | null): string {
    if (!path) return defaultCover;
    if (/^https?:\/\//i.test(path)) return path;
    return this.site + '/' + path.replace(/^\/+/, '');
  }

  private mapStatus(status?: string): string {
    switch ((status || '').toLowerCase().replace(/[\s_]/g, '-')) {
      case 'on-going':
      case 'ongoing':
        return NovelStatus.Ongoing;
      case 'completed':
        return NovelStatus.Completed;
      case 'hiatus':
      case 'on-hold':
        return NovelStatus.OnHiatus;
      case 'dropped':
        return NovelStatus.Cancelled;
      default:
        return NovelStatus.Unknown;
    }
  }

  private async getJson(url: string) {
    const res = await fetchApi(url, {
      headers: { Accept: 'application/json', Referer: this.site + '/' },
    });
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, json: JSON.parse(text) };
    } catch {
      return { ok: res.ok, status: res.status, json: undefined };
    }
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({
      page: pageNo.toString(),
      per_page: '20',
      sort: showLatestNovels ? 'latest' : filters.sort.value,
    });
    if (filters.status.value) {
      params.append('statuses[]', filters.status.value);
    }
    filters.genres.value.forEach(g => params.append('genres[]', g));

    const res = await this.getJson(`${API}/series?${params.toString()}`);
    if (!res.json) {
      throw new Error(
        'Fenrir Realm did not return novel data. Please open the site in WebView and try again.',
      );
    }
    return (res.json.data || []).map((r: APINovel) =>
      this.parseNovelFromApi(r),
    );
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    let slug = novelPath.split('/')[0];
    let chaptersRes = await this.getJson(`${API}/series/${slug}/chapters`);

    // The slug may carry an old numeric prefix ("123-name") or have changed.
    if (!chaptersRes.ok || !chaptersRes.json) {
      const stripped = slug.replace(/^\d+-/, '');
      if (stripped !== slug) {
        slug = stripped;
        chaptersRes = await this.getJson(`${API}/series/${slug}/chapters`);
      }
    }
    if (!chaptersRes.ok || !chaptersRes.json) {
      const words = slug.replace(/-/g, ' ').split(' ');
      const term = words.filter(w => w.length > 3)[0] || words[0];
      const search = await this.getJson(
        `${this.site}/api/series/filter?page=1&per_page=20&search=${encodeURIComponent(term)}`,
      );
      const hit = search.json && search.json.data && search.json.data[0];
      if (hit && hit.slug) {
        slug = hit.slug;
        chaptersRes = await this.getJson(`${API}/series/${slug}/chapters`);
      }
    }
    if (!chaptersRes.ok || !chaptersRes.json) {
      throw new Error(
        'Novel not found. It may have been removed or its URL changed.',
      );
    }

    const seriesRes = await this.getJson(`${API}/series/${slug}`);
    const seriesData: APINovel = seriesRes.json || ({} as APINovel);
    const summaryCheerio = loadCheerio(seriesData.description || '');
    const paragraphs = summaryCheerio('p')
      .map((_, el) => summaryCheerio(el).text())
      .get();

    const novel: Plugin.SourceNovel = {
      path: slug,
      name: seriesData.title || slug,
      summary: paragraphs.length
        ? paragraphs.join('\n\n')
        : summaryCheerio.text() || '',
      author:
        (seriesData.user &&
          (seriesData.user.name || seriesData.user.username)) ||
        '',
      cover: this.fullUrl(seriesData.cover),
      genres: (seriesData.genres || []).map(g => g.name).join(','),
      status: this.mapStatus(seriesData.status),
    };

    let list: APIChapter[] = Array.isArray(chaptersRes.json)
      ? chaptersRes.json
      : chaptersRes.json.data || [];

    if (this.hideLocked) {
      list = list.filter(c => !(c.locked && c.locked.price));
    }

    novel.chapters = list
      .map(c => {
        const group = c.group && c.group.slug ? c.group : null;
        const title = (c.title || '')
          .trim()
          .replace(/^chapter\s*\d+(?:\.\d+)?\s*(?:[-:–—.]\s*|$)/i, '')
          .trim();
        return {
          name:
            (c.locked && c.locked.price ? '🔒 ' : '') +
            (group ? 'Vol ' + group.index + ' ' : '') +
            'Chapter ' +
            c.number +
            (title ? ' - ' + title : ''),
          // Matches the website URL: /series/<slug>[/<group>]/<number>
          path:
            slug +
            (group ? '/' + group.slug : '') +
            '/' +
            c.number +
            '~~' +
            c.id,
          releaseTime: c.created_at,
          chapterNumber: c.number + ((group && group.index) || 0) * 10000,
        };
      })
      .sort((a, b) => a.chapterNumber - b.chapterNumber);

    return novel;
  }

  /** Asks the chapter endpoint once and classifies the answer. */
  private async tryChapterApi(
    id: string,
    pageUrl: string,
  ): Promise<ApiAttempt> {
    const res = await fetchApi(`${API}/chapters/${id}`, {
      headers: { Accept: 'application/json', Referer: pageUrl },
    });
    const text = await res.text();

    let json:
      | { content?: unknown; data?: { content?: unknown }; locked?: unknown }
      | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: an HTML challenge page, or the placeholder itself.
      return { gated: true };
    }
    if (!json) return { gated: true };

    const content =
      json.content !== undefined
        ? json.content
        : json.data
          ? json.data.content
          : undefined;

    if (content === undefined || content === null || content === '') {
      return json.locked ? { locked: true } : { gated: true };
    }

    const html = contentToHtml(content);
    const visibleText = toHtmlText(html);

    if (LOCKED_RE.test(visibleText) && visibleText.length < 200) {
      return { locked: true };
    }
    if (
      !visibleText ||
      (GATE_RE.test(visibleText) && visibleText.length < 200)
    ) {
      return { gated: true };
    }
    return { html };
  }

  /** Finds a chapter id from "<slug>[/<group>]/<number>" using the chapter list. */
  private async lookupChapterId(pagePath: string): Promise<string | undefined> {
    const parts = pagePath.split('/');
    const slug = parts[0];
    const number = parts[parts.length - 1];
    const group = parts.length > 2 ? parts[1] : null;
    const res = await this.getJson(`${API}/series/${slug}/chapters`);
    const list: APIChapter[] = Array.isArray(res.json)
      ? res.json
      : (res.json && res.json.data) || [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const sameGroup = group
        ? !!(c.group && c.group.slug === group)
        : !(c.group && c.group.slug);
      if (String(c.number) === number && sameGroup) return String(c.id);
    }
    return undefined;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const pagePath = chapterPath.split('~~')[0];
    const pageUrl = `${this.site}/series/${pagePath}`;
    let id: string | undefined = chapterPath.split('~~')[1];
    if (!id) id = await this.lookupChapterId(pagePath);

    let attempt: ApiAttempt = {};

    if (id) {
      attempt = await this.tryChapterApi(id, pageUrl);
      if (attempt.html) return attempt.html;
      if (attempt.locked) {
        throw new Error(
          'This chapter is locked (paid or login only) on Fenrir Realm.',
        );
      }
    }

    // Gate answered: visit the chapter page like a browser would (this also
    // lets the site hand out its session cookie), then ask again.
    try {
      const pageRes = await fetchApi(pageUrl, {
        headers: { Accept: 'text/html', Referer: this.site + '/' },
      });
      const pageHtml = await pageRes.text();
      // If the page itself already contains the story, use it.
      if (/class="[^"]*reader-area/.test(pageHtml)) {
        const fromPage = cleanChapterHtml(pageHtml);
        const visible = toHtmlText(fromPage);
        if (visible && !(GATE_RE.test(visible) && visible.length < 200)) {
          return fromPage;
        }
      }
    } catch {
      // network hiccup on the warm-up request: just continue with the retries
    }

    if (id) {
      for (let i = 0; i < GATE_RETRY_DELAYS.length; i++) {
        await sleep(GATE_RETRY_DELAYS[i]);
        attempt = await this.tryChapterApi(id, pageUrl);
        if (attempt.html) return attempt.html;
        if (attempt.locked) {
          throw new Error(
            'This chapter is locked (paid or login only) on Fenrir Realm.',
          );
        }
      }
    }

    throw new Error(
      'Fenrir Realm is showing its "Verifying access…" check instead of the ' +
        "chapter. Open this chapter once in the app's WebView (globe icon), " +
        'wait until the text appears, then come back and retry.',
    );
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const build = (term: string) =>
      `${this.site}/api/series/filter?page=${pageNo}&per_page=20&search=${encodeURIComponent(term)}`;

    let res = await this.getJson(build(searchTerm));

    if (pageNo === 1 && !(res.json && res.json.data && res.json.data.length)) {
      const words = searchTerm.split(' ');
      const fallbackTerm = words.filter(w => w.length > 3)[0] || words[0];
      if (fallbackTerm && fallbackTerm !== searchTerm) {
        res = await this.getJson(build(fallbackTerm));
      }
    }

    return ((res.json && res.json.data) || []).map((novel: APINovel) =>
      this.parseNovelFromApi(novel),
    );
  }

  parseNovelFromApi(apiData: APINovel): Plugin.NovelItem {
    return {
      name: apiData.title,
      path: apiData.slug,
      cover: this.fullUrl(apiData.cover),
    };
  }

  resolveUrl(path: string): string {
    // Works for novels ("<slug>") and chapters ("<slug>[/<group>]/<n>~~<id>").
    return `${this.site}/series/${path.split('~~')[0]}`;
  }

  filters = {
    status: {
      type: FilterTypes.Picker,
      label: 'Status',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Ongoing', value: 'on-going' },
        { label: 'Completed', value: 'completed' },
        { label: 'Hiatus', value: 'hiatus' },
        { label: 'On Hold', value: 'on-hold' },
        { label: 'Dropped', value: 'dropped' },
      ],
    },
    sort: {
      type: FilterTypes.Picker,
      label: 'Sort',
      value: 'popular',
      options: [
        { label: 'Popular', value: 'popular' },
        { label: 'Latest', value: 'latest' },
        { label: 'Updated', value: 'updated' },
      ],
    },
    genres: {
      type: FilterTypes.CheckboxGroup,
      label: 'Genres',
      value: [],
      options: [
        { label: 'Action', value: '1' },
        { label: 'Adult', value: '2' },
        { label: 'Adventure', value: '3' },
        { label: 'Comedy', value: '4' },
        { label: 'Drama', value: '5' },
        { label: 'Ecchi', value: '6' },
        { label: 'Fantasy', value: '7' },
        { label: 'Gender Bender', value: '8' },
        { label: 'Harem', value: '9' },
        { label: 'Historical', value: '10' },
        { label: 'Horror', value: '11' },
        { label: 'Josei', value: '12' },
        { label: 'Martial Arts', value: '13' },
        { label: 'Mature', value: '14' },
        { label: 'Mecha', value: '15' },
        { label: 'Mystery', value: '16' },
        { label: 'Psychological', value: '17' },
        { label: 'Romance', value: '18' },
        { label: 'School Life', value: '19' },
        { label: 'Sci-fi', value: '20' },
        { label: 'Seinen', value: '21' },
        { label: 'Shoujo', value: '22' },
        { label: 'Shoujo Ai', value: '23' },
        { label: 'Shounen', value: '24' },
        { label: 'Shounen Ai', value: '25' },
        { label: 'Slice of Life', value: '26' },
        { label: 'Smut', value: '27' },
        { label: 'Sports', value: '28' },
        { label: 'Supernatural', value: '29' },
        { label: 'Tragedy', value: '30' },
        { label: 'Wuxia', value: '31' },
        { label: 'Xianxia', value: '32' },
        { label: 'Xuanhuan', value: '33' },
        { label: 'Yaoi', value: '34' },
        { label: 'Yuri', value: '35' },
      ],
    },
  } satisfies Filters;
}

export default new FenrealmBlablaPlugin();
