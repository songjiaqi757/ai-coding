mod llm_provider;

use llm_provider::LlmConfig;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
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
            summary TEXT,
            translation TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(feed_id) REFERENCES feeds(id)
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
        "ALTER TABLE articles ADD COLUMN summary TEXT",
        "ALTER TABLE articles ADD COLUMN translation TEXT",
    ];
    for sql in &migrations {
        let _ = conn.execute(sql, []);
    }

    Ok(())
}

fn seed_database(conn: &Connection) -> Result<(), String> {
    let feed_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM feeds", [], |row| row.get(0))
        .map_err(|error| format!("Failed to count feeds: {error}"))?;

    // LLM default settings — always run so provider config stays in sync
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params!["llm_base_url", "https://chat.ecnu.edu.cn/open/api"],
    )
    .map_err(|error| format!("Failed to seed llm_base_url: {error}"))?;

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params!["llm_api_key", "sk-8ff670c62b634986aa98669c1444911b"],
    )
    .map_err(|error| format!("Failed to seed llm_api_key: {error}"))?;

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params!["llm_model_name", "ecnu-plus"],
    )
    .map_err(|error| format!("Failed to seed llm_model_name: {error}"))?;

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
            SELECT id, feed_id, title, source, published_at, excerpt, content,
                   summary, translation
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
                summary: row.get(7)?,
                translation: row.get(8)?,
            })
        })
        .map_err(|error| format!("Failed to query articles: {error}"))?;

    let mut articles = Vec::new();

    for row in rows {
        articles.push(row.map_err(|error| format!("Failed to read article row: {error}"))?);
    }

    Ok(articles)
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

#[tauri::command]
fn summarize_article(app: AppHandle, article_id: String, force: Option<bool>) -> Result<String, String> {
    let conn = open_database(&app)?;

    // Return cached summary unless force is true
    if force != Some(true) {
        let cached: Option<String> = conn
            .query_row(
                "SELECT summary FROM articles WHERE id = ?1",
                params![article_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();

        if let Some(ref s) = cached {
            if !s.is_empty() {
                return Ok(s.clone());
            }
        }
    }

    let content: String = conn
        .query_row(
            "SELECT content FROM articles WHERE id = ?1",
            params![article_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Article not found: {e}"))?;

    let config = get_llm_config_from_db(&conn)?;
    let prompt = format!(
        "Please provide a concise summary of the following article in 2-3 sentences:\n\n{}",
        content
    );
    let summary = llm_provider::call_llm(
        &config,
        "You are a helpful assistant that summarizes articles concisely.",
        &prompt,
    )?;

    conn.execute(
        "UPDATE articles SET summary = ?1 WHERE id = ?2",
        params![summary, article_id],
    )
    .map_err(|e| format!("Failed to save summary: {e}"))?;

    Ok(summary)
}

#[tauri::command]
fn translate_article(app: AppHandle, article_id: String, target_lang: String) -> Result<String, String> {
    let conn = open_database(&app)?;

    // Return cached translation
    let cached: Option<String> = conn
        .query_row(
            "SELECT translation FROM articles WHERE id = ?1",
            params![article_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    if let Some(ref s) = cached {
        if !s.is_empty() {
            return Ok(s.clone());
        }
    }

    let content: String = conn
        .query_row(
            "SELECT content FROM articles WHERE id = ?1",
            params![article_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Article not found: {e}"))?;

    let config = get_llm_config_from_db(&conn)?;

    let lang_name = match target_lang.as_str() {
        "zh" => "Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "fr" => "French",
        "de" => "German",
        "es" => "Spanish",
        _ => &target_lang,
    };

    let prompt = format!(
        "Please translate the following article into {}. Preserve the original meaning and tone:\n\n{}",
        lang_name, content
    );
    let translation = llm_provider::call_llm(
        &config,
        &format!("You are a professional translator. Translate the user's text into {}.", lang_name),
        &prompt,
    )?;

    conn.execute(
        "UPDATE articles SET translation = ?1 WHERE id = ?2",
        params![translation, article_id],
    )
    .map_err(|e| format!("Failed to save translation: {e}"))?;

    Ok(translation)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_feeds,
            list_articles,
            save_setting,
            load_setting,
            get_llm_config,
            summarize_article,
            translate_article,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
