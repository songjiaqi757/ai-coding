mod llm_provider;
mod opml;

use llm_provider::LlmConfig;
use rusqlite::{params, Connection, Row};
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
    pub is_read: bool,
    summary: Option<String>,
    translation: Option<String>,
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

    init_schema(&conn)?;
    seed_database(&conn)?;

    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS feeds (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            url         TEXT NOT NULL UNIQUE,
            site_url    TEXT,
            unread      INTEGER NOT NULL DEFAULT 0,
            last_sync_at TEXT,
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
        "ALTER TABLE articles ADD COLUMN read_status INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE articles ADD COLUMN summary TEXT",
        "ALTER TABLE articles ADD COLUMN translation TEXT",
    ];
    for sql in &migrations {
        let _ = conn.execute(sql, []);
    }

    Ok(())
}

fn seed_database(_conn: &Connection) -> Result<(), String> {
    Ok(())
}

pub fn save_articles(
    conn: &Connection,
    feed_id: &str,
    entries: Vec<feed_rs::model::Entry>,
) -> Result<usize, String> {
    let mut saved = 0;

    for entry in entries {
        let url = match entry.links.first() {
            Some(link) => link.href.clone(),
            None => continue,
        };

        let article_id = Uuid::new_v4().to_string();
        let _guid = Some(entry.id.clone());
        let title = entry
            .title
            .map(|t| t.content)
            .unwrap_or_else(|| "无标题".to_string());
        let author = entry.authors.first().map(|a| a.name.clone());
        let published_at = entry.published.map(|dt| dt.to_rfc3339());

        let excerpt = entry
            .summary
            .map(|s| s.content)
            .or_else(|| {
                entry
                    .content
                    .as_ref()
                    .and_then(|c| c.body.as_ref())
                    .map(|b| b.chars().take(200).collect())
            })
            .unwrap_or_default();

        let content = entry.content.and_then(|c| c.body).unwrap_or_default();

        let result = conn.execute(
            "INSERT OR IGNORE INTO articles
                (id, feed_id, title, url, guid, author, published_at, excerpt, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                article_id,
                feed_id,
                title,
                url,
                _guid,
                author,
                published_at,
                excerpt,
                content
            ],
        );

        if let Ok(1) = result {
            saved += 1;
        }
    }

    Ok(saved)
}

