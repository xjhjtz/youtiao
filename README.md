# 油条 · 基于 GitHub 的 Twikoo 头像管理系统

> 🥖 **名字来源**：作者早上吃的油条。功能和油条没有关系，但确实很香。

一个 **WeAvatar / Gravatar 类的自建头像服务**：把「邮箱 → SHA-256 → 你的 GitHub 仓库 → jsDelivr CDN」这条链路做成开箱即用的零后端 Web 工具，让 **Twikoo** 评论区的头像完全由你自己掌控。

- 零后端：所有请求从你的浏览器直连 `api.github.com`，没有服务器、没有数据库、没有中间人。
- 零依赖：纯原生 ES Module + 一个 CSS 文件，不需要构建，Fork 后开 Pages 就能用。
- 零成本：图片存在你自己的 GitHub 仓库，靠 jsDelivr 免费 CDN 分发。

```
评论者留下邮箱
      │  Twikoo: sha256(email.trim().toLowerCase())
      ▼
https://cdn.jsdmirror.com/gh/你/仓库@main/avatar/973dfe46…813b?d=mp
      │  jsDelivr 把 /gh 后面的路径映射到 GitHub
      ▼
你的仓库：avatar/973dfe46…813b   ← 就是这个文件（无扩展名）
```

---

## 一、它是怎么工作的（以及为什么必须这么设计）

这不是拍脑袋的规则，而是严格对齐 Twikoo 1.7.22 的实际实现。Twikoo 渲染头像的代码等价于：

```js
gravatarCdn = config.GRAVATAR_CDN || 'weavatar.com'
defaultGravatar = config.DEFAULT_GRAVATAR

// 关键分支：只有 cravatar.cn 用 MD5，其它自定义 CDN 一律用 SHA-256
const hash = gravatarCdn === 'cravatar.cn' ? md5(normalizeMail(mail)) : sha256(normalizeMail(mail))
return `https://${gravatarCdn}/avatar/${hash}?d=${defaultGravatar}`

// normalizeMail 的实现
const normalizeMail = (e) => String(e).trim().toLowerCase()
```

由此推出四条**硬性约束**，本工具全部自动处理：

| 约束 | 原因 | 本工具的做法 |
| --- | --- | --- |
| 文件必须放在仓库的 `avatar/` 目录下 | Twikoo 在 CDN 基址和你给的哈希之间**硬编码**追加了 `/avatar/`，无法配置 | 目录前缀默认 `avatar`，改掉会立刻弹出红色警告 |
| 文件名是**纯 SHA-256、不带扩展名** | 模板里哈希后面直接跟 `?d=`，没有扩展名的位置 | 图片按需去扩展名保存 |
| 填进 Twikoo 的 CDN 基址**不带** `https://`、**不带** `/avatar` | Twikoo 自己会拼 `https://` 前缀和 `/avatar/` | 「CDN 与 Twikoo」页给出可直接复制的值，并自动防止你多填一个 `/avatar` |
| 仓库必须是**公开**的 | jsDelivr 无法读取私有仓库 | 检测到私有仓库会立刻警告；「创建仓库」按钮固定建公开仓库 |

另外两个 Twikoo 的内建行为，本工具也会主动提示：

- **QQ 邮箱不走自定义 CDN**。Twikoo 对 `12345@qq.com` 或纯数字 QQ 号会直接调用 QQ 头像接口，你的图床根本收不到请求。输入这类邮箱时界面会明确标注。
- `?d=mp` 这个 fallback 参数**在你的图床上不生效**。它是给 Gravatar 用的，jsDelivr 会忽略查询串（已实测）。

---

## 二、功能

**上传**
- 输入邮箱 + 拖拽 / 选择 / <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴图片，实时预览规范化邮箱、SHA-256、仓库路径、图片直链，以及 **Twikoo 实际会请求的那个地址**。
- 上传前就告诉你这个邮箱**是不是已有头像**（新文件还是覆盖）。
- 批量模式：**把文件名当邮箱**（`alice@example.com.png` → `alice@example.com`），适合把已有的一批头像一次性迁进来。
- 队列式上传，并发数可调（默认 3），逐条状态与失败原因；失败的留在队列里可重试。
- 可选上传前压缩 / 转 WebP（默认关闭，原图直传）。

