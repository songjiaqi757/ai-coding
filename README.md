# BookiBuddy - 本地优先的 AI 阅读器

BookiBuddy 是一个基于 Tauri、React、TypeScript、Rust 和 SQLite 的跨平台桌面 AI 阅读器。它面向 RSS / Atom / JSON Feed 阅读场景，支持订阅源管理、OPML 导入导出、文章同步、正文清洗、已读状态、收藏、批注、AI 摘要和 AI 翻译。

项目坚持本地优先和模型中立：无需注册登录，不自建云端服务器，用户数据默认保存在本地 SQLite；只有用户主动触发摘要或翻译时，文章内容才会发送到用户自己配置的 LLM Provider。

## 项目定位

BookiBuddy 的目标不是做一个云端账号型阅读器，而是做一个隐私边界清晰、可离线保存阅读数据、可由用户自行选择模型服务的桌面阅读工具。

核心目标：

- 通过三栏界面管理订阅源、文章列表和阅读正文；
- 支持真实 RSS / Atom / JSON Feed 和 OPML 批量导入；
- 将 Feed、Article、同步状态、批注、摘要、翻译和设置保存在本地；
- 对文章网页执行 `raw_html -> cleaned_html -> cleaned_markdown` 清洗 pipeline；
- 通过统一 LLM Provider 接口支持摘要、翻译和划词翻译；
- 避免在业务代码中绑定单一模型厂商。

## 当前功能

### Feed 与 OPML

- 添加单个 RSS / Atom / JSON Feed URL；
- 支持 `feed://`、协议相对 URL、裸域名等常见输入规范化；
- 支持 OPML 导入和导出；
- 支持从网页自动发现 `<link rel="alternate">` 中声明的订阅源；
- 支持常见 Feed 路径探测，例如 `/feed`、`/feed.xml`、`/rss.xml`；
- 订阅源 URL 去重，文章按 Feed + URL / GUID / 标题发布时间去重；
- 订阅源刷新和 Sync All；
- 自动同步配置：启用后应用运行期间按间隔执行同步；
- 失败订阅源记录、失败数提示和按重试上限重试。

### 阅读与文章状态

- 三栏布局：订阅源、文章列表、阅读器；
- 全部订阅、收藏等智能视图；
- 全文搜索，包含标题、正文、清洗正文和批注内容；
- 全部 / 未读 / 已读筛选；
- 长文章根据滚动进度自动标记已读；
- 短文章停留一段时间后自动标记已读；
- 收藏文章；
- Saved Articles 本地文章分组，用于保存手动抓取的网页文章。

### 内容清洗

- 用户打开订阅文章或手动输入 URL 时抓取网页 HTML；
- 使用 Node 清洗脚本结合 Readability、DOMPurify、Turndown 提取正文；
- Rust fallback 清洗器作为备用路径；
- 生成并保存 `raw_html`、`cleaned_html`、`cleaned_markdown`；
- 识别站点返回的浏览器/广告拦截占位页，避免把错误页当正文保存；
- 对正文清洗失败或目标站限制抓取的文章回退到 Feed 自带摘要 / 内容展示。

### AI 摘要与翻译

- 摘要 Agent：按用户选择的目标语言生成短摘要；
- 翻译 Agent：按段落结构生成文章翻译；
- 原文 / 对照翻译视图；
- 划词翻译；
- 摘要和翻译结果本地缓存；
- 支持重新生成；
- 摘要和翻译可分别配置 Base URL、API Key 和模型名称；
- API Key 存放在系统凭据库中，而不是 SQLite 明文表中。

### 批注

- 支持选中文本高亮；
- 支持笔记；
- 支持高亮颜色和高亮样式；
- 批注保存在本地 SQLite；
- 阅读器内可打开批注面板查看、编辑和删除。

## 技术架构

