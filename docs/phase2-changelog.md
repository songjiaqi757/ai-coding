# Phase 2 变更说明：Feed / OPML / Sync

> 本文档面向后续 Phase（Phase 3 ~ 7）的开发同学，帮助你快速了解 Phase 2 做了什么、改了哪些文件、数据库结构有什么变化。

---

## 一、Phase 2 做了什么

Phase 1 的应用是一个**本地数据 Demo**：界面能跑，但 Feed 和文章都是 `seed_database()` 硬编码的假数据，不能添加真实订阅源。

Phase 2 把它变成了一个**能真正工作的 RSS 阅读器**：

| 能力 | Phase 1 | Phase 2 之后 |
|---|---|---|
| 数据来源 | 硬编码假数据 | 真实 RSS/Atom/JSON Feed |
| 添加订阅源 | 不支持 | 输入 URL → 自动拉取、解析、入库 |
| 刷新订阅源 | 不支持 | 重新拉取，去重保存新文章 |
| OPML 批量导入 | 不支持 | 选择 .opml 文件，批量添加所有源 |
| 按源过滤文章 | 不支持 | 点左侧 Feed，右侧只显示对应文章 |
| 未读数统计 | 不支持 | 每个 Feed 实时显示未读数 |
| 文章去重 | 不支持 | URL 唯一约束，重复文章自动跳过 |

---

## 二、数据库结构变化（重要）

Phase 2 对 SQLite 表结构做了**不兼容的改动**。如果你本地有 Phase 1 的旧数据库，需要删掉让它重新初始化。

数据库文件位置：`%APPDATA%/com.songjiaqi757.mercury/mercury.db`（Windows）

### feeds 表

```sql
-- Phase 1
feeds (id TEXT PRIMARY KEY, title TEXT, unread INTEGER)

-- Phase 2（新增 url, site_url, last_sync_at, 时间戳）
feeds (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL UNIQUE,        -- 新增：订阅源 URL
    site_url    TEXT,                        -- 新增：站点首页 URL
    unread      INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,                       -- 新增：上次同步时间
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
```

### articles 表

```sql
-- Phase 1
articles (id, feed_id, title, source, published_at, excerpt, content, read_status)

-- Phase 2（新增 url, guid, author, raw_html，去重约束）
articles (
    id           TEXT PRIMARY KEY,
    feed_id      TEXT NOT NULL,
    title        TEXT NOT NULL,
    url          TEXT NOT NULL,               -- 新增：文章链接
    guid         TEXT,                        -- 新增：RSS 唯一标识
    author       TEXT,                        -- 新增：作者
    published_at TEXT,
    excerpt      TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL DEFAULT '',
    raw_html     TEXT,                        -- 新增：原始 HTML（预留给 Phase 3）
    read_status  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(feed_id) REFERENCES feeds(id),
    UNIQUE(feed_id, url)                     -- 新增：去重约束
)
```

> **`raw_html` 字段** 是为 Phase 3（内容清洗）预留的。Phase 3 可以在这里存储抓取到的原始网页 HTML，清洗后的结果放 `content`。

---

## 三、文件变动清单

### 新增文件

| 文件 | 说明 |
|---|---|
| `app/src-tauri/src/opml.rs` | OPML 解析模块，`import_opml` Tauri command |
| `app/src/components/Sidebar.tsx` | 左侧栏：Feed 列表、添加订阅、OPML 导入、刷新 |
| `app/src/components/ArticleList.tsx` | 中间栏：文章列表、搜索框、空状态 |
| `app/src/types.ts` | TypeScript 类型定义（Feed、Article），与 Rust 结构体对应 |
| `samples/opml/example.opml` | 示例 OPML 文件（阮一峰、Hacker News、NASA） |
| `docs/FEED_OPML.md` | OPML 功能使用说明 |

### 修改文件

