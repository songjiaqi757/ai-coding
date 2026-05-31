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

## 4. PERSON B：文章已读/未读系统

分支：`codex/person-b-article-status`

### 4.1 负责范围

- 暴露文章已读状态。
- 实现单篇已读/未读切换。
- 实现批量已读。
- 支持按 `all / unread / read` 过滤文章。
- 保证 Feed 未读数始终准确。

### 4.2 建议修改文件

- `app/src-tauri/src/lib.rs`
- `app/src/types.ts`
- `app/src/App.tsx`
- `app/src/components/ArticleList.tsx`
- `docs/SYNC_AND_READ_STATUS.md`

### 4.3 任务拆解

1. Rust `Article` 增加 `is_read: bool`。
2. 更新 `article_from_row`、`load_article_by_id`、`list_articles_by_feed`、`search_articles` 中的 SELECT 字段。
3. 将 `read_status` 转成布尔值返回给前端。
4. 新增 `set_article_read_status(article_id, is_read)`。
5. 新增 `mark_articles_read(feed_id, article_ids)`。
6. 扩展 `list_articles`，兼容旧调用：
   - `read_filter = None` 等同 `all`。
   - `read_filter = Some("unread")` 只返回未读。
   - `read_filter = Some("read")` 只返回已读。
7. 前端文章卡片显示未读状态。
8. 点击打开文章时，可以自动标记已读；也可以保留一个按钮手动切换，最终由小组确认交互。

### 4.4 Rust 提示代码

```rust
#[tauri::command]
fn set_article_read_status(
    app: AppHandle,
    article_id: String,
    is_read: bool,
) -> Result<Article, String> {
    let conn = open_database(&app)?;
    let read_status = if is_read { 1 } else { 0 };
    let changed = conn
        .execute(
            "UPDATE articles
             SET read_status = ?2, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![article_id, read_status],
        )
        .map_err(|error| format!("Failed to update read status: {error}"))?;

    if changed == 0 {
        return Err(format!("Article {article_id} was not found"));
    }

    load_article_by_id(&conn, &article_id)
}
```

```rust
fn read_filter_sql(read_filter: Option<&str>) -> Result<&'static str, String> {
    match read_filter.unwrap_or("all") {
        "all" => Ok(""),
        "unread" => Ok(" AND read_status = 0"),
        "read" => Ok(" AND read_status = 1"),
        other => Err(format!("Unsupported read filter: {other}")),
    }
}
```

### 4.5 TypeScript 提示代码

```ts
async function toggleReadStatus(article: Article) {
  const updated = await invoke<Article>("set_article_read_status", {
    articleId: article.id,
    isRead: !article.isRead,
  });
  mergeArticle(updated);
  await loadFeeds();
}
```

```ts
async function markCurrentFeedRead() {
  await invoke<UnreadSummary>("mark_articles_read", {
    feedId: selectedFeedId === "all" ? null : selectedFeedId,
    articleIds: null,
  });
  await loadLocalData();
}
```

### 4.6 PERSON B 验收

1. `cd app/src-tauri && cargo check` 通过。
2. 单篇文章可在已读和未读之间切换。
3. 刷新应用后，已读/未读状态仍保留。
4. 未读过滤只展示 `read_status = 0` 的文章。
5. 已读过滤只展示 `read_status = 1` 的文章。
6. 批量已读后，当前 Feed 未读数变为正确值。
7. 新同步进来的文章默认是未读。

## 5. PERSON C：前端同步 UI、集成与文档

分支：`codex/person-c-sync-ui-contract`

### 5.1 负责范围

- 先维护接口合约。
- 实现同步相关 UI。
- 实现文章过滤和批量已读 UI。
- 集成 PERSON A 和 PERSON B 的后端接口。
- 补充文档和最终验收记录。

### 5.2 建议修改文件

- `commen sense.md`
- `docs/SYNC_AND_READ_STATUS.md`
- `app/src/types.ts`
- `app/src/App.tsx`
- `app/src/components/Sidebar.tsx`
- `app/src/components/ArticleList.tsx`
- `app/src/App.css`

### 5.3 任务拆解

1. 第一步只提交接口合约文档，不改业务代码。
2. 在 `types.ts` 中补充 `SyncStatus`、`SyncConfig`、`ReadFilter`、`UnreadSummary`。
3. 在 Sidebar 增加：
   - 同步全部按钮。
   - 同步状态展示。
   - 失败数量提示。
   - 重试失败项按钮。
4. 在设置区域或 Sidebar 小面板增加：
   - 自动同步开关。
   - 同步间隔输入。
   - 最大重试次数输入。
5. 在文章列表顶部增加：
   - `全部 / 未读 / 已读` 分段控件。
   - `全部标为已读` 按钮。
6. 集成 `get_sync_status()`：
   - 同步中每 2 到 3 秒轮询。
   - 非同步中停止轮询。
7. 集成 `start_sync(None)` 和 `retry_failed_syncs()`。
8. 做最终集成测试和文档更新。

