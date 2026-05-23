use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const DEMO_ARTICLES: &[(&str, &str, &str, &str, &str, &str, &str, Option<&str>)] = &[
    (
        "a1",
        "ai",
        "Vibe coding in SwiftUI",
        "Simon Willison's Weblog",
        "Mar 27, 2026",
        "A Simon Willison post about trying vibe coding workflows with SwiftUI.",
        "https://simonwillison.net/2026/Mar/27/vibe-coding-swiftui/",
        Some("Simon Willison"),
    ),
    (
        "a2",
        "tech",
        "Power Apps Vibe Coding Overview",
        "Microsoft Learn",
        "May 2026",
        "An overview of the vibe coding workflow in Microsoft Power Apps.",
        "https://learn.microsoft.com/en-us/power-apps/vibe/overview",
        Some("Microsoft Learn"),
    ),
    (
        "a3",
        "design",
        "create-tauri-app Version 3 Released",
        "Tauri Blog",
        "Mar 1, 2023",
        "A Tauri post about mobile support, template simplification, and onboarding improvements.",
        "https://v2.tauri.app/blog/create-tauri-app-version-3-released/",
        Some("Amr Bashir"),
    ),
    (
        "a4",
        "ai",
        "Tauri 2.0 Release Candidate",
        "Tauri Blog",
        "Aug 1, 2024",
        "A long-form update on the road to Tauri 2.0 stable and the release candidate milestone.",
        "https://v2.tauri.app/blog/tauri-2-0-0-release-candidate/",
        Some("Tauri Team"),
    ),
    (
        "a5",
        "tech",
        "Announcing Rust 1.83.0",
        "Rust Blog",
        "Nov 28, 2024",
        "Rust 1.83.0 continues the stable release cadence with language and tooling improvements.",
        "https://blog.rust-lang.org/2024/11/28/Rust-1.83.0/",
        Some("Rust Core Team"),
    ),
];
const CLEANER_VERSION: &str = "node-readability-v4";

#[derive(Debug, Serialize, Clone)]
struct Feed {
    id: String,
    title: String,
    url: Option<String>,
    site_url: Option<String>,
    last_sync_at: Option<String>,
    unread: i64,
}

#[derive(Debug, Serialize, Clone)]
struct Article {
    id: String,
    feed_id: String,
    title: String,
    url: Option<String>,
    author: Option<String>,
    published_at: Option<String>,
    raw_html: Option<String>,
    cleaned_html: Option<String>,
    cleaned_markdown: Option<String>,
    summary: Option<String>,
    translation: Option<String>,
    source: Option<String>,
    excerpt: Option<String>,
    content: Option<String>,
}

