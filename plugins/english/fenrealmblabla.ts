import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as loadCheerio } from 'cheerio';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { storage } from '@libs/storage';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

// Fenrir Realm (Blabla build)  -  v1.1.0
//
//   Site       : https://fenrirealm.com  (SvelteKit SPA)
//   Novel list : /api/new/v2/series?page=..          (JSON)
//   Novel info : /api/new/v2/series/<slug>           (JSON)
//   Chapters   : /api/new/v2/series/<slug>/chapters  (JSON)
//   Chapter    : /api/new/v2/chapters/<id>           (JSON, usually ENCRYPTED)
//   Read token : /api/read-token                     (GET / POST)
//   Web URL    : /series/<slug>[/<volume-slug>]/<chapter-slug>   e.g. .../chapter-110
//
// What was wrong in 1.0.0 (and what this version does):
//   1. Chapter text. The site no longer returns readable text. It returns
//      `content_format: "encrypted"` (or "locked" until a read token exists).
//      To read it the app must (a) ask /api/read-token for a token, (b) send the
//      token back as the `fr_read` cookie plus the header
//      `X-Accepts-Encrypted-Content: 3`, and (c) decrypt the answer with
//      AES-GCM using a key derived from that token. 1.0.0 did none of this, so
//      an empty/locked answer was misreported as "chapter is locked (paid)".
//      A chapter is now only called "paid" when the API says it has a price.
//   2. Web links. Chapter URLs on the site use the chapter slug
//      ("chapter-110"), not the bare number ("110"). 1.0.0 built ".../110",
//      which is a 404 page. Paths are now  <slug>[/<volume>]/<chapter-slug>~~<id>
//      and resolveUrl() also repairs old library entries that still end in a
//      bare number.
//   3. Chapter text is still cleaned (decoy blocks, zero-width fingerprints,
//      hidden honeypot links, attribution lines). Hidden links are never requested.
//
// Build note: LNReader compiles plugins to ES5 without downlevelIteration, so
// never spread a Set/Map/iterator in this file (it silently becomes []).

const SITE = 'https://fenrirealm.com';
const API = SITE + '/api/new/v2';

const CONTENT_SALT_V1 = 'fr-content-v1';
const FRAG_SALT_V1 = 'fr-frag-v1';
const CONTENT_SALT_V2 = 'fr-content-v2';
const FRAG_SALT_V2 = 'fr-frag-v2';
const AES_GCM_IV_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;

const PLUGIN_VERSION = '1.1.2';

/* ---- self-contained replacements for TextEncoder / TextDecoder / atob ---- */
/* (the Android plugin host is not a browser and may not provide them)       */

function utf8Encode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000)
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b >= 0xc0 && b < 0xe0) cp = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b >= 0xe0 && b < 0xf0) {
      cp = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    } else if (b >= 0xf0) {
      cp =
        ((b & 7) << 18) |
        ((bytes[i++] & 63) << 12) |
        ((bytes[i++] & 63) << 6) |
        (bytes[i++] & 63);
    } else cp = 0xfffd;
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    } else out += String.fromCharCode(cp);
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.slice(0, o);
}

/* ---- AES-256 (CTR keystream) so no host crypto module is needed ---------- */
/* AES-GCM encrypts with CTR (counter starts at 2 for a 96-bit IV), so       */
/* decrypting the text only needs the AES block cipher. The auth tag is      */
/* not verified; a wrong key simply yields garbage that is rejected later.   */

let AES_SBOX: Uint8Array | null = null;

