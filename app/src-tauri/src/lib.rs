use rusqlite::{params, Connection};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Feed {
    id: String,
    title: String,
    unread: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Article {
    id: String,
    feed_id: String,
    title: String,
    source: String,
    published_at: String,
    excerpt: String,
    content: String,
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
    seed_database(&conn)?;

    Ok(conn)
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

fn seed_database(conn: &Connection) -> Result<(), String> {
    let feed_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM feeds", [], |row| row.get(0))
        .map_err(|error| format!("Failed to count feeds: {error}"))?;

    if feed_count > 0 {
        return Ok(());
    }

    conn.execute(
        "INSERT INTO feeds (id, title, unread) VALUES (?1, ?2, ?3)",
        params!["tech", "Technology", 3],
    )
    .map_err(|error| format!("Failed to seed Technology feed: {error}"))?;

    conn.execute(
        "INSERT INTO feeds (id, title, unread) VALUES (?1, ?2, ?3)",
        params!["design", "Design", 2],
    )
    .map_err(|error| format!("Failed to seed Design feed: {error}"))?;

    conn.execute(
        "INSERT INTO feeds (id, title, unread) VALUES (?1, ?2, ?3)",
        params!["ai", "AI Research", 2],
    )
    .map_err(|error| format!("Failed to seed AI feed: {error}"))?;

    conn.execute(
        "
        INSERT INTO articles
            (id, feed_id, title, source, published_at, excerpt, content)
        VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ",
        params![
            "a1",
            "ai",
            "Local-first AI apps are becoming practical",
            "AI Weekly",
            "Today",
            "A new wave of AI tools keeps data local while allowing users to connect their own model providers.",
            "Local-first AI applications combine private local storage with optional model providers. This architecture allows users to keep their reading data, summaries, translations, and preferences on their own device. When an AI feature is triggered, the app can call a user-configured local or remote model provider without requiring a central server."
        ],
    )
    .map_err(|error| format!("Failed to seed article a1: {error}"))?;

    conn.execute(
        "
        INSERT INTO articles
            (id, feed_id, title, source, published_at, excerpt, content)
        VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ",
        params![
            "a2",
            "tech",
            "Why desktop apps still matter",
            "Software Notes",
            "Yesterday",
            "For tools that manage personal data, a desktop app can offer better privacy and reliability than a cloud-only web app.",
            "Desktop applications remain useful for privacy-sensitive workflows. They can run without accounts, store data locally, and continue working even when network services are unavailable. For a reader application, this means feeds, articles, cleaned content, summaries, and translations can remain under the user's control."
        ],
    )
    .map_err(|error| format!("Failed to seed article a2: {error}"))?;

    conn.execute(
        "
        INSERT INTO articles
            (id, feed_id, title, source, published_at, excerpt, content)
        VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ",
        params![
            "a3",
            "design",
            "Designing a calm reading interface",
            "Interface Lab",
            "May 21",
            "A good reader should reduce visual noise and make the article itself the primary focus.",
            "Reader interfaces benefit from simple layouts, consistent spacing, readable typography, and clear hierarchy. A three-column layout can separate navigation, article selection, and reading without overwhelming the user."
        ],
    )
    .map_err(|error| format!("Failed to seed article a3: {error}"))?;

    Ok(())
}

#[tauri::command]
fn list_feeds(app: AppHandle) -> Result<Vec<Feed>, String> {
    let conn = open_database(&app)?;

    let mut stmt = conn
        .prepare("SELECT id, title, unread FROM feeds ORDER BY title ASC")
        .map_err(|error| format!("Failed to prepare feeds query: {error}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Feed {
                id: row.get(0)?,
                title: row.get(1)?,
                unread: row.get(2)?,
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
fn list_articles(app: AppHandle) -> Result<Vec<Article>, String> {
    let conn = open_database(&app)?;

    let mut stmt = conn
        .prepare(
            "
            SELECT id, feed_id, title, source, published_at, excerpt, content
            FROM articles
            ORDER BY created_at ASC
            ",
        )
        .map_err(|error| format!("Failed to prepare articles query: {error}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Article {
                id: row.get(0)?,
                feed_id: row.get(1)?,
                title: row.get(2)?,
                source: row.get(3)?,
                published_at: row.get(4)?,
                excerpt: row.get(5)?,
                content: row.get(6)?,
            })
        })
        .map_err(|error| format!("Failed to query articles: {error}"))?;

    let mut articles = Vec::new();

    for row in rows {
        articles.push(row.map_err(|error| format!("Failed to read article row: {error}"))?);
    }

    Ok(articles)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![list_feeds, list_articles])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
