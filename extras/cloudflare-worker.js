/**
 * Cloudflare Worker：给「无扩展名头像」补上正确的 Content-Type。
 *
 * ## 为什么需要它
 * 按设计，头像文件在仓库里叫 `avatar/973dfe46...813b`，没有扩展名。
 * jsDelivr / raw.githubusercontent.com 只能靠扩展名猜 MIME，对这类文件可能返回
 * `application/octet-stream` 或 `text/plain`。绝大多数浏览器的 <img> 会嗅探内容并正常显示，
 * 但少数严格校验 MIME 的场景（图片代理、社交平台抓头像、部分小程序 webview）会失败。
 *
 * 这个 Worker 把请求转发给 jsDelivr，读取前几个字节判断真实图片类型，
 * 然后强制改写 `Content-Type`，同时保留 jsDelivr 的缓存。
 *
 * ## 用法
 * 1. 打开 Cloudflare Dashboard → Workers & Pages → 创建 Worker，粘贴本文件内容并部署。
 * 2. 记下 Worker 域名，例如 `youtiao.your-name.workers.dev`。
 * 3. 在本工具的「设置 → CDN 线路」里选「自定义模板」，填入：
 *      https://youtiao.your-name.workers.dev/{path}
 *    或在「CDN 与 Twikoo」页把 CDN 基址替换成你的 Worker 域名。
 * 4. 填进 Twikoo 的 GRAVATAR_CDN 就是：
 *      youtiao.your-name.workers.dev
 *    （仍然不带协议头、不带 /avatar —— Twikoo 会自己追加 /avatar/<sha256>）
 *
 * ## 可选：限制只能访问你自己的仓库
 * 把 ALLOWED_PREFIX 改成 ['/gh/你的用户名/你的仓库名@'], 其它路径一律 404，
 * 避免这个 Worker 被当成公共 jsDelivr 代理。
 */

const UPSTREAM_HOST = 'cdn.jsdelivr.net';

/** 限定允许代理的路径前缀；空数组表示不限制。 */
const ALLOWED_PREFIX = [
  // '/gh/your-name/your-avatar-bed@',
];

/** 缓存时长（秒）。jsDelivr 本身有缓存，这里再加一层边缘缓存。 */
const EDGE_CACHE_SECONDS = 60 * 60 * 24;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    if (ALLOWED_PREFIX.length && !ALLOWED_PREFIX.some((prefix) => url.pathname.startsWith(prefix))) {
      return new Response('Not Found', { status: 404 });
    }

    const upstreamUrl = `https://${UPSTREAM_HOST}${url.pathname}${url.search}`;
    const cache = caches.default;
    const cacheKey = new Request(upstreamUrl, { method: 'GET' });

    let response = await cache.match(cacheKey);
    let fromCache = true;

    if (!response) {
      fromCache = false;
      const upstream = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          // 让 jsDelivr 返回真实字节
          Accept: '*/*',
          'User-Agent': request.headers.get('User-Agent') || 'youtiao-worker'
        },
        cf: { cacheTtl: EDGE_CACHE_SECONDS, cacheEverything: true }
      });

      response = new Response(upstream.body, upstream);
      response.headers.set('Cache-Control', `public, max-age=${EDGE_CACHE_SECONDS}`);
    }

    const headers = new Headers(response.headers);
    headers.delete('Content-Disposition');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Youtiao-Worker', fromCache ? 'hit' : 'miss');

    // 只对 2xx 且内容看起来是图片的响应改写 Content-Type
    if (response.ok) {
      const contentType = await sniffContentType(response);
      if (contentType) headers.set('Content-Type', contentType);
    } else {
      headers.delete('Cache-Control');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};

/**
 * 读取响应前 16 字节判断图片类型。用 clone() 以免消费掉原始响应体。
 * 返回 null 表示「不是可识别的图片，保持原 Content-Type」。
 */
async function sniffContentType(response) {
  let head;
  try {
    head = new Uint8Array(await response.clone().arrayBuffer()).slice(0, 16);
  } catch {
    return null;
  }
  if (head.length < 4) return null;

  const is = (...sig) => sig.every((byte, i) => head[i] === byte);

  if (is(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (is(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (is(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (is(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
    return 'image/webp';
  }
  if (is(0x42, 0x4d)) return 'image/bmp';
  if (is(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (is(0x66, 0x74, 0x79, 0x70) && head[8] === 0x61 && head[9] === 0x76 && head[10] === 0x69 && head[11] === 0x66) {
    return 'image/avif';
  }

  // SVG 是文本，用更长的前缀判断
  try {
    const text = new TextDecoder().decode(new Uint8Array(await response.clone().arrayBuffer()).slice(0, 256)).trimStart();
    if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'image/svg+xml';
  } catch {
    /* 忽略 */
  }
  return null;
}