function aesSbox(): Uint8Array {
  if (AES_SBOX) return AES_SBOX;
  const sbox = new Uint8Array(256);
  let p = 1;
  let q = 1;
  const rotl8 = (x: number, n: number) => ((x << n) | (x >> (8 - n))) & 0xff;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= (q << 1) & 0xff;
    q ^= (q << 2) & 0xff;
    q ^= (q << 4) & 0xff;
    if (q & 0x80) q ^= 0x09;
    q &= 0xff;
    sbox[p] =
      (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  sbox[0] = 0x63;
  AES_SBOX = sbox;
  return sbox;
}

function aesExpandKey(key: Uint8Array): Uint8Array {
  const sbox = aesSbox();
  const nk = key.length / 4; // 8 for AES-256
  const rounds = nk + 6;
  const w = new Uint8Array(16 * (rounds + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (rounds + 1); i++) {
    let t0 = w[(i - 1) * 4];
    let t1 = w[(i - 1) * 4 + 1];
    let t2 = w[(i - 1) * 4 + 2];
    let t3 = w[(i - 1) * 4 + 3];
    if (i % nk === 0) {
      const tmp = t0;
      t0 = sbox[t1] ^ rcon;
      t1 = sbox[t2];
      t2 = sbox[t3];
      t3 = sbox[tmp];
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
    } else if (nk > 6 && i % nk === 4) {
      t0 = sbox[t0];
      t1 = sbox[t1];
      t2 = sbox[t2];
      t3 = sbox[t3];
    }
    w[i * 4] = w[(i - nk) * 4] ^ t0;
    w[i * 4 + 1] = w[(i - nk) * 4 + 1] ^ t1;
    w[i * 4 + 2] = w[(i - nk) * 4 + 2] ^ t2;
    w[i * 4 + 3] = w[(i - nk) * 4 + 3] ^ t3;
  }
  return w;
}

function aesEncryptBlock(
  w: Uint8Array,
  input: Uint8Array,
  rounds: number,
): Uint8Array {
  const sbox = aesSbox();
  const xtime = (x: number) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[i] ^ w[i];
  const t = new Uint8Array(16);
  for (let r = 1; r <= rounds; r++) {
    // SubBytes + ShiftRows
    for (let c = 0; c < 4; c++) {
      for (let row = 0; row < 4; row++) {
        t[c * 4 + row] = sbox[s[((c + row) % 4) * 4 + row]];
      }
    }
    if (r < rounds) {
      // MixColumns
      for (let c = 0; c < 4; c++) {
        const a0 = t[c * 4];
        const a1 = t[c * 4 + 1];
        const a2 = t[c * 4 + 2];
        const a3 = t[c * 4 + 3];
        s[c * 4] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
        s[c * 4 + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
        s[c * 4 + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
        s[c * 4 + 3] = xtime(a0) ^ a0 ^ a1 ^ a2 ^ xtime(a3);
      }
    } else {
      s.set(t);
    }
    for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
  }
  return s;
}

/** Decrypts "ciphertext || 16-byte tag" produced by AES-GCM (96-bit IV). */
function aesGcmDecryptNoTag(
  key: Uint8Array,
  iv: Uint8Array,
  ctWithTag: Uint8Array,
): Uint8Array {
  const rounds = key.length / 4 + 6;
  const w = aesExpandKey(key);
  const len = ctWithTag.length - 16;
  const out = new Uint8Array(len);
  const counter = new Uint8Array(16);
  counter.set(iv.slice(0, 12));
  let blockNo = 2;
  for (let off = 0; off < len; off += 16) {
    counter[12] = (blockNo >>> 24) & 0xff;
    counter[13] = (blockNo >>> 16) & 0xff;
    counter[14] = (blockNo >>> 8) & 0xff;
    counter[15] = blockNo & 0xff;
    const ks = aesEncryptBlock(w, counter, rounds);
    const n = Math.min(16, len - off);
    for (let i = 0; i < n; i++) out[off + i] = ctWithTag[off + i] ^ ks[i];
    blockNo++;
  }
  return out;
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Bytes(input: string): Uint8Array {
  const bytes = utf8Encode(input);
  const bitLen = bytes.length * 8;
  const padLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 4, bitLen >>> 0, false);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let i = 0; i < padLen; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 64; j++) {
      const s0 =
        rotr32(w[j - 15], 7) ^ rotr32(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 =
        rotr32(w[j - 2], 17) ^ rotr32(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let j = 0; j < 64; j++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[j] + w[j]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

function xorshift128Next(state: Uint32Array): number {
  const t = state[0];
  let r = (t ^ (t << 11)) >>> 0;
  r = (r ^ (r >>> 8)) >>> 0;
  const o = state[3];
  state[0] = state[1];
  state[1] = state[2];
  state[2] = o;
  const f = (o ^ (o >>> 19) ^ r) >>> 0;
  state[3] = f;
  return f;
}

function unshuffleFragments(fragments: string[], seedStr: string): string {
  const count = fragments.length;
  if (count < 2) return count === 1 ? fragments[0] : '';
  const digest = sha256Bytes(seedStr);
  const view = new DataView(
    digest.buffer,
    digest.byteOffset,
    digest.byteLength,
  );
  const state = new Uint32Array([
    view.getUint32(0, true),
    view.getUint32(4, true),
    view.getUint32(8, true),
    view.getUint32(12, true),
  ]);
  const perm = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    perm[i] = i;
  }
  for (let i = count - 1; i > 0; i--) {
    const j = xorshift128Next(state) % (i + 1);
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  const restored = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    restored[perm[i]] = fragments[i];
  }
  return restored.join('');
}

function decodeBase64Bytes(b64: string): Uint8Array {
  return base64ToBytes(b64);
}

type ReadTokenPayload = {
  vid: string;
  cid: number | null;
  exp: number | null;
};

function parseReadTokenPayload(token: string): ReadTokenPayload {
  try {
    const payloadPart = token.split('.')[0] ?? '';
    if (!payloadPart) return { vid: '', cid: null, exp: null };
    const b64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = utf8Decode(decodeBase64Bytes(padded));
    const parsed = JSON.parse(decoded);
    return {
      vid: typeof parsed?.vid === 'string' ? parsed.vid : '',
      cid:
        typeof parsed?.cid === 'number' && parsed.cid > 0 ? parsed.cid : null,
      exp:
        typeof parsed?.exp === 'number' && parsed.exp > 0 ? parsed.exp : null,
    };
  } catch {
    return { vid: '', cid: null, exp: null };
  }
}

function extractVidFromReadToken(token: string): string {
  return parseReadTokenPayload(token).vid;
}

// Zero-width / invisible characters used to fingerprint a reader's copy.
const INVISIBLE_RE = /[\u200B-\u200D\u2060-\u2064\uFEFF\u00AD\u180E]/g;

// Anything that looks like an actual HTML tag.
const HTML_TAG_RE =
  /<\/?(?:p|div|span|br|b|i|u|s|em|strong|a|h[1-6]|ul|ol|li|blockquote|hr|img|pre|section|article|center|font|small|sup|sub)\b[^>]*>/i;

// Inline styles that hide an element from a human reader.
const HIDDEN_STYLE_RE =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?![.\d])|clip\s*:\s*rect|clip-path\s*:\s*inset|width\s*:\s*1px/i;

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
  uuid?: string | null;
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

type APIChapterData = {
  id: number;
  uuid?: string | null;
  slug?: string;
  name?: string;
  content: string | string[] | null;
  content_format?: 'locked' | 'encrypted' | 'html' | 'text' | 'json' | null;
  content_scheme?: 'fragmented-v2' | 'fragmented-v1' | string | null;
  remint_chapter_id?: number | null;
  remint_chapter_uuid?: string | null;
  locked?: {
    price: number;
    unlocked_at?: string | null;
    is_read_only?: boolean;
  } | null;
  bought?: {
    wallet_type?: string | null;
    amount?: number;
    bought_at?: string | null;
  } | null;
  bypass?: boolean;
};

type CachedReadToken = {
  value: string;
  expiresAt: number;
  cid: number | null;
};

type TipTapMark = { type: string; attrs?: { href?: string } };
type TipTapNode = {
  type: string;
  text?: string;
  marks?: TipTapMark[];
  attrs?: { level?: number; src?: string; alt?: string; href?: string };
  content?: TipTapNode[];
};

const RATE_LIMIT_MSG =
  'Rate limited by Fenrir Realm (Too Many Attempts). Please wait a moment before loading more chapters.';

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
      for (const mark of marks) {
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

/**
 * Reduces any stored path ("slug", "series/slug/34", "slug/34~~123", full URL)
 * to "<slug>[/<volume-slug>]/<chapter-number>" - the part after /series/.
 */
function stripPath(path: string): string {
  return path
    .split('~~')[0]
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+/, '')
    .replace(/^series\//, '')
    .replace(/\/+$/, '');
}

class FenrealmBlablaPlugin implements Plugin.PluginBase {
  id = 'fenrealmblabla';
  name = 'Fenrir Realm (Blabla)';
  icon = 'src/en/fenrealmblabla/icon.png';
  site = SITE;
  version = PLUGIN_VERSION;
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

  private cachedReadToken: CachedReadToken | null = null;

  /* ------------------------------------------------------------------ */
  /*  small helpers                                                      */
  /* ------------------------------------------------------------------ */

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

  /* ------------------------------------------------------------------ */
  /*  read-token handling (needed to get chapter text)                   */
  /* ------------------------------------------------------------------ */

  private setCachedReadToken(
    token: string,
    expiresAt?: number | null,
    cid?: number | null,
  ): void {
    if (!token) return;
    const parsed = parseReadTokenPayload(token);
    const resolvedExp =
      typeof expiresAt === 'number' && expiresAt > 0
        ? expiresAt
        : parsed.exp !== null
          ? parsed.exp
          : Math.floor(Date.now() / 1000) + 300;
    const resolvedCid =
      parsed.cid !== null
        ? parsed.cid
        : typeof cid === 'number' && cid > 0
          ? cid
          : null;
    this.cachedReadToken = {
      value: token,
      expiresAt: resolvedExp,
      cid: resolvedCid,
    };
  }

  private getActiveTokenValue(): string | null {
    if (!this.cachedReadToken) return null;
    if (this.cachedReadToken.expiresAt * 1000 - Date.now() < 5000) {
      this.cachedReadToken = null;
      return null;
    }
    return this.cachedReadToken.value;
  }

  private getCachedReadToken(chapterId?: number | null): string | null {
    const value = this.getActiveTokenValue();
    if (!value || !this.cachedReadToken) return null;
    if (
      chapterId != null &&
      this.cachedReadToken.cid !== null &&
      this.cachedReadToken.cid !== chapterId
    ) {
      return null;
    }
    return value;
  }

  private captureReadTokenHeader(res: Response, cid?: number | null): void {
    const issued =
      res.headers && res.headers.get && res.headers.get('x-read-token-issued');
    if (!issued) return;
    const expHeader = res.headers.get('x-read-token-expires-at');
    const parsedExp = expHeader ? parseInt(expHeader, 10) : NaN;
    this.setCachedReadToken(
      issued,
      Number.isFinite(parsedExp) ? parsedExp : null,
      cid,
    );
  }

  private resolveRemintTarget(
    data: APIChapterData,
    fallbackId?: string,
  ): string | number | null {
    return (
      data.remint_chapter_uuid ||
      data.remint_chapter_id ||
      data.uuid ||
      data.id ||
      fallbackId ||
      null
    );
  }

  private buildChapterHeaders(pageUrl: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'X-Accepts-Encrypted-Content': '3',
      'Referer': pageUrl,
    };
    const activeToken = this.getActiveTokenValue();
    if (activeToken) {
      headers['Cookie'] = `fr_read=${activeToken}`;
    }
    return headers;
  }

  private async mintReadToken(
    chapterTarget?: string | number | null,
    cid?: number | null,
  ): Promise<boolean> {
    try {
      const payload: Record<string, string> = {};
      if (
        chapterTarget !== null &&
        chapterTarget !== undefined &&
        chapterTarget !== ''
      ) {
        payload.chapter_id = String(chapterTarget);
      }
      const requestMint = async (cookieToken: string | null) => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        };
        if (cookieToken) {
          headers['Cookie'] = `fr_read=${cookieToken}`;
        }
        const res = await fetchApi(`${this.site}/api/read-token`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        if (!res.ok) return null;
        const data = await readJson<{
          active?: boolean;
          token?: string;
          expires_at?: number;
        }>(res);
        return data &&
          data.active &&
          typeof data.token === 'string' &&
          data.token !== ''
          ? data
          : null;
      };

      const activeToken = this.getActiveTokenValue();
      let data = await requestMint(activeToken);
      if (!data && activeToken) {
        this.cachedReadToken = null;
        data = await requestMint(null);
      }
      if (data) {
        const numericId =
          typeof cid === 'number' && cid > 0
            ? cid
            : typeof chapterTarget === 'number'
              ? chapterTarget
              : null;
        this.setCachedReadToken(data.token || '', data.expires_at, numericId);
        return true;
      }
      this.cachedReadToken = null;
      return false;
    } catch {
      return false;
    }
  }

  private async getReadToken(
    chapterId?: number | null,
  ): Promise<string | null> {
    const cached = this.getCachedReadToken(chapterId);
    if (cached !== null) return cached;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      const activeToken = this.getActiveTokenValue();
      if (activeToken) {
        headers['Cookie'] = `fr_read=${activeToken}`;
      }
      const res = await fetchApi(`${this.site}/api/read-token`, {
        method: 'GET',
        headers,
      });
      if (!res.ok) return null;
      const data = await readJson<{
        active?: boolean;
        token?: string;
        expires_at?: number;
      }>(res);
      if (
        data &&
        data.active &&
        typeof data.token === 'string' &&
        data.token !== ''
      ) {
        this.setCachedReadToken(
          data.token,
          typeof data.expires_at === 'number' ? data.expires_at : null,
          chapterId === undefined ? null : chapterId,
        );
        return data.token;
      }
      return null;
    } catch {
      return null;
    }
  }

  private decryptWithToken(
    chapterData: APIChapterData,
    token: string,
  ): string | null {
    try {
      const isV2 = chapterData.content_scheme === 'fragmented-v2';
      const vid = isV2 ? extractVidFromReadToken(token) : '';
      const b64Cipher = Array.isArray(chapterData.content)
        ? unshuffleFragments(
            chapterData.content,
            isV2
              ? `${token}:${vid}:${chapterData.id}:${FRAG_SALT_V2}`
              : `${token}:${chapterData.id}:${FRAG_SALT_V1}`,
          )
        : typeof chapterData.content === 'string'
          ? chapterData.content
          : '';
      if (!b64Cipher) return null;

      const raw = decodeBase64Bytes(b64Cipher);
      if (raw.length <= AES_GCM_IV_LENGTH + AES_GCM_TAG_LENGTH) return null;

      const keySeed =
        isV2 && vid !== ''
          ? `${token}:${vid}:${chapterData.id}:${CONTENT_SALT_V2}`
          : `${token}:${chapterData.id}:${CONTENT_SALT_V1}`;
      const keyBytes = sha256Bytes(keySeed);
      const iv = raw.slice(0, AES_GCM_IV_LENGTH);
      const ciphertextWithTag = raw.slice(AES_GCM_IV_LENGTH);
      const decrypted = aesGcmDecryptNoTag(keyBytes, iv, ciphertextWithTag);
      return utf8Decode(decrypted);
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  browsing                                                           */
  /* ------------------------------------------------------------------ */

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
    let slug = stripPath(novelPath).split('/')[0];
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
      path: 'series/' + slug,
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
          // The app opens  site + '/' + path  in its WebView and ignores
          // resolveUrl(), so the path IS the website path:
          //   /series/<slug>[/<volume-slug>]/<chapter-number>
          // (no "~~id" suffix; the id is looked up from the chapter list)
          path:
            'series/' + slug + (group ? '/' + group.slug : '') + '/' + c.number,
          releaseTime: c.created_at,
          chapterNumber: c.number + ((group && group.index) || 0) * 10000,
        };
      })
      .sort((a, b) => a.chapterNumber - b.chapterNumber);

    return novel;
  }

  /* ------------------------------------------------------------------ */
  /*  chapter text                                                       */
  /* ------------------------------------------------------------------ */

  private chapterListCache: {
    slug: string;
    at: number;
    list: APIChapter[];
  } | null = null;

  private async getChapterList(slug: string): Promise<APIChapter[]> {
    const c = this.chapterListCache;
    if (c && c.slug === slug && Date.now() - c.at < 10 * 60 * 1000) {
      return c.list;
    }
    const res = await this.getJson(`${API}/series/${slug}/chapters`);
    const list: APIChapter[] = Array.isArray(res.json)
      ? res.json
      : (res.json && res.json.data) || [];
    if (list.length) this.chapterListCache = { slug, at: Date.now(), list };
    return list;
  }

  /** Finds the chapter id from "<slug>[/<volume-slug>]/<number>". */
  private async lookupChapterId(pagePath: string): Promise<string | undefined> {
    const parts = pagePath.split('/');
    const slug = parts[0];
    const last = parts[parts.length - 1];
    const lastNumber = last.replace(/^chapter-/i, '');
    const group = parts.length > 2 ? parts[1] : null;
    const list = await this.getChapterList(slug);
    for (const c of list) {
      const sameGroup = group
        ? !!(c.group && c.group.slug === group)
        : !(c.group && c.group.slug);
      if (!sameGroup) continue;
      if (String(c.number) === lastNumber || c.slug === last) {
        return String(c.id);
      }
    }
    return undefined;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    try {
      return await this.loadChapter(chapterPath);
    } catch (e) {
      // Tag every error with the plugin version so it is obvious which build
      // is really installed on the device.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${msg} [fenrealmblabla v${PLUGIN_VERSION}]`);
    }
  }

  private async loadChapter(chapterPath: string): Promise<string> {
    const pagePath = stripPath(chapterPath);
    const pageUrl = this.resolveUrl(chapterPath);
    let chapterId: string | undefined = chapterPath.split('~~')[1];
    if (!chapterId) chapterId = await this.lookupChapterId(pagePath);
    if (!chapterId) {
      throw new Error(
        'Could not find this chapter on Fenrir Realm. Refresh the novel and try again.',
      );
    }

    const apiUrl = `${API}/chapters/${chapterId}`;
    const parsedCid = parseInt(chapterId, 10);
    const initialCid = Number.isFinite(parsedCid) ? parsedCid : null;

    // 1) Make sure we hold a read token before the first request.
    if (this.getCachedReadToken(initialCid) === null) {
      await this.mintReadToken(chapterId, initialCid);
    }

    let res = await fetchApi(apiUrl, {
      headers: this.buildChapterHeaders(pageUrl),
    });
    if (res.status === 429) throw new Error(RATE_LIMIT_MSG);
    this.captureReadTokenHeader(res, initialCid);

    // 2) Token refused: mint a fresh one and ask again.
    if (res.status === 403) {
      if (await this.mintReadToken(chapterId, initialCid)) {
        res = await fetchApi(apiUrl, {
          headers: this.buildChapterHeaders(pageUrl),
        });
        if (res.status === 429) throw new Error(RATE_LIMIT_MSG);
        this.captureReadTokenHeader(res, initialCid);
      }
    }

    if (!res.ok) {
      throw new Error(
        `Fenrir Realm answered HTTP ${res.status} for this chapter. ` +
          'Open it once in WebView, then retry.',
      );
    }

    let json = await readJson<APIChapterData>(res);
    this.captureReadTokenHeader(res, json.id);

    // 3) "locked": either really paid, or the token has to be (re)issued.
    if (json.content_format === 'locked') {
      if (
        json.locked &&
        json.locked.price &&
        json.locked.price > 0 &&
        !(json.bought && json.bought.bought_at) &&
        !json.bypass
      ) {
        throw new Error(
          'This chapter is locked (paid). Please unlock it on Fenrir Realm first.',
        );
      }
      const remintTarget = this.resolveRemintTarget(json, chapterId);
      const remintCid = json.remint_chapter_id || json.id || initialCid;
      if (await this.mintReadToken(remintTarget, remintCid)) {
        const retry = await fetchApi(apiUrl, {
          headers: this.buildChapterHeaders(pageUrl),
        });
        if (retry.status === 429) throw new Error(RATE_LIMIT_MSG);
        if (retry.ok) {
          json = await readJson<APIChapterData>(retry);
          this.captureReadTokenHeader(retry, json.id);
        }
      }
    }

    // 4) "encrypted": decrypt with the token (re-mint once if that fails).
    if (json.content_format === 'encrypted') {
      const token = await this.getReadToken(json.id);
      let decrypted = token ? this.decryptWithToken(json, token) : null;

      if (!decrypted) {
        const remintTarget = this.resolveRemintTarget(json, chapterId);
        if (await this.mintReadToken(remintTarget, json.id)) {
          const retry = await fetchApi(apiUrl, {
            headers: this.buildChapterHeaders(pageUrl),
          });
          if (retry.status === 429) throw new Error(RATE_LIMIT_MSG);
          if (retry.ok) {
            const retryJson = await readJson<APIChapterData>(retry);
            this.captureReadTokenHeader(retry, retryJson.id);
            if (retryJson.content_format === 'encrypted') {
              const freshToken = await this.getReadToken(retryJson.id);
              decrypted = freshToken
                ? this.decryptWithToken(retryJson, freshToken)
                : null;
            } else if (
              retryJson.content_format !== 'locked' &&
              typeof retryJson.content === 'string' &&
              retryJson.content
            ) {
              decrypted = retryJson.content;
            }
          }
        }
      }

      if (decrypted) {
        const html = contentToHtml(decrypted);
        if (toHtmlText(html)) return html;
      }
      json = { ...json, content: '', content_format: 'locked' };
    }

    // 5) Plain content (older chapters / no protection).
    if (
      json.content_format !== 'locked' &&
      json.content !== undefined &&
      json.content !== null &&
      json.content !== '' &&
      !Array.isArray(json.content)
    ) {
      const html = contentToHtml(json.content);
      if (toHtmlText(html)) return html;
    }

    // 6) Last resort: the rendered chapter page (works if the site ever
    //    server-renders the text).
    try {
      const pageRes = await fetchApi(pageUrl, {
        headers: { Accept: 'text/html', Referer: this.site + '/' },
      });
      const pageHtml = await pageRes.text();
      if (/class="[^"]*reader-area/.test(pageHtml)) {
        const fromPage = cleanChapterHtml(pageHtml);
        if (toHtmlText(fromPage)) return fromPage;
      }
    } catch {
      // ignore, report the real problem below
    }

    this.cachedReadToken = null;
    throw new Error(
      'Fenrir Realm did not release this chapter (it asks for a browser ' +
        'verification). Open the chapter in WebView, let the text appear, ' +
        'then come back and retry.',
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
      path: 'series/' + apiData.slug,
      cover: this.fullUrl(apiData.cover),
    };
  }

  resolveUrl(path: string): string {
    // novel: "series/<slug>"   chapter: "series/<slug>[/<volume>]/<number>"
    // (older entries without the "series/" prefix or with "~~<id>" also work)
    return `${this.site}/series/${stripPath(path)}`;
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
