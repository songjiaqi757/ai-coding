mod opml;

use rusqlite::{params, Connection};
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
            read_status  INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(feed_id) REFERENCES feeds(id),
            UNIQUE(feed_id, url)
        );
        ",
    )
    .map_err(|error| format!("Failed to initialize database schema: {error}"))?;

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
        let guid = Some(entry.id.clone());
        let title = entry
            .title
            .map(|title| title.content)
            .unwrap_or_else(|| "无标题".to_string());
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
            .and_then(|content| content.body)
            .unwrap_or_default();

        let result = conn.execute(
            "INSERT OR IGNORE INTO articles
                (id, feed_id, title, url, guid, author, published_at, excerpt, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                article_id,
                feed_id,
                title,
                url,
                guid,
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
        .map_err(|error| format!("无法访问该 URL: {error}"))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取响应失败: {error}"))?;

    let parsed = feed_rs::parser::parse(bytes.as_ref())
        .map_err(|error| format!("无法解析为 RSS/Atom/JSON Feed: {error}"))?;

    let feed_id = Uuid::new_v4().to_string();
    let title = parsed
        .title
        .map(|title| title.content)
        .unwrap_or_else(|| "未命名订阅源".to_string());
    let site_url = parsed.links.first().map(|link| link.href.clone());

    let conn = open_database(&app)?;
    conn.execute(
        "INSERT OR IGNORE INTO feeds (id, title, url, site_url) VALUES (?1, ?2, ?3, ?4)",
        params![feed_id, title, url, site_url],
    )
    .map_err(|error| format!("保存订阅源失败: {error}"))?;

    save_articles(&conn, &feed_id, parsed.entries)?;

    let unread: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE feed_id = ?1 AND read_status = 0",
            params![feed_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("查询未读数失败: {error}"))?;

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
        .map_err(|error| format!("请求失败: {error}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取失败: {error}"))?;
    let parsed =
        feed_rs::parser::parse(bytes.as_ref()).map_err(|error| format!("解析失败: {error}"))?;

    save_articles(&conn, &feed_id, parsed.entries)?;

    conn.execute(
        "UPDATE feeds SET last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1",
        params![feed_id],
    )
    .map_err(|error| format!("更新同步时间失败: {error}"))?;

    list_articles_by_feed(&conn, Some(&feed_id))
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
        .map_err(|error| format!("准备查询失败: {error}"))?;

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
        .map_err(|error| format!("查询失败: {error}"))?;

    let mut feeds = Vec::new();
    for row in rows {
        feeds.push(row.map_err(|error| format!("读取行失败: {error}"))?);
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

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|error| format!("准备查询失败: {error}"))?;

    let rows: Vec<Article> = match param {
        Some(param) => {
            let mut result = Vec::new();
            let rows = stmt
                .query_map(params![param], |row| {
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
                })
                .map_err(|error| format!("查询失败: {error}"))?;
            for row in rows {
                result.push(row.map_err(|error| format!("读取行失败: {error}"))?);
            }
            result
        }
        None => {
            let mut result = Vec::new();
            let rows = stmt
                .query_map([], |row| {
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
                })
                .map_err(|error| format!("查询失败: {error}"))?;
            for row in rows {
                result.push(row.map_err(|error| format!("读取行失败: {error}"))?);
            }
            result
        }
    };

    Ok(rows)
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