**图库管理**
- 读取整个 `avatar/` 目录，网格缩略图 + 大小 + 短 SHA + 邮箱备注。
- 搜索（哈希 / 路径 / 邮箱）、排序、分页、点击放大预览。
- 单张操作：复制直链、复制 Markdown、预览、**备注邮箱**（把已有头像和邮箱关联起来）、**改绑邮箱**（自动在仓库里移动文件）、下载原图、在 GitHub 打开、**刷新 CDN 缓存**、删除。
- 批量操作：全选本页、批量复制链接 / Markdown、导出 JSON、批量刷新缓存、批量删除。
- 仓库体积与文件数统计。

**CDN 与 Twikoo**
- 内置 CDN 生成器：jsDelivr 官方 / `cdn.jsdmirror.com` 国内镜像 / Gcore / Statically / GitHub Raw / GitHub Pages / ghproxy / 自定义模板。
- 一键复制可直接填进 Twikoo 的 `GRAVATAR_CDN` 值，并生成完整配置速查与示例地址。
- **邮箱批量转头像链接**：粘贴一堆邮箱，一次性生成全部链接，并标出**哪些邮箱还没有上传头像**，方便核对遗漏。
- 导出 TXT / CSV / JSON。

**工程细节**
- **缓存刷新（**只对 jsDelivr 自家线路有效**）**：覆盖头像后不清缓存，评论里就还是旧头像。本工具在覆盖/删除后会自动调用 `purge.jsdelivr.net`（可关闭），也可手动刷新。但要清楚**这条只对 `cdn.jsdelivr.net` 与 `gcore.jsdelivr.net` 有效**——`cdn.jsdmirror.com` 是第三方镜像，详见下方的「换了头像为什么还是旧的」。
- **邮箱备注 + 远程同步**：SHA-256 不可逆，光看文件名不知道是谁。上传时把「邮箱 ↔ 哈希」记下来，图库因此能显示邮箱、能按邮箱搜索。这份备注会**自动同步到 GitHub 仓库里的一个文件**（默认 `.youtiao/notes.json`），换设备、清浏览器缓存都不会丢。
  > ⚠️ 图床仓库必须是公开的，所以备注写进同一个仓库 = **所有评论者的邮箱公开可读**。因此第一次写入前会让你明确选一次，并且可以（也推荐）把备注放进一个**独立的私有仓库**。详见常见问题里的「备注存在哪里」。
- **安全**：令牌只存你自己的浏览器；细粒度令牌只需 `Contents: Read and write`；可选「仅本次会话」保存。

---

## 三、快速开始

### 第 1 步：建一个图床仓库

GitHub 上新建 **Public** 仓库（例如 `your-avatar-bed`），勾选 *Add a README file* 让它有初始提交（空的仓库没有分支，API 会报错）。

> 想省事的话也可以跳过：本工具的「创建仓库」按钮能直接帮你建好公开仓库和初始提交。

### 第 2 步：建一个最小权限令牌

`Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token`

- **Repository access**：只勾选刚才那个图床仓库
- **Permissions → Repository permissions → Contents**：`Read and write`
- 其余权限全部留空

### 第 3 步：把本工具跑起来（三选一）

**A. 起本地服务（推荐，一条命令）**

在本项目目录里执行：

```bash
npm start                 # 等价于 node serve.mjs --open
```

它会：

```
  🖼️  油条 本地服务已启动

     打开这个地址   http://127.0.0.1:8123
     站点目录       D:\...\youtiao
     停止服务       按 Ctrl + C
```

默认端口 **8123**，被占用会自动顺延到 8124、8125……并自动打开浏览器。

| 命令 | 说明 |
| --- | --- |
| `npm start` | 起服务并自动打开浏览器 |
| `npm run serve` | 只起服务，不打开浏览器 |
| `npm run serve:lan` | 监听 `0.0.0.0`，手机连同一 WiFi 可访问（会打印局域网地址） |
| `node serve.mjs --port 3000` | 指定端口 |
| `node serve.mjs --help` | 查看全部参数 |

Windows 用户也可以直接双击 **`start-server.cmd`**，效果等同于 `npm start`。

用的是 Node 内置模块，**零依赖、不需要 npm install、不需要 Python**。这个服务只读地提供本目录文件，带目录穿越防护。

> ⚠️ **不要直接双击 `index.html`。** 浏览器在 `file://` 下会以同源策略为由拒绝加载 ES 模块，页面会表现成「所有按钮都没反应」。真遇到这种情况，请改用本节的方式，或看下面的 C。