#[tauri::command]
async fn add_feed(app: AppHandle, url: String) -> Result<Feed, String> {
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("无法访问该 URL: {e}"))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    let parsed = feed_rs::parser::parse(bytes.as_ref())
        .map_err(|e| format!("无法解析为 RSS/Atom/JSON Feed: {e}"))?;

    let feed_id = Uuid::new_v4().to_string();
    let title = parsed
        .title
        .map(|t| t.content)
        .unwrap_or_else(|| "未命名订阅源".to_string());
    let site_url = parsed.links.first().map(|l| l.href.clone());

    let conn = open_database(&app)?;
    conn.execute(
        "INSERT OR IGNORE INTO feeds (id, title, url, site_url) VALUES (?1, ?2, ?3, ?4)",
        params![feed_id, title, url, site_url],
    )
    .map_err(|e| format!("保存订阅源失败: {e}"))?;

    save_articles(&conn, &feed_id, parsed.entries)?;

    let unread: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE feed_id = ?1 AND read_status = 0",
            params![feed_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("查询未读数失败: {e}"))?;

    Ok(Feed {
        id: feed_id,
        title,
        url,
        site_url,
        unread,
        last_sync_at: None,
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
        .map_err(|_| format!("找不到 feed_id: {feed_id}"))?;

    let response = reqwest::get(&feed_url)
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取失败: {e}"))?;
    let parsed = feed_rs::parser::parse(bytes.as_ref()).map_err(|e| format!("解析失败: {e}"))?;

    save_articles(&conn, &feed_id, parsed.entries)?;

    conn.execute(
        "UPDATE feeds SET last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1",
        params![feed_id],
    )
    .map_err(|e| format!("更新同步时间失败: {e}"))?;

    list_articles_by_feed(&conn, Some(&feed_id), None)
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
        .map_err(|e| format!("准备查询失败: {e}"))?;

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
        .map_err(|e| format!("查询失败: {e}"))?;

    let mut feeds = Vec::new();
    for row in rows {
        feeds.push(row.map_err(|e| format!("读取行失败: {e}"))?);
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
        summary: row.get(9)?,
        translation: row.get(10)?,
    })
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
    let (sql, param): (String, Option<String>) = match feed_id {
        Some(id) => (
            format!(
                "SELECT id, feed_id, title, url, author, published_at, excerpt, content, read_status, summary, translation
                 FROM articles WHERE feed_id = ?1{filter_sql}
                 ORDER BY published_at DESC, created_at DESC"
            ),
            Some(id.to_string()),
        ),
        None => (
            format!(
                "SELECT id, feed_id, title, url, author, published_at, excerpt, content, read_status, summary, translation
                 FROM articles
                 WHERE 1 = 1{filter_sql}
                 ORDER BY published_at DESC, created_at DESC"
            ),
            None,
        ),
    };

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备查询失败: {e}"))?;

    let rows: Vec<Article> = match param {
        Some(p) => {
            let mut result = Vec::new();
            let rows = stmt
                .query_map(params![p], article_from_row)
                .map_err(|e| format!("查询失败: {e}"))?;
            for row in rows {
                result.push(row.map_err(|e| format!("读取行失败: {e}"))?);
            }
            result
        }
        None => {
            let mut result = Vec::new();
            let rows = stmt
                .query_map([], article_from_row)
                .map_err(|e| format!("查询失败: {e}"))?;
            for row in rows {
                result.push(row.map_err(|e| format!("读取行失败: {e}"))?);
            }
            result
        }
    };

    Ok(rows)
}

fn load_article_by_id(conn: &Connection, article_id: &str) -> Result<Article, String> {
    conn.query_row(
        "SELECT id, feed_id, title, url, author, published_at, excerpt, content, read_status, summary, translation
         FROM articles
         WHERE id = ?1",
        params![article_id],
        article_from_row,
    )
    .map_err(|e| format!("Article not found: {e}"))
}

fn load_unread_summary(conn: &Connection) -> Result<UnreadSummary, String> {
    let total_unread = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE read_status = 0",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("查询总未读数失败: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.title, COUNT(CASE WHEN a.read_status = 0 THEN 1 END) as unread
             FROM feeds f
             LEFT JOIN articles a ON a.feed_id = f.id
             GROUP BY f.id
             ORDER BY f.title ASC",
        )
        .map_err(|e| format!("准备未读数查询失败: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(FeedUnread {
                feed_id: row.get(0)?,
                feed_title: row.get(1)?,
                unread: row.get(2)?,
            })
        })
        .map_err(|e| format!("查询未读数失败: {e}"))?;

    let mut feed_unread = Vec::new();
    for row in rows {
        feed_unread.push(row.map_err(|e| format!("读取未读数行失败: {e}"))?);
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
            .map_err(|e| format!("Failed to start article update transaction: {e}"))?;
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
            .map_err(|e| format!("Failed to save article read updates: {e}"))?;
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
fn summarize_article(
    app: AppHandle,
    article_id: String,
    force: Option<bool>,
) -> Result<String, String> {
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
fn translate_article(
    app: AppHandle,
    article_id: String,
    target_lang: String,
) -> Result<String, String> {
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
        &format!(
            "You are a professional translator. Translate the user's text into {}.",
            lang_name
        ),
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_feeds,
            list_articles,
            add_feed,
            refresh_feed,
            crate::opml::import_opml,
            save_setting,
            load_setting,
            get_llm_config,
            set_article_read_status,
            mark_articles_read,
            summarize_article,
            translate_article,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
