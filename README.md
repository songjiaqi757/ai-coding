# Mercury - AI Reader

Mercury 是一个跨平台、模型中立的 AI 阅读器项目。项目目标是构建一个无需注册登录、默认将数据保存在用户本地的桌面阅读器，并支持 Feed/OPML 订阅、文章内容清洗、AI 摘要和 AI 翻译。

本项目采用 AI 协作开发方式：人类负责需求判断、架构设计、代码审查和最终验收，AI 负责辅助生成代码、补充文档、实现模块和协助重构。

## 一、项目背景

在 AI 编程时代，软件开发不再只是单纯编写代码，而是更强调需求拆解、架构设计、文档约束、代码审查和持续迭代。

Mercury 项目参考了 PDF 案例中 Reversi 项目的开发方法：先通过文档明确目标、约束和计划，再逐步完成可验证的功能模块。项目聚焦于 AI 阅读器场景，避免依赖复杂账号系统。

## 二、项目目标

构建一个跨平台 AI 阅读器，支持用户管理订阅源、阅读文章，并在用户主动触发时调用配置好的大语言模型完成摘要或翻译。

核心目标包括：

1. 提供清晰、简洁的三栏阅读器界面；
2. 支持 Feed / OPML 解析和本地订阅源刷新；
3. 支持文章正文清洗，生成适合阅读的 Cleaned HTML 和 Cleaned Markdown；
4. 支持 Summary Agent，对文章生成摘要；
5. 支持 Translation Agent，对文章进行翻译；
6. 支持不同 LLM Provider，避免绑定单一模型厂商；
7. 默认将用户数据保存在本地，保护用户隐私。

## 三、必须完成的功能

根据项目要求，MVP 阶段主要完成以下四类功能。

### 1. Feed / OPML 解析 + Sync + 内容呈现

- 支持添加 RSS / Atom / JSON Feed 订阅源；
- 支持 OPML 文件导入；
- 支持订阅源刷新；
- 将订阅源和文章保存到本地数据库；
- 在阅读器界面中展示 Feed 列表、文章列表和文章内容。

这里的 Sync 指的是从订阅源拉取最新文章并同步到本地数据库，不是云端同步。

### 2. 内容清洗

- 抓取文章原始网页内容；
- 提取正文；
- 生成 Cleaned HTML；
- 生成 Cleaned Markdown；
- 提供适合阅读的样式展示。

### 3. Summary Agent + LLM Providers

- 支持用户对当前文章生成摘要；
- 支持摘要结果本地缓存；
- 支持重新生成摘要；
- 通过统一 LLM Provider 接口调用模型；
- 支持本地模型或标准 API 模型服务。

### 4. Translation Agent

- 支持文章翻译；
- 支持原文、译文、双语视图；
- 支持翻译结果本地缓存；
- 不在用户未主动触发时上传文章内容。

## 四、技术约束

### 1. 产品体验

应用需要具备简洁、清晰、易用的阅读体验。界面应以阅读为中心，避免过多干扰元素。

### 2.

- 用户无需注册；
- 用户无需登录；
- 不主动采集用户数据；
- 不依赖自建云端服务器；
- Feed、文章、摘要、翻译和设置默认保存在用户本地。

### 2. 平台中立

项目不做 macOS native 专用版本，而是采用跨平台桌面技术栈，尽量使用一份代码支持：

- Windows；
- Linux；
- macOS。

### 3. 大模型中立

项目不绑定某一家模型厂商。AI 摘要和翻译功能通过统一 LLM Provider 接口实现，用户可以配置：

- 本地模型；
- OpenAI-compatible API；
- 其他提供标准 API 的大语言模型服务。

## 五、技术选型

| 模块 | 技术 |
|---|---|
| 桌面应用框架 | Tauri |
| 前端框架 | React |
| 前端语言 | TypeScript |
| 后端语言 | Rust |
| 本地数据库 | SQLite |
| 数据库访问 | rusqlite |
| 构建工具 | Vite |
| 包管理器 | pnpm |

选择 Tauri 的原因是它适合构建本地桌面应用，能够用一套代码开发跨平台程序，同时结合 Rust 后端处理本地文件、数据库和系统能力。

## 六、当前项目进度

### 已完成

- 初始化 GitHub 仓库；
- 创建 Phase 0 项目脚手架；
- 创建 Tauri + React + TypeScript 桌面应用；
- 创建项目文档：
  - `INIT.md`
  - `AGENTS.md`
  - `PLAN.md`
  - `docs/PRIVACY.md`
- 完成 Mercury 三栏阅读器界面；
- 完成基础 Reader Shell Demo；
- 接入本地 SQLite 数据库；
- 通过 Tauri Rust commands 从本地数据库读取 Feed 和 Article 示例数据。

### 当前 Demo 状态

当前版本属于本地数据 Demo，已经不是纯静态界面。应用可以：

