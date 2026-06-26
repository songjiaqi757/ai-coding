# Sync and Read Status

## Person A Sync Core

This phase adds the backend sync core without changing the existing single-feed refresh contract.

Existing command kept compatible:

```text
refresh_feed(feed_id: String) -> Result<Vec<Article>, String>
```

New sync commands:

```text
start_sync(feed_id: Option<String>) -> Result<SyncReport, String>
get_sync_status() -> Result<SyncStatus, String>
retry_failed_syncs() -> Result<SyncReport, String>
get_sync_config() -> Result<SyncConfig, String>
update_sync_config(enabled: bool, interval_minutes: i64, retry_limit: i64) -> Result<SyncConfig, String>
run_scheduled_sync() -> Result<ScheduledSyncResult, String>
```

`start_sync(Some(feed_id))` syncs one ordinary feed. `start_sync(None)` syncs all ordinary feeds in sequence and skips the local Saved Articles feed. A failed feed is recorded and does not stop the rest of the sync run.

`retry_failed_syncs()` only retries feeds currently present in `sync_failures` whose retry count is below the configured retry limit. A successful retry clears that feed's failure record.

`get_sync_status()` returns in-memory sync status for UI polling. The status is reset when a new sync starts and is updated after each feed completes.

`get_sync_config()` and `update_sync_config()` persist app-level sync settings in the local `settings` table. When automatic sync is enabled, the frontend periodically calls `run_scheduled_sync()` while the app is running. The backend checks `sync.next_sync_at`, runs `start_sync(None)` behavior when due, and writes the next scheduled timestamp after completion.

## Person B Article Read Status

New commands for article read/unread management:

```text
set_article_read_status(article_id: String, is_read: bool) -> Result<Article, String>
mark_articles_read(feed_id: Option<String>, article_ids: Option<Vec<String>>) -> Result<UnreadSummary, String>
list_articles(feed_id: Option<String>, read_filter: Option<String>) -> Result<Vec<Article>, String>
```

`set_article_read_status` toggles a single article between read and unread.

`mark_articles_read` batch-marks articles as read. Priority: `article_ids` > `feed_id` > all articles.

`list_articles` now accepts an optional `read_filter` parameter: `"all"` (default), `"unread"`, or `"read"`.

## Person C Frontend Integration

Sidebar additions:
- Sync All button triggers `start_sync(None)` and shows progress.
- Sync status bar shows progress during sync (polls every 2.5s).
- Failed feeds count with retry button.

Article list additions:
- Segmented control for all/unread/read filter.
- Automatic read marking for long and short articles.
- Read state is persisted locally and survives refresh.

AI features:
- LLM settings modal (base URL, API key, model name).
- Article summarization and translation.

## Data Storage

All sync data remains local SQLite data.

New table:

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

Sync configuration keys stored in `settings`:

```text
sync.enabled
sync.interval_minutes
sync.retry_limit
sync.next_sync_at
```

`feeds.last_sync_at` remains the source for the latest successful sync time of a feed.

## Privacy Boundary

Automatic sync only requests feed URLs that the user has added or imported. It does not upload feed data, article content, OPML data, API keys, summaries, translations, or annotations to any self-hosted service.

The Saved Articles feed is local-only and is not synced as a remote feed.

LLM features send article content to the user-configured LLM API endpoint only. No data is sent to Anthropic or any other third party unless the user configures it.

## Manual Acceptance

1. Run `cd app && npm run build` (TypeScript + Vite build).
2. Run `cd app/src-tauri && cargo check`.
3. Start the app and use the existing single Feed refresh button; it should still refresh articles.
4. Click "Sync All" in sidebar; all ordinary feeds should be synced with progress shown.
5. Add or keep one invalid Feed URL, then sync; valid feeds should continue and failed count should appear.
6. Click "Retry" on failed feeds bar; only failed feeds should be retried.
7. Toggle article read/unread status; it should persist after refresh.
8. Switch between all/unread/read filter; article list should update correctly.
9. Open a short unread article and wait briefly; it should become read without requiring scroll.
10. Restart the app; sync config and article read states should persist.