| 层级 | 技术 / 模块 | 说明 |
|---|---|---|
| 桌面壳 | Tauri 2 | 提供桌面窗口、本地能力和 Rust command bridge |
| 前端 | React 18 + TypeScript strict + Vite | 三栏阅读 UI、设置面板、阅读交互 |
| 后端 | Rust | Feed 解析、数据库、同步、清洗调度、LLM 调用 |
| 数据库 | SQLite + rusqlite | 本地保存 Feed、Article、Settings、Sync Failures、Annotations |
| Feed 解析 | feed-rs / opml | RSS、Atom、JSON Feed、OPML |
| 网页抓取 | reqwest | Feed 请求和文章 HTML 请求 |
| 内容清洗 | Readability + DOMPurify + Turndown | HTML 正文提取、净化和 Markdown 转换 |
| 凭据存储 | keyring | macOS Keychain / Windows Credential Manager / Linux Secret Service |
| AI Provider | OpenAI-compatible HTTP API | 摘要、翻译、划词翻译统一经过 Provider 接口 |

### 架构边界

- UI 不直接访问数据库或文件系统，必须通过 Tauri commands；
- 用户数据默认保存到本地 SQLite；
- Feed、Article、LLM Provider、Agent、OPML 和 Sync 逻辑保持模块化；
- LLM 调用统一经过 Provider 接口；
- Summary Agent 和 Translation Agent 不关心具体模型厂商；
- 内容清洗 pipeline 明确区分 `raw_html`、`cleaned_html`、`cleaned_markdown`。

## 隐私边界

BookiBuddy 遵守以下隐私约束：

- 不实现注册登录；
- 不自建云端服务器；
- 不主动上传用户数据；
- Feed、文章、批注、摘要、翻译和设置默认保存在本地；
- OPML 导入只读取用户选择的本地文件；
- 自动同步只请求用户添加或导入的订阅源 URL；
- 文章网页只在用户打开文章、点击清洗或手动抓取 URL 时访问；
- 只有用户主动点击摘要、翻译或划词翻译时，相关文本才会发送到用户配置的 LLM Provider；
- API Key 不提交到仓库，不写入 SQLite 明文表，保存到系统凭据库。

更详细说明见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 项目结构

```text
ai-coding/
├── README.md
├── AGENTS.md
├── INIT.md
├── PLAN.md
├── docs/
│   ├── PRIVACY.md
│   ├── SYNC_AND_READ_STATUS.md
│   ├── feed-refresh-save-article-test.md
│   ├── test-adjustment-record.md
│   └── phase2-changelog.md
├── samples/
│   └── opml/
│       ├── example.opml
│       ├── live-test.opml
│       └── compatibility-test.opml
└── app/
    ├── src/
    │   ├── App.tsx
    │   ├── App.css
    │   ├── components/
    │   │   ├── ArticleList.tsx
    │   │   └── Sidebar.tsx
    │   ├── types.ts
    │   └── main.tsx
    ├── scripts/
    │   └── article-cleaner.mjs
    ├── src-tauri/
    │   ├── src/
    │   │   ├── lib.rs
    │   │   ├── llm_provider.rs
    │   │   ├── opml.rs
    │   │   ├── sync.rs
    │   │   └── main.rs
    │   ├── Cargo.toml
    │   └── tauri.conf.json
    ├── package.json
    ├── package-lock.json
    └── pnpm-lock.yaml
```

## 本地运行

### 环境要求

| 工具 | 建议版本 | 用途 |
|---|---:|---|
| Node.js | 18+ | 前端依赖和 Vite |
| npm | 9+ | 安装和运行脚本 |
| Rust / Cargo | stable | 编译 Tauri 后端 |
| Tauri 系统依赖 | Tauri 2 要求 | 桌面应用构建 |

macOS:

```bash
xcode-select --install
```

Ubuntu / Debian:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

Windows 需要安装 Visual Studio Build Tools，并勾选 C++ build tools。

### 安装依赖

```bash
cd app
npm install
```

### 启动开发应用

```bash
cd app
npm run tauri dev
```

### 前端构建检查

```bash
cd app
npm run build
```

### Rust 检查

```bash
cd app/src-tauri
cargo check
```

### 生产构建

```bash
cd app
npm run tauri build
```

构建产物位于：

```text
app/src-tauri/target/release/bundle/
```

## LLM Provider 配置

打开应用设置后，可以分别配置摘要和翻译服务：

