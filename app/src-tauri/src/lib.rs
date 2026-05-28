mod opml;

mod llm_provider;
mod opml;

use llm_provider::LlmConfig;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

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
    pub raw_html: Option<String>,
    pub cleaned_html: Option<String>,
    pub cleaned_markdown: Option<String>,
    pub content_fetched_at: Option<String>,
    pub content_fetch_status: String,
    pub content_fetch_error: Option<String>,
    pub final_url: Option<String>,
    summary: Option<String>,
    translation: Option<String>,
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to get app data dir: {error}"))?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("Failed to create app data dir: {error}"))?;

    Ok(app_data_dir.join("mercury.db"))
}

pub fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let path = database_path(app)?;
    let conn = Connection::open(path)
        .map_err(|error| format!("Failed to open SQLite database: {error}"))?;

    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("Failed to enable SQLite foreign keys: {error}"))?;

    init_schema(&conn)?;
    seed_database(&conn)?;

    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS feeds (
            id           TEXT PRIMARY KEY,
            title        TEXT NOT NULL,
            url          TEXT NOT NULL UNIQUE,
            site_url     TEXT,
            unread       INTEGER NOT NULL DEFAULT 0,
            last_sync_at TEXT,
            created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
            cleaned_html TEXT,
            cleaned_markdown TEXT,
            content_fetched_at TEXT,
            content_fetch_status TEXT NOT NULL DEFAULT 'pending',
            content_fetch_error TEXT,
            final_url    TEXT,
            read_status  INTEGER NOT NULL DEFAULT 0,
            summary      TEXT,
            translation  TEXT,
            created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(feed_id) REFERENCES feeds(id),
            UNIQUE(feed_id, url)
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        ",
    )
    .map_err(|error| format!("Failed to initialize database schema: {error}"))?;

    // Migration: add columns to existing databases that lack them
    let migrations = [
        "ALTER TABLE feeds ADD COLUMN url TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE feeds ADD COLUMN site_url TEXT",
        "ALTER TABLE feeds ADD COLUMN last_sync_at TEXT",
        "ALTER TABLE feeds ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE feeds ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE articles ADD COLUMN url TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE articles ADD COLUMN guid TEXT",
        "ALTER TABLE articles ADD COLUMN author TEXT",
        "ALTER TABLE articles ADD COLUMN raw_html TEXT",
        "ALTER TABLE articles ADD COLUMN summary TEXT",
        "ALTER TABLE articles ADD COLUMN translation TEXT",
    ];
    for sql in &migrations {
        let _ = conn.execute(sql, []);
    }

    // Migration: add columns to existing databases that lack them
    let migrations = [
        "ALTER TABLE feeds ADD COLUMN url TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE feeds ADD COLUMN site_url TEXT",
        "ALTER TABLE feeds ADD COLUMN last_sync_at TEXT",
        "ALTER TABLE feeds ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE feeds ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE articles ADD COLUMN url TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE articles ADD COLUMN guid TEXT",
        "ALTER TABLE articles ADD COLUMN author TEXT",
        "ALTER TABLE articles ADD COLUMN raw_html TEXT",
        "ALTER TABLE articles ADD COLUMN summary TEXT",
        "ALTER TABLE articles ADD COLUMN translation TEXT",
    ];
    for sql in &migrations {
        let _ = conn.execute(sql, []);
    }

    ensure_article_content_columns(conn)?;

    Ok(())
}

fn ensure_article_content_columns(conn: &Connection) -> Result<(), String> {
    ensure_column_exists(conn, "articles", "cleaned_html", "cleaned_html TEXT")?;
    ensure_column_exists(
        conn,
        "articles",
        "cleaned_markdown",
        "cleaned_markdown TEXT",
    )?;
    ensure_column_exists(
        conn,
        "articles",
        "content_fetched_at",
        "content_fetched_at TEXT",
    )?;
    ensure_column_exists(
        conn,
        "articles",
        "content_fetch_status",
        "content_fetch_status TEXT NOT NULL DEFAULT 'pending'",
    )?;
    ensure_column_exists(
        conn,
        "articles",
        "content_fetch_error",
        "content_fetch_error TEXT",
    )?;
    ensure_column_exists(conn, "articles", "final_url", "final_url TEXT")?;
    Ok(())
}