**B. GitHub Pages（部署到线上，手机也能开）**

Fork 本仓库 → `Settings → Pages → Build and deployment → Source` 选 **GitHub Actions**。
仓库自带的 `.github/workflows/pages.yml` 会在每次推送时跑一遍测试并发布。稍等片刻访问：

```
https://<你的用户名>.github.io/<仓库名>/
```

> 例如仓库叫 `youtiao`，地址就是 `https://你的用户名.github.io/youtiao/`。

> 想让它首次打开就自动指向你的图床（不必每次手填仓库名），改 `assets/js/config.js` 顶部的 `PREFILL` 即可——那里只影响「浏览器里还没保存过设置」时的初始值。开源版本这里是空的，第一次打开需要自己填。

**C. 单文件版（双击即用，无需服务）**

```bash
npm run build             # 生成 youtiao-standalone.html
```

产物把所有模块内联成了一个**普通** `<script>`（不是 ES 模块），因此绕开了 `file://` 的同源限制，**双击就能用**，也可以拷到 U 盘、离线使用。代价是改代码后要重新 build 一次。

### 第 4 步：填设置并上传

打开页面 → **设置**页填令牌 / 所有者 / 仓库名 / 分支 → 点 **测试连接**（会显示仓库是否公开、有无写入权限、API 额度）→ 回到 **上传**页填邮箱、拖入图片 → **开始上传**。

然后到 **CDN 与 Twikoo** 页复制 `GRAVATAR_CDN` 的值。

---

## 四、配置 Twikoo

Twikoo 后台 → **设置 → 评论 → 头像 CDN**，填入本工具给出的值（**不带** `https://`，**不带** `/avatar`）：

```
GRAVATAR_CDN = cdn.jsdmirror.com/gh/your-name/your-avatar-bed@main
```

如果你用配置文件部署 Twikoo，就是：

```js
twikoo.init({
  envId: '...',
  // 其它配置…
  GRAVATAR_CDN: 'cdn.jsdmirror.com/gh/your-name/your-avatar-bed@main',
  DEFAULT_GRAVATAR: 'mp'
})
```

配好后，评论者 `test@example.com` 的头像地址就是：

```
https://cdn.jsdmirror.com/gh/your-name/your-avatar-bed@main/avatar/973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b?d=mp
```

### CDN 线路怎么选

| 线路 | 基址形态 | 说明 |
| --- | --- | --- |
| jsDelivr 官方 | `cdn.jsdelivr.net/gh/u/r@main` | 全球节点最稳，国内偶发抽风 |
| **cdn.jsdmirror.com** | `cdn.jsdmirror.com/gh/u/r@main` | **默认**，jsDelivr 的国内反代，国内速度通常最好 |
| Gcore 节点 | `gcore.jsdelivr.net/gh/u/r@main` | jsDelivr 的另一条线路，可作备选 |
| Statically | `cdn.statically.io/gh/u/r/main` | 注意路径层级不同 |
| GitHub Raw | `raw.githubusercontent.com/u/r/main` | 国内基本不可用，仅用于排障对照 |
| GitHub Pages | `u.github.io/r` | 需在仓库开启 Pages；本项目的工作流会把 `avatar/` 一起发布 |
| 自定义模板 | 任意 | 支持 `{owner} {repo} {branch} {prefix} {path} {hash}`，用于自建反代 / Cloudflare Worker |

> 覆盖过头像后如果 CDN 还是旧图：`cdn.jsdelivr.net` / `gcore.jsdelivr.net` 用图库里的「刷缓存」立即生效；**`cdn.jsdmirror.com` 刷新不了**，见常见问题。

---

## 五、常见问题

**Q：换了头像，评论里还是旧的？（`cdn.jsdmirror.com` 用户必读）**
分两种情况，因为 `cdn.jsdmirror.com` **不是 jsDelivr 的节点**，而是跑在**腾讯 EdgeOne** 上的第三方镜像（响应头里的 `Server: ayao`、`EO-Cache-Status` 能看出来），有它自己独立的多级缓存：

