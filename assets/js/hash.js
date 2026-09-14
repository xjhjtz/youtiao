/**
 * hash.js —— 纯 JS 的 SHA-256 / MD5 与字节编解码工具。
 *
 * 为什么不用 WebCrypto？
 *   1. crypto.subtle 只在安全上下文（https / localhost）可用，本地双击 index.html（file://）会直接不可用；
 *   2. crypto.subtle 是异步的，会让「输入邮箱即时预览哈希」的交互变复杂；
 *   3. 纯 JS 实现是同步的，而且可以被 Node 的单元测试直接 import 对拍，保证正确性。
 *
 * 本文件不依赖任何 DOM，可在浏览器与 Node 中通用。
 * 正确性由 tests/hash.test.mjs 用 node:crypto 对拍保证。
 */

/* ------------------------------------------------------------------ *
 * 字节编码工具
 * ------------------------------------------------------------------ */

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** 把字符串按 UTF-8 编码为 Uint8Array（与 Twikoo 内部 js 哈希库行为一致）。 */
export function utf8Bytes(str) {
  const s = String(str);
  if (textEncoder) return textEncoder.encode(s);

  // 极老环境的兜底实现（不含 TextEncoder 时）
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
        out.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
        continue;
      }
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/** 字节数组 → 小写十六进制字符串。 */
export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字节数组 → base64（GitHub Contents API 需要）。 */
export function bytesToBase64(bytes) {
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
  }
  const rest = len - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + '=';
  }
  return out;
}

/** 去掉 base64 中的换行/空白（GitHub 返回的 blob 会被折行）。 */
export function stripBase64Whitespace(b64) {
  return String(b64).replace(/[\r\n\s]/g, '');
}

/** base64 → 文本（按 UTF-8 解码，中文不会乱码）。 */
export function base64ToText(b64) {
  const binary = atob(stripBase64Whitespace(b64));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 文本 → base64（GitHub Contents API 要求）。 */
export function textToBase64(text) {
  return bytesToBase64(utf8Bytes(text));
}

/* ------------------------------------------------------------------ *
 * SHA-256
 * ------------------------------------------------------------------ */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/** 对字节数组做 SHA-256。 */
export function sha256Bytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const len = bytes.length;
  // 补齐规则：1 字节 0x80 + 8 字节大端位长，整体向上取 64 的倍数。
  // 等价于 ceil((len + 9) / 64) * 64；写成 len + 8 是为了让边界（len ≡ 55 mod 64）落在正确分组。
  const paddedLength = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLength);
  buf.set(bytes);
  buf[len] = 0x80;

  const view = new DataView(buf.buffer);
  const bitLen = len * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(paddedLength - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < paddedLength; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

/* ------------------------------------------------------------------ *
 * MD5（仅为兼容 cravatar.cn 这类使用 MD5 的第三方 CDN，默认不使用）
 * ------------------------------------------------------------------ */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

const MD5_K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
]);

/** 对字节数组做 MD5。 */
export function md5Bytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const len = bytes.length;
  const paddedLength = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLength);
  buf.set(bytes);
  buf[len] = 0x80;

  const view = new DataView(buf.buffer);
  const bitLen = len * 8;
  view.setUint32(paddedLength - 8, bitLen >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLen / 0x100000000), true);

  const m = new Uint32Array(16);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < paddedLength; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);

    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + m[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      const s = MD5_S[i];
      B = (B + (((F << s) | (F >>> (32 - s))) >>> 0)) >>> 0;
    }

    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

/**
 * 邮箱规范化 —— 必须与 Twikoo 的 normalizeMail 完全一致：
 *   Twikoo: `normalizeMail = (e) => String(e).trim().toLowerCase()`
 * 任何差异都会导致算出的哈希与 Twikoo 请求的路径不匹配。
 */
export function normalizeMail(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

/** 字符串 → SHA-256 十六进制（小写）。 */
export function sha256Hex(str) {
  return bytesToHex(sha256Bytes(utf8Bytes(str)));
}

/** 字符串 → MD5 十六进制（小写）。 */
export function md5Hex(str) {
  return bytesToHex(md5Bytes(utf8Bytes(str)));
}

/**
 * 由邮箱计算头像文件名（不含扩展名）。
 * @param {string} email
 * @param {'sha256'|'md5'} [algorithm='sha256'] Twikoo 自定义 CDN 用 sha256；cravatar.cn 用 md5。
 * @returns {string} 64 位（sha256）或 32 位（md5）小写十六进制
 */
export function emailToFileName(email, algorithm = 'sha256') {
  const normalized = normalizeMail(email);
  return algorithm === 'md5' ? md5Hex(normalized) : sha256Hex(normalized);
}

/** 顺手判断是否 QQ 邮箱 —— Twikoo 对 QQ 邮箱会走自己的接口，不走自定义 CDN。 */
export function isQQMail(email) {
  const mail = String(email == null ? '' : email).trim();
  return /^[1-9][0-9]{4,10}$/.test(mail) || /^[1-9][0-9]{4,10}@qq\.com$/i.test(mail);
}