| 文件 | 变动 |
|---|---|
| `app/src-tauri/src/lib.rs` | 重构：新 Schema、`add_feed`、`refresh_feed`、`save_articles`，删掉 `seed_database` 的假数据 |
| `app/src-tauri/Cargo.toml` | 新增依赖：reqwest、feed-rs、opml、uuid、tokio、tauri-plugin-dialog |
| `app/src/App.tsx` | 重写：从单文件拆为三栏组件拼装，调用真实 Tauri commands |
| `app/src/App.css` | 新增：对话框、Feed 操作按钮、阅读区响应式样式 |
| `app/src-tauri/capabilities/default.json` | 新增 `dialog:default` 权限（OPML 文件选择） |
| `app/package.json` | 新增 `@tauri-apps/plugin-dialog` 前端依赖 |

---

## 四、Tauri Commands 接口

Phase 2 注册了以下 Tauri commands，前端通过 `invoke()` 调用：

```typescript
// 添加订阅源：传入 URL，拉取并解析 Feed，返回新建的 Feed 对象
invoke<Feed>("add_feed", { url: string })

// 刷新订阅源：重新拉取，去重保存新文章，返回最新文章列表
invoke<Article[]>("refresh_feed", { feedId: string })

// 列出所有订阅源（含未读数统计）
invoke<Feed[]>("list_feeds")

// 列出文章：feedId 为 null 返回全部，传 Feed ID 只返回该源的文章
invoke<Article[]>("list_articles", { feedId: string | null })

// OPML 导入：弹出文件选择框，解析 OPML，批量添加 Feed
invoke<Feed[]>("import_opml", { filePath: string })
```

---

## 五、TypeScript 类型定义（`src/types.ts`）

```typescript
export type Feed = {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  unread: number;
  lastSyncAt: string | null;
};

export type Article = {
  id: string;
  feedId: string;
  title: string;
  url: string;
  author: string | null;
  publishedAt: string | null;
  excerpt: string;
  content: string;
};
```

> **后续 Phase 注意**：如果 Rust 端的 `Feed` 或 `Article` 结构体新增字段，`types.ts` 需要同步更新，字段名用 camelCase（Rust 端 `#[serde(rename_all = "camelCase")]` 会自动转换）。

---

## 六、前端组件结构

```
App.tsx（主壳：状态管理 + 三栏布局）
├── Sidebar.tsx（左侧栏）
│   ├── Feed 列表（含 All Feeds 入口）
│   ├── + 按钮 → 添加订阅对话框
│   └── ↑ 按钮 → OPML 文件导入
├── ArticleList.tsx（中间栏）
│   ├── 搜索框（UI 已有，功能未实现）
│   └── 文章卡片列表
└── Reader（右侧栏，直接在 App.tsx 内）
    ├── 文章标题 + 作者 + 日期
    ├── 摘要 / 翻译按钮（目前是占位 alert）
    └── 文章正文（dangerouslySetInnerHTML）
```

---

## 七、Phase 3 开发需要注意的

1. **`raw_html` 字段已预留**，可以直接用来存抓取到的原始网页 HTML
2. **`content` 字段**目前存的是 RSS Feed 里的原始内容（可能是 HTML），Phase 3 清洗后可以覆盖写入
3. Rust 端的 `open_database()` 和 `save_articles()` 已声明为 `pub`，新模块可以通过 `use crate::xxx` 调用
4. 前端的摘要/翻译按钮在 `App.tsx` 的 Reader 区域，目前是 `alert()` 占位，Phase 5/6 替换为真实调用即可

---

## 八、Phase 2 分工

| 成员 | 角色 | 负责内容 |
|---|---|---|
| 孔慧婷 | Person A（Rust 后端） | 数据库 Schema 重构、add_feed、refresh_feed、save_articles、依赖管理 |
| 何霜 | Person B（前端 UI） | Sidebar、ArticleList 组件、types.ts、App.tsx 重写、CSS 样式 |
| 汪柔柔 | Person C（OPML + 集成） | opml.rs、example.opml、FEED_OPML.md、三人代码集成 |

---

*最后更新：Phase 2 完成时*
