mod llm_provider;
pub mod opml;
pub mod sync;

use encoding_rs::Encoding;
use llm_provider::LlmConfig;
use reqwest::{header::CONTENT_TYPE, Client, Url};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const CLEANER_VERSION: &str = "node-readability-v4";
const FALLBACK_CLEANER_VERSION: &str = "rust-fallback-v1";
pub(crate) const SAVED_ARTICLES_FEED_ID: &str = "saved";
const SAVED_ARTICLES_FEED_TITLE: &str = "__internal_captured_articles";
const SAVED_ARTICLES_FEED_URL: &str = "mercury://internal/captured-articles";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub id: String,
    pub title: String,
    pub url: String,
    pub site_url: Option<String>,
    pub unread: i64,
    pub total: i64,
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
    pub summary: Option<String>,
    pub summary_lang: Option<String>,
    pub translation: Option<String>,
    pub translation_lang: Option<String>,
    pub is_read: bool,
    pub is_favorite: bool,
    pub read_later: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedUnread {
    pub feed_id: String,
    pub feed_title: String,
    pub unread: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadSummary {
    pub total_unread: i64,
    pub feed_unread: Vec<FeedUnread>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Annotation {
    id: String,
    article_id: String,
    kind: String,
    selected_text: Option<String>,
    prefix_text: Option<String>,
    suffix_text: Option<String>,
    start_offset: Option<i64>,
    end_offset: Option<i64>,
    note_text: Option<String>,
    highlight_color: Option<String>,
    highlight_style: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiJobStatus {
    id: String,
    kind: String,
    article_id: String,
    target_lang: String,
    status: String,
    result: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Default)]
struct AiJobState {
    jobs: Arc<Mutex<HashMap<String, AiJobStatus>>>,
}

#[derive(Debug, Serialize)]
struct NodeCleanerInput {
    html: String,
    url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct NodeCleanerOutput {
    title: Option<String>,
    byline: Option<String>,
    excerpt: Option<String>,
    cleaned_html: Option<String>,
    cleaned_markdown: Option<String>,
}

struct CleanerRunResult {
    output: NodeCleanerOutput,
    version: &'static str,
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

    // Seed non-sensitive defaults once, without overwriting the user's local settings.
    seed_setting_if_missing(&conn, "llm_base_url", "https://chat.ecnu.edu.cn/open/api")?;
    seed_setting_if_missing(&conn, "llm_model_name", "ecnu-plus")?;
    let default_base_url = load_setting_value(&conn, "llm_base_url")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://chat.ecnu.edu.cn/open/api".to_string());
    let default_model = load_setting_value(&conn, "llm_model_name")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "ecnu-plus".to_string());
    seed_setting_if_missing(&conn, "llm_summary_base_url", &default_base_url)?;
    seed_setting_if_missing(&conn, "llm_summary_model_name", &default_model)?;
    seed_setting_if_missing(&conn, "llm_translation_base_url", &default_base_url)?;
    seed_setting_if_missing(&conn, "llm_translation_model_name", &default_model)?;

    Ok(conn)
}

fn seed_setting_if_missing(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO NOTHING",
        params![key, value],
    )
    .map_err(|error| format!("Failed to seed setting '{key}': {error}"))?;
    Ok(())
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
            id                   TEXT PRIMARY KEY,
            feed_id              TEXT NOT NULL,
            title                TEXT NOT NULL,
            url                  TEXT NOT NULL,
            guid                 TEXT,
            author               TEXT,
            published_at         TEXT,
            excerpt              TEXT NOT NULL DEFAULT '',
            content              TEXT NOT NULL DEFAULT '',
            raw_html             TEXT,
            cleaned_html         TEXT,
            cleaned_markdown     TEXT,
            cleaner_version      TEXT,
            content_fetched_at   TEXT,
            content_fetch_status TEXT NOT NULL DEFAULT 'pending',
            content_fetch_error  TEXT,
            final_url            TEXT,
            read_status          INTEGER NOT NULL DEFAULT 0,
            summary              TEXT,
            summary_lang         TEXT,
            translation          TEXT,
            translation_lang     TEXT,
            is_favorite          INTEGER NOT NULL DEFAULT 0,
            read_later           INTEGER NOT NULL DEFAULT 0,
            created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(feed_id) REFERENCES feeds(id),
            UNIQUE(feed_id, url)
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS sync_failures (
            feed_id TEXT PRIMARY KEY,
            feed_title TEXT NOT NULL,
            error TEXT NOT NULL,
            retry_count INTEGER NOT NULL DEFAULT 0,
            failed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(feed_id) REFERENCES feeds(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS annotations (
            id TEXT PRIMARY KEY,
            article_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('highlight', 'note')),
            selected_text TEXT,
            prefix_text TEXT,
            suffix_text TEXT,
            start_offset INTEGER,
            end_offset INTEGER,
            note_text TEXT,
            highlight_color TEXT,
            highlight_style TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(article_id) REFERENCES articles(id) ON DELETE CASCADE
        );
        ",
    )
    .map_err(|error| format!("Failed to initialize database schema: {error}"))?;

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
        "ALTER TABLE articles ADD COLUMN cleaned_html TEXT",
        "ALTER TABLE articles ADD COLUMN cleaned_markdown TEXT",
        "ALTER TABLE articles ADD COLUMN cleaner_version TEXT",
        "ALTER TABLE articles ADD COLUMN content_fetched_at TEXT",
        "ALTER TABLE articles ADD COLUMN content_fetch_status TEXT NOT NULL DEFAULT 'pending'",
        "ALTER TABLE articles ADD COLUMN content_fetch_error TEXT",
        "ALTER TABLE articles ADD COLUMN final_url TEXT",
        "ALTER TABLE articles ADD COLUMN summary TEXT",
        "ALTER TABLE articles ADD COLUMN summary_lang TEXT",
        "ALTER TABLE articles ADD COLUMN translation TEXT",
        "ALTER TABLE articles ADD COLUMN translation_lang TEXT",
        "ALTER TABLE articles ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE articles ADD COLUMN read_later INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE annotations ADD COLUMN highlight_color TEXT",
        "ALTER TABLE annotations ADD COLUMN highlight_style TEXT",
    ];

    for sql in &migrations {
        let _ = conn.execute(sql, []);
    }

    Ok(())
}

pub(crate) fn find_feed_by_url(conn: &Connection, url: &str) -> Result<Option<Feed>, String> {
    conn.query_row(
        "SELECT f.id, f.title, COALESCE(f.url, ''), f.site_url, f.last_sync_at,
                COUNT(CASE WHEN a.read_status = 0 THEN 1 END) as unread,
                COUNT(a.id) as total
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
                total: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("Failed to query feed by URL: {error}"))
}

pub async fn import_feed(app: &AppHandle, url: &str) -> Result<Feed, String> {
    let resolved = resolve_feed_import(url).await?;
    let parsed = resolved.feed;
    let feed_url = resolved.feed_url;

    let title = parsed
        .title
        .as_ref()
        .map(|title| title.content.clone())
        .unwrap_or_else(|| "Untitled feed".to_string());
    let site_url = select_feed_site_url(&parsed, None, &feed_url);
    let conn = open_database(app)?;

    if let Some(existing_feed) = find_feed_by_url(&conn, &feed_url)? {
        save_articles(&conn, &existing_feed.id, &feed_url, parsed.entries)?;
        return find_feed_by_url(&conn, &feed_url)?
            .ok_or_else(|| "Feed disappeared after saving articles".to_string());
    }

    let feed_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO feeds (id, title, url, site_url, last_sync_at)
         VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)",
        params![feed_id, title, feed_url, site_url],
    )
    .map_err(|error| format!("Failed to save feed: {error}"))?;

    save_articles(&conn, &feed_id, &feed_url, parsed.entries)?;

    let unread: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE feed_id = ?1 AND read_status = 0",
            params![feed_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to query unread count: {error}"))?;
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE feed_id = ?1",
            params![feed_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to query total article count: {error}"))?;
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
        url: feed_url,
        site_url,
        unread,
        total,
        last_sync_at,
    })
}

struct ResolvedFeedImport {
    feed_url: String,
    feed: feed_rs::model::Feed,
}

struct FeedFetchResponse {
    final_url: String,
    content_type: Option<String>,
    bytes: Vec<u8>,
}

async fn resolve_feed_import(input_url: &str) -> Result<ResolvedFeedImport, String> {
    let primary = fetch_feed_resource(input_url).await?;
    if let Ok(feed) = feed_rs::parser::parse(primary.bytes.as_slice()) {
        return Ok(ResolvedFeedImport {
            feed_url: primary.final_url,
            feed,
        });
    }

    let primary_parse_error = feed_rs::parser::parse(primary.bytes.as_slice())
        .err()
        .map(|error| error.to_string())
        .unwrap_or_else(|| "Unknown feed parsing error".to_string());
    let mut tried_urls = vec![primary.final_url.clone()];
    let primary_html = decode_http_body(primary.content_type.as_deref(), &primary.bytes);

    let mut candidates = discover_feed_links_from_html(&primary.final_url, &primary_html);
    candidates.extend(common_feed_candidate_urls(&primary.final_url));
    candidates.dedup();

    for candidate in candidates {
        if tried_urls.iter().any(|tried| urls_match(tried, &candidate)) {
            continue;
        }
        tried_urls.push(candidate.clone());

        let fetched = match fetch_feed_resource(&candidate).await {
            Ok(value) => value,
            Err(_) => continue,
        };

        if let Ok(feed) = feed_rs::parser::parse(fetched.bytes.as_slice()) {
            return Ok(ResolvedFeedImport {
                feed_url: fetched.final_url,
                feed,
            });
        }
    }

    let tried_summary = tried_urls.join(", ");
    if looks_like_html_content(primary.content_type.as_deref(), &primary_html) {
        return Err(format!(
            "This URL looks like a webpage, not a feed. Mercury tried these feed URLs: {}. Original parse error: {}",
            tried_summary, primary_parse_error
        ));
    }

    Err(format!(
        "Failed to parse RSS/Atom/JSON Feed. Tried: {}. Parse error: {}",
        tried_summary, primary_parse_error
    ))
}

async fn fetch_feed_resource(url: &str) -> Result<FeedFetchResponse, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .http1_only()
        .user_agent("Mercury/0.1 feed-import")
        .build()
        .map_err(|error| {
            format!(
                "Failed to create feed HTTP client: {}",
                reqwest_error_details(&error, url)
            )
        })?;

    let response = client.get(url).send().await.map_err(|error| {
        format!(
            "Failed to request feed URL: {}",
            reqwest_error_details(&error, url)
        )
    })?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to request feed URL: HTTP {}",
            response.status()
        ));
    }

    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read feed response: {error}"))?;

    Ok(FeedFetchResponse {
        final_url,
        content_type,
        bytes: bytes.to_vec(),
    })
}

