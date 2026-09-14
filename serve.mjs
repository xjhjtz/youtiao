#!/usr/bin/env node
/**
 * serve.mjs —— 本地静态服务（零依赖，只用 Node 内置模块）。
 *
 * 为什么需要它：浏览器在 file:// 下会拒绝加载 ES 模块，直接双击 index.html
 * 会得到一个按钮全部无响应的死页面。起一个本地 http 服务就没这个问题，
 * 而且 http://127.0.0.1 属于安全上下文，剪贴板 API 也能正常用。
 *
 * 用法：
 *     node serve.mjs                 # 默认 http://127.0.0.1:8123
 *     node serve.mjs --port 3000     # 指定端口
 *     node serve.mjs --open          # 启动后自动打开浏览器
 *     node serve.mjs --lan           # 监听 0.0.0.0，同局域网设备可访问
 *
 * 也可以直接用 npm：npm start（= node serve.mjs --open）
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 扩展名 → Content-Type。.js 必须是 JS 类型，否则浏览器会拒绝执行 ES 模块。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.worker': 'text/javascript; charset=utf-8'
};

export const contentTypeOf = (filePath) => MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';

/**
 * 创建一个只读静态文件服务。
 * @param {string} root 站点根目录
 * @returns {import('node:http').Server}
 */
export function createStaticServer(root) {
  const rootDir = resolve(root);

  return http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(400, 'Bad Request：URL 编码无法解析');
    }

    // 目录穿越防护：解析后必须仍在 root 之内
    let target = resolve(rootDir, '.' + normalize(pathname));
    if (target !== rootDir && !target.startsWith(rootDir + sep)) {
      return send(403, 'Forbidden：越界访问被拒绝');
    }

    let info;
    try {
      info = await stat(target);
    } catch {
      return send(404, `404 Not Found: ${pathname}`);
    }

    if (info.isDirectory()) {
      target = join(target, 'index.html');
      try {
        info = await stat(target);
      } catch {
        return send(404, `404 Not Found: ${pathname}（目录下没有 index.html）`);
      }
    }

    res.writeHead(200, {
      'Content-Type': contentTypeOf(target),
      'Content-Length': info.size,
      // 开发用：永不缓存，改完刷新就能看到
      'Cache-Control': 'no-store, must-revalidate'
    });

    if (req.method === 'HEAD') return res.end();

    const stream = createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

/** 列出一个可用的局域网地址（用于手机调试）。 */
export function lanAddress(port) {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return `http://${item.address}:${port}`;
    }
  }
  return '';
}

/** 监听端口，端口被占用时自动顺延。 */
export function listenWithFallback(server, { host, port, attempts = 10 }) {
  return new Promise((resolvePromise, reject) => {
    let current = port;
    let left = attempts;

    const onError = (error) => {
      if (error.code === 'EADDRINUSE' && left > 0) {
        left--;
        current++;
        server.listen(current, host);
        return;
      }
      server.removeListener('error', onError);
      reject(error);
    };

    server.on('error', onError);
    server.listen(current, host, () => {
      server.removeListener('error', onError);
      // 传 0 时由系统分配端口，必须从 address() 里取真实端口
      const address = server.address();
      resolvePromise(address && typeof address === 'object' ? address.port : current);
    });
  });
}

/** 用系统默认程序打开 URL。 */
function openBrowser(url) {
  const command =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(command[0], command[1], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* 打不开就算了，用户自己复制地址 */
  }
}

function parseArgs(argv) {
  const args = { port: 8123, host: '127.0.0.1', open: false, root: HERE };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--port' || item === '-p') args.port = Number(argv[++i]) || args.port;
    else if (item === '--host') args.host = argv[++i] || args.host;
    else if (item === '--root') args.root = resolve(argv[++i] || args.root);
    else if (item === '--open' || item === '-o') args.open = true;
    else if (item === '--lan') args.host = '0.0.0.0';
    else if (item === '--help' || item === '-h') args.help = true;
  }
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
油条 本地服务

  node serve.mjs [选项]

  -p, --port <端口>   监听端口（默认 8123，被占用时自动顺延）
      --host <地址>   监听地址（默认 127.0.0.1）
      --lan           监听 0.0.0.0，同局域网设备可访问
  -o, --open          启动后自动打开浏览器
      --root <目录>   站点根目录（默认为本文件所在目录）
`);
    process.exit(0);
  }

  const server = createStaticServer(args.root);
  const port = await listenWithFallback(server, { host: args.host, port: args.port });
  const local = `http://127.0.0.1:${port}`;
  const lan = args.host === '0.0.0.0' ? lanAddress(port) : '';

  console.log('');
  console.log('  🥖  油条 本地服务已启动');
  console.log('');
  console.log(`     打开这个地址   ${local}`);
  if (lan) console.log(`     局域网访问     ${lan}   （手机连同一个 WiFi 可用）`);
  console.log(`     站点目录       ${args.root}`);
  console.log('     停止服务       按 Ctrl + C');
  console.log('');
  console.log('  下一步：打开页面 → 设置页粘贴 GitHub 令牌 → 保存 → 测试连接。');
  console.log('');

  if (args.open) openBrowser(local);

  const shutdown = () => {
    console.log('\n  已停止本地服务。\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
