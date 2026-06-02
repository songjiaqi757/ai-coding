# 第二阶段实施计划：自动同步系统与文章状态系统

## 0. 背景与目标

本阶段由三人协作完成两条能力线：

- 自动同步系统：启动同步、定时同步、失败重试、同步状态。
- 文章状态系统：已读/未读、未读数量、未读过滤、批量已读。

当前项目已经具备这些基础：

- `feeds.last_sync_at` 已存在，可继续作为最近同步成功时间。
- `articles.read_status` 已存在，约定 `0 = 未读`，`1 = 已读`。
- `list_feeds()` 已经通过 `COUNT(CASE WHEN a.read_status = 0 THEN 1 END)` 统计未读数。
- `refresh_feed(feed_id)` 已存在，可以作为同步核心逻辑的起点。
- 前端已有 Feed 列表、单 Feed 刷新按钮、文章列表和 Reader。

本阶段的重点不是重写 RSS 阅读器，而是把已有能力模块化、可观察、可重试，并把文章阅读状态完整暴露给 UI。

## 1. 三人共同协作原则

1. 先更新接口合约，再写业务代码。
2. 不破坏现有 Tauri command 签名，已有前端能继续运行。
3. UI 不直接操作数据库和文件系统，所有数据变更必须通过 Tauri commands。
4. 用户数据继续只保存在本地 SQLite，不引入注册登录、不自建云端服务。
5. 自动同步只访问用户添加的 Feed URL，不上传文章内容。
6. 新增或修改数据结构、隐私边界、架构边界时，同步更新 `docs`。
7. 每个分支交付时必须提供手动验收步骤。

## 2. 共享接口合约

基于 `commen sense.md` 继续补充，已有接口保持兼容：

```text
add_feed(url: String) -> Result<Feed, String>
refresh_feed(feed_id: String) -> Result<Vec<Article>, String>
list_feeds() -> Result<Vec<Feed>, String>
list_articles(feed_id: Option<String>) -> Result<Vec<Article>, String>
import_opml(file_path: String) -> Result<Vec<Feed>, String>
```

本阶段新增接口建议：

```text
start_sync(feed_id: Option<String>) -> Result<SyncReport, String>
    feed_id 为 Some 时同步单个 Feed；为 None 时同步全部普通 Feed。

get_sync_status() -> Result<SyncStatus, String>
    返回当前同步状态，用于前端轮询或刷新状态条。

retry_failed_syncs() -> Result<SyncReport, String>
    只重试上次失败的 Feed。

get_sync_config() -> Result<SyncConfig, String>
    读取自动同步配置。

update_sync_config(enabled: bool, interval_minutes: i64, retry_limit: i64) -> Result<SyncConfig, String>
    保存自动同步配置。

set_article_read_status(article_id: String, is_read: bool) -> Result<Article, String>
    设置单篇文章已读或未读。

mark_articles_read(feed_id: Option<String>, article_ids: Option<Vec<String>>) -> Result<UnreadSummary, String>
    批量标记已读。article_ids 优先级高于 feed_id。

list_articles(feed_id: Option<String>, read_filter: Option<String>) -> Result<Vec<Article>, String>
    read_filter 可取 all、unread、read。为了兼容旧调用，None 等同 all。
```

### 2.1 Rust 结构提示

```rust
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub phase: String, // idle | running | success | failed
    pub current_feed_id: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub total_feeds: i64,
    pub completed_feeds: i64,
    pub failed_feeds: Vec<SyncFeedFailure>,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncFeedFailure {
    pub feed_id: String,
    pub feed_title: String,
    pub error: String,
    pub retry_count: i64,
    pub failed_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub total_feeds: i64,
    pub synced_feeds: i64,
    pub failed_feeds: Vec<SyncFeedFailure>,
    pub new_articles: i64,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub enabled: bool,
    pub interval_minutes: i64,
    pub retry_limit: i64,
    pub next_sync_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadSummary {
    pub total_unread: i64,
    pub feed_unread: Vec<FeedUnread>,
}
```

### 2.2 TypeScript 类型提示

```ts
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

export type Article = {
  id: string;
  feedId: string;
  title: string;
  url: string;
  isRead: boolean;
  isFavorite: boolean;
  readLater: boolean;
};
```

