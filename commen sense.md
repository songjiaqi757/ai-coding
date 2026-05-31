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