fn decode_http_body(content_type: Option<&str>, bytes: &[u8]) -> String {
    let charset = content_type
        .and_then(extract_charset_from_content_type)
        .or_else(|| extract_charset_from_html(bytes))
        .unwrap_or_else(|| "utf-8".to_string());
    let encoding = Encoding::for_label(charset.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (decoded, _, _) = encoding.decode(bytes);
    decoded.into_owned()
}

fn reqwest_error_details(error: &reqwest::Error, url: &str) -> String {
    let category = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_request() {
        "request"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else {
        "unknown"
    };

    let mut parts = vec![
        format!("type={category}"),
        format!("url={url}"),
        format!("message={error}"),
    ];

    if let Some(status) = error.status() {
        parts.push(format!("status={status}"));
    }

    if let Some(error_url) = error.url() {
        parts.push(format!("reqwest_url={error_url}"));
    }

    let mut sources = Vec::new();
    let mut current = std::error::Error::source(error);
    while let Some(source) = current {
        sources.push(source.to_string());
        current = source.source();
    }
    if !sources.is_empty() {
        parts.push(format!("sources={}", sources.join(" | ")));
    }

    parts.join("; ")
}

fn looks_like_html_content(content_type: Option<&str>, body: &str) -> bool {
    let from_header = content_type
        .map(|value| value.to_ascii_lowercase().contains("text/html"))
        .unwrap_or(false);
    let body_sample = body[..body.len().min(512)].to_ascii_lowercase();
    from_header
        || body_sample.contains("<html")
        || body_sample.contains("<head")
        || body_sample.contains("<body")
}

fn discover_feed_links_from_html(base_url: &str, html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut candidates = Vec::new();
    let mut search_from = 0usize;

    while let Some(relative_index) = lower[search_from..].find("<link") {
        let start = search_from + relative_index;
        let Some(end_relative) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_relative + 1;
        let tag = &html[start..end];
        let tag_lower = &lower[start..end];

        let is_feed_link = (tag_lower.contains("application/rss+xml")
            || tag_lower.contains("application/atom+xml")
            || tag_lower.contains("application/feed+json")
            || tag_lower.contains("application/json"))
            && tag_lower.contains("alternate");

        if is_feed_link {
            if let Some(href) = extract_html_attr(tag, "href") {
                if let Ok(base) = Url::parse(base_url) {
                    if let Ok(resolved) = base.join(href.trim()) {
                        candidates.push(resolved.to_string());
                    }
                }
            }
        }

        search_from = end;
    }

    candidates
}

fn extract_html_attr<'a>(tag: &'a str, attr_name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{attr_name}=");
    let start = lower.find(&needle)? + needle.len();
    let remainder = &tag[start..];
    let quote = remainder.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let value = &remainder[1..];
    let end = value.find(quote)?;
    Some(&value[..end])
}

fn common_feed_candidate_urls(base_url: &str) -> Vec<String> {
    let Ok(parsed) = Url::parse(base_url) else {
        return Vec::new();
    };

    let mut roots = Vec::new();
    roots.push(parsed.clone());

    let mut directory = parsed.clone();
    let path = directory.path().to_string();
    if path.ends_with(".html") {
        let trimmed = path.rsplit_once('/').map(|value| value.0).unwrap_or("");
        directory.set_path(if trimmed.is_empty() { "/" } else { trimmed });
        roots.push(directory.clone());
    }

    if !path.ends_with('/') {
        let mut section = parsed.clone();
        section.set_path(&format!("{}/", path));
        roots.push(section);
    }

    let suffixes = ["index.xml", "feed.xml", "feed", "rss.xml", "atom.xml"];
    let mut candidates = Vec::new();

    for mut root in roots {
        let base_path = root.path().trim_end_matches('/').to_string();
        for suffix in suffixes {
            let candidate_path = if base_path.is_empty() || base_path == "/" {
                format!("/{}", suffix)
            } else {
                format!("{}/{}", base_path, suffix)
            };
            root.set_path(&candidate_path);
            candidates.push(root.to_string());
        }
    }

    candidates
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

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("Failed to inspect table '{table}': {error}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to query columns for '{table}': {error}"))?;

    for row in rows {
        let existing = row.map_err(|error| format!("Failed to read column name: {error}"))?;
        if existing == column {
            return Ok(true);
        }
    }

    Ok(false)
}

pub fn save_articles(
    conn: &Connection,
    feed_id: &str,
    feed_url: &str,
    entries: Vec<feed_rs::model::Entry>,
) -> Result<usize, String> {
    let mut saved = 0;
    let has_legacy_source_column = table_has_column(conn, "articles", "source")?;
    let mut dedupe_state = ArticleDedupeState::load(conn, feed_id)?;
    dedupe_state.cleanup_existing(conn)?;

    for entry in entries {
        let url = match select_article_url(&entry, feed_url) {
            Some(url) => url,
            None => continue,
        };
        let canonical_url = canonicalize_article_url(&url);

        let guid = normalize_entry_guid(&entry.id);
        let title = entry
            .title
            .map(|title| title.content)
            .unwrap_or_else(|| "Untitled".to_string());
        let author = entry.authors.first().map(|author| author.name.clone());
        let published_at = entry.published.map(|date| date.to_rfc3339());
        let published_at_for_legacy = published_at.clone().unwrap_or_default();
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
            .and_then(|content| content.body)
            .unwrap_or_default();
        let title_published_key = article_title_published_key(&title, published_at.as_deref());

        if let Some(existing_id) = dedupe_state.find_existing(
            guid.as_deref(),
            &canonical_url,
            title_published_key.as_deref(),
        ) {
            update_existing_article_from_feed(
                conn,
                has_legacy_source_column,
                existing_id,
                &canonical_url,
                guid.as_deref(),
                &title,
                author.as_deref(),
                published_at.as_deref(),
                &published_at_for_legacy,
                &excerpt,
                &content,
            )?;
            continue;
        }

        let article_id = Uuid::new_v4().to_string();

        let inserted = if has_legacy_source_column {
            conn.execute(
                "INSERT OR IGNORE INTO articles
                    (id, feed_id, title, source, published_at, excerpt, content, url, guid, author)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    article_id,
                    feed_id,
                    title,
                    canonical_url,
                    published_at_for_legacy,
                    excerpt,
                    content,
                    canonical_url,
                    guid,
                    author
                ],
            )
        } else {
            conn.execute(
                "INSERT OR IGNORE INTO articles
                    (id, feed_id, title, url, guid, author, published_at, excerpt, content)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    article_id,
                    feed_id,
                    title,
                    canonical_url,
                    guid,
                    author,
                    published_at,
                    excerpt,
                    content
                ],
            )
        }
        .map_err(|error| format!("Failed to save article: {error}"))?;

        if inserted == 1 {
            saved += 1;
            dedupe_state.remember(article_id, guid, canonical_url, title_published_key);
        }
    }

    Ok(saved)
}

#[derive(Clone)]
struct ExistingArticleRecord {
    id: String,
    guid: Option<String>,
    url: String,
    title: String,
    published_at: Option<String>,
    is_read: bool,
    is_favorite: bool,
    read_later: bool,
}

struct ArticleDedupeState {
    records: Vec<ExistingArticleRecord>,
    by_guid: HashMap<String, String>,
    by_url: HashMap<String, String>,
    by_title_published: HashMap<String, String>,
}

impl ArticleDedupeState {
    fn load(conn: &Connection, feed_id: &str) -> Result<Self, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, guid, url, title, published_at, read_status, is_favorite, read_later
                 FROM articles
                 WHERE feed_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|error| format!("Failed to prepare article dedupe query: {error}"))?;

        let records = stmt
            .query_map(params![feed_id], |row| {
                let read_status: i64 = row.get(5)?;
                let is_favorite: i64 = row.get(6)?;
                let read_later: i64 = row.get(7)?;
                Ok(ExistingArticleRecord {
                    id: row.get(0)?,
                    guid: row.get(1)?,
                    url: row.get(2)?,
                    title: row.get(3)?,
                    published_at: row.get(4)?,
                    is_read: read_status != 0,
                    is_favorite: is_favorite != 0,
                    read_later: read_later != 0,
                })
            })
            .map_err(|error| format!("Failed to query existing articles: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to collect existing articles: {error}"))?;

        Ok(Self {
            records,
            by_guid: HashMap::new(),
            by_url: HashMap::new(),
            by_title_published: HashMap::new(),
        })
    }

    fn cleanup_existing(&mut self, conn: &Connection) -> Result<(), String> {
        let mut keepers: HashMap<String, ExistingArticleRecord> = HashMap::new();
        self.by_guid.clear();
        self.by_url.clear();
        self.by_title_published.clear();

        for record in self.records.clone() {
            let guid_key = record.guid.as_deref().and_then(normalize_entry_guid);
            let url_key = canonicalize_article_url(&record.url);
            let title_key =
                article_title_published_key(&record.title, record.published_at.as_deref());

            let keeper_id = guid_key
                .as_ref()
                .and_then(|key| self.by_guid.get(key).cloned())
                .or_else(|| self.by_url.get(&url_key).cloned())
                .or_else(|| {
                    title_key
                        .as_ref()
                        .and_then(|key| self.by_title_published.get(key).cloned())
                });

            if let Some(keeper_id) = keeper_id {
                if let Some(keeper) = keepers.get_mut(&keeper_id) {
                    merge_duplicate_article(conn, keeper, &record)?;
                }
                continue;
            }

            self.remember(record.id.clone(), guid_key, url_key, title_key);
            keepers.insert(record.id.clone(), record);
        }

        self.records = keepers.into_values().collect();
        Ok(())
    }

    fn find_existing(
        &self,
        guid: Option<&str>,
        canonical_url: &str,
        title_key: Option<&str>,
    ) -> Option<&String> {
        guid.and_then(|value| self.by_guid.get(value))
            .or_else(|| self.by_url.get(canonical_url))
            .or_else(|| title_key.and_then(|value| self.by_title_published.get(value)))
    }

    fn remember(
        &mut self,
        article_id: String,
        guid: Option<String>,
        canonical_url: String,
        title_key: Option<String>,
    ) {
        if let Some(guid) = guid {
            self.by_guid.insert(guid, article_id.clone());
        }
        self.by_url.insert(canonical_url, article_id.clone());
        if let Some(title_key) = title_key {
            self.by_title_published.insert(title_key, article_id);
        }
    }
}