| 线路 | 覆盖后能否立即生效 |
| --- | --- |
| `cdn.jsdelivr.net` | ✅ 本工具自动调 `purge.jsdelivr.net` 刷新（实测 purge 覆盖它的 CF / Fastly 两个供应商） |
| `gcore.jsdelivr.net` | ✅ 同上（它本身就是 jsDelivr 的 Cloudflare 节点） |
| **`cdn.jsdmirror.com`** | ❌ **刷新不了**。它没有公开的 purge 接口（`purge.jsdmirror.com` 这个域名不存在，`cdn.jsdmirror.com/purge/…` 返回 401 需要授权），缓存最长约 24 小时（浏览器侧 5 分钟） |

用的是 jsdmirror 的话，想立刻换上新头像，三个办法：

1. **让 URL 变一下**（最快）：在 Twikoo 里把 `DEFAULT_GRAVATAR` 从 `mp` 改成别的值（比如 `mp2`）。Twikoo 拼出的头像是 `<cdn>/avatar/<hash>?d=mp`，`d` 一变 URL 就整体变化，等于绕过旧缓存。实测 jsdmirror 的缓存键包含查询串（换新查询串时 `EO-Cache-Status` 从 `HIT` 变 `MISS`），所以这招有效。代价是所有头像会一起重新拉取一次。
2. **换线路**：改成 `cdn.jsdelivr.net` 或 `gcore.jsdelivr.net`，这两条能 purge 立即生效。
3. **自建反代**：用仓库里的 `extras/cloudflare-worker.js`，缓存时长由你自己控制。

**Q：某个评论者一直没头像？**
三种可能：① 他从没在你这里上传过（用「邮箱批量转头像链接」核对，未上传的会标出来）；② 他是 QQ 邮箱，Twikoo 根本不会请求你的图床；③ 哈希对不上，检查邮箱是否有拼写/大小写差异——不过大小写和前后空格已经被 `normalizeMail` 归一化了，不影响。

**Q：仓库必须是公开的吗？**
是。jsDelivr 只读公开仓库。私有仓库需要自建带令牌的反代，本项目不支持。

**Q：图片没有扩展名，浏览器能显示吗？**
能，但要知道确切原因。jsDelivr **不嗅探文件内容**，只按文件名映射 MIME，`LICENSE` / `README` 等少数名字在白名单里才给 `text/plain`；你的 `<sha256>` 不在白名单，所以会得到 `application/octet-stream`，并带 `X-Content-Type-Options: nosniff`。

这个组合是可用的：**在 Chromium/Edge 上实测**（headless，复刻 jsDelivr 全部响应头、跨源 `<img>`）`octet-stream + nosniff` 的 1×1 图片**正常渲染**——浏览器在 `<img>` 场景仍会解码图片。也就是说，Twikoo 评论区的头像能正常显示。

需要留意的是：
- 真正会被浏览器拦掉的是 `text/plain + nosniff`，而本方案的路径不会落到这一组合。
- Firefox / Safari 未做实测（Chromium 之外的行为未确证）。
- 严格校验 MIME 的场景——CSS `background-image`、`<picture>`/`srcset`、图片代理、社交平台抓头像、部分小程序 webview——可能拒绝 `octet-stream`。

想 100% 稳妥就用仓库里附带的 `extras/cloudflare-worker.js`：部署一个免费的 Cloudflare Worker 反代 jsDelivr，按文件魔数强制返回正确的 `Content-Type: image/*`，然后把 CDN 基址换成你的 Worker 域名。

**上线前先花 10 秒确证自己仓库的真实响应头**（把路径换成你自己已上传的一个哈希）：

```bash
curl -sI "https://cdn.jsdmirror.com/gh/你/仓库@main/avatar/<你的某个sha256>" | grep -i "content-type\|x-content-type"
```

看到 `image/*` 最好；看到 `application/octet-stream` 也属正常，按上面的结论使用即可。

**Q：为什么默认是 SHA-256 而不是 MD5？**
Twikoo 只在 CDN 填 `cravatar.cn` 时用 MD5；换成任何自定义 CDN 都会切成 SHA-256。所以自建图床必须用 SHA-256。设置页仍保留 MD5 选项，仅供你把图片喂给 cravatar.cn 这类第三方服务时使用（选中会提示与 Twikoo 不兼容）。

**Q：会不会撞哈希 / 覆盖别人的头像？**
文件名就是邮箱的 SHA-256，**同一邮箱重复上传必然覆盖**（这正是头像更新的机制）。不同邮箱的 SHA-256 碰撞在工程上可以忽略。

**Q：仓库会不会被塞爆？**
GitHub 单仓库建议 1GB 以内，单文件 100MB。头像一般几十 KB，几千个没问题。建议开启「压缩 / 转 WebP」（512px 边长对头像足够）。