fn ensure_column_exists(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("Failed to inspect table '{table}': {error}"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to query columns for '{table}': {error}"))?;

    for existing_column in columns {
        let existing_column =
            existing_column.map_err(|error| format!("Failed to read column name: {error}"))?;
        if existing_column == column {
            return Ok(());
        }
    }

    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {definition}"), [])
        .map_err(|error| format!("Failed to add column '{column}' to '{table}': {error}"))?;
    Ok(())
}

fn seed_database(_conn: &Connection) -> Result<(), String> {
    Ok(())
}

pub(crate) fn find_feed_by_url(conn: &Connection, url: &str) -> Result<Option<Feed>, String> {
    conn.query_row(
        "SELECT f.id, f.title, f.url, f.site_url, f.last_sync_at,
                COUNT(CASE WHEN a.read_status = 0 THEN 1 END) as unread
         FROM feeds f
         LEFT JOIN articles a ON a.feed_id = f.id
         WHERE f.url = ?1
         GROUP BY f.id, f.title, f.url, f.site_url, f.last_sync_at
         LIMIT 1",
        params![url],
        |row| {
            Ok(Feed {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                site_url: row.get(3)?,
                last_sync_at: row.get(4)?,
                unread: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("Failed to query feed by URL: {error}"))
}

pub(crate) fn select_feed_site_url(
    feed: &feed_rs::model::Feed,
    opml_site_url: Option<&str>,
    feed_url: &str,
) -> Option<String> {
    feed.links
        .iter()
        .find_map(|link| {
            let rel = link.rel.as_deref().unwrap_or("alternate");
            rel.eq_ignore_ascii_case("alternate")
                .then(|| clean_site_url(Some(&link.href), feed_url))
                .flatten()
        })
        .or_else(|| {
            feed.links.iter().find_map(|link| {
                let rel = link.rel.as_deref().unwrap_or("alternate");
                (!rel.eq_ignore_ascii_case("self"))
                    .then(|| clean_site_url(Some(&link.href), feed_url))
                    .flatten()
            })
        })
        .or_else(|| clean_site_url(opml_site_url, feed_url))
        .or_else(|| guess_site_url_from_feed_url(feed_url))
}

pub(crate) fn clean_site_url(candidate: Option<&str>, feed_url: &str) -> Option<String> {
    let candidate = candidate.map(str::trim).filter(|value| !value.is_empty())?;

    if urls_match(candidate, feed_url) || looks_like_feed_url(candidate) {
        return None;
    }

    Some(candidate.to_string())
}

pub(crate) fn guess_site_url_from_feed_url(feed_url: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(feed_url).ok()?;
    let had_query = url.query().is_some();
    url.set_query(None);
    url.set_fragment(None);

    let path = url.path().trim_end_matches('/').to_string();
    let lower_path = path.to_ascii_lowercase();
    let new_path = if lower_path.ends_with("/feed") {
        &path[..path.len() - "/feed".len()]
    } else if lower_path.ends_with("/rss2") {
        &path[..path.len() - "/rss2".len()]
    } else if lower_path.ends_with("/atom") {
        &path[..path.len() - "/atom".len()]
    } else if lower_path.ends_with("/rss") {
        &path[..path.len() - "/rss".len()]
    } else if lower_path.ends_with("/rss/index.xml") {
        &path[..path.len() - "/rss/index.xml".len()]
    } else if lower_path.ends_with("/index.xml") {
        &path[..path.len() - "/index.xml".len()]
    } else if had_query {
        path.as_str()
    } else {
        return None;
    };

    url.set_path(if new_path.is_empty() { "/" } else { new_path });
    Some(url.to_string())
}

fn urls_match(left: &str, right: &str) -> bool {
    match (reqwest::Url::parse(left), reqwest::Url::parse(right)) {
        (Ok(mut left), Ok(mut right)) => {
            left.set_fragment(None);
            right.set_fragment(None);
            left == right
        }
        _ => left.trim_end_matches('/') == right.trim_end_matches('/'),
    }
}

fn looks_like_feed_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };

    let path = parsed.path().trim_end_matches('/').to_ascii_lowercase();
    let has_feed_query = parsed
        .query_pairs()
        .any(|(key, value)| key.eq_ignore_ascii_case("feed") || value.eq_ignore_ascii_case("feed"));

    has_feed_query
        || path.ends_with("/feed")
        || path.ends_with("/rss")
        || path.ends_with("/rss2")
        || path.ends_with("/atom")
        || path.ends_with(".rss")
        || path.ends_with(".xml")
}

pub fn save_articles(
    conn: &Connection,
    feed_id: &str,
    entries: Vec<feed_rs::model::Entry>,
) -> Result<usize, String> {
    let mut saved = 0;

    for entry in entries {
        let url = match select_article_url(&entry) {
            Some(url) => url,
            None => continue,
        };

        let article_id = Uuid::new_v4().to_string();
        let guid = Some(entry.id.clone());
        let title = entry
            .title
            .map(|title| title.content)
            .unwrap_or_else(|| "Untitled".to_string());
        let author = entry.authors.first().map(|author| author.name.clone());
        let published_at = entry.published.map(|date| date.to_rfc3339());

        let excerpt = entry
            .summary
            .map(|summary| summary.content)
            .or_else(|| {
                entry
                    .content
                    .as_ref()
                    .and_then(|content| content.body.as_ref())
                    .map(|body| body.chars().take(200).collect())
            })
            .unwrap_or_default();

        let content = entry
            .content
            .and_then(|c| c.body)
            .unwrap_or_default();

        let result = conn
            .execute(
                "INSERT INTO articles
                (id, feed_id, title, url, guid, author, published_at, excerpt, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                article_id, feed_id, title, url, _guid,
                author, published_at, excerpt, content
            ],
        );

        if let Ok(1) = result {
            saved += 1;
        }
    }

    Ok(saved)
}

fn select_article_url(entry: &feed_rs::model::Entry) -> Option<String> {
    entry
        .links
        .iter()
        .find(|link| {
            link.rel
                .as_deref()
                .unwrap_or("alternate")
                .eq_ignore_ascii_case("alternate")
        })
        .or_else(|| entry.links.first())
        .map(|link| link.href.trim().to_string())
        .filter(|url| !url.is_empty())
}

#[tauri::command]
async fn add_feed(app: AppHandle, url: String) -> Result<Feed, String> {
    let response = reqwest::get(&url)
        .await
        .map_err(|error| format!("Failed to request feed URL: {error}"))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read feed response: {error}"))?;

    let parsed = feed_rs::parser::parse(bytes.as_ref())
        .map_err(|error| format!("Failed to parse RSS/Atom/JSON Feed: {error}"))?;

    let title = parsed
        .title
        .as_ref()
        .map(|title| title.content.clone())
        .unwrap_or_else(|| "Untitled feed".to_string());
    let site_url = select_feed_site_url(&parsed, None, &url);

    let conn = open_database(&app)?;

    if let Some(existing_feed) = find_feed_by_url(&conn, &url)? {
        save_articles(&conn, &existing_feed.id, parsed.entries)?;
        return find_feed_by_url(&conn, &url)?
            .ok_or_else(|| "Feed disappeared after saving articles".to_string());
    }

    let feed_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO feeds (id, title, url, site_url, last_sync_at)
         VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)",
        params![feed_id, title, url, site_url],
    )
    .map_err(|error| format!("Failed to save feed: {error}"))?;

    save_articles(&conn, &feed_id, parsed.entries)?;

    let unread: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE feed_id = ?1 AND read_status = 0",
            params![feed_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to query unread count: {error}"))?;

    let last_sync_at = conn
        .query_row(
            "SELECT last_sync_at FROM feeds WHERE id = ?1",
            params![feed_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to query sync time: {error}"))?;

    Ok(Feed {
        id: feed_id,
        title,
        url,
        site_url,
        unread,
        last_sync_at,
    })
}

#[tauri::command]
async fn refresh_feed(app: AppHandle, feed_id: String) -> Result<Vec<Article>, String> {
    let conn = open_database(&app)?;

    let feed_url: String = conn
        .query_row(
            "SELECT url FROM feeds WHERE id = ?1",
            params![feed_id],
            |row| row.get(0),
        )
        .map_err(|_| format!("Feed not found: {feed_id}"))?;

    let response = reqwest::get(&feed_url)
        .await
        .map_err(|error| format!("Failed to request feed: {error}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取失败: {e}"))?;
    let parsed = feed_rs::parser::parse(bytes.as_ref())
        .map_err(|e| format!("解析失败: {e}"))?;

    save_articles(&conn, &feed_id, parsed.entries)?;

    conn.execute(
        "UPDATE feeds SET last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1",
        params![feed_id],
    )
    .map_err(|error| format!("Failed to update sync time: {error}"))?;

    list_articles_by_feed(&conn, Some(&feed_id))
}

fn load_setting_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| {
        if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
            Ok(None)
        } else {
            Err(format!("Failed to load setting '{key}': {e}"))
        }
    })
}