- 启动桌面窗口；
- 展示 Mercury 阅读器界面；
- 展示 Feed 列表；
- 展示文章列表；
- 展示文章阅读区；
- 从本地 SQLite 数据库读取示例数据；
- 预留 Summary 和 Translate 功能入口。

### 尚未完成

- 真实 Feed URL 添加；
- RSS / Atom / JSON Feed 解析；
- OPML 导入导出；
- 真实文章抓取；
- Cleaned HTML / Cleaned Markdown；
- Windows / Linux 打包。

## 七、项目结构

~~~text
ai-coding/
├── README.md
├── INIT.md
├── AGENTS.md
├── PLAN.md
├── docs/
│   └── PRIVACY.md
├── samples/
│   ├── feeds/
│   ├── opml/
│   └── articles/
└── app/
    ├── src/
    │   ├── App.tsx          # 主界面 + AI 功能
    │   ├── App.css          # 全部样式
    │   ├── index.css
    │   └── main.tsx
    ├── src-tauri/
    │   ├── src/
    │   │   ├── lib.rs           # Tauri commands + DB
    │   │   ├── llm_provider.rs  # LLM API 调用模块
    │   │   └── main.rs
    │   ├── Cargo.toml
    │   └── tauri.conf.json
    ├── package.json
    └── pnpm-lock.yaml
~~~

## 八、本地运行方式

### 环境要求

需要安装以下工具：

| 工具 | 用途 | 安装方式 |
|------|------|----------|
| Node.js (v18+) | 前端构建 | https://nodejs.org |
| Rust + Cargo | 后端编译 | https://rustup.rs |
| Tauri 系统依赖 | 桌面应用构建 | 见下方说明 |

### 安装 Tauri 系统依赖

**Windows**: 安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选 "C++ build tools"。

**macOS**: 运行 `xcode-select --install`。

**Linux (Ubuntu)**: `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`

### 安装步骤

1. **安装前端依赖**：

~~~bash
cd app
npm install
~~~

2. **启动开发模式**：

~~~bash
npm run tauri dev
~~~

首次运行会编译 Rust 依赖，耗时较长（约 5-10 分钟）。后续启动会快很多。运行成功后自动打开 Mercury 桌面应用窗口。

3. **配置 LLM Provider**：

应用启动后，点击左侧边栏底部的 **Settings** 按钮，填入：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| API Base URL | LLM 服务地址 | `https://api.openai.com` 或 `http://localhost:11434`（Ollama） |
| API Key | API 密钥 | `sk-...`（Ollama 留空） |
| Model Name | 模型名称 | `gpt-3.5-turbo`、`deepseek-chat`、`llama3` |

配置保存后即可使用 Summary 和 Translate 功能。

### 构建生产版本

~~~bash
cd app
npm run tauri build
~~~

构建产物在 `app/src-tauri/target/release/bundle/` 目录下。

## 九、开发环境参考

~~~text
node v20.15.0
npm 10.8.1
rustc 1.87.0
cargo 1.87.0
~~~

## 十、开发计划

### Phase 0：项目脚手架

- 初始化文档；
- 初始化 Tauri + React + TypeScript；
- 确认桌面应用可以运行。

状态：已完成。

### Phase 1：本地数据和阅读器外壳

- 完成三栏阅读器界面；
- 接入 SQLite；
- 通过 Tauri command 读取本地数据。

状态：进行中 / 基本完成。

### Phase 2：Feed / OPML / Sync

- 添加 Feed URL；
- 解析 RSS / Atom / JSON Feed；
- 支持 OPML 导入导出；
- 将文章同步到本地数据库。

状态：待完成。

### Phase 3：内容清洗

- 抓取文章网页；
- 提取正文；
- 生成 Cleaned HTML；
- 生成 Cleaned Markdown；
- 优化阅读样式。

状态：待完成。

### Phase 4：LLM Provider

- 设计统一 LLM Provider 接口（OpenAI-compatible）；
- 支持本地模型（Ollama）和标准 API 模型服务；
- 前端 Settings 面板配置 API Base URL / API Key / Model Name；
- 配置持久化到本地 SQLite settings 表。

状态：已完成。

### Phase 5：Summary Agent

- 对文章生成摘要（通过 LLM）；
- 摘要结果本地缓存（SQLite summary 列）；
- 支持重新生成摘要（Regenerate）；
- 前端 Summary 按钮替换 alert()，支持 loading 和错误提示。

状态：已完成。

### Phase 6：Translation Agent

- 对文章生成翻译（通过 LLM）；
- 支持中文、英文、日文、韩文等多语言选择；
- 支持原文、译文、双语对照三种阅读视图；
- 翻译结果本地缓存（SQLite translation 列）。

状态：已完成。

### Phase 7：打包和演示

- Windows 打包；
- Linux 打包；
- 补充使用说明；
- 完成演示视频或现场展示材料。

状态：待完成。

## 十一、小组成员

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