**Q：仓库里已经有头像了，图库只显示一串哈希，我想知道这是谁的？**
SHA-256 不可逆，没有任何办法从文件名反推邮箱——这是这套方案的固有代价。点缩略图上的「**备注**」按钮手动关联：如果哈希正好对得上，就记一条备注；如果对不上，工具会明确告诉你不匹配（意味着 Twikoo 用那个邮箱取不到它），并问你要不要把文件移动到正确的路径。

**Q：双击 `index.html` 打开后，所有按钮都按不动？**
这是浏览器的同源策略：`file://` 下会拒绝加载 ES 模块，`app.js` 根本没执行，所以事件绑定都不存在。页面顶部会自动弹出红色提示告诉你怎么办。解决办法任选其一：`npm start` 起本地服务、双击 `start-server.cmd`、用 `youtiao-standalone.html` 单文件版、或部署到 GitHub Pages。

**Q：令牌安全吗？**
令牌只存在你的浏览器（localStorage 或 sessionStorage），所有请求直连 `api.github.com`。请务必使用**只授权该仓库、只有 Contents 读写权限**的细粒度令牌，并避免在公共电脑勾选「保存在浏览器」。

**Q：为什么不用 GitHub OAuth 登录（「用 GitHub 登录」那种按钮）？**
评估过，结论是**故意不用**，理由有两条：

1. **标准 OAuth 授权码流程在纯静态应用里做不了**——用 `code` 换 `token` 必须带上 `client_secret`，而本项目没有后端可以藏它，放在前端等于公开。唯一不需要 secret 的是 Device Flow（实测 GitHub 的 `/login/device/code` 与 `/login/oauth/access_token` 都允许浏览器跨域调用，连 `file://` 的 `Origin: null` 都放行），所以技术上可行。
2. **但它的权限粒度比现在差得多**。OAuth App 只能申请经典 scope：`repo` = **对你所有仓库的完整读写，包括全部私有仓库**；`public_repo` = 所有公开仓库。它没法像细粒度 PAT 那样「只授权这一个图床仓库 + 只有 Contents 读写」。

也就是说：一个只用来存头像的小工具，会让令牌持有者拿到你整个 GitHub 的写权限。一旦泄漏（浏览器扩展、共用电脑、XSS），损失的不是几张头像，而是你所有仓库。所以这里坚持用细粒度 PAT——**最小权限**比少点几下更值。顺带一提，Device Flow 的登录动作其实也不更省事：要手动打开 `github.com/login/device` 输入 8 位代码，而 PAT 是粘一次长期有效。

如果你哪天想要这个功能（比如主要用手机操作），它属于可以加的——但要先想清楚上面第 2 点。

**Q：邮箱备注会不会丢？**
不会了。备注会同步到 GitHub 仓库里的一个文件（默认 `.youtiao/notes.json`），换设备、清浏览器缓存都能拉回来。本地还留一份缓存，所以离线也照样能显示邮箱。

**Q：备注存哪里？会不会泄露评论者的邮箱？**
这是本项目唯一需要你认真权衡的地方，因为**图床仓库必须公开**（jsDelivr 只能读公开仓库）：

| 方案 | 备注隐私 | 耐久性 |
| --- | --- | --- |
| 放在图床仓库（同仓库） | ❌ 邮箱公开可读，谁都能下载这个文件 | ✅ 跨设备不丢 |
| **放在独立私有仓库（推荐）** | ✅ 只有你自己能看 | ✅ 跨设备不丢 |
| 只存浏览器本地 | ✅ 不外泄 | ❌ 清缓存 / 换设备即丢失 |

第一次写入备注时工具会把这件事讲清楚让你选；也可以随时在设置页的「备注同步」卡片里改。想用私有仓库：点「**创建私有备注仓库**」一键建好并切换，或手动填 `owner/repo`（也支持 `owner/repo@分支`）。注意令牌需要对那个仓库同样有 `Contents: Read and write` 权限——细粒度令牌可以同时授权多个仓库。

---

## 六、项目结构

