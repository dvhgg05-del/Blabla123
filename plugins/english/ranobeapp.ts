import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { load as parseHTML } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { storage } from '@libs/storage';

// Ranobe (https://staging.ranobe.app) - a Next.js light novel library.
//
//  * Every page redirects to /auth unless a logged-in session cookie is sent,
//    so the plugin needs the "Cookie" setting.
//  * /                -> "Recently Released" cards            (Latest)
//  * /browse          -> the same cards, 856+ novels          (Popular, filters)
//  * /novel/<id>      -> details + one block per volume with a "Read" link
//  * /reader/<volume> -> an epub.js viewer; the text lives in an EPUB file that
//                        the browser downloads, so a volume is read by
//                        downloading that EPUB and extracting its text.
//
// Build notes: LNReader compiles plugins to ES5 without downlevelIteration, so
// never spread a Set/Map/iterator (it silently becomes []). HTML parsing uses
// only basic selector calls so it behaves the same in the app's HTML engine.

const SITE = 'https://staging.ranobe.app';
// Next's image optimiser only serves certain widths; 256 is one the site uses.
const COVER_WIDTH = 256;

// Limits when turning an EPUB into one chapter.
const MAX_INLINE_IMAGE_BYTES = 800 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;

type Cheerio$ = ReturnType<typeof parseHTML>;

/* ------------------------------------------------------------------ */
/* Requests                                                             */
/* ------------------------------------------------------------------ */