fn normalize_entry_guid(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn normalize_title_key(value: &str) -> String {
    collapse_whitespace(value).to_ascii_lowercase()
}

fn article_title_published_key(title: &str, published_at: Option<&str>) -> Option<String> {
    let normalized_title = normalize_title_key(title);
    let published_at = published_at?.trim();
    (!normalized_title.is_empty() && !published_at.is_empty())
        .then(|| format!("{normalized_title}::{published_at}"))
}

fn canonicalize_article_url(url: &str) -> String {
    let trimmed = url.trim();
    let Ok(mut parsed) = Url::parse(trimmed) else {
        return trimmed.trim_end_matches('/').to_string();
    };

    parsed.set_fragment(None);

    let filtered_query = parsed
        .query_pairs()
        .filter(|(key, _)| {
            let lowercase = key.to_ascii_lowercase();
            !(lowercase.starts_with("utm_")
                || lowercase == "fbclid"
                || lowercase == "gclid"
                || lowercase == "guccounter"
                || lowercase == "guce_referrer"
                || lowercase == "guce_referrer_sig"
                || lowercase == "ncid"
                || lowercase == "sr_share")
        })
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>();

    if filtered_query.is_empty() {
        parsed.set_query(None);
    } else {
        parsed.set_query(Some(&filtered_query.join("&")));
    }

    parsed.to_string().trim_end_matches('/').to_string()
}

fn update_existing_article_from_feed(
    conn: &Connection,
    has_legacy_source_column: bool,
    article_id: &str,
    canonical_url: &str,
    guid: Option<&str>,
    title: &str,
    author: Option<&str>,
    published_at: Option<&str>,
    published_at_for_legacy: &str,
    excerpt: &str,
    content: &str,
) -> Result<(), String> {
    let affected = if has_legacy_source_column {
        conn.execute(
            "UPDATE articles
             SET title = ?1,
                 source = ?2,
                 published_at = ?3,
                 excerpt = ?4,
                 content = ?5,
                 url = ?6,
                 guid = COALESCE(?7, guid),
                 author = ?8,
                 raw_html = CASE WHEN url <> ?6 THEN NULL ELSE raw_html END,
                 cleaned_html = CASE WHEN url <> ?6 THEN NULL ELSE cleaned_html END,
                 cleaned_markdown = CASE WHEN url <> ?6 THEN NULL ELSE cleaned_markdown END,
                 cleaner_version = CASE WHEN url <> ?6 THEN NULL ELSE cleaner_version END,
                 content_fetched_at = CASE WHEN url <> ?6 THEN NULL ELSE content_fetched_at END,
                 content_fetch_status = CASE WHEN url <> ?6 THEN 'pending' ELSE content_fetch_status END,
                 content_fetch_error = CASE WHEN url <> ?6 THEN NULL ELSE content_fetch_error END,
                 final_url = CASE WHEN url <> ?6 THEN NULL ELSE final_url END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?9",
            params![
                title,
                canonical_url,
                published_at_for_legacy,
                excerpt,
                content,
                canonical_url,
                guid,
                author,
                article_id
            ],
        )
    } else {
        conn.execute(
            "UPDATE articles
             SET title = ?1,
                 url = ?2,
                 guid = COALESCE(?3, guid),
                 author = ?4,
                 published_at = ?5,
                 excerpt = ?6,
                 content = ?7,
                 raw_html = CASE WHEN url <> ?2 THEN NULL ELSE raw_html END,
                 cleaned_html = CASE WHEN url <> ?2 THEN NULL ELSE cleaned_html END,
                 cleaned_markdown = CASE WHEN url <> ?2 THEN NULL ELSE cleaned_markdown END,
                 cleaner_version = CASE WHEN url <> ?2 THEN NULL ELSE cleaner_version END,
                 content_fetched_at = CASE WHEN url <> ?2 THEN NULL ELSE content_fetched_at END,
                 content_fetch_status = CASE WHEN url <> ?2 THEN 'pending' ELSE content_fetch_status END,
                 content_fetch_error = CASE WHEN url <> ?2 THEN NULL ELSE content_fetch_error END,
                 final_url = CASE WHEN url <> ?2 THEN NULL ELSE final_url END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?8",
            params![title, canonical_url, guid, author, published_at, excerpt, content, article_id],
        )
    }
    .map_err(|error| format!("Failed to update existing article: {error}"))?;

    if affected == 0 {
        return Err("Failed to update existing article: article disappeared".to_string());
    }

    Ok(())
}

fn merge_duplicate_article(
    conn: &Connection,
    keeper: &mut ExistingArticleRecord,
    duplicate: &ExistingArticleRecord,
) -> Result<(), String> {
    keeper.is_read = keeper.is_read && duplicate.is_read;
    keeper.is_favorite = keeper.is_favorite || duplicate.is_favorite;
    keeper.read_later = keeper.read_later || duplicate.read_later;

    conn.execute(
        "UPDATE articles
         SET read_status = ?1,
             is_favorite = ?2,
             read_later = ?3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?4",
        params![
            if keeper.is_read { 1 } else { 0 },
            if keeper.is_favorite { 1 } else { 0 },
            if keeper.read_later { 1 } else { 0 },
            keeper.id
        ],
    )
    .map_err(|error| format!("Failed to merge duplicate article state: {error}"))?;

    conn.execute(
        "DELETE FROM articles WHERE id = ?1",
        params![duplicate.id.clone()],
    )
    .map_err(|error| format!("Failed to remove duplicate article: {error}"))?;

    Ok(())
}

fn resolve_article_url(candidate: &str, feed_url: &str) -> Option<String> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(parsed) = reqwest::Url::parse(trimmed) {
        return Some(parsed.to_string());
    }

    reqwest::Url::parse(feed_url)
        .ok()
        .and_then(|base| base.join(trimmed).ok())
        .map(|url| url.to_string())
}

fn select_article_url(entry: &feed_rs::model::Entry, feed_url: &str) -> Option<String> {
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
        .and_then(|link| resolve_article_url(&link.href, feed_url))
        .or_else(|| {
            let guid = entry.id.trim();
            resolve_article_url(guid, feed_url)
        })
}

fn article_from_row(row: &Row<'_>) -> rusqlite::Result<Article> {
    let read_status: i64 = row.get(8)?;
    Ok(Article {
        id: row.get(0)?,
        feed_id: row.get(1)?,
        title: row.get(2)?,
        url: row.get(3)?,
        author: row.get(4)?,
        published_at: row.get(5)?,
        excerpt: row.get(6)?,
        content: row.get(7)?,
        is_read: read_status == 1,
        raw_html: row.get(9)?,
        cleaned_html: row.get(10)?,
        cleaned_markdown: row.get(11)?,
        content_fetched_at: row.get(12)?,
        content_fetch_status: row.get(13)?,
        content_fetch_error: row.get(14)?,
        final_url: row.get(15)?,
        summary: row.get(16)?,
        summary_lang: row.get(17)?,
        translation: row.get(18)?,
        translation_lang: row.get(19)?,
        is_favorite: row.get(20)?,
        read_later: row.get(21)?,
    })
}

fn safe_fetchable_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    normalized.starts_with("http://") || normalized.starts_with("https://")
}

fn normalize_fetch_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if !safe_fetchable_url(trimmed) {
        return Err("Article URL must start with http:// or https://".to_string());
    }

    Url::parse(trimmed)
        .map(|parsed| parsed.to_string())
        .map_err(|error| format!("Invalid article URL: {error}"))
}