#[derive(Debug, Serialize)]
struct NodeCleanerInput {
    html: String,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NodeCleanerOutput {
    title: Option<String>,
    byline: Option<String>,
    excerpt: Option<String>,
    cleaned_html: Option<String>,
    cleaned_markdown: Option<String>,
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

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let path = database_path(app)?;
    let conn = Connection::open(path)
        .map_err(|error| format!("Failed to open SQLite database: {error}"))?;

    init_schema(&conn)?;
    migrate_schema(&conn)?;
    seed_database(&conn)?;
    sync_demo_articles(&conn)?;

    Ok(conn)
}

fn sync_demo_articles(conn: &Connection) -> Result<(), String> {
    for (article_id, feed_id, title, source, published_at, excerpt, url, author) in DEMO_ARTICLES {
        let previous_state = conn
            .query_row(
                "SELECT url, cleaner_version FROM articles WHERE id = ?1",
                [article_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Failed to read demo article {article_id}: {error}"))?;

        conn.execute(
            "
            INSERT INTO articles (
                id, feed_id, title, source, published_at, excerpt, content, url, author
            )
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8
            WHERE NOT EXISTS (SELECT 1 FROM articles WHERE id = ?1)
            ",
            params![article_id, feed_id, title, source, published_at, excerpt, url, author],
        )
        .map_err(|error| format!("Failed to insert demo article {article_id}: {error}"))?;

        let previous_url = previous_state
            .as_ref()
            .and_then(|(existing_url, _)| existing_url.as_deref());
        let previous_cleaner_version = previous_state
            .as_ref()
            .and_then(|(_, cleaner_version)| cleaner_version.as_deref());
        let reset_cache = previous_url.is_some_and(|existing_url| existing_url != *url)
            || previous_cleaner_version != Some(CLEANER_VERSION);

        conn.execute(
            "
            UPDATE articles
            SET
                feed_id = ?2,
                title = ?3,
                source = ?4,
                published_at = ?5,
                excerpt = ?6,
                url = ?7,
                author = CASE WHEN ?8 IS NOT NULL THEN ?8 ELSE author END,
                raw_html = CASE WHEN ?9 THEN NULL ELSE raw_html END,
                cleaned_html = CASE WHEN ?9 THEN NULL ELSE cleaned_html END,
                cleaned_markdown = CASE WHEN ?9 THEN NULL ELSE cleaned_markdown END,
                cleaner_version = CASE WHEN ?9 THEN NULL ELSE cleaner_version END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
            ",
            params![
                article_id,
                feed_id,
                title,
                source,
                published_at,
                excerpt,
                url,
                author,
                reset_cache
            ],
        )
        .map_err(|error| format!("Failed to sync demo article {article_id}: {error}"))?;
    }

    Ok(())
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS feeds (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            unread INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS articles (
            id TEXT PRIMARY KEY,
            feed_id TEXT NOT NULL,
            title TEXT NOT NULL,
            source TEXT NOT NULL,
            published_at TEXT NOT NULL,
            excerpt TEXT NOT NULL,
            content TEXT NOT NULL,
            read_status INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(feed_id) REFERENCES feeds(id)
        );
        ",
    )
    .map_err(|error| format!("Failed to initialize database schema: {error}"))?;

    Ok(())
}

fn migrate_schema(conn: &Connection) -> Result<(), String> {
    ensure_column(conn, "feeds", "url TEXT")?;
    ensure_column(conn, "feeds", "site_url TEXT")?;
    ensure_column(conn, "feeds", "last_sync_at TEXT")?;

    ensure_column(conn, "articles", "url TEXT")?;
    ensure_column(conn, "articles", "author TEXT")?;
    ensure_column(conn, "articles", "raw_html TEXT")?;
    ensure_column(conn, "articles", "cleaned_html TEXT")?;
    ensure_column(conn, "articles", "cleaned_markdown TEXT")?;
    ensure_column(conn, "articles", "cleaner_version TEXT")?;
    ensure_column(conn, "articles", "summary TEXT")?;
    ensure_column(conn, "articles", "translation TEXT")?;

    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, definition: &str) -> Result<(), String> {
    let column_name = definition
        .split_whitespace()
        .next()
        .ok_or_else(|| format!("Invalid column definition for {table}: {definition}"))?;

    let pragma = format!("PRAGMA table_info({table})");
    let mut stmt = conn
        .prepare(&pragma)
        .map_err(|error| format!("Failed to inspect schema for {table}: {error}"))?;

    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to read schema for {table}: {error}"))?;

    for column in columns {
        if column.map_err(|error| format!("Failed to decode schema row: {error}"))? == column_name {
            return Ok(());
        }
    }

    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {definition}"),
        [],
    )
    .map_err(|error| format!("Failed to add column {column_name} to {table}: {error}"))?;

    Ok(())
}

fn seed_database(conn: &Connection) -> Result<(), String> {
    let feed_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM feeds", [], |row| row.get(0))
        .map_err(|error| format!("Failed to count feeds: {error}"))?;

    if feed_count > 0 {
        return Ok(());
    }

    conn.execute(
        "INSERT INTO feeds (id, title, unread, url, site_url) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            "tech",
            "Technology",
            3,
            Option::<String>::None,
            Option::<String>::None
        ],
    )
    .map_err(|error| format!("Failed to seed Technology feed: {error}"))?;

    conn.execute(
        "INSERT INTO feeds (id, title, unread, url, site_url) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            "design",
            "Design",
            2,
            Option::<String>::None,
            Option::<String>::None
        ],
    )
    .map_err(|error| format!("Failed to seed Design feed: {error}"))?;

