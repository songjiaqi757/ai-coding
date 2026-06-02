## 2. API 契约（三人共同遵守，不得擅自修改签名）

### 2.1 Tauri Commands（Rust 端实现，前端调用）

```text
add_feed(url: String) -> Result<Feed, String>
    传入订阅源 URL，拉取并解析 Feed，存入数据库，返回新建的 Feed 对象

refresh_feed(feed_id: String) -> Result<Vec<Article>, String>
    刷新指定 Feed，拉取最新文章，去重后存入数据库，返回新增的文章列表

list_feeds() -> Result<Vec<Feed>, String>
    返回所有订阅源列表（已有，需适配新 schema）

list_articles(feed_id: Option<String>, read_filter: Option<String>) -> Result<Vec<Article>, String>
    feed_id 为 None 时返回全部文章；传入 feed_id 时只返回该 Feed 的文章
    read_filter 可取 "all"（默认）、"unread"、"read"

import_opml(file_path: String) -> Result<Vec<Feed>, String>
    解析 OPML 文件，批量添加 Feed，返回成功导入的 Feed 列表

export_opml(file_path: String) -> Result<(), String>
    导出所有 Feed 为 OPML 文件

start_sync(feed_id: Option<String>) -> Result<SyncReport, String>
    feed_id 为 Some 时同步单个 Feed；为 None 时同步全部普通 Feed

get_sync_status() -> Result<SyncStatus, String>
    返回当前同步状态，用于前端轮询

retry_failed_syncs() -> Result<SyncReport, String>
    只重试上次失败的 Feed

get_sync_config() -> Result<SyncConfig, String>
    读取自动同步配置

update_sync_config(enabled: bool, interval_minutes: i64, retry_limit: i64) -> Result<SyncConfig, String>
    保存自动同步配置

set_article_read_status(article_id: String, is_read: bool) -> Result<Article, String>
    设置单篇文章已读或未读

mark_articles_read(feed_id: Option<String>, article_ids: Option<Vec<String>>) -> Result<UnreadSummary, String>
    批量标记已读。article_ids 优先级高于 feed_id

save_setting(key: String, value: String) -> Result<(), String>
    保存设置项

load_setting(key: String) -> Result<Option<String>, String>
    读取设置项

summarize_article(article_id: String, force: Option<bool>) -> Result<String, String>
    生成文章摘要（缓存，force=true 时重新生成）

translate_article(article_id: String, target_lang: String) -> Result<String, String>
    翻译文章内容
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

### 2.3 TypeScript 类型（`src/types.ts` 中定义）

```typescript
export type Feed = {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  unread: number;
  lastSyncAt: string | null;
};

export type SyncPhase = "idle" | "running" | "success" | "failed";
export type ReadFilter = "all" | "unread" | "read";

export type SyncFeedFailure = {
  feedId: string;
  feedTitle: string;
  error: string;
  retryCount: number;
  failedAt: string;
};

export type SyncStatus = {
  phase: SyncPhase;
  currentFeedId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  totalFeeds: number;
  completedFeeds: number;
  failedFeeds: SyncFeedFailure[];
  lastError: string | null;
};

export type SyncConfig = {
  enabled: boolean;
  intervalMinutes: number;
  retryLimit: number;
  nextSyncAt: string | null;
};

export type SyncReport = {
  totalFeeds: number;
  syncedFeeds: number;
  failedFeeds: SyncFeedFailure[];
  newArticles: number;
  startedAt: string;
  finishedAt: string;
};

export type UnreadSummary = {
  totalUnread: number;
  feedUnread: { feedId: string; unread: number }[];
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
  rawHtml: string | null;
  cleanedHtml: string | null;
  cleanedMarkdown: string | null;
  contentFetchedAt: string | null;
  contentFetchStatus: string;
  contentFetchError: string | null;
  finalUrl: string | null;
  summary: string | null;
  translation: string | null;
  isRead: boolean;
  isFavorite: boolean;
  readLater: boolean;
};
```