fn source_from_url(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| "Web Article".to_string())
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|inner| {
        let trimmed = inner.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn collapse_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_html_tags(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut in_tag = false;

    for ch in input.chars() {
        match ch {
            '<' => {
                in_tag = true;
                output.push(' ');
            }
            '>' => {
                in_tag = false;
                output.push(' ');
            }
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }

    collapse_whitespace(&output)
}

fn strip_markdown_syntax(input: &str) -> String {
    input
        .replace("**", "")
        .replace("__", "")
        .replace('`', "")
        .replace('~', "")
        .lines()
        .map(|line| {
            let trimmed = line.trim_start_matches('#').trim_start();
            trimmed.trim_start_matches('>').trim_start().to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn looks_like_literal_html_markdown(input: &str) -> bool {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return false;
    }

    let lowercase = trimmed.to_ascii_lowercase();
    let markers = [
        "<p>", "</p>", "<ol>", "</ol>", "<ul>", "</ul>", "<li>", "</li>", "<h1", "<h2", "<h3",
        "href=\"",
    ];
    let marker_count = markers
        .iter()
        .filter(|marker| lowercase.contains(**marker))
        .count();

    marker_count >= 2 || (lowercase.contains("<p>") && lowercase.contains("href=\""))
}

fn looks_like_encoded_html_content(input: &str) -> bool {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return false;
    }

    let lowercase = trimmed.to_ascii_lowercase();
    let markers = [
        "&lt;p&gt;",
        "&lt;/p&gt;",
        "&lt;ol&gt;",
        "&lt;/ol&gt;",
        "&lt;ul&gt;",
        "&lt;/ul&gt;",
        "&lt;li&gt;",
        "&lt;/li&gt;",
        "&lt;h1",
        "&lt;h2",
        "&lt;h3",
        "href=&quot;",
        "href=&#34;",
    ];
    let marker_count = markers
        .iter()
        .filter(|marker| lowercase.contains(**marker))
        .count();

    marker_count >= 2 || (lowercase.contains("&lt;p&gt;") && marker_count >= 1)
}

fn is_metadata_line(input: &str) -> bool {
    let value = input.trim();
    if value.is_empty() {
        return true;
    }

    let lowercase = value.to_ascii_lowercase();
    lowercase == "startups"
        || lowercase == "climate"
        || lowercase == "ai"
        || lowercase == "events"
        || lowercase == "news"
        || lowercase == "podcast"
        || value.ends_with("分钟")
        || lowercase.ends_with(" min")
        || lowercase.ends_with(" mins")
        || lowercase.ends_with(" minutes")
        || (value.len() >= 10
            && value.chars().nth(4) == Some('-')
            && value.chars().nth(7) == Some('-'))
        || (value.contains('年') && value.contains('月') && value.contains('日'))
}

fn is_decorative_markdown_block(block: &str) -> bool {
    let trimmed = block.trim();
    if trimmed.is_empty() {
        return true;
    }

    let lines = trimmed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let normalized = collapse_whitespace(&strip_markdown_syntax(trimmed));
    let has_image = trimmed.contains("![") && trimmed.contains("](");
    let link_count = trimmed.matches("](").count();
    let heading_count = lines.iter().filter(|line| line.starts_with('#')).count();
    let only_metadata = lines
        .iter()
        .all(|line| is_metadata_line(&collapse_whitespace(&strip_markdown_syntax(line))));

    normalized.is_empty()
        || only_metadata
        || (has_image && lines.len() <= 4)
        || (link_count > 0 && lines.len() <= 4 && (has_image || heading_count > 0))
        || (normalized.chars().count() < 18 && lines.len() <= 2 && link_count > 0)
}

fn article_text_for_ai(conn: &Connection, article_id: &str) -> Result<String, String> {
    let (title, cleaned_markdown, cleaned_html, content, excerpt): (
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT title, cleaned_markdown, cleaned_html, content, excerpt
             FROM articles
             WHERE id = ?1",
            params![article_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|e| format!("Article not found: {e}"))?;

    let body = normalize_optional_text(cleaned_markdown)
        .or_else(|| normalize_optional_text(cleaned_html).map(|html| strip_html_tags(&html)))
        .or_else(|| normalize_optional_text(Some(content)).map(|html| strip_html_tags(&html)))
        .or_else(|| normalize_optional_text(Some(excerpt)).map(|html| strip_html_tags(&html)))
        .ok_or_else(|| "Article content is empty. Please open the article first so the app can fetch and clean it.".to_string())?;

    let text = collapse_whitespace(&format!("{}\n\n{}", title.trim(), body));
    if text.chars().count() < 40 {
        return Err("Article content is too short to summarize or translate reliably.".to_string());
    }

    Ok(text)
}

fn article_blocks_for_translation(
    conn: &Connection,
    article_id: &str,
) -> Result<Vec<String>, String> {
    let (_title, cleaned_markdown, cleaned_html, content, excerpt): (
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT title, cleaned_markdown, cleaned_html, content, excerpt
             FROM articles
             WHERE id = ?1",
            params![article_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|e| format!("Article not found: {e}"))?;

    let body = normalize_optional_text(cleaned_markdown)
        .or_else(|| normalize_optional_text(cleaned_html).map(|html| strip_html_tags(&html).replace(". ", ".\n\n")))
        .or_else(|| normalize_optional_text(Some(content)))
        .or_else(|| normalize_optional_text(Some(excerpt)))
        .ok_or_else(|| "Article content is empty. Please open the article first so the app can fetch and clean it.".to_string())?;

    let blocks = body
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .filter(|block| !is_decorative_markdown_block(block))
        .map(str::to_string)
        .collect::<Vec<_>>();

    if collapse_whitespace(&blocks.join(" ")).chars().count() < 40 {
        return Err("Article content is too short to translate reliably.".to_string());
    }

    Ok(blocks)
}

fn format_translation_blocks(blocks: &[String], start_index: usize) -> String {
    blocks
        .iter()
        .enumerate()
        .map(|(offset, block)| {
            let index = start_index + offset + 1;
            format!("[BLOCK {index}]\n{block}\n[END BLOCK {index}]")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn translation_block_count(text: &str) -> usize {
    parse_structured_translation_blocks(text)
        .into_iter()
        .filter(|block| !block.trim().is_empty())
        .count()
}

fn parse_structured_translation_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current_start = 1usize;

    loop {
        let start_tag = format!("[BLOCK {current_start}]");
        let end_tag = format!("[END BLOCK {current_start}]");
        let Some(start_index) = text.find(&start_tag) else {
            break;
        };
        let content_start = start_index + start_tag.len();
        let remaining = &text[content_start..];
        let Some(relative_end_index) = remaining.find(&end_tag) else {
            break;
        };
        let content = remaining[..relative_end_index].trim().to_string();
        blocks.push(content);
        current_start += 1;
    }

    blocks
}

fn parse_structured_translation_blocks_from(text: &str, start_index: usize) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current_index = start_index + 1;

    loop {
        let start_tag = format!("[BLOCK {current_index}]");
        let end_tag = format!("[END BLOCK {current_index}]");
        let Some(start_index_in_text) = text.find(&start_tag) else {
            break;
        };
        let content_start = start_index_in_text + start_tag.len();
        let remaining = &text[content_start..];
        let Some(relative_end_index) = remaining.find(&end_tag) else {
            break;
        };
        let content = remaining[..relative_end_index].trim().to_string();
        blocks.push(content);
        current_index += 1;
    }

    blocks
}

fn is_invalid_ai_result(result: &str) -> bool {
    let normalized = result.trim();
    if normalized.is_empty() {
        return true;
    }

    let lowered = normalized.to_ascii_lowercase();
    lowered.starts_with("please provide the text of the article")
        || lowered.starts_with("please provide the text you would like me to summarize")
        || lowered.starts_with("please translate the following article into")
        || normalized.starts_with("请将以下文章翻译成")
        || normalized.starts_with("请提供需要总结的文章")
        || normalized.starts_with("请提供要翻译的文章")
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn extract_charset_from_content_type(value: &str) -> Option<String> {
    value
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix("charset=").map(str::trim))
        .map(|value| value.trim_matches('"').to_string())
        .filter(|value| !value.is_empty())
}

fn extract_charset_from_html(bytes: &[u8]) -> Option<String> {
    let sniff_len = bytes.len().min(8192);
    let head = String::from_utf8_lossy(&bytes[..sniff_len]).to_ascii_lowercase();

    if let Some(index) = head.find("charset=") {
        let charset = head[index + "charset=".len()..]
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':'))
            .collect::<String>();
        if !charset.is_empty() {
            return Some(charset);
        }
    }

    None
}

fn fallback_html_from_article(article: &Article) -> String {
    let mut blocks = vec![format!("<h1>{}</h1>", escape_html(&article.title))];

    if !article.excerpt.trim().is_empty() {
        blocks.push(format!("<p>{}</p>", escape_html(article.excerpt.trim())));
    }

    if !article.content.trim().is_empty() {
        for paragraph in article.content.split("\n\n") {
            let trimmed = paragraph.trim();
            if !trimmed.is_empty() {
                blocks.push(format!("<p>{}</p>", escape_html(trimmed)));
            }
        }
    }

    format!("<article>{}</article>", blocks.join("\n"))
}

fn build_reader_document(html: &str, base_url: &str) -> String {
    let cleaned = remove_html_block_case_insensitive(
        &remove_html_block_case_insensitive(html, "script"),
        "noscript",
    );
    let base_tag = format!(r#"<base href="{}">"#, escape_html(base_url));
    let meta_charset = r#"<meta charset="utf-8">"#;
    let viewport = r#"<meta name="viewport" content="width=device-width, initial-scale=1">"#;
    let style = r#"<style>
html, body { margin: 0; padding: 0; background: #f5f1e8; color: #241f17; }
body { font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; overflow-wrap: anywhere; }
img, video, iframe, table, pre, code { max-width: 100%; }
pre { white-space: pre-wrap; }
a { color: #8b5e1a; }
</style>"#;

    let lower = cleaned.to_ascii_lowercase();
    if let Some(head_index) = lower.find("<head") {
        if let Some(tag_end) = cleaned[head_index..].find('>') {
            let insert_at = head_index + tag_end + 1;
            let mut document = String::with_capacity(cleaned.len() + 256);
            document.push_str(&cleaned[..insert_at]);
            document.push_str(meta_charset);
            document.push_str(viewport);
            document.push_str(&base_tag);
            document.push_str(style);
            document.push_str(&cleaned[insert_at..]);
            return document;
        }
    }

    if lower.contains("<html") {
        return format!(
            "<!doctype html><html><head>{meta_charset}{viewport}{base_tag}{style}</head><body>{cleaned}</body></html>"
        );
    }

    format!(
        "<!doctype html><html><head>{meta_charset}{viewport}{base_tag}{style}</head><body>{cleaned}</body></html>"
    )
}

fn remove_html_block_case_insensitive(input: &str, tag: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let open_tag = format!("<{tag}");
    let close_tag = format!("</{tag}>");
    let mut result = String::with_capacity(input.len());
    let mut cursor = 0;

    while let Some(relative_start) = lower[cursor..].find(&open_tag) {
        let start = cursor + relative_start;
        result.push_str(&input[cursor..start]);

        if let Some(relative_end) = lower[start..].find(&close_tag) {
            cursor = start + relative_end + close_tag.len();
        } else {
            cursor = input.len();
            break;
        }
    }

    result.push_str(&input[cursor..]);
    result
}

fn extract_html_tag_text(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open_tag = format!("<{tag}");
    let close_tag = format!("</{tag}>");
    let start = lower.find(&open_tag)?;
    let content_start = lower[start..].find('>')? + start + 1;
    let end = lower[content_start..].find(&close_tag)? + content_start;
    normalize_optional_text(Some(strip_html_tags(&html[content_start..end])))
}

fn extract_preferred_html_section(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    for tag in ["article", "main", "body"] {
        let open_tag = format!("<{tag}");
        let close_tag = format!("</{tag}>");
        if let Some(start) = lower.find(&open_tag) {
            if let Some(open_end) = lower[start..].find('>') {
                let content_start = start + open_end + 1;
                if let Some(relative_end) = lower[content_start..].find(&close_tag) {
                    let end = content_start + relative_end;
                    return html[content_start..end].to_string();
                }
            }
        }
    }

    html.to_string()
}

fn html_to_basic_markdown(html: &str) -> String {
    let mut text = html
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("</p>", "\n\n")
        .replace("</div>", "\n\n")
        .replace("</section>", "\n\n")
        .replace("</article>", "\n\n")
        .replace("</li>", "\n")
        .replace("</h1>", "\n\n")
        .replace("</h2>", "\n\n")
        .replace("</h3>", "\n\n")
        .replace("</h4>", "\n\n")
        .replace("</h5>", "\n\n")
        .replace("</h6>", "\n\n")
        .replace("</tr>", "\n");

    text = strip_html_tags(&text);
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .replace("\n\n\n", "\n\n")
}

fn fallback_cleaner_output(
    html: &str,
    url: Option<&str>,
    title_hint: Option<&str>,
) -> NodeCleanerOutput {
    let sanitized = remove_html_block_case_insensitive(
        &remove_html_block_case_insensitive(
            &remove_html_block_case_insensitive(html, "script"),
            "style",
        ),
        "noscript",
    );
    let body = extract_preferred_html_section(&sanitized);
    let cleaned_html = format!("<article>{}</article>", body.trim());
    let cleaned_markdown = html_to_basic_markdown(&cleaned_html);
    let title = extract_html_tag_text(html, "title")
        .or_else(|| title_hint.map(str::to_string))
        .or_else(|| url.map(str::to_string));
    let excerpt = normalize_optional_text(Some(cleaned_markdown.clone())).map(|markdown| {
        let mut chars = markdown.chars();
        let excerpt: String = chars.by_ref().take(220).collect();
        if chars.next().is_some() {
            format!("{excerpt}...")
        } else {
            excerpt
        }
    });

    NodeCleanerOutput {
        title,
        byline: None,
        excerpt,
        cleaned_html: Some(cleaned_html),
        cleaned_markdown: Some(cleaned_markdown),
    }
}

fn node_script_path(app: &AppHandle) -> PathBuf {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("scripts").join("article-cleaner.mjs"));

    if let Some(path) = bundled.filter(|path| path.exists()) {
        return path;
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("article-cleaner.mjs")
}

async fn run_node_cleaner(
    app: &AppHandle,
    html: String,
    url: Option<String>,
    title_hint: Option<String>,
) -> Result<CleanerRunResult, String> {
    let script_path = node_script_path(app);
    let fallback_output = fallback_cleaner_output(&html, url.as_deref(), title_hint.as_deref());

    tauri::async_runtime::spawn_blocking(move || {
        let payload = serde_json::to_vec(&NodeCleanerInput { html, url })
            .map_err(|error| format!("Failed to serialize cleaner input: {error}"))?;

        let child_result = Command::new("node")
            .arg(script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        let mut child = match child_result {
            Ok(child) => child,
            Err(_) => {
                return Ok(CleanerRunResult {
                    output: fallback_output.clone(),
                    version: FALLBACK_CLEANER_VERSION,
                })
            }
        };

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open stdin for Node article cleaner".to_string());
        let mut stdin = match stdin {
            Ok(stdin) => stdin,
            Err(_) => {
                return Ok(CleanerRunResult {
                    output: fallback_output.clone(),
                    version: FALLBACK_CLEANER_VERSION,
                })
            }
        };
        if stdin.write_all(&payload).is_err() {
            return Ok(CleanerRunResult {
                output: fallback_output.clone(),
                version: FALLBACK_CLEANER_VERSION,
            });
        }
        drop(stdin);

        let output = match child.wait_with_output() {
            Ok(output) => output,
            Err(_) => {
                return Ok(CleanerRunResult {
                    output: fallback_output.clone(),
                    version: FALLBACK_CLEANER_VERSION,
                })
            }
        };

        if !output.status.success() {
            return Ok(CleanerRunResult {
                output: fallback_output.clone(),
                version: FALLBACK_CLEANER_VERSION,
            });
        }

        match serde_json::from_slice::<NodeCleanerOutput>(&output.stdout) {
            Ok(cleaned) => Ok(CleanerRunResult {
                output: cleaned,
                version: CLEANER_VERSION,
            }),
            Err(_) => Ok(CleanerRunResult {
                output: fallback_output,
                version: FALLBACK_CLEANER_VERSION,
            }),
        }
    })
    .await
    .map_err(|error| format!("Node cleaner task failed: {error}"))?
}

async fn fetch_html(url: &str) -> Result<String, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .http1_only()
        .user_agent(concat!(
            env!("CARGO_PKG_NAME"),
            "/",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|error| {
            format!(
                "Failed to create HTTP client: {}",
                reqwest_error_details(&error, url)
            )
        })?;
    let response = client.get(url).send().await.map_err(|error| {
        format!(
            "Failed to fetch article HTML: {}",
            reqwest_error_details(&error, url)
        )
    })?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch article HTML: HTTP {}",
            response.status()
        ));
    }

    let header_charset = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(extract_charset_from_content_type);

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read article HTML: {error}"))?;

    let charset = header_charset
        .or_else(|| extract_charset_from_html(&bytes))
        .unwrap_or_else(|| "utf-8".to_string());

    let encoding = Encoding::for_label(charset.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (decoded, _, _) = encoding.decode(&bytes);
    Ok(decoded.into_owned())
}

fn load_article_by_id(conn: &Connection, article_id: &str) -> Result<Article, String> {
    conn.query_row(
        "SELECT id, feed_id, title, url, author, published_at, excerpt, content,
                read_status, raw_html, cleaned_html, cleaned_markdown, content_fetched_at,
                  content_fetch_status, content_fetch_error, final_url, summary, summary_lang, translation,
                  translation_lang, is_favorite, read_later
         FROM articles
         WHERE id = ?1",
        params![article_id],
        article_from_row,
    )
    .optional()
    .map_err(|error| format!("Failed to query article: {error}"))?
    .ok_or_else(|| format!("Article {article_id} was not found"))
}

fn save_cleaned_article(
    conn: &Connection,
    article_id: &str,
    raw_html: Option<&str>,
    final_url: Option<&str>,
    cleaned: NodeCleanerOutput,
    cleaner_version: &str,
) -> Result<(), String> {
    let cleaned_html = normalize_optional_text(cleaned.cleaned_html)
        .ok_or_else(|| "Article cleaner returned empty cleaned_html".to_string())?;
    let cleaned_markdown = normalize_optional_text(cleaned.cleaned_markdown)
        .ok_or_else(|| "Article cleaner returned empty cleaned_markdown".to_string())?;
    let title = normalize_optional_text(cleaned.title);
    let author = normalize_optional_text(cleaned.byline);
    let excerpt = normalize_optional_text(cleaned.excerpt);

    conn.execute(
        "UPDATE articles
         SET raw_html = COALESCE(?2, raw_html),
             cleaned_html = ?3,
             cleaned_markdown = ?4,
             title = COALESCE(?5, title),
             author = COALESCE(?6, author),
             excerpt = COALESCE(?7, excerpt),
             cleaner_version = ?8,
             content_fetched_at = CURRENT_TIMESTAMP,
             content_fetch_status = 'cleaned',
             content_fetch_error = NULL,
             final_url = COALESCE(?9, final_url),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1",
        params![
            article_id,
            raw_html,
            cleaned_html,
            cleaned_markdown,
            title,
            author,
            excerpt,
            cleaner_version,
            final_url
        ],
    )
    .map_err(|error| format!("Failed to save cleaned article: {error}"))?;

    Ok(())
}

fn ensure_saved_articles_feed(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT INTO feeds (id, title, url, site_url, unread)
         VALUES (?1, ?2, ?3, NULL, 0)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            url = excluded.url,
            updated_at = CURRENT_TIMESTAMP",
        params![
            SAVED_ARTICLES_FEED_ID,
            SAVED_ARTICLES_FEED_TITLE,
            SAVED_ARTICLES_FEED_URL
        ],
    )
    .map_err(|error| format!("Failed to ensure internal captured-articles feed: {error}"))?;

    Ok(())
}

#[tauri::command]
async fn add_feed(app: AppHandle, url: String) -> Result<Feed, String> {
    import_feed(&app, &url).await
}

#[tauri::command]
async fn refresh_feed(app: AppHandle, feed_id: String) -> Result<Vec<Article>, String> {
    if feed_id == SAVED_ARTICLES_FEED_ID {
        let conn = open_database(&app)?;
        return list_articles_by_feed(&conn, Some(&feed_id), None);
    }

    sync::sync_one_feed(&app, &feed_id).await?;
    let conn = open_database(&app)?;
    list_articles_by_feed(&conn, Some(&feed_id), None)
}

#[tauri::command]
fn list_feeds(app: AppHandle) -> Result<Vec<Feed>, String> {
    let conn = open_database(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.title, COALESCE(f.url, ''), f.site_url, f.last_sync_at,
                    COUNT(CASE WHEN a.read_status = 0 THEN 1 END) as unread,
                    COUNT(a.id) as total
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
                total: row.get(6)?,
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
fn list_articles(
    app: AppHandle,
    feed_id: Option<String>,
    read_filter: Option<String>,
) -> Result<Vec<Article>, String> {
    let conn = open_database(&app)?;
    list_articles_by_feed(&conn, feed_id.as_deref(), read_filter.as_deref())
}

fn read_filter_sql(read_filter: Option<&str>) -> Result<&'static str, String> {
    match read_filter.unwrap_or("all") {
        "all" => Ok(""),
        "unread" => Ok(" AND read_status = 0"),
        "read" => Ok(" AND read_status = 1"),
        other => Err(format!("Unsupported read filter: {other}")),
    }
}

fn list_articles_by_feed(
    conn: &Connection,
    feed_id: Option<&str>,
    read_filter: Option<&str>,
) -> Result<Vec<Article>, String> {
    let filter_sql = read_filter_sql(read_filter)?;
    let sql = match feed_id {
        Some(_) => {
            format!(
                "SELECT id, feed_id, title, COALESCE(url, ''), author, published_at, excerpt, content,
                        read_status, raw_html, cleaned_html, cleaned_markdown, content_fetched_at,
                         content_fetch_status, content_fetch_error, final_url, summary, summary_lang, translation,
                         translation_lang, is_favorite, read_later
                 FROM articles
                 WHERE feed_id = ?1{filter_sql}
                 ORDER BY published_at DESC, created_at DESC"
            )
        }
        None => {
            format!(
                "SELECT id, feed_id, title, COALESCE(url, ''), author, published_at, excerpt, content,
                        read_status, raw_html, cleaned_html, cleaned_markdown, content_fetched_at,
                         content_fetch_status, content_fetch_error, final_url, summary, summary_lang, translation,
                         translation_lang, is_favorite, read_later
                 FROM articles
                 WHERE 1 = 1{filter_sql}
                 ORDER BY published_at DESC, created_at DESC"
            )
        }
    };

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare article query: {error}"))?;
    let mut result = Vec::new();

    match feed_id {
        Some(feed_id) => {
            let rows = stmt
                .query_map(params![feed_id], article_from_row)
                .map_err(|error| format!("Failed to query articles: {error}"))?;
            for row in rows {
                result.push(row.map_err(|error| format!("Failed to read article row: {error}"))?);
            }
        }
        None => {
            let rows = stmt
                .query_map([], article_from_row)
                .map_err(|error| format!("Failed to query articles: {error}"))?;
            for row in rows {
                result.push(row.map_err(|error| format!("Failed to read article row: {error}"))?);
            }
        }
    }

    Ok(result)
}

#[tauri::command]
fn get_article(app: AppHandle, article_id: String) -> Result<Article, String> {
    let conn = open_database(&app)?;
    load_article_by_id(&conn, &article_id)
}

fn annotation_from_row(row: &Row<'_>) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: row.get(0)?,
        article_id: row.get(1)?,
        kind: row.get(2)?,
        selected_text: row.get(3)?,
        prefix_text: row.get(4)?,
        suffix_text: row.get(5)?,
        start_offset: row.get(6)?,
        end_offset: row.get(7)?,
        note_text: row.get(8)?,
        highlight_color: row.get(9)?,
        highlight_style: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn load_annotation_by_id(conn: &Connection, annotation_id: &str) -> Result<Annotation, String> {
    conn.query_row(
        "SELECT id, article_id, kind, selected_text, prefix_text, suffix_text,
                start_offset, end_offset, note_text, highlight_color, highlight_style,
                created_at, updated_at
         FROM annotations
         WHERE id = ?1",
        [annotation_id],
        annotation_from_row,
    )
    .optional()
    .map_err(|error| format!("Failed to query annotation: {error}"))?
    .ok_or_else(|| format!("Annotation {annotation_id} was not found"))
}

#[tauri::command]
fn set_article_favorite(
    app: AppHandle,
    article_id: String,
    is_favorite: bool,
) -> Result<Article, String> {
    let conn = open_database(&app)?;
    let changed = conn
        .execute(
            "UPDATE articles SET is_favorite = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![article_id, is_favorite],
        )
        .map_err(|error| format!("Failed to update favorite state: {error}"))?;
    if changed == 0 {
        return Err(format!("Article {article_id} was not found"));
    }
    load_article_by_id(&conn, &article_id)
}

#[tauri::command]
fn set_article_read_later(
    app: AppHandle,
    article_id: String,
    read_later: bool,
) -> Result<Article, String> {
    let conn = open_database(&app)?;
    let changed = conn
        .execute(
            "UPDATE articles SET read_later = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![article_id, read_later],
        )
        .map_err(|error| format!("Failed to update read later state: {error}"))?;
    if changed == 0 {
        return Err(format!("Article {article_id} was not found"));
    }
    load_article_by_id(&conn, &article_id)
}

#[tauri::command]
fn list_annotations(app: AppHandle, article_id: String) -> Result<Vec<Annotation>, String> {
    let conn = open_database(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, article_id, kind, selected_text, prefix_text, suffix_text,
                    start_offset, end_offset, note_text, highlight_color, highlight_style,
                    created_at, updated_at
             FROM annotations
             WHERE article_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|error| format!("Failed to prepare annotations query: {error}"))?;
    let rows = stmt
        .query_map([article_id], annotation_from_row)
        .map_err(|error| format!("Failed to query annotations: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read annotation row: {error}"))
}

#[tauri::command]
fn create_annotation(
    app: AppHandle,
    article_id: String,
    kind: String,
    selected_text: Option<String>,
    prefix_text: Option<String>,
    suffix_text: Option<String>,
    start_offset: Option<i64>,
    end_offset: Option<i64>,
    note_text: Option<String>,
    highlight_color: Option<String>,
    highlight_style: Option<String>,
) -> Result<Annotation, String> {
    if kind != "highlight" && kind != "note" {
        return Err("Annotation kind must be highlight or note".to_string());
    }
    if kind == "highlight"
        && selected_text
            .as_ref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err("Highlight selected text cannot be empty".to_string());
    }
    if kind == "note"
        && note_text
            .as_ref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err("Note text cannot be empty".to_string());
    }

    let conn = open_database(&app)?;
    load_article_by_id(&conn, &article_id)?;
    let annotation_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO annotations (
            id, article_id, kind, selected_text, prefix_text, suffix_text,
            start_offset, end_offset, note_text, highlight_color, highlight_style
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            annotation_id,
            article_id,
            kind,
            normalize_optional_text(selected_text),
            normalize_optional_text(prefix_text),
            normalize_optional_text(suffix_text),
            start_offset,
            end_offset,
            normalize_optional_text(note_text),
            normalize_optional_text(highlight_color),
            normalize_optional_text(highlight_style)
        ],
    )
    .map_err(|error| format!("Failed to create annotation: {error}"))?;
    load_annotation_by_id(&conn, &annotation_id)
}

#[tauri::command]
fn update_annotation(
    app: AppHandle,
    annotation_id: String,
    note_text: Option<String>,
) -> Result<Annotation, String> {
    let conn = open_database(&app)?;
    let changed = conn
        .execute(
            "UPDATE annotations SET note_text = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![annotation_id, normalize_optional_text(note_text)],
        )
        .map_err(|error| format!("Failed to update annotation: {error}"))?;
    if changed == 0 {
        return Err(format!("Annotation {annotation_id} was not found"));
    }
    load_annotation_by_id(&conn, &annotation_id)
}

#[tauri::command]
fn delete_annotation(app: AppHandle, annotation_id: String) -> Result<(), String> {
    let conn = open_database(&app)?;
    let changed = conn
        .execute(
            "DELETE FROM annotations WHERE id = ?1",
            [annotation_id.clone()],
        )
        .map_err(|error| format!("Failed to delete annotation: {error}"))?;
    if changed == 0 {
        return Err(format!("Annotation {annotation_id} was not found"));
    }
    Ok(())
}

#[tauri::command]
fn search_articles(
    app: AppHandle,
    query: String,
    feed_id: Option<String>,
) -> Result<Vec<Article>, String> {
    let conn = open_database(&app)?;
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return list_articles_by_feed(&conn, feed_id.as_deref(), None);
    }

    let pattern = format!("%{trimmed_query}%");
    let mut stmt = conn
        .prepare(
            "SELECT id, feed_id, title, COALESCE(url, ''), author, published_at, excerpt, content,
                    read_status, raw_html, cleaned_html, cleaned_markdown, content_fetched_at,
                    content_fetch_status, content_fetch_error, final_url, summary, summary_lang, translation,
                    translation_lang, is_favorite, read_later
             FROM articles
             WHERE (?1 IS NULL OR ?1 = '' OR feed_id = ?1)
               AND (
                 title LIKE ?2 COLLATE NOCASE
                 OR COALESCE(author, '') LIKE ?2 COLLATE NOCASE
                 OR COALESCE(excerpt, '') LIKE ?2 COLLATE NOCASE
                 OR COALESCE(content, '') LIKE ?2 COLLATE NOCASE
                 OR COALESCE(cleaned_html, '') LIKE ?2 COLLATE NOCASE
                 OR COALESCE(cleaned_markdown, '') LIKE ?2 COLLATE NOCASE
                 OR EXISTS (
                     SELECT 1 FROM annotations
                     WHERE annotations.article_id = articles.id
                       AND (
                         COALESCE(annotations.selected_text, '') LIKE ?2 COLLATE NOCASE
                         OR COALESCE(annotations.note_text, '') LIKE ?2 COLLATE NOCASE
                       )
                 )
               )
             ORDER BY published_at DESC, created_at DESC",
        )
        .map_err(|error| format!("Failed to prepare article search: {error}"))?;
    let rows = stmt
        .query_map(params![feed_id.as_deref(), pattern], article_from_row)
        .map_err(|error| format!("Failed to search articles: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read search result: {error}"))
}

#[tauri::command]
async fn clean_article(app: AppHandle, article_id: String) -> Result<Article, String> {
    let article = {
        let conn = open_database(&app)?;
        load_article_by_id(&conn, &article_id)?
    };

    let has_stale_cleaned_markdown = article
        .cleaned_markdown
        .as_ref()
        .is_some_and(|value| looks_like_literal_html_markdown(value));
    let has_stale_cleaned_html = article
        .cleaned_html
        .as_ref()
        .is_some_and(|value| looks_like_encoded_html_content(value));
    if article
        .cleaned_html
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
        && !has_stale_cleaned_html
        && !has_stale_cleaned_markdown
    {
        return Ok(article);
    }

    let (html_for_cleaning, raw_html_to_store, final_url) = if let Some(raw_html) = article
        .raw_html
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        (raw_html.clone(), None, article.final_url.clone())
    } else if safe_fetchable_url(&article.url) {
        match fetch_html(&article.url).await {
            Ok(fetched_html) => (
                fetched_html.clone(),
                Some(fetched_html),
                Some(article.url.clone()),
            ),
            Err(_) => {
                let fallback_html = fallback_html_from_article(&article);
                (fallback_html, None, article.final_url.clone())
            }
        }
    } else {
        let fallback_html = fallback_html_from_article(&article);
        (fallback_html, None, article.final_url.clone())
    };

    let cleaned = run_node_cleaner(
        &app,
        html_for_cleaning,
        Some(article.url.clone()),
        Some(article.title.clone()),
    )
    .await?;
    let conn = open_database(&app)?;
    save_cleaned_article(
        &conn,
        &article_id,
        raw_html_to_store.as_deref(),
        final_url.as_deref(),
        cleaned.output,
        cleaned.version,
    )?;

    load_article_by_id(&conn, &article_id)
}

#[tauri::command]
async fn fetch_and_clean_article(app: AppHandle, url: String) -> Result<Article, String> {
    let normalized_url = normalize_fetch_url(&url)?;
    let raw_html = fetch_html(&normalized_url).await?;
    let cleaned = run_node_cleaner(
        &app,
        raw_html.clone(),
        Some(normalized_url.clone()),
        Some(normalized_url.clone()),
    )
    .await?;
    let cleaned_html = normalize_optional_text(cleaned.output.cleaned_html)
        .ok_or_else(|| "Article cleaner returned empty cleaned_html".to_string())?;
    let cleaned_markdown = normalize_optional_text(cleaned.output.cleaned_markdown)
        .ok_or_else(|| "Article cleaner returned empty cleaned_markdown".to_string())?;
    let title =
        normalize_optional_text(cleaned.output.title).unwrap_or_else(|| normalized_url.clone());
    let author = normalize_optional_text(cleaned.output.byline);
    let excerpt = normalize_optional_text(cleaned.output.excerpt).unwrap_or_default();
    let cleaner_version = cleaned.version;

    let conn = open_database(&app)?;
    ensure_saved_articles_feed(&conn)?;
    let source = source_from_url(&normalized_url);
    let existing_article_id = conn
        .query_row(
            "SELECT id FROM articles WHERE feed_id = ?1 AND url = ?2",
            params![SAVED_ARTICLES_FEED_ID, &normalized_url],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to check existing fetched article: {error}"))?;

    let saved_id = if let Some(article_id) = existing_article_id {
        if table_has_column(&conn, "articles", "source")? {
            conn.execute(
                "UPDATE articles
                 SET title = ?2,
                     source = ?3,
                     author = ?4,
                     excerpt = ?5,
                     content = ?6,
                     raw_html = ?7,
                     cleaned_html = ?8,
                     cleaned_markdown = ?9,
                     cleaner_version = ?10,
                     content_fetched_at = CURRENT_TIMESTAMP,
                     content_fetch_status = 'cleaned',
                     content_fetch_error = NULL,
                     final_url = ?11,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![
                    article_id,
                    title,
                    source,
                    author,
                    excerpt,
                    excerpt,
                    raw_html,
                    cleaned_html,
                    cleaned_markdown,
                    cleaner_version,
                    normalized_url
                ],
            )
        } else {
            conn.execute(
                "UPDATE articles
                 SET title = ?2,
                     author = ?3,
                     excerpt = ?4,
                     content = ?5,
                     raw_html = ?6,
                     cleaned_html = ?7,
                     cleaned_markdown = ?8,
                     cleaner_version = ?9,
                     content_fetched_at = CURRENT_TIMESTAMP,
                     content_fetch_status = 'cleaned',
                     content_fetch_error = NULL,
                     final_url = ?10,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![
                    article_id,
                    title,
                    author,
                    excerpt,
                    excerpt,
                    raw_html,
                    cleaned_html,
                    cleaned_markdown,
                    cleaner_version,
                    normalized_url
                ],
            )
        }
        .map_err(|error| format!("Failed to update fetched article: {error}"))?;
        article_id
    } else {
        let article_id = Uuid::new_v4().to_string();
        if table_has_column(&conn, "articles", "source")? {
            conn.execute(
                "INSERT INTO articles (
                    id, feed_id, title, source, url, author, published_at, excerpt, content,
                    raw_html, cleaned_html, cleaned_markdown, cleaner_version,
                    content_fetched_at, content_fetch_status, content_fetch_error, final_url
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Fetched article', ?7, ?8,
                         ?9, ?10, ?11, ?12, CURRENT_TIMESTAMP, 'cleaned', NULL, ?5)",
                params![
                    article_id,
                    SAVED_ARTICLES_FEED_ID,
                    title,
                    source,
                    normalized_url,
                    author,
                    excerpt,
                    excerpt,
                    raw_html,
                    cleaned_html,
                    cleaned_markdown,
                    cleaner_version
                ],
            )
        } else {
            conn.execute(
                "INSERT INTO articles (
                    id, feed_id, title, url, author, published_at, excerpt, content,
                    raw_html, cleaned_html, cleaned_markdown, cleaner_version,
                    content_fetched_at, content_fetch_status, content_fetch_error, final_url
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11,
                         CURRENT_TIMESTAMP, 'cleaned', NULL, ?4)",
                params![
                    article_id,
                    SAVED_ARTICLES_FEED_ID,
                    title,
                    normalized_url,
                    author,
                    excerpt,
                    excerpt,
                    raw_html,
                    cleaned_html,
                    cleaned_markdown,
                    cleaner_version
                ],
            )
        }
        .map_err(|error| format!("Failed to save fetched article: {error}"))?;
        article_id
    };

    load_article_by_id(&conn, &saved_id)
}

#[tauri::command]
async fn fetch_article_html(url: String) -> Result<String, String> {
    let normalized_url = normalize_fetch_url(&url)?;
    let raw_html = fetch_html(&normalized_url).await?;
    Ok(build_reader_document(&raw_html, &normalized_url))
}

fn load_unread_summary(conn: &Connection) -> Result<UnreadSummary, String> {
    let total_unread: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE read_status = 0",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to query total unread: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.title, COUNT(CASE WHEN a.read_status = 0 THEN 1 END) as unread
             FROM feeds f
             LEFT JOIN articles a ON a.feed_id = f.id
             GROUP BY f.id
             ORDER BY f.title ASC",
        )
        .map_err(|e| format!("Failed to prepare unread query: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(FeedUnread {
                feed_id: row.get(0)?,
                feed_title: row.get(1)?,
                unread: row.get(2)?,
            })
        })
        .map_err(|e| format!("Failed to query unread counts: {e}"))?;

    let mut feed_unread = Vec::new();
    for row in rows {
        feed_unread.push(row.map_err(|e| format!("Failed to read unread row: {e}"))?);
    }

    Ok(UnreadSummary {
        total_unread,
        feed_unread,
    })
}

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
        .map_err(|e| format!("Failed to update read status: {e}"))?;

    if changed == 0 {
        return Err(format!("Article {article_id} was not found"));
    }

    load_article_by_id(&conn, &article_id)
}