    conn.execute(
        "INSERT INTO feeds (id, title, unread, url, site_url) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            "ai",
            "AI Research",
            2,
            Option::<String>::None,
            Option::<String>::None
        ],
    )
    .map_err(|error| format!("Failed to seed AI feed: {error}"))?;

    Ok(())
}

fn map_feed_row(row: &Row<'_>) -> rusqlite::Result<Feed> {
    Ok(Feed {
        id: row.get(0)?,
        title: row.get(1)?,
        url: row.get(2)?,
        site_url: row.get(3)?,
        last_sync_at: row.get(4)?,
        unread: row.get(5)?,
    })
}

fn map_article_row(row: &Row<'_>) -> rusqlite::Result<Article> {
    Ok(Article {
        id: row.get(0)?,
        feed_id: row.get(1)?,
        title: row.get(2)?,
        url: row.get(3)?,
        author: row.get(4)?,
        published_at: row.get(5)?,
        raw_html: row.get(6)?,
        cleaned_html: row.get(7)?,
        cleaned_markdown: row.get(8)?,
        summary: row.get(9)?,
        translation: row.get(10)?,
        source: row.get(11)?,
        excerpt: row.get(12)?,
        content: row.get(13)?,
    })
}

fn load_article_by_id(conn: &Connection, article_id: &str) -> Result<Article, String> {
    conn.query_row(
        "
        SELECT
            id,
            feed_id,
            title,
            url,
            author,
            published_at,
            raw_html,
            cleaned_html,
            cleaned_markdown,
            summary,
            translation,
            source,
            excerpt,
            content
        FROM articles
        WHERE id = ?1
        ",
        [article_id],
        map_article_row,
    )
    .optional()
    .map_err(|error| format!("Failed to query article: {error}"))?
    .ok_or_else(|| format!("Article {article_id} was not found"))
}

fn safe_fetchable_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    normalized.starts_with("http://") || normalized.starts_with("https://")
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

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn fallback_html_from_article(article: &Article) -> String {
    let mut blocks = vec![format!("<h1>{}</h1>", escape_html(&article.title))];

    if let Some(excerpt) = article.excerpt.as_ref().filter(|value| !value.trim().is_empty()) {
        blocks.push(format!("<p>{}</p>", escape_html(excerpt.trim())));
    }

    if let Some(content) = article.content.as_ref().filter(|value| !value.trim().is_empty()) {
        for paragraph in content.split("\n\n") {
            let trimmed = paragraph.trim();
            if !trimmed.is_empty() {
                blocks.push(format!("<p>{}</p>", escape_html(trimmed)));
            }
        }
    }

    format!("<article>{}</article>", blocks.join("\n"))
}

fn node_script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("article-cleaner.mjs")
}

async fn run_node_cleaner(
    html: String,
    url: Option<String>,
) -> Result<NodeCleanerOutput, String> {
    let script_path = node_script_path();

    tauri::async_runtime::spawn_blocking(move || {
        let payload = serde_json::to_vec(&NodeCleanerInput { html, url })
            .map_err(|error| format!("Failed to serialize cleaner input: {error}"))?;

        let mut child = Command::new("node")
            .arg(script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start Node article cleaner: {error}"))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open stdin for Node article cleaner".to_string())?;
        stdin
            .write_all(&payload)
            .map_err(|error| format!("Failed to send HTML to Node article cleaner: {error}"))?;
        drop(stdin);

        let output = child
            .wait_with_output()
            .map_err(|error| format!("Failed to wait for Node article cleaner: {error}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "Node article cleaner exited with an unknown error".to_string()
            } else {
                format!("Node article cleaner failed: {stderr}")
            });
        }

        serde_json::from_slice::<NodeCleanerOutput>(&output.stdout)
            .map_err(|error| format!("Failed to decode Node cleaner output: {error}"))
    })
    .await
    .map_err(|error| format!("Node cleaner task failed: {error}"))?
}

