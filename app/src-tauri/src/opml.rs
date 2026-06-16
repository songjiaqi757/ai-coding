use opml::{Head, Outline, OPML};
use rusqlite::params;
use serde::Serialize;
use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    clean_site_url, find_feed_by_url, guess_site_url_from_feed_url, open_database,
    resolve_feed_import, save_articles, select_feed_site_url, Feed, ResolvedFeedImport,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpmlFeed {
    pub title: String,
    pub text: String,
    pub url: String,
    pub site_url: Option<String>,
    pub feed_type: Option<String>,
}

#[derive(Debug)]
pub struct ExportFeed {
    pub title: String,
    pub url: String,
    pub site_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpmlImportFailure {
    pub url: String,
    pub error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpmlImportReport {
    pub imported_feeds: Vec<Feed>,
    pub failed_feeds: Vec<OpmlImportFailure>,
}

pub fn parse_opml_feeds(xml: &str) -> Result<Vec<OpmlFeed>, String> {
    let document = OPML::from_str(xml).map_err(|error| format!("Invalid OPML file: {error}"))?;

    let mut feeds = Vec::new();
    collect_outlines(&document.body.outlines, &mut feeds);

    Ok(feeds)
}

fn collect_outlines(outlines: &[opml::Outline], feeds: &mut Vec<OpmlFeed>) {
    for outline in outlines {
        if let Some(url) = &outline.xml_url {
            let title = first_non_empty([outline.title.as_deref(), Some(outline.text.as_str())])
                .unwrap_or_else(|| url.clone());
            let text = first_non_empty([Some(outline.text.as_str()), Some(title.as_str())])
                .unwrap_or_else(|| url.clone());

            feeds.push(OpmlFeed {
                title,
                text,
                url: url.clone(),
                site_url: non_empty_owned(outline.html_url.as_deref()),
                feed_type: non_empty_owned(outline.r#type.as_deref()),
            });
        }

        if !outline.outlines.is_empty() {
            collect_outlines(&outline.outlines, feeds);
        }
    }
}

#[tauri::command]
pub async fn import_opml(app: AppHandle, file_path: String) -> Result<OpmlImportReport, String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|error| format!("Failed to read OPML file '{file_path}': {error}"))?;
    let xml = String::from_utf8_lossy(&bytes);
    let feed_list = parse_opml_feeds(&xml)?;

    if feed_list.is_empty() {
        return Err("No feeds found in OPML file. Expected outline nodes with xmlUrl.".to_string());
    }

    let mut imported_feeds = Vec::new();
    let mut failed_feeds = Vec::new();

    for feed in feed_list {
        match fetch_and_save_feed(&app, &feed).await {
            Ok(feed) => imported_feeds.push(feed),
            Err(error) => failed_feeds.push(OpmlImportFailure {
                url: feed.url,
                error,
            }),
        }
    }

    Ok(OpmlImportReport {
        imported_feeds,
        failed_feeds,
    })
}

#[tauri::command]
pub fn export_opml(app: AppHandle, file_path: String) -> Result<usize, String> {
    let conn = open_database(&app)?;
    let feeds = list_export_feeds(&conn)?;

    if feeds.is_empty() {
        return Err("No feeds to export.".to_string());
    }

    let xml = build_opml_xml(&feeds)?;
    std::fs::write(&file_path, xml)
        .map_err(|error| format!("Failed to write OPML file '{file_path}': {error}"))?;

    Ok(feeds.len())
}

fn list_export_feeds(conn: &rusqlite::Connection) -> Result<Vec<ExportFeed>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT title, url, site_url
             FROM feeds
             ORDER BY title ASC",
        )
        .map_err(|error| format!("Failed to prepare OPML export query: {error}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ExportFeed {
                title: row.get(0)?,
                url: row.get(1)?,
                site_url: row.get(2)?,
            })
        })
        .map_err(|error| format!("Failed to query feeds for OPML export: {error}"))?;

    let mut feeds = Vec::new();
    for row in rows {
        feeds.push(row.map_err(|error| format!("Failed to read feed for OPML export: {error}"))?);
    }

    Ok(feeds)
}

pub fn build_opml_xml(feeds: &[ExportFeed]) -> Result<String, String> {
    let mut document = OPML::default();
    document.head = Some(Head {
        title: Some("Mercury subscriptions".to_string()),
        docs: Some("http://opml.org/spec2.opml".to_string()),
        ..Head::default()
    });

    document.body.outlines = feeds
        .iter()
        .map(|feed| Outline {
            text: feed.title.clone(),
            r#type: Some("rss".to_string()),
            xml_url: Some(feed.url.clone()),
            html_url: clean_site_url(feed.site_url.as_deref(), &feed.url)
                .or_else(|| guess_site_url_from_feed_url(&feed.url)),
            title: Some(feed.title.clone()),
            ..Outline::default()
        })
        .collect();

    document
        .to_string()
        .map(|xml| {
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{}\n",
                pretty_opml(&xml)
            )
        })
        .map_err(|error| format!("Failed to generate OPML: {error}"))
}

async fn fetch_and_save_feed(app: &AppHandle, opml_feed: &OpmlFeed) -> Result<Feed, String> {
    let resolved = resolve_feed_import(&opml_feed.url).await?;
    save_resolved_opml_feed(app, opml_feed, resolved)
}