#[tauri::command]
fn mark_articles_read(
    app: AppHandle,
    feed_id: Option<String>,
    article_ids: Option<Vec<String>>,
) -> Result<UnreadSummary, String> {
    let mut conn = open_database(&app)?;

    if let Some(ids) = article_ids.filter(|ids| !ids.is_empty()) {
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {e}"))?;
        for article_id in ids {
            tx.execute(
                "UPDATE articles
                 SET read_status = 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![article_id],
            )
            .map_err(|e| format!("Failed to mark article read: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {e}"))?;
    } else if let Some(id) = feed_id {
        conn.execute(
            "UPDATE articles
             SET read_status = 1, updated_at = CURRENT_TIMESTAMP
             WHERE feed_id = ?1",
            params![id],
        )
        .map_err(|e| format!("Failed to mark feed articles read: {e}"))?;
    } else {
        conn.execute(
            "UPDATE articles
             SET read_status = 1, updated_at = CURRENT_TIMESTAMP",
            [],
        )
        .map_err(|e| format!("Failed to mark all articles read: {e}"))?;
    }

    load_unread_summary(&conn)
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

fn get_llm_config_for_task(
    conn: &Connection,
    base_url_key: &str,
    api_key_key: &str,
    model_key: &str,
    task_label: &str,
) -> Result<LlmConfig, String> {
    let base_url =
        load_task_setting_with_legacy(conn, base_url_key, "llm_base_url")?.unwrap_or_default();
    if base_url.trim().is_empty() {
        return Err(format!(
            "LLM {task_label} API Base URL not configured. Please set it in Settings."
        ));
    }

    let api_key =
        load_task_setting_with_legacy(conn, api_key_key, "llm_api_key")?.unwrap_or_default();
    let model_name = load_task_setting_with_legacy(conn, model_key, "llm_model_name")?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("LLM {task_label} model not configured. Please set it in Settings.")
        })?;

    Ok(LlmConfig {
        base_url,
        api_key,
        model_name,
    })
}

