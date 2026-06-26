use crate::{
    open_database, resolve_feed_import, save_articles, select_feed_site_url, SAVED_ARTICLES_FEED_ID,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, State};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub phase: String,
    pub current_feed_id: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub total_feeds: i64,
    pub completed_feeds: i64,
    pub failed_feeds: Vec<SyncFeedFailure>,
    pub last_error: Option<String>,
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            current_feed_id: None,
            started_at: None,
            finished_at: None,
            total_feeds: 0,
            completed_feeds: 0,
            failed_feeds: Vec::new(),
            last_error: None,
        }
    }
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
pub struct ScheduledSyncResult {
    pub ran: bool,
    pub next_sync_at: Option<String>,
    pub report: Option<SyncReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub enabled: bool,
    pub interval_minutes: i64,
    pub retry_limit: i64,
    pub next_sync_at: Option<String>,
}

pub struct SyncState {
    status: Mutex<SyncStatus>,
}

impl Default for SyncState {
    fn default() -> Self {
        Self {
            status: Mutex::new(SyncStatus::default()),
        }
    }
}

#[derive(Debug, Clone)]
struct FeedSyncTarget {
    id: String,
    title: String,
    url: String,
}

pub async fn sync_one_feed(app: &AppHandle, feed_id: &str) -> Result<i64, String> {
    if feed_id == SAVED_ARTICLES_FEED_ID {
        return Err("Internal captured-articles feed does not have a remote feed URL".to_string());
    }

    let target = {
        let conn = open_database(app)?;
        load_feed_target(&conn, feed_id)?
    };

    let resolved = resolve_feed_import(&target.url).await?;
    let parsed = resolved.feed;
    let feed_url = resolved.feed_url;
    let title = parsed
        .title
        .as_ref()
        .map(|title| title.content.clone())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| target.title.clone());
    let site_url = select_feed_site_url(&parsed, None, &feed_url);

    let conn = open_database(app)?;
    let saved = save_articles(&conn, feed_id, &feed_url, parsed.entries)? as i64;
    conn.execute(
        "UPDATE feeds
         SET title = ?1,
             url = ?2,
             site_url = ?3,
             last_sync_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?4",
        params![title, feed_url, site_url, feed_id],
    )
    .map_err(|error| format!("Failed to update feed after sync: {error}"))?;
    clear_sync_failure(&conn, feed_id)?;

    Ok(saved)
}

#[tauri::command]
pub async fn start_sync(
    app: AppHandle,
    state: State<'_, SyncState>,
    feed_id: Option<String>,
) -> Result<SyncReport, String> {
    let targets = {
        let conn = open_database(&app)?;
        match feed_id.as_deref() {
            Some(SAVED_ARTICLES_FEED_ID) => {
                return Err("Internal captured-articles feed does not have a remote feed URL".to_string());
            }
            Some(feed_id) => vec![load_feed_target(&conn, feed_id)?],
            None => load_all_sync_targets(&conn)?,
        }
    };

    run_sync_targets(app, state, targets).await
}

#[tauri::command]
pub async fn retry_failed_syncs(
    app: AppHandle,
    state: State<'_, SyncState>,
) -> Result<SyncReport, String> {
    let targets = {
        let conn = open_database(&app)?;
        load_failed_sync_targets(&conn)?
    };

    run_sync_targets(app, state, targets).await
}

#[tauri::command]
pub async fn run_scheduled_sync(
    app: AppHandle,
    state: State<'_, SyncState>,
) -> Result<ScheduledSyncResult, String> {
    let (config, due, targets) = {
        let conn = open_database(&app)?;
        let config = load_sync_config(&conn)?;
        if !config.enabled {
            return Ok(ScheduledSyncResult {
                ran: false,
                next_sync_at: config.next_sync_at,
                report: None,
            });
        }

        let due = sync_is_due(&conn, config.next_sync_at.as_deref())?;
        let targets = if due {
            load_all_sync_targets(&conn)?
        } else {
            Vec::new()
        };
        (config, due, targets)
    };

    if !due {
        return Ok(ScheduledSyncResult {
            ran: false,
            next_sync_at: config.next_sync_at,
            report: None,
        });
    }

    let report = run_sync_targets(app.clone(), state, targets).await?;
    let next_sync_at = {
        let conn = open_database(&app)?;
        let next_sync_at = next_sync_time(&conn, config.interval_minutes)?;
        save_optional_setting(&conn, "sync.next_sync_at", Some(&next_sync_at))?;
        next_sync_at
    };

    Ok(ScheduledSyncResult {
        ran: true,
        next_sync_at: Some(next_sync_at),
        report: Some(report),
    })
}

#[tauri::command]
pub fn get_sync_status(state: State<'_, SyncState>) -> Result<SyncStatus, String> {
    clone_status(&state)
}

#[tauri::command]
pub fn get_sync_config(app: AppHandle) -> Result<SyncConfig, String> {
    let conn = open_database(&app)?;
    load_sync_config(&conn)
}