| 配置项 | 说明 | 示例 |
|---|---|---|
| Summary API Base URL | 摘要服务地址 | `https://api.openai.com`、`http://localhost:11434` |
| Summary API Key | 摘要服务 API Key | `sk-...`，本地服务可留空 |
| Summary Model | 摘要模型 | `gpt-4o-mini`、`deepseek-chat`、`llama3` |
| Translation API Base URL | 翻译服务地址 | `https://api.openai.com`、`http://localhost:11434` |
| Translation API Key | 翻译服务 API Key | `sk-...`，本地服务可留空 |
| Translation Model | 翻译模型 | `gpt-4o-mini`、`deepseek-chat`、`llama3` |

API Key 会保存到系统凭据库。macOS 开发版可能显示 “app 想要访问你的钥匙串中的密钥 com.songjiaqi757.bookibuddy” 弹窗，这是系统在保护本地密钥，不是注册登录。

## 手动验收建议

### Feed / OPML

1. 添加 `https://planetpython.org/rss20.xml`，应能导入文章；
2. 添加 `https://xkcd.com/atom.xml`，应能解析 Atom；
3. 添加 `https://daringfireball.net/feeds/json`，应能解析 JSON Feed；
4. 导入 `samples/opml/compatibility-test.opml`，应显示成功和失败明细；
5. 导出 OPML，应生成本地 `.opml` 文件；
6. 点击 Sync All，应展示同步进度；
7. 开启自动同步并保存配置，应用运行期间应按间隔同步。

### 文章阅读

1. 点击文章，右侧应显示 Feed 内容或清洗后的正文；
2. 长文章滚动到一定进度后应自动标记已读；
3. 短文章停留一段时间后应自动标记已读；
4. 收藏文章后，应出现在收藏视图中；
5. 搜索标题、正文或批注内容，应返回匹配文章。

### 内容清洗

1. 手动抓取文章 URL；
2. 应保存到 Saved Articles；
3. `raw_html`、`cleaned_html`、`cleaned_markdown` 应写入本地数据库；
4. 对返回反爬或浏览器占位页的网站，不应把错误页当正文展示。

### AI 功能

1. 配置摘要和翻译 Provider；
2. 点击摘要，应生成并缓存摘要；
3. 点击翻译，应生成并缓存翻译；
4. 切换对照翻译视图，应按原文段落展示译文；
5. 划词翻译应只发送选中文本。

## 已知限制

- 某些网站会对抓取请求返回 `403`、登录页、广告拦截提示或浏览器占位页，这是目标站策略，不代表 Feed 解析失败；
- 自动同步只在应用运行期间执行，不是系统级后台守护进程；
- 开发模式下为了避免 React Fast Refresh 与外部 DOM 修改冲突，React 源文件变更会触发整页刷新；
- macOS / Windows 正式分发如需减少系统安全提示，后续仍需要签名和 notarization。

## GitHub Actions 构建

仓库配置了桌面应用构建工作流，工作流文件位于：

```text
.github/workflows/release.yml
```

它用于课程小组和团队成员测试构建产物，默认更适合作为 prerelease 产物使用。当前构建不包含 Windows 代码签名，也不依赖 Apple Developer secrets。

## 开发文档

- [AGENTS.md](AGENTS.md)：AI Coding Agent 协作约束；
- [PLAN.md](PLAN.md)：阶段计划；
- [docs/PRIVACY.md](docs/PRIVACY.md)：隐私边界；
- [docs/SYNC_AND_READ_STATUS.md](docs/SYNC_AND_READ_STATUS.md)：同步和已读状态设计；
- [docs/feed-refresh-save-article-test.md](docs/feed-refresh-save-article-test.md)：刷新与 Saved Articles 测试记录；
- [docs/test-adjustment-record.md](docs/test-adjustment-record.md)：测试调整记录；
- [docs/phase2-changelog.md](docs/phase2-changelog.md)：Feed / OPML 阶段历史记录。

## 小组成员

| 序号 | 姓名 | 学号 |
|---|---|---|
| 1 | 宋佳琦 | 51285903003 |
| 2 | 马淑玥 | 51285903001 |
| 3 | 汪柔柔 | 51285903093 |
| 4 | 李怡萱 | 51285903059 |
| 5 | 孔慧婷 | 51285903085 |
| 6 | 何霜 | 51285903087 |
| 7 | 刘永哲 | 51285903033 |
| 8 | 周倩 | 51285903084 |
| 9 | 张钰婷 | 51285903063 |
