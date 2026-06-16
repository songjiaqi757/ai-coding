# Phase 2 分工指南：Feed / OPML / Sync

> **适用人员**：第一组三位成员（Person A · Person B · Person C）
>
> **核心原则**：每人只改自己负责的文件，零冲突合并。

---

## 0. 快速开始（5 步上手）

1. `git checkout main && git pull origin main`
2. `git checkout -b feature/你的名字-phase2`
3. 阅读本文档中属于你的那一章
4. 按章节中的"实现步骤"vibe coding
5. 完成后 `git push`，通知 Person C 做集成

---

## 1. 分工总览

| 成员 | 角色 | **只能改这些文件** | 不能动的文件 |
|---|---|---|---|
| **Person A** | Rust 后端 | `app/src-tauri/src/lib.rs`、`app/src-tauri/Cargo.toml` | `src/`、`opml.rs` |
| **Person B** | 前端 UI | `app/src/` 下的所有文件（可新建组件文件） | `src-tauri/` |
| **Person C** | OPML + 集成 | 新建 `app/src-tauri/src/opml.rs`、`samples/` 目录、`docs/` 文档 | `lib.rs`（只读）、`src/`（只读） |

> ⚠️ **冲突预防规则**
> - Person A 和 Person C 唯一的交接点：Person A 在 `lib.rs` 末尾加一行 `mod opml;` 并注册 command，其余由 Person C 写在独立文件
> - Person B 开发期间用 mock 数据，不依赖 Person A 完成

---

## 2. API 契约（三人共同遵守，不得擅自修改签名）

### 2.1 Tauri Commands（Rust 端实现，前端调用）

```text
add_feed(url: String) -> Result<Feed, String>
    传入订阅源 URL，拉取并解析 Feed，存入数据库，返回新建的 Feed 对象

refresh_feed(feed_id: String) -> Result<Vec<Article>, String>
    刷新指定 Feed，拉取最新文章，去重后存入数据库，返回新增的文章列表

list_feeds() -> Result<Vec<Feed>, String>
    返回所有订阅源列表（已有，需适配新 schema）

list_articles(feed_id: Option<String>) -> Result<Vec<Article>, String>
    feed_id 为 None 时返回全部文章；传入 feed_id 时只返回该 Feed 的文章

import_opml(file_path: String) -> Result<Vec<Feed>, String>
    解析 OPML 文件，批量添加 Feed，返回成功导入的 Feed 列表
```