#[tauri::command]
pub fn update_sync_config(
    app: AppHandle,
    enabled: bool,
    interval_minutes: i64,
    retry_limit: i64,
) -> Result<SyncConfig, String> {
    if interval_minutes <= 0 {
        return Err("Sync interval must be greater than 0 minutes".to_string());
    }
    if retry_limit < 0 {
        return Err("Retry limit cannot be negative".to_string());
    }

    let conn = open_database(&app)?;
    let next_sync_at = if enabled {
        Some(next_sync_time(&conn, interval_minutes)?)
    } else {
        None
    };

    save_setting(
        &conn,
        "sync.enabled",
        if enabled { "true" } else { "false" },
    )?;
    save_setting(
        &conn,
        "sync.interval_minutes",
        &interval_minutes.to_string(),
    )?;
    save_setting(&conn, "sync.retry_limit", &retry_limit.to_string())?;
    save_optional_setting(&conn, "sync.next_sync_at", next_sync_at.as_deref())?;

    load_sync_config(&conn)
}

async fn run_sync_targets(
    app: AppHandle,
    state: State<'_, SyncState>,
    targets: Vec<FeedSyncTarget>,
) -> Result<SyncReport, String> {
    let started_at = current_timestamp(&app)?;
    begin_sync(&state, &started_at, targets.len() as i64)?;

    let mut synced_feeds = 0;
    let mut new_articles = 0;
    let mut failed_feeds = Vec::new();

    for target in targets {
        set_current_feed(&state, Some(target.id.clone()))?;

        match sync_one_feed(&app, &target.id).await {
            Ok(saved) => {
                synced_feeds += 1;
                new_articles += saved;
            }
            Err(error) => {
                let failure = {
                    let conn = open_database(&app)?;
                    save_sync_failure(&conn, &target.id, &target.title, &error)?;
                    load_sync_failure(&conn, &target.id)?
                };
                failed_feeds.push(failure);
            }
        }

        update_progress(
            &state,
            synced_feeds + failed_feeds.len() as i64,
            &failed_feeds,
        )?;
    }

    let finished_at = current_timestamp(&app)?;
    finish_sync(&state, &finished_at, &failed_feeds)?;

    Ok(SyncReport {
        total_feeds: synced_feeds + failed_feeds.len() as i64,
        synced_feeds,
        failed_feeds,
        new_articles,
        started_at,
        finished_at,
    })
}

fn begin_sync(
    state: &State<'_, SyncState>,
    started_at: &str,
    total_feeds: i64,
) -> Result<(), String> {
    let mut status = state
        .status
        .lock()
        .map_err(|_| "Failed to lock sync status".to_string())?;
    if status.phase == "running" {
        return Err("Sync is already running".to_string());
    }

    *status = SyncStatus {
        phase: "running".to_string(),
        current_feed_id: None,
        started_at: Some(started_at.to_string()),
        finished_at: None,
        total_feeds,
        completed_feeds: 0,
        failed_feeds: Vec::new(),
        last_error: None,
    };
    Ok(())
}

fn set_current_feed(state: &State<'_, SyncState>, feed_id: Option<String>) -> Result<(), String> {
    let mut status = state
        .status
        .lock()
        .map_err(|_| "Failed to lock sync status".to_string())?;
    status.current_feed_id = feed_id;
    Ok(())
}

fn update_progress(
    state: &State<'_, SyncState>,
    completed_feeds: i64,
    failed_feeds: &[SyncFeedFailure],
) -> Result<(), String> {
    let mut status = state
        .status
        .lock()
        .map_err(|_| "Failed to lock sync status".to_string())?;
    status.completed_feeds = completed_feeds;
    status.failed_feeds = failed_feeds.to_vec();
    status.last_error = failed_feeds.last().map(|failure| failure.error.clone());
    Ok(())
}

fn finish_sync(
    state: &State<'_, SyncState>,
    finished_at: &str,
    failed_feeds: &[SyncFeedFailure],
) -> Result<(), String> {
    let mut status = state
        .status
        .lock()
        .map_err(|_| "Failed to lock sync status".to_string())?;
    status.phase = if failed_feeds.is_empty() {
        "success".to_string()
    } else {
        "failed".to_string()
    };
    status.current_feed_id = None;
    status.finished_at = Some(finished_at.to_string());
    status.failed_feeds = failed_feeds.to_vec();
    status.last_error = failed_feeds.last().map(|failure| failure.error.clone());
    Ok(())
}

fn clone_status(state: &State<'_, SyncState>) -> Result<SyncStatus, String> {
    state
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "Failed to lock sync status".to_string())
}

fn load_feed_target(conn: &Connection, feed_id: &str) -> Result<FeedSyncTarget, String> {
    conn.query_row(
        "SELECT id, title, COALESCE(url, '')
         FROM feeds
         WHERE id = ?1",
        params![feed_id],
        feed_target_from_row,
    )
    .optional()
    .map_err(|error| format!("Failed to query feed: {error}"))?
    .ok_or_else(|| format!("Feed not found: {feed_id}"))
}

