use std::str::FromStr;

use opml::OPML;
use rusqlite::params;
use tauri::AppHandle;
use uuid::Uuid;

use crate::{open_database, save_articles, Feed};

/// Parse OPML content and extract every feed as (title, xml_url).
pub fn parse_opml_feeds(xml: &str) -> Result<Vec<(String, String)>, String> {
    let document = OPML::from_str(xml).map_err(|error| format!("Invalid OPML file: {error}"))?;

    let mut feeds = Vec::new();
    collect_outlines(&document.body.outlines, &mut feeds);

    Ok(feeds)
}

fn collect_outlines(outlines: &[opml::Outline], feeds: &mut Vec<(String, String)>) {
    for outline in outlines {
        if let Some(url) = &outline.xml_url {
            let title = outline
                .title
                .clone()
                .or_else(|| Some(outline.text.clone()))
                .unwrap_or_else(|| url.clone());
            feeds.push((title, url.clone()));
        }

        if !outline.outlines.is_empty() {
            collect_outlines(&outline.outlines, feeds);
        }
    }
}

#[tauri::command]
pub async fn import_opml(app: AppHandle, file_path: String) -> Result<Vec<Feed>, String> {
    let xml = std::fs::read_to_string(&file_path)
        .map_err(|error| format!("Failed to read OPML file '{file_path}': {error}"))?;
    let feed_list = parse_opml_feeds(&xml)?;

    if feed_list.is_empty() {
        return Err("No feeds found in OPML file. Expected outline nodes with xmlUrl.".to_string());
    }

    let mut imported_feeds = Vec::new();
    let mut errors = Vec::new();

    for (title, url) in feed_list {
        match fetch_and_save_feed(&app, &title, &url).await {
            Ok(feed) => imported_feeds.push(feed),
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }

    if imported_feeds.is_empty() && !errors.is_empty() {
        return Err(format!("Failed to import all feeds: {}", errors.join("; ")));
    }

    Ok(imported_feeds)
}

async fn fetch_and_save_feed(app: &AppHandle, opml_title: &str, url: &str) -> Result<Feed, String> {
    if let Some(feed) = find_existing_feed(app, url)? {
        return Ok(feed);
    }

    let response = reqwest::get(url)
        .await
        .map_err(|error| format!("Request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Feed request returned {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read feed response: {error}"))?;
    let parsed = feed_rs::parser::parse_with_uri(bytes.as_ref(), Some(url))
        .map_err(|error| format!("Failed to parse feed: {error}"))?;

    let feed_id = Uuid::new_v4().to_string();
    let title = parsed
        .title
        .map(|text| text.content)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| opml_title.to_string());
    let site_url = parsed.links.first().map(|link| link.href.clone());

    let conn = open_database(app)?;
    conn.execute(
        "
        INSERT INTO feeds (id, title, url, site_url, last_sync_at)
        VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
        ",
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
        .map_err(|error| format!("Failed to count unread articles: {error}"))?;

    Ok(Feed {
        id: feed_id,
        title,
        url: url.to_string(),
        site_url,
        unread,
        last_sync_at: None,
    })
}

fn find_existing_feed(app: &AppHandle, url: &str) -> Result<Option<Feed>, String> {
    let conn = open_database(app)?;
    let mut stmt = conn
        .prepare(
            "
            SELECT f.id, f.title, f.url, f.site_url,
                   COUNT(CASE WHEN a.read_status = 0 THEN 1 END) as unread,
                   f.last_sync_at
            FROM feeds f
            LEFT JOIN articles a ON a.feed_id = f.id
            WHERE f.url = ?1
            GROUP BY f.id, f.title, f.url, f.site_url, f.last_sync_at
            LIMIT 1
            ",
        )
        .map_err(|error| format!("Failed to prepare existing feed query: {error}"))?;

    let mut rows = stmt
        .query(params![url])
        .map_err(|error| format!("Failed to query existing feed: {error}"))?;

    if let Some(row) = rows
        .next()
        .map_err(|error| format!("Failed to read existing feed: {error}"))?
    {
        return Ok(Some(Feed {
            id: row.get(0).map_err(|error| format!("Failed to read feed id: {error}"))?,
            title: row
                .get(1)
                .map_err(|error| format!("Failed to read feed title: {error}"))?,
            url: row.get(2).map_err(|error| format!("Failed to read feed url: {error}"))?,
            site_url: row
                .get(3)
                .map_err(|error| format!("Failed to read feed site url: {error}"))?,
            unread: row
                .get(4)
                .map_err(|error| format!("Failed to read unread count: {error}"))?,
            last_sync_at: row
                .get(5)
                .map_err(|error| format!("Failed to read last sync time: {error}"))?,
        }));
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::parse_opml_feeds;

    #[test]
    fn parses_nested_opml_feeds() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Test</title>
  </head>
  <body>
    <outline text="Tech">
      <outline text="Example Feed" title="Example Feed" type="rss" xmlUrl="https://example.com/rss.xml" />
      <outline text="Another Feed" type="rss" xmlUrl="https://example.com/atom.xml" />
    </outline>
  </body>
</opml>"#;

        let feeds = parse_opml_feeds(xml).expect("OPML should parse");

        assert_eq!(feeds.len(), 2);
        assert_eq!(feeds[0].0, "Example Feed");
        assert_eq!(feeds[0].1, "https://example.com/rss.xml");
        assert_eq!(feeds[1].0, "Another Feed");
    }
}
