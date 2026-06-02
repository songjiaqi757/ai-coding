use opml::{Head, Outline, OPML};
use rusqlite::params;
use std::time::Duration;
use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    clean_site_url, guess_site_url_from_feed_url, open_database, save_articles,
    select_feed_site_url, Feed,
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
pub async fn import_opml(app: AppHandle, file_path: String) -> Result<Vec<Feed>, String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|error| format!("Failed to read OPML file '{file_path}': {error}"))?;
    let xml = String::from_utf8_lossy(&bytes);
    let feed_list = parse_opml_feeds(&xml)?;

    if feed_list.is_empty() {
        return Err("No feeds found in OPML file. Expected outline nodes with xmlUrl.".to_string());
    }

    let mut imported_feeds = Vec::new();
    let mut errors = Vec::new();

    for feed in feed_list {
        match fetch_and_save_feed(&app, &feed).await {
            Ok(feed) => imported_feeds.push(feed),
            Err(error) => errors.push(format!("{}: {error}", feed.url)),
        }
    }

    if imported_feeds.is_empty() && !errors.is_empty() {
        return Err(format!("Failed to import all feeds: {}", errors.join("; ")));
    }

    Ok(imported_feeds)
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
    let saved_feed = save_or_update_opml_feed(app, opml_feed)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Failed to create OPML import HTTP client: {error}"))?;
    let response = match client.get(&opml_feed.url).send().await {
        Ok(response) => response,
        Err(_) => return Ok(saved_feed),
    };

    if !response.status().is_success() {
        return Ok(saved_feed);
    }

    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(_) => return Ok(saved_feed),
    };
    let parsed = match feed_rs::parser::parse(bytes.as_ref()) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(saved_feed),
    };

    let title = parsed
        .title
        .as_ref()
        .map(|text| text.content.clone())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| opml_feed.title.clone());
    let site_url = select_feed_site_url(&parsed, opml_feed.site_url.as_deref(), &opml_feed.url);

    let conn = open_database(app)?;
    conn.execute(
        "
        UPDATE feeds
        SET title = ?1, site_url = ?2, last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE url = ?3
        ",
        params![title, site_url, opml_feed.url],
    )
    .map_err(|error| format!("Failed to update feed after OPML sync: {error}"))?;

    save_articles(&conn, &saved_feed.id, parsed.entries)?;

    find_existing_feed(app, &opml_feed.url)?
        .ok_or_else(|| "Feed disappeared after OPML import sync".to_string())
}

fn save_or_update_opml_feed(app: &AppHandle, opml_feed: &OpmlFeed) -> Result<Feed, String> {
    if let Some(feed) = find_existing_feed(app, &opml_feed.url)? {
        let corrected_site_url = clean_site_url(feed.site_url.as_deref(), &feed.url)
            .or_else(|| clean_site_url(opml_feed.site_url.as_deref(), &opml_feed.url))
            .or_else(|| guess_site_url_from_feed_url(&opml_feed.url));

        if corrected_site_url.is_some() && corrected_site_url != feed.site_url {
            let conn = open_database(app)?;
            conn.execute(
                "UPDATE feeds SET site_url = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![corrected_site_url, feed.id],
            )
            .map_err(|error| format!("Failed to update feed site URL from OPML: {error}"))?;

            return find_existing_feed(app, &opml_feed.url)?
                .ok_or_else(|| "Feed disappeared after OPML metadata update".to_string());
        }

        return Ok(feed);
    }

    let feed_id = Uuid::new_v4().to_string();
    let title = opml_feed.title.clone();
    let site_url = clean_site_url(opml_feed.site_url.as_deref(), &opml_feed.url)
        .or_else(|| guess_site_url_from_feed_url(&opml_feed.url));

    let conn = open_database(app)?;
    conn.execute(
        "
        INSERT INTO feeds (id, title, url, site_url, last_sync_at)
        VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
        ",
        params![feed_id, title, opml_feed.url, site_url],
    )
    .map_err(|error| format!("Failed to save feed: {error}"))?;

    Ok(Feed {
        id: feed_id,
        title,
        url: opml_feed.url.clone(),
        site_url,
        unread: 0,
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
            id: row
                .get(0)
                .map_err(|error| format!("Failed to read feed id: {error}"))?,
            title: row
                .get(1)
                .map_err(|error| format!("Failed to read feed title: {error}"))?,
            url: row
                .get(2)
                .map_err(|error| format!("Failed to read feed url: {error}"))?,
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