fn save_resolved_opml_feed(
    app: &AppHandle,
    opml_feed: &OpmlFeed,
    resolved: ResolvedFeedImport,
) -> Result<Feed, String> {
    let parsed = resolved.feed;
    let feed_url = resolved.feed_url;
    let title = parsed
        .title
        .as_ref()
        .map(|text| text.content.clone())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| opml_feed.title.clone());
    let site_url = select_feed_site_url(&parsed, opml_feed.site_url.as_deref(), &feed_url);

    let conn = open_database(app)?;

    if let Some(existing_feed) = find_feed_by_url(&conn, &feed_url)? {
        update_imported_feed_metadata(&conn, &existing_feed.id, &title, site_url.as_deref())?;
        save_articles(&conn, &existing_feed.id, &feed_url, parsed.entries)?;
        return find_feed_by_url(&conn, &feed_url)?
            .ok_or_else(|| "Feed disappeared after OPML import sync".to_string());
    }

    if feed_url != opml_feed.url {
        if let Some(existing_feed) = find_feed_by_url(&conn, &opml_feed.url)? {
            conn.execute(
                "
                UPDATE feeds
                SET title = ?1, url = ?2, site_url = ?3, last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?4
                ",
                params![
                    title.as_str(),
                    feed_url.as_str(),
                    site_url.as_deref(),
                    existing_feed.id.as_str()
                ],
            )
            .map_err(|error| format!("Failed to update OPML feed URL after discovery: {error}"))?;
            save_articles(&conn, &existing_feed.id, &feed_url, parsed.entries)?;
            return find_feed_by_url(&conn, &feed_url)?
                .ok_or_else(|| "Feed disappeared after OPML import URL update".to_string());
        }
    }

    let feed_id = Uuid::new_v4().to_string();
    conn.execute(
        "
        INSERT INTO feeds (id, title, url, site_url, last_sync_at)
        VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
        ",
        params![
            feed_id.as_str(),
            title.as_str(),
            feed_url.as_str(),
            site_url.as_deref()
        ],
    )
    .map_err(|error| format!("Failed to save feed: {error}"))?;

    save_articles(&conn, &feed_id, &feed_url, parsed.entries)?;

    let feed = find_feed_by_url(&conn, &feed_url)?
        .ok_or_else(|| "Feed disappeared after OPML import insert".to_string())?;
    Ok(feed)
}

fn update_imported_feed_metadata(
    conn: &rusqlite::Connection,
    feed_id: &str,
    title: &str,
    site_url: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "
        UPDATE feeds
        SET title = ?1, site_url = ?2, last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?3
        ",
        params![title, site_url, feed_id],
    )
    .map_err(|error| format!("Failed to update feed after OPML sync: {error}"))?;

    Ok(())
}

fn first_non_empty<const N: usize>(values: [Option<&str>; N]) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn non_empty_owned(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn pretty_opml(xml: &str) -> String {
    xml.replace("<head>", "\n  <head>\n    ")
        .replace("</title><docs>", "</title>\n    <docs>")
        .replace("</docs></head>", "</docs>\n  </head>")
        .replace("</head><body>", "</head>\n  <body>\n")
        .replace("/><outline ", "/>\n<outline ")
        .replace("<outline ", "    <outline ")
        .replace("</body>", "\n  </body>")
        .replace("</opml>", "\n</opml>")
}

#[cfg(test)]
mod tests {
    use super::{build_opml_xml, parse_opml_feeds, ExportFeed};
    use std::path::Path;

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
        assert_eq!(feeds[0].title, "Example Feed");
        assert_eq!(feeds[0].text, "Example Feed");
        assert_eq!(feeds[0].url, "https://example.com/rss.xml");
        assert_eq!(feeds[0].feed_type.as_deref(), Some("rss"));
        assert_eq!(feeds[1].title, "Another Feed");
    }

    #[test]
    fn parses_sample_opml_file() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let sample_path = manifest_dir
            .parent()
            .and_then(Path::parent)
            .expect("src-tauri should be inside app")
            .join("samples")
            .join("opml")
            .join("example.opml");
        let xml = std::fs::read_to_string(sample_path).expect("sample OPML should be readable");

        let feeds = parse_opml_feeds(&xml).expect("sample OPML should parse");

        assert!(feeds.len() >= 2);
        assert!(feeds
            .iter()
            .any(|feed| feed.url == "https://hnrss.org/frontpage"));
    }

    #[test]
    fn exports_feeds_as_opml() {
        let xml = build_opml_xml(&[
            ExportFeed {
                title: "Example Feed".to_string(),
                url: "https://example.com/rss.xml".to_string(),
                site_url: Some("https://example.com".to_string()),
            },
            ExportFeed {
                title: "Another Feed".to_string(),
                url: "https://example.com/atom.xml".to_string(),
                site_url: None,
            },
        ])
        .expect("OPML export should be generated");

        let feeds = parse_opml_feeds(&xml).expect("exported OPML should parse");

        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(xml.contains("type=\"rss\""));
        assert!(xml.contains("xmlUrl=\"https://example.com/rss.xml\""));
        assert_eq!(feeds.len(), 2);
        assert_eq!(feeds[0].title, "Example Feed");
        assert_eq!(feeds[0].url, "https://example.com/rss.xml");
    }
}