fn load_task_setting_with_legacy(
    conn: &Connection,
    task_key: &str,
    legacy_key: &str,
) -> Result<Option<String>, String> {
    match load_setting_value(conn, task_key)? {
        Some(value) => Ok(Some(value)),
        None => load_setting_value(conn, legacy_key),
    }
}

fn get_summary_llm_config_from_db(conn: &Connection) -> Result<LlmConfig, String> {
    get_llm_config_for_task(
        conn,
        "llm_summary_base_url",
        "llm_summary_api_key",
        "llm_summary_model_name",
        "summary",
    )
}

fn get_translation_llm_config_from_db(conn: &Connection) -> Result<LlmConfig, String> {
    get_llm_config_for_task(
        conn,
        "llm_translation_base_url",
        "llm_translation_api_key",
        "llm_translation_model_name",
        "translation",
    )
}

fn language_name(target_lang: &str) -> &str {
    match target_lang {
        "zh" => "Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "fr" => "French",
        "de" => "German",
        "es" => "Spanish",
        _ => target_lang,
    }
}

fn translate_text_with_config(
    config: &LlmConfig,
    text: &str,
    target_lang: &str,
) -> Result<String, String> {
    let lang_name = language_name(target_lang);
    let prompt = format!(
        "Translate the following text into {}. Preserve the original meaning and tone. Reply with the translation only.\n\n{}",
        lang_name, text
    );
    let translation = llm_provider::call_llm(
        config,
        &format!(
            "You are a professional translator. Translate the user's text into {}.",
            lang_name
        ),
        &prompt,
    )?;
    if is_invalid_ai_result(&translation) {
        return Err(
            "LLM returned an invalid translation. Please check the configured model/provider and try again."
                .to_string(),
        );
    }
    Ok(translation)
}