注意：当前代码里部分前端类型仍使用 `feed_id`、`published_at`、`is_favorite` 这种 snake_case 字段。PERSON B 和 PERSON C 需要一起确认是否统一为 `#[serde(rename_all = "camelCase")]`。如果统一，应一次性更新 `types.ts` 和前端引用，避免混用两套命名。

## 3. PERSON A：自动同步后端核心

分支：`codex/person-a-sync-core`

### 3.1 负责范围

- 新增 Rust `sync` 模块。
- 抽取 `refresh_feed` 内部逻辑，形成可复用的单 Feed 同步函数。
- 实现全部 Feed 同步、失败记录、失败重试、同步状态查询。
- 实现同步配置读取和更新。
- 保证旧的 `refresh_feed(feed_id)` 继续可用。

### 3.2 建议修改文件

- `app/src-tauri/src/lib.rs`
- `app/src-tauri/src/sync.rs`
- `app/src-tauri/Cargo.toml`，如确实需要时间库再新增依赖。
- `docs/FEED_OPML.md` 或新增 `docs/SYNC_AND_READ_STATUS.md`

### 3.3 任务拆解

1. 新建 `sync.rs`，先放结构体和纯后端函数。
2. 把 `refresh_feed` 中的逻辑拆成 `sync_one_feed(conn, feed_id)`。
3. `refresh_feed(feed_id)` 改为调用 `sync_one_feed`，返回该 Feed 的文章列表，保持旧行为。
4. 新增 `start_sync(feed_id)`：
   - `Some(feed_id)`：同步单个 Feed。
   - `None`：查询全部普通 Feed，同步每一个。
   - 跳过 `SAVED_ARTICLES_FEED_ID`。
5. 新增 `sync_failures` 表，记录失败 Feed。
6. 新增 `retry_failed_syncs()`，只查询失败表中的 Feed 重试。
7. 新增 `get_sync_status()`，前端可轮询状态。
8. 新增 `get_sync_config()` 和 `update_sync_config()`，配置写入 `settings` 表。
9. 注册新增 Tauri commands。

### 3.4 数据库提示

```sql
CREATE TABLE IF NOT EXISTS sync_failures (
    feed_id TEXT PRIMARY KEY,
    feed_title TEXT NOT NULL,
    error TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    failed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(feed_id) REFERENCES feeds(id) ON DELETE CASCADE
);
```

`settings` 表可复用现有结构：

```text
sync.enabled = "true" | "false"
sync.interval_minutes = "30"
sync.retry_limit = "3"
sync.next_sync_at = "2026-05-31T12:30:00+08:00"
```

### 3.5 Rust 提示代码

```rust
pub fn sync_one_feed(conn: &Connection, feed_id: &str) -> Result<i64, String> {
    let before_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE feed_id = ?1",
            params![feed_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to count articles before sync: {error}"))?;

    // 这里复用现有 refresh_feed 中的获取 feed.url、reqwest 拉取、feed-rs 解析、save_articles 逻辑。

    let after_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE feed_id = ?1",
            params![feed_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to count articles after sync: {error}"))?;

    Ok(after_count - before_count)
}
```

```rust
fn save_sync_failure(
    conn: &Connection,
    feed_id: &str,
    feed_title: &str,
    error: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sync_failures (feed_id, feed_title, error, retry_count, failed_at)
         VALUES (?1, ?2, ?3, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(feed_id) DO UPDATE SET
            error = excluded.error,
            retry_count = sync_failures.retry_count + 1,
            failed_at = CURRENT_TIMESTAMP",
        params![feed_id, feed_title, error],
    )
    .map_err(|error| format!("Failed to save sync failure: {error}"))?;
    Ok(())
}
```

### 3.6 PERSON A 验收

1. `cd app/src-tauri && cargo check` 通过。
2. 点击旧的单 Feed 刷新按钮仍能同步文章。
3. 调用 `start_sync(None)` 时，全部普通 Feed 被依次同步。
4. 某个 Feed 请求失败时，其他 Feed 不受影响。
5. `retry_failed_syncs()` 只重试失败 Feed。
6. `get_sync_status()` 在同步前、中、后都有合理返回。
