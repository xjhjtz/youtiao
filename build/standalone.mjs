/**
 * build/standalone.mjs —— 把整个应用打包成单个 HTML 文件。
 *
 * ## 为什么需要它
 * 浏览器在 `file://` 协议下会以同源策略为由拒绝加载 ES 模块
 * （`<script type="module">` 必然失败，控制台会报 CORS），
 * 于是「双击 index.html」会得到一个按钮全部无响应的死页面。
 *
 * 本脚本把 CSS 与所有 JS 模块内联进一个**普通** `<script>`（不是 module），
 * 普通脚本不受该限制，于是单文件版双击即可正常工作。
 *
 * 产物：youtiao-standalone.html（自包含，可离线、可拷到任何地方运行）
 *
 * 用法：npm run build
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 拼接顺序：被依赖的放前面。
 * 之所以不能随便排，是因为 app.js 顶层有 `const state = { settings: loadSettings() }`
 * 这类立即求值的代码——此时 config.js 里的 const 必须已经初始化（const 有 TDZ）。
 */
const ORDER = [
  'format.js',
  'hash.js',
  'paths.js',
  'cdn.js',
  'github.js',
  'config.js',
  'notes.js',
  'notes-sync.js',
  'image.js',
  'ui.js',
  'app.js'
];

/** 去掉模块语法：import / export，使其能在一个作用域里直接拼接。 */
function stripModuleSyntax(source, file) {
  let out = source;

  // import ... from '...';（可能跨多行）
  out = out.replace(/^[ \t]*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?[ \t]*$/gm, '');
  // export { a, b };
  out = out.replace(/^[ \t]*export\s*\{[^}]*\};?[ \t]*$/gm, '');
  // export function / const / let / var / class
  out = out.replace(/^([ \t]*)export\s+(async\s+function|function|const|let|var|class)/gm, '$1$2');

  const leftovers = out.match(/^[ \t]*(import|export)\b.*$/m);
  if (leftovers) {
    throw new Error(`${file} 里仍有未处理的模块语法：${leftovers[0].trim()}`);
  }
  return out.trimEnd();
}

/** 收集顶层声明名，用来检测跨文件重名（重名会让拼接后的代码静默出错）。 */
function topLevelNames(source) {
  const names = [];
  for (const m of source.matchAll(/^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.push(m[1]);
  }
  return names;
}

function build() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'assets', 'style.css'), 'utf8');

  const seen = new Map();
  const chunks = [];

  for (const file of ORDER) {
    const raw = readFileSync(join(ROOT, 'assets', 'js', file), 'utf8');
    const stripped = stripModuleSyntax(raw, file);

    for (const name of topLevelNames(stripped)) {
      if (seen.has(name)) {
        throw new Error(
          `顶层标识符重名：${name} 同时出现在 ${seen.get(name)} 和 ${file}，` +
            `拼接后会互相覆盖。请改名或改用命名空间。`
        );
      }
      seen.set(name, file);
    }

    chunks.push(`/* ================= ${file} ================= */\n${stripped}`);
  }

  const bundle = `(function () {\n'use strict';\n\n${chunks.join('\n\n')}\n})();`;

  const styleTag = /[ \t]*<link[^>]+href="assets\/style\.css"[^>]*>\n?/;
  const scriptTag = /[ \t]*<script[^>]+src="assets\/js\/app\.js"[^>]*><\/script>\n?/;
  if (!styleTag.test(html)) throw new Error('index.html 里找不到 style.css 的引用');
  if (!scriptTag.test(html)) throw new Error('index.html 里找不到 app.js 的引用');

  // ⚠️ 必须用「函数形式」的替换：如果把 bundle 直接当替换字符串，`$$` 会被
  // String.replace 解释成字面量 `$`，于是 ui.js 里的 `const $$ = ...` 会变成
  // `const $ = ...`，与另一个 `$` 重复声明，整个脚本直接语法错误（页面全死）。
  const out = html
    .replace(styleTag, () => `<style>\n${css.trimEnd()}\n    </style>\n`)
    .replace(
      scriptTag,
      () =>
        `<!-- 单文件版：所有模块已内联为一个普通脚本，避开 file:// 对 ES 模块的同源限制 -->\n` +
        `    <script>\n${bundle}\n    </script>\n`
    )
    .replace('<title>', () => '<!-- 由 build/standalone.mjs 生成，请勿直接编辑；改源码后执行 npm run build -->\n<title>');

  // ---- 产物自检：宁可在构建时炸，也不要让用户拿到一个按钮全死的页面 ----
  if (!out.includes(bundle)) {
    throw new Error('内联脚本在写入 HTML 时被改写了（检查替换串里的 $ 转义问题）');
  }
  const inlined = out.match(/<script>\n([\s\S]*?)\n {4}<\/script>/);
  if (!inlined) throw new Error('产物里找不到内联脚本，模板结构可能已变化');
  try {
    // 仅编译不执行：语法错误会立刻抛出
    // eslint-disable-next-line no-new-func
    new Function(inlined[1]);
  } catch (error) {
    throw new Error(`内联脚本存在语法错误：${error.message}`);
  }
  // 只按「语句位置」判断残留模块语法——注释里出现 import/export 这种词是正常的
  const residual = inlined[1].split('\n').find((line) => /^\s*(import|export)\s/.test(line));
  if (residual) {
    throw new Error(`产物里仍残留模块语法：${residual.trim().slice(0, 80)}`);
  }

  const target = join(ROOT, 'youtiao-standalone.html');
  writeFileSync(target, out, 'utf8');

  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
  return { target, size: out.length, kb, modules: ORDER.length, names: seen.size };
}

const result = build();
console.log(`✅ 已生成单文件版：${result.target}`);
console.log(`   内联模块 ${result.modules} 个，顶层标识符 ${result.names} 个，体积 ${result.kb} KB`);
console.log('   这个文件双击即可用（file:// 下也能正常工作）。');