fn translate_article_chunk_with_config(
    config: &LlmConfig,
    text: &str,
    target_lang: &str,
) -> Result<String, String> {
    let lang_name = language_name(target_lang);
    let prompt = format!(
        "Translate the following article into {}.\nEach source paragraph is wrapped in [BLOCK n] ... [END BLOCK n].\nReturn the translation using exactly the same block markers and numbers.\nTranslate only the text inside each block.\nDo not merge or split blocks.\nDo not add commentary or extra text outside the block markers.\n\n{}",
        lang_name, text
    );
    let translation = llm_provider::call_llm(
        config,
        &format!(
            "You are a professional translator. Translate the user's article into {} and preserve its block structure exactly.",
            lang_name
        ),
        &prompt,
    )?;
    if is_invalid_ai_result(&translation) {
        return Err(
            "LLM returned an invalid translation. Please check the configured model/provider and try again."
                .to_string(),
        );
    }
    Ok(translation)
}

#[tauri::command]
fn save_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let conn = open_database(&app)?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|error| format!("Failed to save setting: {error}"))?;
    Ok(())
}

#[tauri::command]
fn load_setting(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let conn = open_database(&app)?;
    load_setting_value(&conn, &key)
}

#[tauri::command]
fn get_llm_config(app: AppHandle) -> Result<LlmConfig, String> {
    let conn = open_database(&app)?;
    get_llm_config_from_db(&conn)
}