function setting(key: string): string {
  const value = storage.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function requestHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${SITE}/`,
  };
  const cookie = setting('cookie');
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function loginError(): Error {
  return new Error(
    'Ranobe wants you to sign in. Log in at staging.ranobe.app in a browser, ' +
      'copy the request "Cookie" header value (DevTools > Network > any request ' +
      'to the site) and paste it into this source\'s "Cookie" setting.',
  );
}

function looksLikeSignInPage(url: string | undefined, html: string): boolean {
  if (url && /\/auth(?:[/?#]|$)/.test(url)) return true;
  return /Enter your credentials to access your account/i.test(html);
}

async function getHtml(url: string): Promise<string> {
  const response = await fetchApi(url, {
    headers: requestHeaders('text/html,application/xhtml+xml'),
  });
  const html = await response.text();
  if (looksLikeSignInPage((response as any).url, html)) throw loginError();
  if (!response.ok) throw new Error(`Ranobe returned HTTP ${response.status}`);
  return html;
}

async function getBytes(url: string): Promise<Uint8Array> {
  const response = await fetchApi(url, {
    headers: requestHeaders(
      'application/epub+zip,application/octet-stream,*/*',
    ),
  });
  if (!response.ok) throw new Error(`Ranobe returned HTTP ${response.status}`);
  if (typeof (response as any).arrayBuffer !== 'function') {
    throw new Error(
      "This app's fetch cannot download binary files, so EPUB volumes cannot be read.",
    );
  }
  return new Uint8Array(await (response as any).arrayBuffer());
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

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
  return /^https?:\/\/staging\.ranobe\.app(?:[/?#]|$)/i.test(url);
}

// Site-relative path (without query/hash) for links on this site, else null.
function toPath(href?: string): string | null {
  const value = (href ?? '').trim().replace(/#.*$/, '');
  if (!value || /^(?:javascript|mailto|tel):/i.test(value)) return null;
  if (/^https?:\/\//i.test(value)) {
    if (!isOwnHost(value)) return null;
    return value.replace(/^https?:\/\/[^/]+/i, '').replace(/\?.*$/, '') || '/';
  }
  return (value.startsWith('/') ? value : `/${value}`).replace(/\?.*$/, '');
}

function novelIdOf(path: string): string {
  return path.match(/\/novel\/(\d+)/)?.[1] ?? '';
}

function readerIdOf(path: string): string {
  return path.match(/\/reader\/(\d+)/)?.[1] ?? '';
}

function coverUrl(src?: string): string {
  const url = normalizeUrl(src);
  if (!url) return defaultCover;
  // The grid asks for w=3840; ask for something phone-sized instead.
  return /\/_next\/image\?/.test(url)
    ? url.replace(/([?&])w=\d+/, `$1w=${COVER_WIDTH}`)
    : url;
}

// "2025/3" -> "2025-03-01"
function releaseDate(year?: string, month?: string): string | undefined {
  if (!year) return undefined;
  const mm = String(Number(month) || 1);
  return `${year}-${mm.length < 2 ? `0${mm}` : mm}-01`;
}

/* ------------------------------------------------------------------ */
/* Listing cards                                                        */
/* ------------------------------------------------------------------ */

function parseCards(html: string): Plugin.NovelItem[] {
  const $ = parseHTML(html);
  const items: Plugin.NovelItem[] = [];
  const seen: Record<string, boolean> = {};

  $('main a[href*="/novel/"]').each((_, anchor) => {
    const $a = $(anchor);
    const path = toPath($a.attr('href'));
    if (!path || !novelIdOf(path) || seen[path]) return;

    const image = $a.find('img').first();
    const name = cleanText(
      $a.find('h3').first().text() || image.attr('alt') || $a.attr('title'),
    );
    if (!name) return;

    seen[path] = true;
    items.push({ name, path, cover: coverUrl(image.attr('src')) });
  });
  return items;
}

// A listing that silently re-serves page 1 for a page that does not exist
// would make infinite scroll repeat forever; remember page 1's first item.
const firstPathOfPageOne: Record<string, string> = {};

async function fetchPagedCards(
  key: string,
  url: string,
  page: number,
): Promise<Plugin.NovelItem[]> {
  const items = parseCards(await getHtml(url));
  if (page <= 1) {
    if (items.length) firstPathOfPageOne[key] = items[0].path;
    return items;
  }
  const first = firstPathOfPageOne[key];
  if (first && items.length && items[0].path === first) return [];
  return items;
}

/* ------------------------------------------------------------------ */
/* Novel page                                                           */
/* ------------------------------------------------------------------ */

type Volume = { name: string; path: string; releaseTime?: string };

// Volume blocks: a small "Volume 1 • 2025/3" label, later a "Read" link.
// Walk both in document order so each link picks up the label before it.
function readVolumes($: Cheerio$): Volume[] {
  const volumes: Volume[] = [];
  const seen: Record<string, boolean> = {};
  let label = '';
  let date: string | undefined;

  $('main small, main a[href*="/reader/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');

    if (href === undefined) {
      const text = cleanText($el.text());
      const match = text.match(/^(.*?)\s*[•·]\s*(\d{4})\/(\d{1,2})/);
      if (match) {
        label = match[1];
        date = releaseDate(match[2], match[3]);
      } else if (/^(?:volume|vol\.?|book|part)\b/i.test(text)) {
        label = text;
        date = undefined;
      }
      return;
    }

    const path = toPath(href);
    if (!path || !readerIdOf(path) || seen[path]) return;
    seen[path] = true;
    volumes.push({
      name: label || `Volume ${volumes.length + 1}`,
      path,
      releaseTime: date,
    });
    label = '';
    date = undefined;
  });
  return volumes;
}

function numberOf(name: string): number | undefined {
  const match = name.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}

/* ------------------------------------------------------------------ */
/* EPUB reading: ZIP + DEFLATE + OPF spine                              */
/* ------------------------------------------------------------------ */

// --- DEFLATE (RFC 1951), in the style of zlib's "puff" ---
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

type Huffman = { count: number[]; symbol: number[] };

function buildHuffman(lengths: number[], n: number): Huffman {
  const count: number[] = [];
  for (let i = 0; i <= 15; i++) count.push(0);
  for (let i = 0; i < n; i++) count[lengths[i]]++;

  const offs: number[] = [0, 0];
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];

  const symbol: number[] = [];
  for (let i = 0; i < n; i++) symbol.push(0);
  for (let i = 0; i < n; i++) {
    if (lengths[i] !== 0) symbol[offs[lengths[i]]++] = i;
  }
  return { count, symbol };
}

let fixedLiteral: Huffman | null = null;
let fixedDistance: Huffman | null = null;

function fixedTables(): { literal: Huffman; distance: Huffman } {
  if (!fixedLiteral || !fixedDistance) {
    const lengths: number[] = [];
    for (let i = 0; i < 144; i++) lengths.push(8);
    for (let i = 144; i < 256; i++) lengths.push(9);
    for (let i = 256; i < 280; i++) lengths.push(7);
    for (let i = 280; i < 288; i++) lengths.push(8);
    fixedLiteral = buildHuffman(lengths, 288);
    const distances: number[] = [];
    for (let i = 0; i < 30; i++) distances.push(5);
    fixedDistance = buildHuffman(distances, 30);
  }
  return { literal: fixedLiteral, distance: fixedDistance };
}

function inflateRaw(src: Uint8Array, expectedSize: number): Uint8Array {
  let out = new Uint8Array(Math.max(expectedSize, 1024));
  let outPos = 0;
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  const ensure = (extra: number) => {
    if (outPos + extra <= out.length) return;
    let size = out.length * 2;
    while (size < outPos + extra) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(out.subarray(0, outPos));
    out = bigger;
  };

  const bits = (need: number): number => {
    let value = bitBuf;
    while (bitCnt < need) {
      if (pos >= src.length) throw new Error('EPUB data ended unexpectedly');
      value |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
    bitBuf = value >>> need;
    bitCnt -= need;
    return value & ((1 << need) - 1);
  };

  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('Corrupt EPUB (bad Huffman code)');
  };

  const codes = (literal: Huffman, distance: Huffman) => {
    for (;;) {
      let symbol = decode(literal);
      if (symbol < 256) {
        ensure(1);
        out[outPos++] = symbol;
      } else if (symbol === 256) {
        return;
      } else {
        symbol -= 257;
        if (symbol >= 29) throw new Error('Corrupt EPUB (bad length)');
        const len = LEN_BASE[symbol] + bits(LEN_EXTRA[symbol]);
        const dsym = decode(distance);
        if (dsym >= 30) throw new Error('Corrupt EPUB (bad distance)');
        const dist = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]);
        if (dist > outPos) throw new Error('Corrupt EPUB (distance too far)');
        ensure(len);
        for (let i = 0; i < len; i++) {
          out[outPos] = out[outPos - dist];
          outPos++;
        }
      }
    }
  };

  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);

    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new Error('EPUB data ended unexpectedly');
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      if (pos + len > src.length)
        throw new Error('EPUB data ended unexpectedly');
      ensure(len);
      out.set(src.subarray(pos, pos + len), outPos);
      outPos += len;
      pos += len;
    } else if (type === 1) {
      const tables = fixedTables();
      codes(tables.literal, tables.distance);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      const lengths: number[] = [];
      for (let i = 0; i < 19; i++) lengths.push(0);
      for (let i = 0; i < ncode; i++) lengths[CODE_LENGTH_ORDER[i]] = bits(3);
      const lencode = buildHuffman(lengths, 19);

      const all: number[] = [];
      while (all.length < nlen + ndist) {
        const symbol = decode(lencode);
        if (symbol < 16) {
          all.push(symbol);
        } else {
          let repeat = 0;
          let value = 0;
          if (symbol === 16) {
            if (!all.length) throw new Error('Corrupt EPUB (bad repeat)');
            value = all[all.length - 1];
            repeat = 3 + bits(2);
          } else if (symbol === 17) {
            repeat = 3 + bits(3);
          } else {
            repeat = 11 + bits(7);
          }
          for (let i = 0; i < repeat; i++) all.push(value);
        }
      }
      codes(
        buildHuffman(all.slice(0, nlen), nlen),
        buildHuffman(all.slice(nlen, nlen + ndist), ndist),
      );
    } else {
      throw new Error('Corrupt EPUB (bad block type)');
    }
  } while (!last);

  return out.subarray(0, outPos);
}

// --- ZIP ---
type ZipEntry = { method: number; size: number; data: Uint8Array };

function u16(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}
function u32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function utf8Decode(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let buffer: number[] = [];
  const flush = () => {
    chunks.push(String.fromCharCode.apply(null, buffer));
    buffer = [];
  };
  let i = 0;
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    i = 3;
  }
  while (i < bytes.length) {
    const b = bytes[i++];
    let cp = b;
    if (b >= 0xf0 && i + 2 < bytes.length + 0) {
      cp =
        ((b & 0x07) << 18) |
        ((bytes[i] & 0x3f) << 12) |
        ((bytes[i + 1] & 0x3f) << 6) |
        (bytes[i + 2] & 0x3f);
      i += 3;
    } else if (b >= 0xe0) {
      cp =
        ((b & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f);
      i += 2;
    } else if (b >= 0xc0) {
      cp = ((b & 0x1f) << 6) | (bytes[i] & 0x3f);
      i += 1;
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      buffer.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      buffer.push(cp);
    }
    if (buffer.length >= 4096) flush();
  }
  flush();
  return chunks.join('');
}

function readZip(zip: Uint8Array): Record<string, ZipEntry> {
  if (zip.length < 22 || zip[0] !== 0x50 || zip[1] !== 0x4b) {
    throw new Error(
      'The downloaded file is not an EPUB (not a ZIP). The site may have sent a sign-in page instead.',
    );
  }
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Corrupt EPUB (no ZIP directory)');

  const total = u16(zip, eocd + 10);
  let cursor = u32(zip, eocd + 16);
  const entries: Record<string, ZipEntry> = {};

  for (let n = 0; n < total; n++) {
    if (u32(zip, cursor) !== 0x02014b50) break;
    const method = u16(zip, cursor + 10);
    const compressed = u32(zip, cursor + 20);
    const size = u32(zip, cursor + 24);
    const nameLen = u16(zip, cursor + 28);
    const extraLen = u16(zip, cursor + 30);
    const commentLen = u16(zip, cursor + 32);
    const local = u32(zip, cursor + 42);
    const name = utf8Decode(zip.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    const dataStart = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    entries[name] = {
      method,
      size,
      data: zip.subarray(dataStart, dataStart + compressed),
    };
  }
  return entries;
}

function unzipEntry(entry: ZipEntry): Uint8Array {
  if (entry.method === 0) return entry.data;
  if (entry.method === 8) return inflateRaw(entry.data, entry.size);
  throw new Error(`Unsupported EPUB compression (method ${entry.method})`);
}

function base64(bytes: Uint8Array): string {
  const table =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    chunk +=
      table[a >> 2] +
      table[((a & 3) << 4) | (b >> 4)] +
      (i + 1 < bytes.length ? table[((b & 15) << 2) | (c >> 6)] : '=') +
      (i + 2 < bytes.length ? table[c & 63] : '=');
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

// --- OPF / spine ---
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(tag);
  while (match) {
    out[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
    match = pattern.exec(tag);
  }
  return out;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

function resolveInZip(base: string, href: string): string {
  const raw = href.replace(/[?#].*$/, '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_error) {
    decoded = raw;
  }
  const parts = (decoded.startsWith('/') ? decoded : base + decoded).split('/');
  const stack: string[] = [];
  parts.forEach(part => {
    if (part === '..') stack.pop();
    else if (part && part !== '.') stack.push(part);
  });
  return stack.join('/');
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function epubToHtml(zipBytes: Uint8Array): string {
  const files = readZip(zipBytes);
  const read = (name: string): Uint8Array | null =>
    files[name] ? unzipEntry(files[name]) : null;

  const containerBytes = read('META-INF/container.xml');
  if (!containerBytes) throw new Error('Corrupt EPUB (no container.xml)');
  const opfPath = utf8Decode(containerBytes).match(
    /full-path\s*=\s*["']([^"']+)["']/,
  )?.[1];
  const opfBytes = opfPath ? read(opfPath) : null;
  if (!opfPath || !opfBytes) throw new Error('Corrupt EPUB (no package file)');

  const opf = utf8Decode(opfBytes);
  const base = dirOf(opfPath);

  const manifest: Record<
    string,
    { href: string; type: string; props: string }
  > = {};
  (opf.match(/<item\b[^>]*>/gi) ?? []).forEach(tag => {
    const a = attrsOf(tag);
    if (a.id && a.href) {
      manifest[a.id] = {
        href: resolveInZip(base, a.href),
        type: (a['media-type'] ?? '').toLowerCase(),
        props: a.properties ?? '',
      };
    }
  });

  const spine: string[] = [];
  (opf.match(/<itemref\b[^>]*>/gi) ?? []).forEach(tag => {
    const a = attrsOf(tag);
    if (a.idref && manifest[a.idref]) spine.push(a.idref);
  });
  if (!spine.length) throw new Error('Corrupt EPUB (empty reading order)');

  let imageBudget = MAX_TOTAL_IMAGE_BYTES;
  const sections: string[] = [];

  spine.forEach(id => {
    const item = manifest[id];
    if (!/html|xml/.test(item.type) || /\bnav\b/.test(item.props)) return;
    const bytes = read(item.href);
    if (!bytes) return;

    const $ = parseHTML(utf8Decode(bytes));
    $('script, style, link, title').remove();

    $('img').each((_, el) => {
      const $img = $(el);
      const src = $img.attr('src');
      let embedded = '';
      if (src && !/^data:/i.test(src)) {
        const name = resolveInZip(dirOf(item.href), src);
        const entry = files[name];
        if (
          entry &&
          entry.size <= MAX_INLINE_IMAGE_BYTES &&
          entry.size <= imageBudget
        ) {
          const ext = (name.split('.').pop() ?? '').toLowerCase();
          const type = IMAGE_TYPES[ext];
          const data = type ? read(name) : null;
          if (data && type) {
            imageBudget -= data.length;
            embedded = `data:${type};base64,${base64(data)}`;
          }
        }
      } else if (src) {
        embedded = src;
      }
      if (embedded) {
        $img.attr('src', embedded);
        ['srcset', 'class', 'style', 'width', 'height', 'id'].forEach(attr => {
          $img.removeAttr(attr);
        });
      } else {
        $img.remove();
      }
    });
    $('svg, image').remove();

    const html = ($('body').html() ?? '').trim();
    if (html) sections.push(html);
  });

  if (!sections.length) throw new Error('This EPUB has no readable text');
  return sections.join('\n');
}

// Where is this volume's EPUB? The "EPUB URL" setting wins (use {id} for the
// reader id); otherwise look for an .epub link inside the reader page's HTML.
function findEpubUrl(readerHtml: string): string {
  // Next.js embeds data as JSON inside JS strings, so slashes and ampersands
  // can arrive escaped once or twice (\/, \\/, \u0026, \\u0026).
  const unescaped = readerHtml
    .replace(/\\+u0026/gi, '&')
    .replace(/\\+\//g, '/')
    .replace(/&amp;/g, '&');
  const found = unescaped.match(
    /(?:https?:\/\/[^"'\s<>\\]+|\/[A-Za-z0-9_\-./%~+]+)\.epub(?:\?[^"'\s<>\\]*)?/i,
  );
  return found ? found[0] : '';
}

function stripTemplate(template: string, id: string): string {
  return template.replace(/\{id\}/g, id);
}

/* ------------------------------------------------------------------ */

class RanobeApp implements Plugin.PluginBase {
  id = 'ranobeapp';
  name = 'Ranobe';
  icon = 'src/en/ranobeapp/icon.png';
  site = SITE;
  version = '1.0.0';

  pluginSettings = {
    cookie: {
      value: '',
      label: 'Cookie header (required: copy it from a logged-in browser)',
      type: 'Text',
    },
    epubUrl: {
      value: '',
      label: 'EPUB URL template, use {id} for the reader id (optional)',
      type: 'Text',
    },
  };

  filters = {
    genre: {
      type: FilterTypes.TextInput,
      label: 'Genre (e.g. fantasy)',
      value: '',
    },
    tag: {
      type: FilterTypes.TextInput,
      label: 'Tag (e.g. isekai)',
      value: '',
    },
    status: {
      type: FilterTypes.TextInput,
      label: 'Status (e.g. ongoing)',
      value: '',
    },
  } satisfies Filters;

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, Number(pageNo) || 1);

    // "Recently Released" on the home page is a single list.
    if (showLatestNovels) {
      return page > 1 ? [] : parseCards(await getHtml(`${SITE}/`));
    }

    const query: string[] = [];
    const add = (key: string, value: unknown) => {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text) query.push(`${key}=${encodeURIComponent(text.toLowerCase())}`);
    };
    add('genres', filters?.genre?.value);
    add('tags', filters?.tag?.value);
    add('status', filters?.status?.value);
    if (page > 1) query.push(`page=${page}`);

    const url = `${SITE}/browse${query.length ? `?${query.join('&')}` : ''}`;
    const key = `browse:${query.filter(q => !/^page=/.test(q)).join('&')}`;
    return fetchPagedCards(key, url, page);
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (Number(pageNo) > 1) return [];
    const words = searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    // The site's search box is script-driven and its URL is not visible, so
    // try the usual parameter names and keep only titles that really match.
    const encoded = encodeURIComponent(searchTerm.trim());
    const candidates = [
      `${SITE}/browse?q=${encoded}`,
      `${SITE}/browse?search=${encoded}`,
      `${SITE}/browse?query=${encoded}`,
    ];

    let lastError: unknown;
    for (const url of candidates) {
      try {
        const hits = parseCards(await getHtml(url)).filter(item => {
          const title = item.name.toLowerCase();
          return words.every(word => title.indexOf(word) !== -1);
        });
        if (hits.length) return hits;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof Error && /sign in/i.test(lastError.message)) {
      throw lastError;
    }
    return [];
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const path = toPath(novelPath) ?? novelPath;
    const id = novelIdOf(path);
    if (!id) throw new Error(`Invalid Ranobe novel path: ${novelPath}`);

    const $ = parseHTML(await getHtml(this.resolveUrl(path)));

    const name = cleanText($('main h1').first().text()) || `Novel ${id}`;
    const byline = cleanText($('main div.font-display span').first().text());
    const author = byline.split(' - ')[0].trim();

    const paragraphs: string[] = [];
    $('main div.prose-sm p').each((_, p) => {
      const text = cleanText($(p).text());
      if (text) paragraphs.push(text);
    });

    const status = cleanText(
      $('main a[href*="browse?status="]').first().text(),
    );
    const labels: string[] = [];
    $('main a[href*="browse?genres="], main a[href*="browse?tags="]').each(
      (_, a) => {
        const text = cleanText($(a).text());
        if (text && labels.indexOf(text) === -1) labels.push(text);
      },
    );

    const volumes = readVolumes($);
    const numbered = volumes.every(v => numberOf(v.name) !== undefined);
    const chapters: Plugin.ChapterItem[] = volumes.map((volume, index) => ({
      name: volume.name,
      path: volume.path,
      chapterNumber: numbered ? (numberOf(volume.name) as number) : index + 1,
      ...(volume.releaseTime ? { releaseTime: volume.releaseTime } : {}),
    }));
    if (numbered)
      chapters.sort((x, y) => (x.chapterNumber ?? 0) - (y.chapterNumber ?? 0));

    return {
      path,
      name,
      cover: coverUrl($('main img[alt^="Cover for"]').first().attr('src')),
      author: author || undefined,
      summary: paragraphs.join('\n\n'),
      genres: labels.join(','),
      status: /^(?:completed?|finished)$/i.test(status)
        ? NovelStatus.Completed
        : /^ongoing$/i.test(status)
          ? NovelStatus.Ongoing
          : NovelStatus.Unknown,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const path = toPath(chapterPath) ?? chapterPath;
    const id = readerIdOf(path);
    if (!id) throw new Error(`Invalid Ranobe reader path: ${chapterPath}`);

    const template = setting('epubUrl');
    let epubUrl = template ? stripTemplate(template, id) : '';
    let pageHint = '';

    if (!epubUrl) {
      const readerHtml = await getHtml(this.resolveUrl(path));
      epubUrl = findEpubUrl(readerHtml);
      pageHint = `${readerHtml.length} bytes of reader HTML`;
    }
    if (!epubUrl) {
      throw new Error(
        `Could not find this volume's EPUB download (${pageHint}). In a browser, ` +
          `open ${SITE}${path}, then DevTools > Network, filter by "epub", copy the ` +
          'file URL and paste it into the "EPUB URL template" setting, replacing ' +
          `${id} with {id}.`,
      );
    }

    const html = epubToHtml(await getBytes(normalizeUrl(epubUrl) ?? epubUrl));
    return html;
  }

  resolveUrl = (path: string) =>
    /^https?:\/\//i.test(path)
      ? path
      : `${SITE}${path.startsWith('/') ? '' : '/'}${path}`;

  // Read once at start-up, like other plugins that use settings in fields.
  imageRequestInit: Plugin.ImageRequestInit = {
    headers: {
      Referer: `${SITE}/`,
      ...(setting('cookie') ? { Cookie: setting('cookie') } : {}),
    },
  };
}

export default new RanobeApp();
