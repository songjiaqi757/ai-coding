# Marking and Search Extension

Date: 2026-05-30

## Implemented

- Added local favorite and read-later article states.
- Added local highlight and article-note CRUD commands backed by SQLite.
- Added article search across metadata, cleaned content, fallback content, and annotations.
- Added Favorites and Read Later smart lists plus search scope controls.
- Added cleaned-article highlights and a current-article annotation panel.
- Changed View Original Article to an isolated in-app iframe that loads `article.url`.
- Added isolated in-app link previews for links clicked inside cleaned article content.
- Added Back to article navigation, iframe timeout/error feedback, and a copy-link fallback.

## Constraints Preserved

- `clean_article(articleId)` and its cache strategy were not changed.
- `raw_html` remains part of the cleaning pipeline and is not used as the original-article view.
- Annotation tools are available only for cleaned content, not iframe previews.
- Summary and translation placeholders were not changed.
- No commit or push was performed.

## Verification

Run:

```bash
cd app
pnpm build
cd src-tauri
cargo check
```

Manual checks should cover favorite/read-later persistence, annotation CRUD and highlight
restoration, search scopes and fields, original URL preview, cleaned-content link preview,
Back to article behavior, missing article URLs, and blocked iframe fallback handling.

## UI Follow-up

- Added an in-field clear button that resets the search text, results, active query, and scope.
- Added submitted-query highlighting for article cards, cleaned content, and annotation text.
- Added first-match scrolling and automatic annotation drawer opening for annotation-only matches.
- Clamped article-card previews to three lines.
- Replaced the always-visible annotation panel with an on-demand drawer.
- Replaced native annotation prompts and confirms with drawer text areas and inline confirmation.
- Moved article metadata, title, original-link control, and reader actions into the scrolling
  cleaned-content flow with a more compact layout.
- Added current-article Previous / Next search-match navigation across cleaned content and
  annotations.
- Added click-to-jump behavior from highlight annotation quotes back to cleaned-content marks.
- Fixed annotation drawer primary-button styling so Save labels remain visible.
- Changed the annotation drawer from a width-consuming reader column to a right-side overlay
  anchored at the start of cleaned content, preserving the article layout while it is open.
- Pinned the annotation overlay to the reader workspace so it remains visible while cleaned
  content scrolls.
- Replaced reader-header favorite and read-later text actions with independent article-card
  star and bookmark icon controls, including filled active states.
- Reduced article-card marking icons and floated them at the bottom-right corner so they no
  longer add an extra row of whitespace; added keyboard focus styling.

## Main Integration

- Resolved the merge with the latest `main` while preserving Feed refresh, OPML import/export,
  dialog UI, Tauri capabilities, and the incoming LLM provider module.
- Migrated favorite, read-later, annotation CRUD, and article search commands onto the richer
  `main` SQLite schema.
- Reused the `main` Sidebar in the marking/search reader UI and added Favorites and Read Later
  smart entries alongside the real Feed list.
- Restored Sidebar management styles after combining the reader and Feed-management layouts.