fn summarize_article_impl(
    app: AppHandle,
    article_id: String,
    target_lang: String,
    force: Option<bool>,
) -> Result<String, String> {
    let conn = open_database(&app)?;

    if force != Some(true) {
        let cached: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT summary, summary_lang FROM articles WHERE id = ?1",
                params![article_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        if let Some((Some(summary), cached_lang)) = cached {
            if !summary.is_empty()
                && !is_invalid_ai_result(&summary)
                && cached_lang.as_deref() == Some(target_lang.as_str())
            {
                return Ok(summary);
            }
        }
    }

    let config = get_summary_llm_config_from_db(&conn)?;
    let article_text = article_text_for_ai(&conn, &article_id)?;
    let lang_name = language_name(&target_lang);
    let prompt = format!(
        "Summarize the following article in 2-3 sentences in {}. Reply with the summary only.\n\n{}",
        lang_name, article_text
    );
    let summary = llm_provider::call_llm(
        &config,
        &format!(
            "You are a helpful assistant that summarizes articles concisely in {}.",
            lang_name
        ),
        &prompt,
    )?;
    if is_invalid_ai_result(&summary) {
        return Err("LLM returned an invalid summary. Please check the configured model/provider and try again.".to_string());
    }

    conn.execute(
        "UPDATE articles SET summary = ?1, summary_lang = ?2 WHERE id = ?3",
        params![summary, target_lang, article_id],
    )
    .map_err(|e| format!("Failed to save summary: {e}"))?;

    Ok(summary)
}

#[tauri::command]
fn summarize_article(
    app: AppHandle,
    article_id: String,
    target_lang: String,
    force: Option<bool>,
) -> Result<String, String> {
    summarize_article_impl(app, article_id, target_lang, force)
}

fn translate_article_impl(
    app: AppHandle,
    article_id: String,
    target_lang: String,
) -> Result<String, String> {
    let conn = open_database(&app)?;

    let cached: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT translation, translation_lang FROM articles WHERE id = ?1",
            params![article_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    let source_blocks = article_blocks_for_translation(&conn, &article_id)?;
    let source_block_count = source_blocks.len();

    if let Some((Some(translation), cached_lang)) = cached {
        if !translation.is_empty()
            && !is_invalid_ai_result(&translation)
            && cached_lang.as_deref() == Some(target_lang.as_str())
            && translation_block_count(&translation) == source_block_count
        {
            return Ok(translation);
        }
    }

    let config = get_translation_llm_config_from_db(&conn)?;
    const TRANSLATION_CHUNK_SIZE: usize = 6;
    let mut translated_chunks = Vec::new();

    for (chunk_index, block_chunk) in source_blocks.chunks(TRANSLATION_CHUNK_SIZE).enumerate() {
        let start_index = chunk_index * TRANSLATION_CHUNK_SIZE;
        let formatted_chunk = format_translation_blocks(block_chunk, start_index);
        let translated_chunk =
            translate_article_chunk_with_config(&config, &formatted_chunk, &target_lang)?;
        let parsed_blocks =
            parse_structured_translation_blocks_from(&translated_chunk, start_index);
        if parsed_blocks.len() != block_chunk.len() {
            return Err(format!(
                "LLM translation did not preserve paragraph structure for chunk {}. Please try again.",
                chunk_index + 1
            ));
        }
        translated_chunks.extend(parsed_blocks);
    }

    let translation = translated_chunks
        .into_iter()
        .enumerate()
        .map(|(index, block)| {
            format!(
                "[BLOCK {}]\n{}\n[END BLOCK {}]",
                index + 1,
                block,
                index + 1
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    if translation_block_count(&translation) != source_block_count {
        return Err(
            "LLM translation did not preserve paragraph structure. Please try again.".to_string(),
        );
    }

    conn.execute(
        "UPDATE articles SET translation = ?1, translation_lang = ?2 WHERE id = ?3",
        params![translation, target_lang, article_id],
    )
    .map_err(|e| format!("Failed to save translation: {e}"))?;

    Ok(translation)
}

#[tauri::command]
fn translate_article(
    app: AppHandle,
    article_id: String,
    target_lang: String,
) -> Result<String, String> {
    translate_article_impl(app, article_id, target_lang)
}

fn create_ai_job(kind: &str, article_id: String, target_lang: String) -> AiJobStatus {
    AiJobStatus {
        id: Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        article_id,
        target_lang,
        status: "running".to_string(),
        result: None,
        error: None,
    }
}

fn store_ai_job(
    jobs: &Arc<Mutex<HashMap<String, AiJobStatus>>>,
    job: AiJobStatus,
) -> Result<(), String> {
    let mut guard = jobs
        .lock()
        .map_err(|_| "AI job state is unavailable".to_string())?;
    guard.insert(job.id.clone(), job);
    Ok(())
}

fn finish_ai_job(
    jobs: Arc<Mutex<HashMap<String, AiJobStatus>>>,
    mut job: AiJobStatus,
    result: Result<String, String>,
) {
    match result {
        Ok(value) => {
            job.status = "completed".to_string();
            job.result = Some(value);
            job.error = None;
        }
        Err(error) => {
            job.status = "failed".to_string();
            job.result = None;
            job.error = Some(error);
        }
    }

    if let Ok(mut guard) = jobs.lock() {
        guard.insert(job.id.clone(), job);
    }
}

#[tauri::command]
fn start_summary_job(
    app: AppHandle,
    jobs: tauri::State<'_, AiJobState>,
    article_id: String,
    target_lang: String,
    force: Option<bool>,
) -> Result<AiJobStatus, String> {
    let job = create_ai_job("summary", article_id.clone(), target_lang.clone());
    let jobs_map = jobs.jobs.clone();
    store_ai_job(&jobs_map, job.clone())?;

    let thread_job = job.clone();
    thread::spawn(move || {
        let result = summarize_article_impl(app, article_id, target_lang, force);
        finish_ai_job(jobs_map, thread_job, result);
    });

    Ok(job)
}

#[tauri::command]
fn start_translation_job(
    app: AppHandle,
    jobs: tauri::State<'_, AiJobState>,
    article_id: String,
    target_lang: String,
) -> Result<AiJobStatus, String> {
    let job = create_ai_job("translation", article_id.clone(), target_lang.clone());
    let jobs_map = jobs.jobs.clone();
    store_ai_job(&jobs_map, job.clone())?;

    let thread_job = job.clone();
    thread::spawn(move || {
        let result = translate_article_impl(app, article_id, target_lang);
        finish_ai_job(jobs_map, thread_job, result);
    });

    Ok(job)
}

#[tauri::command]
fn get_ai_job_status(
    jobs: tauri::State<'_, AiJobState>,
    job_id: String,
) -> Result<AiJobStatus, String> {
    let guard = jobs
        .jobs
        .lock()
        .map_err(|_| "AI job state is unavailable".to_string())?;
    guard
        .get(&job_id)
        .cloned()
        .ok_or_else(|| format!("AI job {job_id} was not found"))
}

#[tauri::command]
fn translate_text(app: AppHandle, text: String, target_lang: String) -> Result<String, String> {
    let normalized = normalize_optional_text(Some(text))
        .ok_or_else(|| "Selected text cannot be empty".to_string())?;
    if normalized.chars().count() > 3000 {
        return Err("Selected text is too long. Please choose a shorter passage.".to_string());
    }

    let conn = open_database(&app)?;
    let config = get_translation_llm_config_from_db(&conn)?;
    translate_text_with_config(&config, &normalized, &target_lang)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(sync::SyncState::default())
        .manage(AiJobState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_feeds,
            list_articles,
            get_article,
            set_article_favorite,
            set_article_read_later,
            set_article_read_status,
            mark_articles_read,
            list_annotations,
            create_annotation,
            update_annotation,
            delete_annotation,
            search_articles,
            add_feed,
            refresh_feed,
            sync::start_sync,
            sync::get_sync_status,
            sync::retry_failed_syncs,
            sync::get_sync_config,
            sync::update_sync_config,
            save_setting,
            load_setting,
            get_llm_config,
            summarize_article,
            translate_article,
            start_summary_job,
            start_translation_job,
            get_ai_job_status,
            translate_text,
            clean_article,
            fetch_and_clean_article,
            fetch_article_html,
            opml::import_opml,
            opml::export_opml,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{init_schema, save_articles};
    use rusqlite::{params, Connection};

    fn parse_entries(xml: &str) -> Vec<feed_rs::model::Entry> {
        feed_rs::parser::parse(xml.as_bytes())
            .expect("feed should parse")
            .entries
    }

    fn setup_connection(feed_id: &str, feed_url: &str) -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory sqlite should open");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("foreign keys should enable");
        init_schema(&conn).expect("schema should initialize");
        conn.execute(
            "INSERT INTO feeds (id, title, url) VALUES (?1, ?2, ?3)",
            params![feed_id, "Test Feed", feed_url],
        )
        .expect("feed should insert");
        conn
    }

    #[test]
    fn save_articles_resolves_relative_entry_links_against_feed_url() {
        let feed_id = "feed-1";
        let feed_url = "https://soulhacker.me/index.xml";
        let conn = setup_connection(feed_id, feed_url);
        let entries = parse_entries(
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0">
              <channel>
                <title>Test Feed</title>
                <item>
                  <title>Local Inference</title>
                  <link>/posts/local-inference/</link>
                  <guid>/posts/local-inference/</guid>
                  <description>&lt;p&gt;Summary&lt;/p&gt;</description>
                </item>
              </channel>
            </rss>"#,
        );

        save_articles(&conn, feed_id, feed_url, entries).expect("articles should save");

        let saved_url: String = conn
            .query_row(
                "SELECT url FROM articles WHERE feed_id = ?1",
                params![feed_id],
                |row| row.get(0),
            )
            .expect("article url should load");
        assert_eq!(saved_url, "https://soulhacker.me/posts/local-inference");
    }

    #[test]
    fn save_articles_keeps_absolute_entry_links_unchanged() {
        let feed_id = "feed-2";
        let feed_url = "https://example.com/feed.xml";
        let conn = setup_connection(feed_id, feed_url);
        let entries = parse_entries(
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0">
              <channel>
                <title>Test Feed</title>
                <item>
                  <title>Absolute Link</title>
                  <link>https://example.com/posts/absolute-link/</link>
                  <guid>https://example.com/posts/absolute-link/</guid>
                  <description>Summary</description>
                </item>
              </channel>
            </rss>"#,
        );

        save_articles(&conn, feed_id, feed_url, entries).expect("articles should save");

        let saved_url: String = conn
            .query_row(
                "SELECT url FROM articles WHERE feed_id = ?1",
                params![feed_id],
                |row| row.get(0),
            )
            .expect("article url should load");
        assert_eq!(saved_url, "https://example.com/posts/absolute-link");
    }

    #[test]
    fn save_articles_clears_stale_cleaned_cache_when_entry_url_changes() {
        let feed_id = "feed-3";
        let feed_url = "https://soulhacker.me/index.xml";
        let conn = setup_connection(feed_id, feed_url);
        conn.execute(
            "INSERT INTO articles (
                id, feed_id, title, url, guid, excerpt, content, cleaned_html,
                cleaned_markdown, cleaner_version, content_fetched_at, content_fetch_status,
                content_fetch_error, final_url
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                ?9, ?10, ?11, ?12,
                ?13, ?14
             )",
            params![
                "article-1",
                feed_id,
                "Local Inference",
                "/posts/local-inference/",
                "/posts/local-inference/",
                "<p>Summary</p>",
                "",
                "<article>bad</article>",
                "<p>bad</p>",
                "old-cleaner",
                "2026-06-12T00:00:00Z",
                "cleaned",
                "old error",
                "https://soulhacker.me/posts/local-inference/"
            ],
        )
        .expect("stale article should insert");

        let entries = parse_entries(
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0">
              <channel>
                <title>Test Feed</title>
                <item>
                  <title>Local Inference</title>
                  <link>/posts/local-inference/</link>
                  <guid>/posts/local-inference/</guid>
                  <description>&lt;p&gt;Summary&lt;/p&gt;</description>
                </item>
              </channel>
            </rss>"#,
        );

        save_articles(&conn, feed_id, feed_url, entries).expect("articles should save");

        let row = conn
            .query_row(
                "SELECT url, cleaned_html, cleaned_markdown, cleaner_version, content_fetched_at,
                        content_fetch_status, content_fetch_error, final_url
                 FROM articles
                 WHERE id = ?1",
                params!["article-1"],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .expect("updated article should load");

        assert_eq!(row.0, "https://soulhacker.me/posts/local-inference");
        assert_eq!(row.1, None);
        assert_eq!(row.2, None);
        assert_eq!(row.3, None);
        assert_eq!(row.4, None);
        assert_eq!(row.5, "pending");
        assert_eq!(row.6, None);
        assert_eq!(row.7, None);
    }

    #[test]
    fn literal_html_markdown_detection_matches_broken_cached_markdown() {
        let broken =
            r#"<p>我决定写篇短文</p><ol><li><a href="https://example.com">link</a></li></ol>"#;
        let normal = "我决定写篇短文\n\n- 第一条\n- 第二条";

        assert!(super::looks_like_literal_html_markdown(broken));
        assert!(!super::looks_like_literal_html_markdown(normal));
    }

    #[test]
    fn encoded_html_detection_matches_broken_cleaned_html() {
        let broken = r#"<article><p>&lt;p&gt;我决定写篇短文&lt;/p&gt;&lt;ol&gt;&lt;li&gt;&lt;a href=&quot;https://example.com&quot;&gt;link&lt;/a&gt;&lt;/li&gt;&lt;/ol&gt;</p></article>"#;
        let normal = r#"<article><p>我决定写篇短文</p><ol><li><a href="https://example.com">link</a></li></ol></article>"#;

        assert!(super::looks_like_encoded_html_content(broken));
        assert!(!super::looks_like_encoded_html_content(normal));
    }
}
