# Feed / OPML 说明

## 功能范围

当前 Phase 2 聚焦 Feed 添加、OPML 导入导出和订阅源刷新：

- 添加单个 RSS / Atom / JSON Feed URL，并保存为 `feed.url`。
- 重复添加相同 Feed URL 时复用本地已有订阅源，不创建孤立文章。
- 解析 OPML 2.0 文件中的嵌套 `outline`。
- 提取带有 `xmlUrl` 的订阅源，先保存 OPML 中的订阅源元数据，再尝试拉取 RSS / Atom / JSON Feed。
- 导入时把 OPML `xmlUrl` 保存为 `feed.url`，把 Feed 页面链接或 OPML `htmlUrl` 保存为 `feed.site_url`。
- 单个 Feed 拉取失败不会阻止订阅源进入列表。
- 拉取 Feed 后保存文章元数据和 `article.url`，为后续原文 HTML 抓取提供稳定入口。
- 将订阅源和文章保存到本地 SQLite。
- 将本地订阅源导出为包含 `text`、`title`、`type`、`xmlUrl` 和清洗后 `htmlUrl` 的 OPML 2.0 文件。
- 刷新单个订阅源时继续使用 `feed.url` 同步新增或更新的文章元数据。

## 正文衔接契约

当前阶段不会根据 `article.url` 抓取原网页 HTML，也不会执行正文清洗。后续正文 pipeline 可以按以下顺序接入：

`article.url -> raw_html -> cleaned_html -> cleaned_markdown -> 阅读区渲染 cleaned_html`

文章表已预留这些字段：

- `raw_html`：后续根据 `article.url` 抓到的原始页面 HTML。
- `cleaned_html`：后续清洗后的可阅读 HTML，阅读区会优先渲染它。
- `cleaned_markdown`：由 cleaned HTML 转出的 Markdown。
- `content_fetched_at`：正文抓取时间。
- `content_fetch_status`：正文抓取或清洗状态，默认 `pending`。
- `content_fetch_error`：抓取或清洗失败时的错误信息。
- `final_url`：处理重定向后的真实文章 URL。

阅读区只做展示，不主动抓取原文。展示优先级为：

`cleaned_html > Feed content > Feed excerpt > 打开原文`

## 隐私边界

OPML 导入只会读取用户选择的本地 OPML 文件，并访问文件中列出的 Feed URL。导入结果保存到本地 SQLite，不上传到自建云端服务。

OPML 导出只会读取本地 SQLite 中的订阅源信息，并写入用户选择的本地文件路径，不上传到自建云端服务。

当前阶段不会根据文章 URL 主动抓取原网页正文。后续只有在实现正文抓取功能时，才会访问 `article.url`。

摘要和翻译仍然只在用户主动点击对应按钮时，才会把当前文章内容发送给用户配置的 LLM Provider。

## 手动验收步骤

1. 运行 `cd app/src-tauri && cargo check`，确认 Rust 后端编译通过。
2. 启动应用后，点击添加订阅源，输入一个真实 RSS / Atom / JSON Feed URL。
3. 再次添加同一个 URL，确认 Feed 列表不会重复创建订阅源，文章仍归属原订阅源。
4. 通过前端 OPML 导入口选择 `samples/opml/example.opml` 或本地 `feed.opml`。
5. 确认导入时侧边栏出现“正在导入 OPML...”状态。
6. 确认导入后 Feed 列表出现 OPML 中的多个订阅源，即使其中个别 Feed 暂时拉取失败也应保留订阅源。
7. 选择导入的 Feed，确认已同步的文章列表能显示对应内容，阅读区能渲染已有的 Feed 内容或清洗后的 HTML。
8. 确认文章数据中保留 `article.url`，后续正文抓取可以从该 URL 接入。
9. 点击单个 Feed 的刷新按钮，确认新增文章会同步到本地数据库。
10. 点击 OPML 导出入口，保存为 `.opml` 文件。
11. 用文本编辑器打开导出的文件，确认其中包含 XML 声明，以及本地订阅源的 `outline`、`type`、`xmlUrl`、`htmlUrl` 和 `title`。