fn get_llm_config_from_db(conn: &Connection) -> Result<LlmConfig, String> {
    let base_url = load_setting_value(conn, "llm_base_url")?
        .ok_or("LLM Base URL not configured. Please set it in Settings.".to_string())?;
    let api_key = load_setting_value(conn, "llm_api_key")?
        .ok_or("LLM API Key not configured. Please set it in Settings.".to_string())?;
    let model_name = load_setting_value(conn, "llm_model_name")?
        .ok_or("LLM Model Name not configured. Please set it in Settings.".to_string())?;

    Ok(LlmConfig {
        base_url,
        api_key,
        model_name,
    })
}

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
        .map_err(|error| format!("Failed to prepare feed query: {error}"))?;

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
        .map_err(|error| format!("Failed to query feeds: {error}"))?;

    let mut feeds = Vec::new();
    for row in rows {
        feeds.push(row.map_err(|error| format!("Failed to read feed row: {error}"))?);
    }
    Ok(feeds)
}

#[tauri::command]
fn list_articles(app: AppHandle, feed_id: Option<String>) -> Result<Vec<Article>, String> {
    let conn = open_database(&app)?;
    list_articles_by_feed(&conn, feed_id.as_deref())
}

fn list_articles_by_feed(conn: &Connection, feed_id: Option<&str>) -> Result<Vec<Article>, String> {
    let (sql, param): (String, Option<String>) = match feed_id {
        Some(id) => (
            "SELECT id, feed_id, title, url, author, published_at, excerpt, content
             FROM articles WHERE feed_id = ?1
             ORDER BY published_at DESC, created_at DESC"
                .to_string(),
            Some(id.to_string()),
        ),
        None => (
            "SELECT id, feed_id, title, url, author, published_at, excerpt, content
             FROM articles
             ORDER BY published_at DESC, created_at DESC"
                .to_string(),
            None,
        ),
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("准备查询失败: {e}"))?;

    let rows: Vec<Article> = match param {
        Some(param) => {
            let mut result = Vec::new();
            let rows = stmt.query_map(params![p], |row| {
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
            }).map_err(|e| format!("查询失败: {e}"))?;
            for row in rows {
                result.push(row.map_err(|error| format!("Failed to read article row: {error}"))?);
            }
            result
        }
        None => {
            let mut result = Vec::new();
            let rows = stmt.query_map([], |row| {
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
            }).map_err(|e| format!("查询失败: {e}"))?;
            for row in rows {
                result.push(row.map_err(|error| format!("Failed to read article row: {error}"))?);
            }
            result
        }
    };

    Ok(rows)
}

// mod opml;  // TODO: 取消注释 when Person C submits opml.rs

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
            // crate::opml::import_opml,  // TODO: 取消注释 when Person C submits opml.rs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