async fn fetch_html(url: &str) -> Result<String, String> {
    let client = Client::builder()
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch article HTML: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch article HTML: HTTP {}",
            response.status()
        ));
    }

    response
        .text()
        .await
        .map_err(|error| format!("Failed to read article HTML: {error}"))
}

fn update_article_cleaning(
    conn: &Connection,
    article_id: &str,
    raw_html: Option<&str>,
    cleaned_html: Option<&str>,
    cleaned_markdown: Option<&str>,
    title: Option<&str>,
    author: Option<&str>,
    excerpt: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "
        UPDATE articles
        SET
            raw_html = COALESCE(?2, raw_html),
            cleaned_html = COALESCE(?3, cleaned_html),
            cleaned_markdown = COALESCE(?4, cleaned_markdown),
            title = COALESCE(?5, title),
            author = COALESCE(?6, author),
            excerpt = COALESCE(?7, excerpt),
            cleaner_version = ?8,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
        ",
        params![
            article_id,
            raw_html,
            cleaned_html,
            cleaned_markdown,
            title,
            author,
            excerpt,
            CLEANER_VERSION
        ],
    )
    .map_err(|error| format!("Failed to save cleaned article: {error}"))?;

    Ok(())
}

#[tauri::command]
fn list_feeds(app: AppHandle) -> Result<Vec<Feed>, String> {
    let conn = open_database(&app)?;

    let mut stmt = conn
        .prepare(
            "
            SELECT id, title, url, site_url, last_sync_at, unread
            FROM feeds
            ORDER BY title ASC
            ",
        )
        .map_err(|error| format!("Failed to prepare feeds query: {error}"))?;

    let rows = stmt
        .query_map([], map_feed_row)
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
    let mut articles = Vec::new();

    let mut stmt = conn
        .prepare(
            "
            SELECT
                id,
                feed_id,
                title,
                url,
                author,
                published_at,
                raw_html,
                cleaned_html,
                cleaned_markdown,
                summary,
                translation,
                source,
                excerpt,
                content
            FROM articles
            WHERE (?1 IS NULL OR ?1 = '' OR feed_id = ?1)
            ORDER BY created_at ASC
            ",
        )
        .map_err(|error| format!("Failed to prepare articles query: {error}"))?;

    let rows = stmt
        .query_map([feed_id.as_deref()], map_article_row)
        .map_err(|error| format!("Failed to query articles: {error}"))?;

    for row in rows {
        articles.push(row.map_err(|error| format!("Failed to read article row: {error}"))?);
    }

    Ok(articles)
}

#[tauri::command]
fn get_article(app: AppHandle, article_id: String) -> Result<Article, String> {
    let conn = open_database(&app)?;
    load_article_by_id(&conn, &article_id)
}