### 5.4 TypeScript 提示代码

```ts
const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
const [readFilter, setReadFilter] = useState<ReadFilter>("all");

async function refreshSyncStatus() {
  setSyncStatus(await invoke<SyncStatus>("get_sync_status"));
}

async function startFullSync() {
  await invoke<SyncReport>("start_sync", { feedId: null });
  await refreshSyncStatus();
  await loadLocalData();
}
```

```ts
useEffect(() => {
  if (syncStatus?.phase !== "running") return;
  const timer = window.setInterval(() => {
    void refreshSyncStatus();
  }, 2500);
  return () => window.clearInterval(timer);
}, [syncStatus?.phase]);
```

```tsx
<div className="segmented-control" aria-label="文章状态过滤">
  {(["all", "unread", "read"] as const).map((value) => (
    <button
      key={value}
      className={readFilter === value ? "active" : ""}
      onClick={() => setReadFilter(value)}
    >
      {value === "all" ? "全部" : value === "unread" ? "未读" : "已读"}
    </button>
  ))}
</div>
```

### 5.5 PERSON C 验收

1. `cd app && pnpm build` 通过。
2. `cd app/src-tauri && cargo check` 通过。
3. 同步全部时，UI 显示进行中状态。
4. 同步失败时，UI 显示失败项数量和重试按钮。
5. 自动同步配置刷新后仍保留。
6. 文章过滤切换后列表正确变化。
7. 批量已读后，Sidebar 未读数和文章列表同时更新。

## 6. 推荐 Git 协作顺序

1. 三人从 `main` 拉最新代码。
2. PERSON C 先开 `codex/person-c-sync-ui-contract`，只提交接口合约和文档。
3. 合约 PR 合并后，PERSON A 和 PERSON B 基于最新 `main` 开发。
4. PERSON A 先合并同步核心，因为 PERSON C 的同步 UI 依赖它。
5. PERSON B 再合并文章状态，因为 PERSON C 的文章过滤 UI 依赖它。
6. PERSON C 最后合并 UI 集成和最终文档。

每个 PR 建议包含：

```text
变更摘要：
- 做了什么

手动验收：
- 执行了哪些命令
- 在 UI 中验证了哪些流程

风险说明：
- 可能影响哪些已有功能
- 是否修改数据结构或隐私边界
```

## 7. 最小可用交付顺序

如果时间紧，建议按这个顺序交付：

1. 单篇已读/未读切换。
2. 未读数正确刷新。
3. 未读/已读过滤。
4. 手动同步全部。
5. 同步状态展示。
6. 失败记录和重试。
7. 自动定时同步配置。

这样即使定时同步来不及，项目仍有一条完整可验收链路：同步文章、显示未读、阅读文章、批量已读。

## 8. 全计划反思

这个计划的主要风险有四个。

第一，接口命名可能混乱。当前 Rust 的 `Feed` 使用 camelCase 序列化，但 `Article` 仍然在前端大量使用 snake_case。若本阶段新增 `isRead`，最好趁机统一 `Article` 序列化策略，否则前端会长期同时出现 `feed_id`、`feedId`、`is_favorite`、`isFavorite`，后续维护成本会越来越高。

第二，自动同步容易被做得太复杂。桌面应用第一版不必实现后台常驻服务级别的调度。更稳妥的做法是先在应用运行期间通过前端定时器触发 `start_sync(None)`，配置持久化在后端。后续如果需要真正后台调度，再升级为 Rust runtime task。

第三，失败重试要避免阻塞整体同步。同步全部 Feed 时，单个 Feed 失败只应记录失败，不应让整个同步直接报错中断。`SyncReport` 可以带失败项，UI 再提醒用户手动重试。

第四，未读数不要做双写维护。虽然 `feeds` 表有 `unread` 字段，但当前更可靠的方式是继续用 `articles.read_status` 实时统计。否则单篇已读、批量已读、同步新增文章都要同时更新两个地方，很容易产生不一致。

因此，本阶段最推荐的实现策略是：后端保持数据权威，前端只展示和触发；同步先做应用内定时，不做系统级后台服务；未读数只由查询统计得到，不由前端计算；三人以接口合约为边界并行开发。

## 9. 最终手动验收清单

1. 添加或导入至少两个真实 Feed。
2. 点击同步全部，确认文章新增且 `lastSyncAt` 更新。
3. 故意加入一个错误 Feed URL，确认同步失败不会阻塞其他 Feed。
4. 点击重试失败项，确认只重试失败 Feed。
5. 打开未读文章，确认可以变为已读。
6. 手动把已读文章改回未读。
7. 切换 `全部 / 未读 / 已读`，确认列表正确。
8. 对当前 Feed 执行批量已读，确认未读数清零。
9. 重启应用，确认同步配置和文章状态仍保留。
10. 执行 `cd app && pnpm build`。
11. 执行 `cd app/src-tauri && cargo check`。

