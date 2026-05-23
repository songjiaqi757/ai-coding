use dom_query::Document;
use reqwest::{Client, Url};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const BLOCKED_SELECTORS: &[&str] = &[
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "noscript",
    "nav",
    "footer",
    "aside",
    "svg",
];

const CONTENT_SELECTORS: &[&str] = &[
    "article",
    ".entryPage",
    ".entry",
    "main",
    ".sl-markdown-content",
    ".content-panel",
    "[data-pagefind-body]",
    "[role='main']",
    ".content",
    ".article",
    ".post",
    ".entry-content",
    ".article-content",
    ".post-content",
];

const NOISE_KEYWORDS: &[&str] = &[
    "ad",
    "advert",
    "ads",
    "recommend",
    "related",
    "comment",
    "share",
    "sidebar",
    "footer",
    "nav",
    "sponsor",
    "sponsored",
    "toc",
    "popup",
    "login",
];

const SAFE_ATTRS: &[&str] = &["href", "src", "alt", "title", "colspan", "rowspan"];
const DEMO_ARTICLES: &[(&str, &str, &str, &str, &str, &str, &str)] = &[
    (
        "a1",
        "ai",
        "Vibe coding in SwiftUI",
        "Simon Willison's Weblog",
        "Mar 27, 2026",
        "A Simon Willison post about trying vibe coding workflows with SwiftUI.",
        "https://simonwillison.net/2026/Mar/27/vibe-coding-swiftui/",
    ),
    (
        "a2",
        "tech",
        "The science of slowing down",
        "Psychology Today",
        "Sep 2025",
        "An article about the cognitive and health science behind slowing down.",
        "https://www.psychologytoday.com/us/blog/heart-of-healthcare/202509/the-science-of-slowing-down",
    ),
    (
        "a3",
        "design",
        "create-tauri-app Version 3 Released",
        "Tauri Blog",
        "Mar 1, 2023",
        "A Tauri post about mobile support, template simplification, and onboarding improvements.",
        "https://v2.tauri.app/blog/create-tauri-app-version-3-released/",
    ),
    (
        "a4",
        "ai",
        "Tauri 2.0 Release Candidate",
        "Tauri Blog",
        "Aug 1, 2024",
        "A long-form update on the road to Tauri 2.0 stable and the release candidate milestone.",
        "https://v2.tauri.app/blog/tauri-2-0-0-release-candidate/",
    ),
    (
        "a5",
        "tech",
        "Announcing Rust 1.83.0",
        "Rust Blog",
        "Nov 28, 2024",
        "Rust 1.83.0 continues the stable release cadence with language and tooling improvements.",
        "https://blog.rust-lang.org/2024/11/28/Rust-1.83.0/",
    ),
];

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
    for (article_id, feed_id, title, source, published_at, excerpt, url) in DEMO_ARTICLES {
        conn.execute(
            "
            INSERT INTO articles (
                id, feed_id, title, source, published_at, excerpt, content, url, author
            )
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, 'Demo Source'
            WHERE NOT EXISTS (SELECT 1 FROM articles WHERE id = ?1)
            ",
            params![article_id, feed_id, title, source, published_at, excerpt, url],
        )
        .map_err(|error| format!("Failed to insert demo article {article_id}: {error}"))?;

        conn.execute(
            "
            UPDATE articles
            SET
                title = ?2,
                source = ?3,
                published_at = ?4,
                excerpt = ?5,
                url = ?6,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
            ",
            params![article_id, title, source, published_at, excerpt, url],
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

    conn.execute(
        "
        INSERT INTO articles
            (id, feed_id, title, source, published_at, excerpt, content, url, author)
        VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ",
        params![
            "a1",
            "ai",
            "Vibe coding in SwiftUI",
            "Simon Willison's Weblog",
            "Mar 27, 2026",
            "A Simon Willison post about trying vibe coding workflows with SwiftUI.",
            "Local-first AI applications combine private local storage with optional model providers. This architecture allows users to keep their reading data, summaries, translations, and preferences on their own device. When an AI feature is triggered, the app can call a user-configured local or remote model provider without requiring a central server.",
            Some("https://simonwillison.net/2026/Mar/27/vibe-coding-swiftui/".to_string()),
            Some("Simon Willison".to_string())
        ],
    )
    .map_err(|error| format!("Failed to seed article a1: {error}"))?;

    conn.execute(
        "
        INSERT INTO articles
            (id, feed_id, title, source, published_at, excerpt, content, url, author)
        VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ",
        params![
            "a2",
            "tech",
            "The science of slowing down",
            "Psychology Today",
            "Sep 2025",
            "An article about the cognitive and health science behind slowing down.",
            "Desktop applications remain useful for privacy-sensitive workflows. They can run without accounts, store data locally, and continue working even when network services are unavailable. For a reader application, this means feeds, articles, cleaned content, summaries, and translations can remain under the user's control.",
            Some("https://www.psychologytoday.com/us/blog/heart-of-healthcare/202509/the-science-of-slowing-down".to_string()),
            Some("Psychology Today".to_string())
        ],
    )
    .map_err(|error| format!("Failed to seed article a2: {error}"))?;

    conn.execute(
        "
        INSERT INTO articles
            (id, feed_id, title, source, published_at, excerpt, content, url, author)
        VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ",
        params![
            "a3",
            "design",
            "Designing a calm reading interface",
            "Interface Lab",
            "May 21",
            "A good reader should reduce visual noise and make the article itself the primary focus.",
            "Reader interfaces benefit from simple layouts, consistent spacing, readable typography, and clear hierarchy. A three-column layout can separate navigation, article selection, and reading without overwhelming the user.",
            Some("https://v2.tauri.app/blog/create-tauri-app-version-3-released/".to_string()),
            Some("Lina Zhou".to_string())
        ],
    )
    .map_err(|error| format!("Failed to seed article a3: {error}"))?;

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

fn safe_content_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    !(normalized.starts_with("javascript:")
        || normalized.starts_with("vbscript:")
        || normalized.starts_with("data:text/html"))
}

fn contains_noise_keyword(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    NOISE_KEYWORDS.iter().any(|keyword| normalized.contains(keyword))
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

fn content_score(node_html: &str) -> i64 {
    let candidate = Document::fragment(node_html);
    let text = candidate.formatted_text().to_string();
    let text_len = text.trim().chars().count() as i64;
    let paragraph_count = candidate.select("p").length() as i64;
    let heading_count = candidate.select("h1, h2, h3").length() as i64;
    let link_text_len = candidate
        .select("a")
        .iter()
        .map(|node| node.text().chars().count() as i64)
        .sum::<i64>();

    text_len + paragraph_count * 120 + heading_count * 80 - link_text_len * 2
}

fn select_best_content_html(doc: &Document) -> String {
    for selector in CONTENT_SELECTORS {
        let mut best_html = String::new();
        let mut best_score = i64::MIN;

        for node in doc.select(selector).iter() {
            let html = node.html().to_string();
            let score = content_score(&html);
            if score > best_score {
                best_score = score;
                best_html = html;
            }
        }

        if !best_html.is_empty() && best_score > 200 {
            return best_html;
        }
    }

    let mut best_html = String::new();
    let mut best_score = i64::MIN;

    for selector in ["body", "main", "article", "div"] {
        for node in doc.select(selector).iter() {
            let html = node.html().to_string();
            let score = content_score(&html);
            if score > best_score {
                best_score = score;
                best_html = html;
            }
        }
    }

    if best_html.is_empty() {
        let body = doc.select("body");
        if body.exists() {
            return body.inner_html().to_string();
        }
        return doc.html().to_string();
    }

    best_html
}

fn remove_blocked_and_noisy_nodes(doc: &Document) {
    for selector in BLOCKED_SELECTORS {
        doc.select(selector).remove();
    }

    let nodes: Vec<_> = doc.select("*").iter().collect();
    for node in nodes {
        let mut should_remove = false;

        for attr_name in ["class", "id", "role"] {
            if let Some(value) = node.attr(attr_name) {
                if contains_noise_keyword(value.as_ref()) {
                    should_remove = true;
                    break;
                }
            }
        }

        if should_remove && !node.is("article") && !node.is("main") && !node.is("body") {
            node.remove();
        }
    }
}

fn normalize_resource_url(base_url: Option<&str>, value: &str) -> Option<String> {
    if !safe_content_url(value) {
        return None;
    }

    if let Ok(url) = Url::parse(value) {
        return Some(url.to_string());
    }

    let base = Url::parse(base_url?).ok()?;
    base.join(value).ok().map(|url| url.to_string())
}

fn flatten_heading_links(doc: &Document) {
    for heading in doc.select("h1, h2, h3, h4, h5, h6").iter() {
        let text = heading.text().trim().to_string();
        if !text.is_empty() {
            heading.set_text(&text);
        }
    }
}

fn extract_author(doc: &Document) -> Option<String> {
    for selector in [
        ".authors .name",
        ".author .name",
        ".byline .name",
        "meta[name='author']",
        "meta[property='article:author']",
        "meta[name='twitter:creator']",
        "[itemprop='author']",
        "a[rel='author']",
        ".byline",
    ] {
        for node in doc.select(selector).iter() {
            if node.is("meta") {
                if let Some(content) = node.attr("content") {
                    let value = content.trim().trim_start_matches('@').to_string();
                    if !value.is_empty() {
                        return Some(value);
                    }
                }
            } else {
                let text = node.text().trim().trim_start_matches("By ").to_string();
                if !text.is_empty() && text.len() <= 80 {
                    return Some(text);
                }
            }
        }
    }

    None
}

fn sanitize_node_attrs(doc: &Document, base_url: Option<&str>) {
    let nodes: Vec<_> = doc.select("*").iter().collect();

    for node in nodes {
        let attrs = node.attrs();

        for attr in attrs {
            let attr_name = attr.name.local.to_string();
            let attr_value = attr.value.to_string();
            let lower_name = attr_name.to_ascii_lowercase();

            if lower_name.starts_with("on") || lower_name == "style" || lower_name == "srcset" {
                node.remove_attr(&attr_name);
                continue;
            }

            if !SAFE_ATTRS.contains(&lower_name.as_str()) {
                node.remove_attr(&attr_name);
                continue;
            }

            if matches!(lower_name.as_str(), "href" | "src") {
                if let Some(normalized_url) = normalize_resource_url(base_url, &attr_value) {
                    node.set_attr(&attr_name, &normalized_url);
                } else {
                    node.remove_attr(&attr_name);
                }
            }
        }
    }
}

fn clean_html(raw_html: &str, base_url: Option<&str>) -> Result<String, String> {
    let raw_doc = Document::from(raw_html);
    remove_blocked_and_noisy_nodes(&raw_doc);

    let candidate_html = select_best_content_html(&raw_doc);
    if candidate_html.trim().is_empty() {
        return Err("Failed to extract article content from HTML".to_string());
    }

    let cleaned_doc = Document::fragment(candidate_html);
    remove_blocked_and_noisy_nodes(&cleaned_doc);
    flatten_heading_links(&cleaned_doc);
    sanitize_node_attrs(&cleaned_doc, base_url);

    let cleaned_html = cleaned_doc.html().to_string();
    if cleaned_html.trim().is_empty() {
        return Err("Article content was empty after cleaning".to_string());
    }

    Ok(cleaned_html)
}

fn html_to_markdown(cleaned_html: &str) -> Result<String, String> {
    let doc = Document::fragment(cleaned_html);
    let markdown = doc.md(Some(&[])).to_string();
    let normalized = markdown.trim().to_string();

    if normalized.is_empty() {
        return Err("Failed to generate markdown from cleaned HTML".to_string());
    }

    Ok(normalized)
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
) -> Result<(), String> {
    conn.execute(
        "
        UPDATE articles
        SET
            raw_html = COALESCE(?2, raw_html),
            cleaned_html = COALESCE(?3, cleaned_html),
            cleaned_markdown = COALESCE(?4, cleaned_markdown),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
        ",
        params![article_id, raw_html, cleaned_html, cleaned_markdown],
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

    let sql = "
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
    ";

    let mut stmt = conn
        .prepare(sql)
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

    if let Some(existing_cleaned_html) = initial_article
        .cleaned_html
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        let markdown = html_to_markdown(existing_cleaned_html)?;
        let conn = open_database(&app)?;
        update_article_cleaning(
            &conn,
            &article_id,
            None,
            Some(existing_cleaned_html),
            Some(&markdown),
        )?;
        return load_article_by_id(&conn, &article_id);
    }

    let raw_html = if let Some(existing_raw_html) = initial_article
        .raw_html
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        existing_raw_html.clone()
    } else if let Some(url) = initial_article
        .url
        .as_ref()
        .filter(|value| safe_fetchable_url(value))
    {
        fetch_html(url).await?
    } else {
        fallback_html_from_article(&initial_article)
    };

    let extracted_author = Document::from(raw_html.as_str());
    let next_author = extract_author(&extracted_author)
        .or_else(|| initial_article.author.clone())
        .or_else(|| initial_article.source.clone());

    let cleaned_html = clean_html(&raw_html, initial_article.url.as_deref()).or_else(|_| {
        clean_html(
            &fallback_html_from_article(&initial_article),
            initial_article.url.as_deref(),
        )
    })?;
    let cleaned_markdown = html_to_markdown(&cleaned_html)?;

    let conn = open_database(&app)?;
    update_article_cleaning(
        &conn,
        &article_id,
        Some(&raw_html),
        Some(&cleaned_html),
        Some(&cleaned_markdown),
    )?;
    conn.execute(
        "
        UPDATE articles
        SET author = COALESCE(?2, author), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
        ",
        params![article_id, next_author],
    )
    .map_err(|error| format!("Failed to update article author: {error}"))?;

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