```
youtiao/
├── index.html                  单页应用结构
├── serve.mjs                   本地静态服务（零依赖，npm start）
├── start-server.cmd            Windows 双击启动器
├── youtiao-standalone.html   单文件版（npm run build 生成，双击即用）
├── build/standalone.mjs        把模块内联成单文件的构建脚本
├── assets/
│   ├── style.css               亮/暗双主题样式（无外部依赖）
│   └── js/
│       ├── hash.js             纯 JS 的 SHA-256 / MD5 + 编解码（与 Twikoo 对齐）
│       ├── paths.js            仓库内路径规则（avatar/<hash>、无扩展名）
│       ├── cdn.js              CDN 基址、直链、Twikoo 值、purge 地址
│       ├── github.js           GitHub REST 客户端（文件树 / 上传 / 删除 / 重命名）
│       ├── config.js           设置读写（令牌分 local/session、PREFILL 预填值）
│       ├── notes.js            「邮箱 ↔ 哈希」备注：文档模型 + 合并 + 本地缓存
│       ├── notes-sync.js       备注与 GitHub 仓库的同步（拉取 / 推送 / 冲突重试）
│       ├── image.js            图片读取、可选压缩、MIME 魔数嗅探
│       ├── format.js           体积/时间/CSV/Markdown/分页
│       ├── ui.js               toast、对话框、剪贴板、灯箱、主题
│       └── app.js              主应用与全部交互
├── extras/cloudflare-worker.js 可选：修正无扩展名文件的 Content-Type
├── tests/                      node --test 单元测试
└── .github/workflows/pages.yml 测试 + 发布到 GitHub Pages
```

---

## 七、本地开发与测试

不需要安装任何依赖：

```bash
git clone <本仓库>
cd youtiao
npm test          # 等价于 node --test，109 个用例通过（装上 jsdom 则 110 个全通过）
npm start         # 起本地服务并打开浏览器
npm run build     # 生成单文件版 youtiao-standalone.html
```

项目**零运行依赖**，不需要 `npm install`。

测试覆盖的内容（都是真跑，不是占位）：

| 文件 | 覆盖点 |
| --- | --- |
| `tests/hash.test.mjs` | SHA-256 / MD5 与 `node:crypto` 逐位对拍（含 200 组随机 Unicode 字符串、多分组边界长度）、base64 编码、`normalizeMail` 与 Twikoo 逐字一致 |
| `tests/cdn.test.mjs` | 8 条 CDN 线路的基址、Twikoo 的 `GRAVATAR_CDN` 取值规则、复刻 Twikoo 的请求 URL 模板、purge 地址、路径规则 |
| `tests/github.test.mjs` | 用假 fetch 校验交互：文件树过滤、上传（新建 / 跳过 / 覆盖 / 已知 sha 直传）、非 sha 的 422 不得误判为「已存在」、删除、重命名、空仓库 409、错误提示、速率限制记录 |
| `tests/format.test.mjs` | 体积格式化、分页夹紧、CSV 转义与 BOM、Markdown 生成 |
| `tests/wiring.test.mjs` | 静态契约：脚本引用的 DOM id 都存在、无重复 id、import 的符号真的被导出、资源路径存在 |
| `tests/serve.test.mjs` | 本地服务真实 HTTP：`.js` 必须是 JS MIME（否则 ES 模块被拒）、不缓存、HEAD/POST、404、**目录穿越不能读到站点外文件**、URL 编码损坏返回 400、端口占用自动顺延 |
| `tests/notes.test.mjs` | 备注文档模型：脏数据归一化、按时间取新的合并、**删除不会被远程旧数据复活**（墓碑）、序列化稳定、备注文件不能落在 `avatar/` 目录、私有仓库目标的解析 |
| `tests/notes-sync.test.mjs` | 同步行为：第一次同步是「创建文件」而非报 422、推送前先合并远程（别的设备写的不能丢）、**sha 冲突后合并重试**、关掉开关后零请求、防抖只推一次 |
| `tests/config.test.mjs` | 存储键迁移（旧版 `gh-avatar-bed.*` → `youtiao.*`），保证改名后令牌与备注不丢 |
| `tests/dom.test.mjs` | **可选**：用 jsdom 把 `index.html` 真的跑起来，验证启动渲染、邮箱实时预览、批量生成器、不兼容配置警告、标签页切换。项目本身零依赖，未安装 jsdom 时该用例自动跳过（`npm i -D jsdom` 可启用） |

项目里的哈希实现是手写的纯 JS（为了避免 `crypto.subtle` 的异步与安全上下文限制，也为了能在 Node 里直接对拍），所以第一组测试专门盯着它——所有常量写错一位都会被立刻抓住。

