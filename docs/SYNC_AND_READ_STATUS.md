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
```

`start_sync(Some(feed_id))` syncs one ordinary feed. `start_sync(None)` syncs all ordinary feeds in sequence and skips the local Saved Articles feed. A failed feed is recorded and does not stop the rest of the sync run.

`retry_failed_syncs()` only retries feeds currently present in `sync_failures`. A successful retry clears that feed's failure record.

`get_sync_status()` returns in-memory sync status for UI polling. The status is reset when a new sync starts and is updated after each feed completes.

`get_sync_config()` and `update_sync_config()` persist app-level sync settings in the local `settings` table. This phase stores configuration only; the first UI integration can trigger scheduled syncs while the app is running.

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

## Manual Acceptance

1. Run `cd app/src-tauri && cargo check`.
2. Start the app and use the existing single Feed refresh button; it should still refresh articles.
3. Call `start_sync` with `feedId: null`; all ordinary feeds should be synced in sequence.
4. Add or keep one invalid Feed URL, then call `start_sync`; valid feeds should continue syncing and the invalid feed should be recorded in `sync_failures`.
5. Call `get_sync_status` before, during, and after sync; it should return `idle`, `running`, then `success` or `failed` with feed counts.
6. Call `retry_failed_syncs`; only feeds in `sync_failures` should be retried.
7. Call `update_sync_config` with a positive interval and non-negative retry limit, then call `get_sync_config`; the saved values should be returned.
8. Call `update_sync_config` with `interval_minutes <= 0` or `retry_limit < 0`; it should return an error.