### 2.2 Rust 数据结构（lib.rs 中定义，前端 TypeScript 类型与之对应）

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub id: String,
    pub title: String,
    pub url: String,
    pub site_url: Option<String>,
    pub unread: i64,
    pub last_sync_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Article {
    pub id: String,
    pub feed_id: String,
    pub title: String,
    pub url: String,
    pub author: Option<String>,
    pub published_at: Option<String>,
    pub excerpt: String,
    pub content: String,
}
```

### 2.3 TypeScript 类型（Person B 在 `src/types.ts` 中定义）

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

---

## 3. 数据库新 Schema

Person A 在 `init_schema()` 中替换为以下 SQL：

```sql
CREATE TABLE IF NOT EXISTS feeds (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL UNIQUE,
    site_url    TEXT,
    unread      INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS articles (
    id           TEXT PRIMARY KEY,
    feed_id      TEXT NOT NULL,
    title        TEXT NOT NULL,
    url          TEXT NOT NULL,
    guid         TEXT,
    author       TEXT,
    published_at TEXT,
    excerpt      TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL DEFAULT '',
    raw_html     TEXT,
    read_status  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(feed_id) REFERENCES feeds(id),
    UNIQUE(feed_id, url)
);
```

> **注意**：schema 改动后旧的本地数据库会不兼容。开发期间直接删除旧数据库文件重新初始化即可。
> 数据库文件路径：`%APPDATA%/com.songjiaqi757.bookibuddy/bookibuddy.db`（Windows）

---

## 4. Git 工作流和合并顺序

```text
main
 |-- feature/PersonA-rust-backend    <-- Person A 独立开发
 |-- feature/PersonB-frontend-ui     <-- Person B 独立开发
 |-- feature/PersonC-opml-integration <-- Person C 独立开发
```

**合并顺序（由 Person C 执行）：**

```text
Step 1: 合并 Person A 的分支到 main（Rust backend 先进）
Step 2: 合并 Person C 自己的 opml.rs（在 lib.rs 中加 mod opml;）
Step 3: 合并 Person B 的分支（前端对接真实 commands）
Step 4: 跑 pnpm tauri dev，端到端验收
```

---

---

## Person A 专属指南：Rust 后端

**你负责的文件**：`app/src-tauri/src/lib.rs`、`app/src-tauri/Cargo.toml`

**你的目标**：实现 5 个 Tauri commands，让应用能真实添加、刷新、列出 Feed 和文章。

---

### A-1. 先改 Cargo.toml

在 `[dependencies]` 中添加：

```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json"] }
feed-rs = "2"
opml = "1"
uuid = { version = "1", features = ["v4"] }
tokio = { version = "1", features = ["rt", "rt-multi-thread"] }
tauri-plugin-dialog = "2"
```

完整 `[dependencies]` 示例：

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.39.0", features = ["bundled"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json"] }
feed-rs = "2"
opml = "1"
uuid = { version = "1", features = ["v4"] }
tokio = { version = "1", features = ["rt", "rt-multi-thread"] }
```

> 改完后先 `cargo check`，确保编译通过再写逻辑。

---

### A-2. lib.rs 顶部：更新 use 声明和数据结构

用第 2 节的 Rust 数据结构替换 `lib.rs` 里旧的 `Feed` 和 `Article` struct。

新增 use：

```rust
use uuid::Uuid;
```

---

### A-3. 更新 init_schema()

用第 3 节的 SQL 替换现有的 `init_schema()` 函数体。

---

### A-4. 删除 seed_database()，改为空实现

Phase 2 开始后用真实 Feed 数据，不再需要硬编码种子数据：

```rust
fn seed_database(_conn: &Connection) -> Result<(), String> {
    Ok(())
}
```

---

### A-5. 实现 add_feed（核心功能）

```rust
#[tauri::command]
async fn add_feed(app: AppHandle, url: String) -> Result<Feed, String> {
    // 1. 用 reqwest 拉取 Feed 内容
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("无法访问该 URL: {e}"))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    // 2. 用 feed-rs 解析（自动识别 RSS/Atom/JSON Feed）
    let parsed = feed_rs::parser::parse_with_uri(bytes.as_ref(), Some(&url))
        .map_err(|e| format!("无法解析为 RSS/Atom/JSON Feed: {e}"))?;

    // 3. 提取 Feed 基本信息
    let feed_id = Uuid::new_v4().to_string();
    let title = parsed
        .title
        .map(|t| t.content)
        .unwrap_or_else(|| "未命名订阅源".to_string());
    let site_url = parsed.links.first().map(|l| l.href.clone());

    // 4. 存入数据库
    let conn = open_database(&app)?;
    conn.execute(
        "INSERT OR IGNORE INTO feeds (id, title, url, site_url) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![feed_id, title, url, site_url],
    )
    .map_err(|e| format!("保存订阅源失败: {e}"))?;

    // 5. 顺便拉取并保存第一批文章
    save_articles(&conn, &feed_id, parsed.entries)?;

    // 6. 返回新建的 Feed
    let unread: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE feed_id = ?1 AND read_status = 0",
            rusqlite::params![feed_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("查询未读数失败: {e}"))?;

    Ok(Feed {
        id: feed_id,
        title,
        url,
        site_url,
        unread,
        last_sync_at: None,
    })
}
```

---

### A-6. 辅助函数：save_articles（供 add_feed 和 refresh_feed 共用）

```rust
pub fn save_articles(
    conn: &Connection,
    feed_id: &str,
    entries: Vec<feed_rs::model::Entry>,
) -> Result<usize, String> {
    let mut saved = 0;

    for entry in entries {
        // 提取文章 URL（取第一个 link）
        let url = match entry.links.first() {
            Some(link) => link.href.clone(),
            None => continue, // 没有 URL 的文章跳过
        };

        let article_id = Uuid::new_v4().to_string();
        let guid = Some(entry.id.clone());
        let title = entry
            .title
            .map(|t| t.content)
            .unwrap_or_else(|| "无标题".to_string());
        let author = entry.authors.first().map(|a| a.name.clone());
        let published_at = entry.published.map(|dt| dt.to_rfc3339());

        // 摘要：优先 summary，其次截取 content 前 200 字符
        let excerpt = entry
            .summary
            .map(|s| s.content)
            .or_else(|| {
                entry
                    .content
                    .as_ref()
                    .and_then(|c| c.body.as_ref())
                    .map(|b| b.chars().take(200).collect())
            })
            .unwrap_or_default();

        // 正文 HTML
        let content = entry
            .content
            .and_then(|c| c.body)
            .unwrap_or_default();

        // INSERT OR IGNORE 保证 url 重复时不报错（去重）
        let result = conn.execute(
            "INSERT OR IGNORE INTO articles
                (id, feed_id, title, url, guid, author, published_at, excerpt, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                article_id, feed_id, title, url, guid,
                author, published_at, excerpt, content
            ],
        );

        if let Ok(1) = result {
            saved += 1;
        }
    }

    Ok(saved)
}
```

---

### A-7. 实现 refresh_feed

```rust
#[tauri::command]
async fn refresh_feed(app: AppHandle, feed_id: String) -> Result<Vec<Article>, String> {
    let conn = open_database(&app)?;

    // 1. 取出该 Feed 的 URL
    let feed_url: String = conn
        .query_row(
            "SELECT url FROM feeds WHERE id = ?1",
            rusqlite::params![feed_id],
            |row| row.get(0),
        )
        .map_err(|_| format!("找不到 feed_id: {feed_id}"))?;

    // 2. 拉取并解析
    let response = reqwest::get(&feed_url)
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取失败: {e}"))?;
    let parsed = feed_rs::parser::parse_with_uri(bytes.as_ref(), Some(&feed_url))
        .map_err(|e| format!("解析失败: {e}"))?;

    // 3. 保存新文章（重复的自动跳过）
    save_articles(&conn, &feed_id, parsed.entries)?;

    // 4. 更新 last_sync_at
    conn.execute(
        "UPDATE feeds SET last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1",
        rusqlite::params![feed_id],
    )
    .map_err(|e| format!("更新同步时间失败: {e}"))?;

    // 5. 返回该 Feed 的最新文章列表
    list_articles_by_feed(&conn, Some(&feed_id))
}
```

---

### A-8. 更新 list_feeds

```rust
#[tauri::command]
fn list_feeds(app: AppHandle) -> Result<Vec<Feed>, String> {
    let conn = open_database(&app)?;

    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.title, f.url, f.site_url, f.last_sync_at,
                    COUNT(CASE WHEN a.read_status = 0 THEN 1 END) as unread
             FROM feeds f
             LEFT JOIN articles a ON a.feed_id = f.id
             GROUP BY f.id
             ORDER BY f.title ASC",
        )
        .map_err(|e| format!("准备查询失败: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Feed {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                site_url: row.get(3)?,
                last_sync_at: row.get(4)?,
                unread: row.get(5)?,
            })
        })
        .map_err(|e| format!("查询失败: {e}"))?;

    let mut feeds = Vec::new();
    for row in rows {
        feeds.push(row.map_err(|e| format!("读取行失败: {e}"))?);
    }
    Ok(feeds)
}
```

---

### A-9. 更新 list_articles

```rust
#[tauri::command]
fn list_articles(app: AppHandle, feed_id: Option<String>) -> Result<Vec<Article>, String> {
    let conn = open_database(&app)?;
    list_articles_by_feed(&conn, feed_id.as_deref())
}

fn list_articles_by_feed(conn: &Connection, feed_id: Option<&str>) -> Result<Vec<Article>, String> {
    let (sql, params_vec): (String, Vec<String>) = match feed_id {
        Some(id) => (
            "SELECT id, feed_id, title, url, author, published_at, excerpt, content
             FROM articles WHERE feed_id = ?1
             ORDER BY published_at DESC, created_at DESC".to_string(),
            vec![id.to_string()],
        ),
        None => (
            "SELECT id, feed_id, title, url, author, published_at, excerpt, content
             FROM articles
             ORDER BY published_at DESC, created_at DESC".to_string(),
            vec![],
        ),
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("准备查询失败: {e}"))?;

    let rows = if params_vec.is_empty() {
        stmt.query_map([], |row| {
            Ok(Article {
                id: row.get(0)?,
                feed_id: row.get(1)?,
                title: row.get(2)?,
                url: row.get(3)?,
                author: row.get(4)?,
                published_at: row.get(5)?,
                excerpt: row.get(6)?,
                content: row.get(7)?,
            })
        })
        .map_err(|e| format!("查询失败: {e}"))?
    } else {
        stmt.query_map(rusqlite::params![params_vec[0]], |row| {
            Ok(Article {
                id: row.get(0)?,
                feed_id: row.get(1)?,
                title: row.get(2)?,
                url: row.get(3)?,
                author: row.get(4)?,
                published_at: row.get(5)?,
                excerpt: row.get(6)?,
                content: row.get(7)?,
            })
        })
        .map_err(|e| format!("查询失败: {e}"))?
    };

    let mut articles = Vec::new();
    for row in rows {
        articles.push(row.map_err(|e| format!("读取行失败: {e}"))?);
    }
    Ok(articles)
}
```

---

### A-10. 更新 run() — 注册所有 commands

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_feeds,
            list_articles,
            add_feed,
            refresh_feed,
            crate::opml::import_opml,   // Person C 实现，你只需加这一行
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

在文件顶部加：

```rust
mod opml;  // 引入 Person C 写的 opml.rs 模块
```

> **注意**：`mod opml;` 和 `crate::opml::import_opml` 需要等 Person C 提交 `opml.rs` 之后才能取消注释。
> 开发期间可以先注释掉这两行，自己先测 add_feed / refresh_feed。

---

### A-11. Person A 需要配合其他人的事项

Person C 需要你把以下函数/结构体声明为 `pub`：

- `pub struct Feed`
- `pub struct Article`
- `pub fn open_database`
- `pub fn save_articles`

Person B 需要你在 `run()` 里加：`.plugin(tauri_plugin_dialog::init())`

---

### A-12. Person A 验收清单

完成后用 AI 帮你验证以下内容：

- [ ] `cargo check` 零错误
- [ ] 启动应用，打开控制台，调用 `add_feed("https://hnrss.org/frontpage")` 不报错
- [ ] 调用后 `list_feeds()` 返回至少一条记录
- [ ] 调用 `refresh_feed(feed_id)` 不报错，返回文章列表
- [ ] 同一篇文章多次刷新不重复插入（去重验证）
- [ ] `list_articles(None)` 返回全部，`list_articles(Some(id))` 只返回对应 Feed 的文章

---

---

## Person B 专属指南：前端 UI

**你负责的文件**：`app/src/` 下所有文件（可自由新建，不改 `src-tauri/`）

**你的目标**：实现添加 Feed、OPML 导入、刷新订阅的完整 UI 交互。

---

### B-1. 先新建类型文件 src/types.ts

创建 `app/src/types.ts`，内容来自第 2.3 节（见上方 TypeScript 类型）。

---

### B-2. 组件拆分计划

将 `App.tsx` 拆分为以下组件：

```text
app/src/
|-- types.ts              <-- 新建：类型定义
|-- App.tsx               <-- 主壳，只负责状态管理和布局拼装
|-- App.css               <-- 现有样式 + 新增样式
|-- components/
|   |-- Sidebar.tsx       <-- 新建：左侧 Feed 列表 + 添加按钮
|   |-- ArticleList.tsx   <-- 新建：中间文章列表
|   |-- Reader.tsx        <-- 新建：右侧阅读区
```

> **开发期间不需要 Person A 完成**：先用 mock 数据写 UI，等 Person A 合并后再对接真实 commands。

---

### B-3. Mock 数据写法（开发期间使用）

在 `App.tsx` 顶部定义 mock，等 Person A 完成后替换为真实 `invoke`：

```typescript
import type { Feed, Article } from "./types";

// 开发期间：mock 数据
const MOCK_FEEDS: Feed[] = [
  { id: "1", title: "阮一峰的网络日志", url: "https://feeds.feedburner.com/ruanyifeng",
    siteUrl: "https://ruanyifeng.com", unread: 3, lastSyncAt: null },
  { id: "2", title: "InfoQ", url: "https://feed.infoq.com",
    siteUrl: "https://infoq.com", unread: 7, lastSyncAt: "2024-01-15" },
];

const MOCK_ARTICLES: Article[] = [
  { id: "a1", feedId: "1", title: "示例文章", url: "https://example.com/1",
    author: "阮一峰", publishedAt: "2024-01-15", excerpt: "这是摘要...", content: "正文内容" },
];

// 对接真实 API 时替换为：
// import { invoke } from "@tauri-apps/api/core";
// const feeds = await invoke<Feed[]>("list_feeds");
```

---

### B-4. 实现 Sidebar.tsx（添加 Feed + OPML 导入）

```typescript
// app/src/components/Sidebar.tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Feed } from "../types";

type Props = {
  feeds: Feed[];
  selectedFeedId: string;
  onSelectFeed: (id: string) => void;
  onFeedsChange: () => void;
};

export function Sidebar({ feeds, selectedFeedId, onSelectFeed, onFeedsChange }: Props) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAddFeed() {
    if (!addUrl.trim()) return;
    setIsAdding(true);
    setAddError(null);
    try {
      await invoke("add_feed", { url: addUrl.trim() });
      setAddUrl("");
      setShowAddDialog(false);
      onFeedsChange();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRefreshFeed(feedId: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await invoke("refresh_feed", { feedId });
      onFeedsChange();
    } catch (err) {
      console.error("刷新失败", err);
    }
  }

  async function handleImportOpml() {
    // 使用 Tauri 文件对话框选择文件
    const { open } = await import("@tauri-apps/plugin-dialog");
    const filePath = await open({
      filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
    });
    if (!filePath) return;
    try {
      await invoke("import_opml", { filePath });
      onFeedsChange();
    } catch (err) {
      console.error("OPML 导入失败", err);
    }
  }

  const allFeed: Feed = {
    id: "all",
    title: "All Feeds",
    url: "",
    siteUrl: null,
    unread: feeds.reduce((sum, f) => sum + f.unread, 0),
    lastSyncAt: null,
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">M</div>
        <div>
          <h1>BookiBuddy</h1>
          <p>AI Reader</p>
        </div>
      </div>

      <section className="panel-section">
        <div className="section-header">
          <div className="section-title">Feeds</div>
          <div className="section-actions">
            <button className="icon-button" title="添加订阅" onClick={() => setShowAddDialog(true)}>+</button>
            <button className="icon-button" title="导入 OPML" onClick={handleImportOpml}>&#8593;</button>
          </div>
        </div>

        <div className="feed-list">
          {[allFeed, ...feeds].map((feed) => (
            <button
              key={feed.id}
              className={feed.id === selectedFeedId ? "feed-item active" : "feed-item"}
              onClick={() => onSelectFeed(feed.id)}
            >
              <span className="feed-title">{feed.title}</span>
              <div className="feed-right">
                {feed.id !== "all" && (
                  <button className="refresh-button" title="刷新"
                    onClick={(e) => handleRefreshFeed(feed.id, e)}>&#8635;</button>
                )}
                {feed.unread > 0 && <span className="badge">{feed.unread}</span>}
              </div>
            </button>
          ))}
        </div>
      </section>

      {showAddDialog && (
        <div className="dialog-overlay" onClick={() => setShowAddDialog(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>添加订阅源</h3>
            <input
              type="url"
              placeholder="输入 RSS/Atom 地址..."
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddFeed()}
              autoFocus
            />
            {addError && <p className="error-text">{addError}</p>}
            <div className="dialog-actions">
              <button onClick={() => setShowAddDialog(false)}>取消</button>
              <button className="primary-button" onClick={handleAddFeed} disabled={isAdding}>
                {isAdding ? "添加中..." : "添加"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
```

> **注意**：文件选择对话框需要在 `package.json` 中加：
> ```json
> "@tauri-apps/plugin-dialog": "^2"
> ```
> Rust 端 Person A 已加 `tauri-plugin-dialog = "2"` 和 `.plugin(tauri_plugin_dialog::init())`

---

### B-5. 实现 ArticleList.tsx

```typescript
// app/src/components/ArticleList.tsx
import type { Article } from "../types";

type Props = {
  articles: Article[];
  selectedArticleId: string | null;
  isLoading: boolean;
  onSelectArticle: (id: string) => void;
};

export function ArticleList({ articles, selectedArticleId, isLoading, onSelectArticle }: Props) {
  return (
    <section className="article-list">
      <div className="toolbar">
        <div>
          <h2>Articles</h2>
          <p>{isLoading ? "加载中..." : `${articles.length} 篇文章`}</p>
        </div>
      </div>

      <div className="search-box">
        <input placeholder="搜索文章..." />
      </div>

      <div className="cards">
        {articles.length === 0 && !isLoading && (
          <div className="empty-state">暂无文章，请添加订阅源或刷新</div>
        )}
        {articles.map((article) => (
          <button
            key={article.id}
            className={article.id === selectedArticleId ? "article-card active" : "article-card"}
            onClick={() => onSelectArticle(article.id)}
          >
            <div className="article-meta">
              <span>{article.author ?? "未知作者"}</span>
              <span>{article.publishedAt
                ? new Date(article.publishedAt).toLocaleDateString("zh-CN")
                : ""}</span>
            </div>
            <h3>{article.title}</h3>
            <p>{article.excerpt}</p>
          </button>
        ))}
      </div>
    </section>
  );
}
```

---

### B-6. 更新 App.tsx（拼装组件）

```typescript
// app/src/App.tsx
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { ArticleList } from "./components/ArticleList";
import type { Feed, Article } from "./types";
import "./App.css";

function App() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadData() {
    try {
      setIsLoading(true);
      setErrorMessage(null);
      const [nextFeeds, nextArticles] = await Promise.all([
        invoke<Feed[]>("list_feeds"),
        invoke<Article[]>("list_articles", { feedId: null }),
      ]);
      setFeeds(nextFeeds);
      setArticles(nextArticles);
      if (nextArticles.length > 0) {
        setSelectedArticleId((cur) => cur ?? nextArticles[0].id);
      }
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void loadData(); }, []);

  const visibleArticles = useMemo(() => {
    if (selectedFeedId === "all") return articles;
    return articles.filter((a) => a.feedId === selectedFeedId);
  }, [articles, selectedFeedId]);

  const selectedArticle = useMemo(
    () => articles.find((a) => a.id === selectedArticleId) ?? visibleArticles[0] ?? null,
    [articles, selectedArticleId, visibleArticles]
  );

  return (
    <main className="app-shell">
      <Sidebar
        feeds={feeds}
        selectedFeedId={selectedFeedId}
        onSelectFeed={setSelectedFeedId}
        onFeedsChange={loadData}
      />
      <ArticleList
        articles={visibleArticles}
        selectedArticleId={selectedArticle?.id ?? null}
        isLoading={isLoading}
        onSelectArticle={setSelectedArticleId}
      />
      <article className="reader">
        {errorMessage && <div className="error-box">{errorMessage}</div>}
        {selectedArticle ? (
          <>
            <div className="reader-header">
              <div>
                <div className="article-meta">
                  <span>{selectedArticle.author ?? "未知作者"}</span>
                  <span>{selectedArticle.publishedAt
                    ? new Date(selectedArticle.publishedAt).toLocaleDateString("zh-CN")
                    : ""}</span>
                </div>
                <h2>{selectedArticle.title}</h2>
              </div>
              <div className="reader-actions">
                <button onClick={() => alert("Summary Agent - Phase 5")}>摘要</button>
                <button onClick={() => alert("Translation Agent - Phase 6")}>翻译</button>
              </div>
            </div>
            <div className="reader-content">
              <div dangerouslySetInnerHTML={{ __html: selectedArticle.content }} />
            </div>
          </>
        ) : (
          <div className="empty-reader">
            {isLoading ? "加载中..." : "请从左侧选择文章"}
          </div>
        )}
      </article>
    </main>
  );
}

export default App;
```

---

### B-7. 需要告诉 Person A 的事项

1. 在 `lib.rs` 的 `run()` 里加 `.plugin(tauri_plugin_dialog::init())`
2. 在 `Cargo.toml` 里加 `tauri-plugin-dialog = "2"`
3. `list_articles` 命令的参数 `feed_id` 需要接受 `Option<String>`（可为 null）

---

### B-8. CSS 补充（App.css 末尾追加）

在现有 `App.css` 末尾追加以下样式：

```css
/* == Phase 2: Sidebar 新样式 == */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-actions {
  display: flex;
  gap: 4px;
}

.icon-button {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #64748b;
  font-size: 16px;
  display: grid;
  place-items: center;
}

.icon-button:hover {
  background: #e2e8f0;
}

.feed-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.refresh-button {
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #94a3b8;
  font-size: 14px;
  opacity: 0;
  transition: opacity 0.15s;
  display: grid;
  place-items: center;
}

.feed-item:hover .refresh-button {
  opacity: 1;
}

/* == Phase 2: 添加 Feed 对话框 == */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 30%);
  display: grid;
  place-items: center;
  z-index: 100;
}

.dialog {
  width: 420px;
  padding: 28px;
  border-radius: 20px;
  background: white;
  box-shadow: 0 24px 64px rgb(0 0 0 / 18%);
}

.dialog h3 {
  margin: 0 0 18px;
  font-size: 20px;
  letter-spacing: -0.03em;
}

.dialog input {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid #d0d7e2;
  border-radius: 12px;
  outline: none;
  font-size: 14px;
}

.dialog input:focus {
  border-color: #1f6feb;
  box-shadow: 0 0 0 3px rgb(31 111 235 / 12%);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

.error-text {
  margin: 8px 0 0;
  color: #dc2626;
  font-size: 13px;
}

.empty-state {
  padding: 40px 0;
  text-align: center;
  color: #94a3b8;
  font-size: 14px;
}
```

---

### B-9. Person B 验收清单

- [ ] `pnpm build`（TypeScript 编译）零错误
- [ ] 页面加载显示 Feed 列表（mock 数据或真实数据均可）
- [ ] 点击 + 弹出添加对话框，输入 URL 按 Enter 触发添加
- [ ] 点击上箭头弹出文件选择框，选择 .opml 文件触发导入
- [ ] Feed 列表 hover 时显示刷新按钮
- [ ] 切换 Feed 后中间列表正确过滤
- [ ] 选中文章后右侧阅读区正确展示

---

---

## Person C 专属指南：OPML + 集成 + 文档

**你负责的文件**：新建 `app/src-tauri/src/opml.rs`、`samples/` 目录、`docs/` 更新

**你的目标**：实现 OPML 解析模块，准备测试数据，最终完成集成。

---

### C-1. 新建 app/src-tauri/src/opml.rs

这是一个独立的 Rust 模块文件，不与 lib.rs 冲突。

```rust
// app/src-tauri/src/opml.rs
use opml::OPML;
use tauri::AppHandle;
use uuid::Uuid;

use crate::{open_database, save_articles, Feed};

/// 解析 OPML 文件内容，提取所有订阅源 (title, url)
pub fn parse_opml_feeds(xml: &str) -> Result<Vec<(String, String)>, String> {
    let document = OPML::from_str(xml)
        .map_err(|e| format!("OPML 格式错误: {e}"))?;

    let mut feeds = Vec::new();
    collect_outlines(&document.body.outlines, &mut feeds);

    Ok(feeds)
}

/// 递归遍历 OPML outlines（支持分组嵌套）
fn collect_outlines(outlines: &[opml::Outline], feeds: &mut Vec<(String, String)>) {
    for outline in outlines {
        if let Some(url) = &outline.xml_url {
            let title = outline
                .title
                .clone()
                .or_else(|| Some(outline.text.clone()))
                .unwrap_or_else(|| url.clone());
            feeds.push((title, url.clone()));
        }
        if !outline.outlines.is_empty() {
            collect_outlines(&outline.outlines, feeds);
        }
    }
}

/// Tauri command: 导入 OPML 文件
#[tauri::command]
pub async fn import_opml(app: AppHandle, file_path: String) -> Result<Vec<Feed>, String> {
    // 1. 读取文件内容
    let xml = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("无法读取文件 {file_path}: {e}"))?;

    // 2. 解析 OPML
    let feed_list = parse_opml_feeds(&xml)?;

    if feed_list.is_empty() {
        return Err("OPML 文件中没有找到订阅源（缺少 xmlUrl 属性）".to_string());
    }

    // 3. 逐个拉取并保存
    let mut imported_feeds = Vec::new();

    for (_title, url) in feed_list {
        match fetch_and_save_feed(&app, &url).await {
            Ok(feed) => imported_feeds.push(feed),
            Err(e) => {
                // 批量导入：单个失败不中断
                eprintln!("导入 {url} 失败: {e}");
            }
        }
    }

    Ok(imported_feeds)
}

/// 内部函数：拉取并保存一个 Feed
async fn fetch_and_save_feed(app: &AppHandle, url: &str) -> Result<Feed, String> {
    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取失败: {e}"))?;
    let parsed = feed_rs::parser::parse_with_uri(bytes.as_ref(), Some(url))
        .map_err(|e| format!("解析失败: {e}"))?;

    let feed_id = Uuid::new_v4().to_string();
    let title = parsed
        .title
        .map(|t| t.content)
        .unwrap_or_else(|| "未命名订阅源".to_string());
    let site_url = parsed.links.first().map(|l| l.href.clone());

    let conn = open_database(app)?;
    conn.execute(
        "INSERT OR IGNORE INTO feeds (id, title, url, site_url) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![feed_id, title, url, site_url],
    )
    .map_err(|e| format!("保存失败: {e}"))?;

    save_articles(&conn, &feed_id, parsed.entries)?;

    let unread: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE feed_id = ?1 AND read_status = 0",
            rusqlite::params![feed_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("查询失败: {e}"))?;

    Ok(Feed {
        id: feed_id,
        title,
        url: url.to_string(),
        site_url,
        unread,
        last_sync_at: None,
    })
}
```

---

### C-2. 你需要告诉 Person A 的事项

Person A 在 `lib.rs` 中需要把以下内容声明为 `pub`，这样你的 `opml.rs` 才能 `use crate::xxx`：

```rust
pub struct Feed { ... }
pub struct Article { ... }
pub fn open_database(app: &AppHandle) -> Result<Connection, String> { ... }
pub fn save_articles(conn: &Connection, feed_id: &str, entries: Vec<feed_rs::model::Entry>) -> Result<usize, String> { ... }
```

---

### C-3. 准备 Sample 文件

在仓库根目录创建：

**`samples/opml/example.opml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>BookiBuddy Test Feeds</title>
  </head>
  <body>
    <outline text="技术" title="技术">
      <outline text="阮一峰的网络日志" title="阮一峰的网络日志"
               type="rss" xmlUrl="https://feeds.feedburner.com/ruanyifeng"
               htmlUrl="https://ruanyifeng.com"/>
      <outline text="Hacker News" title="Hacker News"
               type="rss" xmlUrl="https://hnrss.org/frontpage"
               htmlUrl="https://news.ycombinator.com"/>
    </outline>
    <outline text="科学" title="科学">
      <outline text="NASA" title="NASA Breaking News"
               type="rss" xmlUrl="https://www.nasa.gov/news-release/feed/"
               htmlUrl="https://www.nasa.gov"/>
    </outline>
  </body>
</opml>
```

---

### C-4. 集成合并操作步骤

当 Person A 和 Person B 都完成后：

```bash
# Step 1: 更新 main
git checkout main
git pull origin main

# Step 2: 合并 Person A
git merge origin/feature/PersonA-rust-backend
# 解决冲突（如有）

# Step 3: 合并自己的 opml.rs
git merge origin/feature/PersonC-opml-integration

# Step 4: 手动在 lib.rs 加入 opml 模块
# 文件顶部加：mod opml;
# run() 里 invoke_handler 加：crate::opml::import_opml,

# Step 5: cargo check 确保编译通过

# Step 6: 合并 Person B
git merge origin/feature/PersonB-frontend-ui

# Step 7: 安装依赖并测试
cd app
pnpm install
pnpm tauri dev
```

---

### C-5. Person C 验收清单

**opml.rs 单元验证：**
- [ ] `cargo check` 通过
- [ ] 用 `samples/opml/example.opml` 调用 `import_opml`，返回至少 2 条 Feed

**集成验证（合并后）：**
- [ ] 三个分支合并后 `pnpm tauri dev` 启动无报错
- [ ] 点击 + 输入 RSS URL -> 订阅源出现在列表中
- [ ] 点击上箭头选择 `samples/opml/example.opml` -> 多个订阅源批量导入
- [ ] 点击刷新按钮 -> 文章列表更新，不重复
- [ ] 选中文章 -> 右侧显示正文内容

---

## 附录：常用测试 Feed URL

| Feed 名称 | URL | 格式 |
|---|---|---|
| 阮一峰的网络日志 | `https://feeds.feedburner.com/ruanyifeng` | RSS 2.0 |
| Hacker News 首页 | `https://hnrss.org/frontpage` | RSS 2.0 |
| The Verge | `https://www.theverge.com/rss/index.xml` | Atom |
| NASA Breaking News | `https://www.nasa.gov/news-release/feed/` | RSS 2.0 |

---

*最后更新：Phase 2 开发周期*