fn load_all_sync_targets(conn: &Connection) -> Result<Vec<FeedSyncTarget>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, COALESCE(url, '')
             FROM feeds
             WHERE id != ?1
             ORDER BY title ASC",
        )
        .map_err(|error| format!("Failed to prepare feed sync query: {error}"))?;
    let rows = stmt
        .query_map(params![SAVED_ARTICLES_FEED_ID], feed_target_from_row)
        .map_err(|error| format!("Failed to query sync feeds: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read sync feed row: {error}"))
}

fn load_failed_sync_targets(conn: &Connection) -> Result<Vec<FeedSyncTarget>, String> {
    let retry_limit = parse_i64_setting(setting_value(conn, "sync.retry_limit")?, 3);
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.title, COALESCE(f.url, '')
             FROM sync_failures sf
             JOIN feeds f ON f.id = sf.feed_id
             WHERE f.id != ?1
               AND sf.retry_count < ?2
             ORDER BY sf.failed_at ASC",
        )
        .map_err(|error| format!("Failed to prepare failed sync query: {error}"))?;
    let rows = stmt
        .query_map(params![SAVED_ARTICLES_FEED_ID, retry_limit], feed_target_from_row)
        .map_err(|error| format!("Failed to query failed sync feeds: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read failed sync feed row: {error}"))
}

fn feed_target_from_row(row: &Row<'_>) -> rusqlite::Result<FeedSyncTarget> {
    Ok(FeedSyncTarget {
        id: row.get(0)?,
        title: row.get(1)?,
        url: row.get(2)?,
    })
}

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
            feed_title = excluded.feed_title,
            error = excluded.error,
            retry_count = sync_failures.retry_count + 1,
            failed_at = CURRENT_TIMESTAMP",
        params![feed_id, feed_title, error],
    )
    .map_err(|error| format!("Failed to save sync failure: {error}"))?;
    Ok(())
}

fn clear_sync_failure(conn: &Connection, feed_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM sync_failures WHERE feed_id = ?1",
        params![feed_id],
    )
    .map_err(|error| format!("Failed to clear sync failure: {error}"))?;
    Ok(())
}

fn load_sync_failure(conn: &Connection, feed_id: &str) -> Result<SyncFeedFailure, String> {
    conn.query_row(
        "SELECT feed_id, feed_title, error, retry_count, failed_at
         FROM sync_failures
         WHERE feed_id = ?1",
        params![feed_id],
        sync_failure_from_row,
    )
    .map_err(|error| format!("Failed to load sync failure: {error}"))
}

fn sync_failure_from_row(row: &Row<'_>) -> rusqlite::Result<SyncFeedFailure> {
    Ok(SyncFeedFailure {
        feed_id: row.get(0)?,
        feed_title: row.get(1)?,
        error: row.get(2)?,
        retry_count: row.get(3)?,
        failed_at: row.get(4)?,
    })
}

fn load_sync_config(conn: &Connection) -> Result<SyncConfig, String> {
    Ok(SyncConfig {
        enabled: parse_bool_setting(setting_value(conn, "sync.enabled")?, false),
        interval_minutes: parse_i64_setting(setting_value(conn, "sync.interval_minutes")?, 30),
        retry_limit: parse_i64_setting(setting_value(conn, "sync.retry_limit")?, 3),
        next_sync_at: setting_value(conn, "sync.next_sync_at")?,
    })
}

fn setting_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|value| value.flatten().filter(|inner| !inner.trim().is_empty()))
    .map_err(|error| format!("Failed to read setting {key}: {error}"))
}

fn parse_bool_setting(value: Option<String>, fallback: bool) -> bool {
    value
        .as_deref()
        .map(|inner| inner.eq_ignore_ascii_case("true") || inner == "1")
        .unwrap_or(fallback)
}

fn parse_i64_setting(value: Option<String>, fallback: i64) -> i64 {
    value
        .and_then(|inner| inner.parse::<i64>().ok())
        .unwrap_or(fallback)
}

fn save_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|error| format!("Failed to save setting {key}: {error}"))?;
    Ok(())
}

fn save_optional_setting(conn: &Connection, key: &str, value: Option<&str>) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|error| format!("Failed to save setting {key}: {error}"))?;
    Ok(())
}

fn current_timestamp(app: &AppHandle) -> Result<String, String> {
    let conn = open_database(app)?;
    conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now')", [], |row| {
        row.get(0)
    })
    .map_err(|error| format!("Failed to read current time: {error}"))
}

fn next_sync_time(conn: &Connection, interval_minutes: i64) -> Result<String, String> {
    let modifier = format!("+{interval_minutes} minutes");
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1)",
        params![modifier],
        |row| row.get(0),
    )
    .map_err(|error| format!("Failed to compute next sync time: {error}"))
}

fn sync_is_due(conn: &Connection, next_sync_at: Option<&str>) -> Result<bool, String> {
    let Some(next_sync_at) = next_sync_at.filter(|value| !value.trim().is_empty()) else {
        return Ok(true);
    };

    conn.query_row(
        "SELECT CASE WHEN strftime('%s', 'now') >= strftime('%s', ?1) THEN 1 ELSE 0 END",
        params![next_sync_at],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .map_err(|error| format!("Failed to check scheduled sync time: {error}"))
}