#[tauri::command]
async fn clean_article(app: AppHandle, article_id: String) -> Result<Article, String> {
    let initial_article = {
        let conn = open_database(&app)?;
        load_article_by_id(&conn, &article_id)?
    };

    if initial_article
        .cleaned_markdown
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Ok(initial_article);
    }

    let raw_html_source = initial_article
        .raw_html
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned();

    let cached_cleaned_html = initial_article
        .cleaned_html
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned();

    let (html_for_cleaning, raw_html_to_store) = if let Some(existing_raw_html) = raw_html_source {
        (existing_raw_html.clone(), Some(existing_raw_html))
    } else if let Some(existing_cleaned_html) = cached_cleaned_html.clone() {
        (existing_cleaned_html, None)
    } else if let Some(url) = initial_article
        .url
        .as_ref()
        .filter(|value| safe_fetchable_url(value))
    {
        match fetch_html(url).await {
            Ok(fetched_html) => (fetched_html.clone(), Some(fetched_html)),
            Err(_) => {
                let fallback_html = fallback_html_from_article(&initial_article);
                (fallback_html.clone(), Some(fallback_html))
            }
        }
    } else {
        let fallback_html = fallback_html_from_article(&initial_article);
        (fallback_html.clone(), Some(fallback_html))
    };

    let cleaned = run_node_cleaner(html_for_cleaning, initial_article.url.clone()).await?;
    let cleaned_html = normalize_optional_text(cleaned.cleaned_html)
        .ok_or_else(|| "Article cleaner returned empty cleaned_html".to_string())?;
    let cleaned_markdown = normalize_optional_text(cleaned.cleaned_markdown)
        .ok_or_else(|| "Article cleaner returned empty cleaned_markdown".to_string())?;
    let next_title = normalize_optional_text(cleaned.title).or_else(|| Some(initial_article.title.clone()));
    let next_author = normalize_optional_text(cleaned.byline)
        .or_else(|| initial_article.author.clone())
        .or_else(|| initial_article.source.clone());
    let next_excerpt = normalize_optional_text(cleaned.excerpt).or_else(|| initial_article.excerpt.clone());

    let conn = open_database(&app)?;
    update_article_cleaning(
        &conn,
        &article_id,
        raw_html_to_store.as_deref(),
        Some(&cleaned_html),
        Some(&cleaned_markdown),
        next_title.as_deref(),
        next_author.as_deref(),
        next_excerpt.as_deref(),
    )?;

    load_article_by_id(&conn, &article_id)
}

#[tauri::command]
fn add_feed(app: AppHandle, url: String) -> Result<Feed, String> {
    if !safe_fetchable_url(&url) {
        return Err("Feed URL must start with http:// or https://".to_string());
    }

    let conn = open_database(&app)?;
    let feed_id = format!(
        "feed-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("Failed to generate feed id: {error}"))?
            .as_millis()
    );

    conn.execute(
        "
        INSERT INTO feeds (id, title, url, site_url, unread, last_sync_at)
        VALUES (?1, ?2, ?3, ?4, 0, CURRENT_TIMESTAMP)
        ",
        params![feed_id, url.clone(), url.clone(), url.clone()],
    )
    .map_err(|error| format!("Failed to add feed: {error}"))?;

    conn.query_row(
        "
        SELECT id, title, url, site_url, last_sync_at, unread
        FROM feeds
        WHERE id = ?1
        ",
        [feed_id],
        map_feed_row,
    )
    .map_err(|error| format!("Failed to read added feed: {error}"))
}

#[tauri::command]
fn refresh_feed(app: AppHandle, feed_id: String) -> Result<(), String> {
    let conn = open_database(&app)?;
    let changed = conn
        .execute(
            "
            UPDATE feeds
            SET
                last_sync_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
            ",
            [feed_id],
        )
        .map_err(|error| format!("Failed to refresh feed: {error}"))?;

    if changed == 0 {
        return Err("Feed was not found".to_string());
    }

    Ok(())
}

#[tauri::command]
fn summarize_article(article_id: String) -> Result<String, String> {
    Err(format!(
        "summarize_article({article_id}) is reserved for the summary group and is not implemented in this branch."
    ))
}

#[tauri::command]
fn translate_article(article_id: String, target_lang: String) -> Result<String, String> {
    Err(format!(
        "translate_article({article_id}, {target_lang}) is reserved for the translation group and is not implemented in this branch."
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_feeds,
            list_articles,
            get_article,
            add_feed,
            refresh_feed,
            clean_article,
            summarize_article,
            translate_article
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