---

## 八、实测记录

开发过程中实际抓过的数据，供你判断可靠性：

| 结论 | 验证方式 |
| --- | --- |
| Twikoo 自定义 CDN 用 SHA-256，只有 `cravatar.cn` 用 MD5 | 反编译 `twikoo@1.7.22` 的 `dist/twikoo.min.js`，定位到 `const e = "cravatar.cn" === this.gravatarCdn ? md5 : sha256` |
| Twikoo 会硬编码追加 `/avatar/` | 同一处代码模板 `` `https://${this.gravatarCdn}/avatar/${e(...)}?d=${...}` `` |
| `normalizeMail = String(e).trim().toLowerCase()` | 同一文件内 `t.normalizeMail` 的实现 |
| jsDelivr 的 purge 接口可跨域调用 | `GET https://purge.jsdelivr.net/gh/twikoojs/twikoo@main/package.json` → `200`，`Access-Control-Allow-Origin: *` |
| **purge 只覆盖 jsDelivr 自家的 CDN** | 响应体里是 `"providers": { "CF": true, "FY": true }`，即 Cloudflare 与 Fastly；`cdn.jsdelivr.net` 实测 `X-Served-By: cache-fra-…`（Fastly），`gcore.jsdelivr.net` 实测 `Server: cloudflare` + `CF-Cache-Status` |
| **`cdn.jsdmirror.com` 是独立的第三方 CDN，purge 管不到** | 响应头 `Server: ayao`、`X-Served-By: ayao`、`EO-Cache-Status: HIT`、`EO-LOG-UUID` → 腾讯 EdgeOne；`purge.jsdmirror.com` 域名不存在（TLS 连不上），`cdn.jsdmirror.com/purge/…` → `401` |
| jsdmirror 的缓存策略 | `Cache-Control: public, max-age=300, stale-while-revalidate=86400` → 浏览器 5 分钟，边缘最长继续用旧副本约 24 小时 |
| jsdmirror 的缓存键**包含查询串**（所以能用改 URL 的方式绕过旧缓存） | 同路径请求：无查询串 → `EO-Cache-Status: HIT`；带一个全新查询串 → `MISS`；再请求无查询串 → 仍 `HIT` |
| GitHub API 允许任意来源（含 `file://`） | 带 `Origin: null` 请求 `api.github.com/rate_limit` → `Access-Control-Allow-Origin: *` |
| jsDelivr 会忽略查询串 | `GET .../node@main/LICENSE?d=mp` → `200`，正常返回文件 |
| jsDelivr **不嗅探内容**，只按文件名映射 MIME（`LICENSE`/`README` 等少数名字在白名单） | `.../node@main/LICENSE` → `text/plain; charset=utf-8`，而同为纯文本、无扩展名的 `Dockerfile`、`prepare` → `application/octet-stream` |
| 因此 `<sha256>` 命名的文件**必然**返回 `application/octet-stream` + `X-Content-Type-Options: nosniff` | 该名字不在 jsDelivr 的 MIME 白名单内 |
| 但 Chromium 仍会正常渲染这种图片 | headless Chromium 复刻 jsDelivr 全部响应头做跨源 `<img>` 实测：`octet-stream + nosniff` → 正常渲染；`text/plain + nosniff` → 被拦截（本方案不会落到后者） |
| weavatar.com 就是「SHA-256 + 无扩展名路径」的线上真实实现 | `GET https://weavatar.com/avatar/<sha256("test@example.com")>` → `200`，`Content-Type: image/webp` |
| 本方案在真实仓库上跑通完整链路 | 在一个公开仓库的 `avatar/<sha256>` 上实测：jsDelivr / `cdn.jsdmirror.com` / Gcore 三个端点（含 Twikoo 会带的 `?d=mp`）全部 `200`，`Content-Type: application/octet-stream` + `nosniff`，返回字节数与 Git Trees API 报告的文件大小完全一致，且文件是合法可解码的 WebP |

---

## 九、与 WeAvatar 的关系

WeAvatar / Cravatar 是**别人运营的服务**，你只能使用、无法掌控。本项目借用了它「邮箱哈希当文件名」的思路，但把存储换成了**你自己的 GitHub 仓库**：数据在你手里、没有第三方服务可以消失或改变规则、也没有任何 API 配额。代价是你要自己保管一个令牌。

## 十、许可

[MIT](LICENSE)
