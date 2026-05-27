# Feed / OPML 说明

## 功能范围

当前 Phase 2 集成了 Feed 添加、OPML 导入导出和订阅源刷新：

- 添加单个 RSS / Atom / JSON Feed URL。
- 重复添加相同 Feed URL 时复用本地已有订阅源，不创建孤立文章。
- 解析 OPML 2.0 文件中的嵌套 `outline`。
- 提取带有 `xmlUrl` 的订阅源并拉取 RSS / Atom Feed。
- 将订阅源和文章保存到本地 SQLite。
- 将本地订阅源导出为 OPML 2.0 文件。
- 刷新单个订阅源并同步新增文章。

示例文件位于 `samples/opml/example.opml`。

## 隐私边界

OPML 导入只会读取用户选择的本地 OPML 文件，并访问文件中列出的 Feed URL。导入结果保存到本地 SQLite，不上传到自建云端服务。

OPML 导出只会读取本地 SQLite 中的订阅源信息，并写入用户选择的本地文件路径，不上传到自建云端服务。

摘要和翻译仍然只在用户主动点击对应按钮时，才会把当前文章内容发送给用户配置的 LLM Provider。

## 手动验收步骤

1. 运行 `cd app/src-tauri && cargo check`，确认 Rust 后端编译通过。
2. 启动应用后，点击添加订阅源，输入一个真实 RSS / Atom / JSON Feed URL。
3. 再次添加同一个 URL，确认 Feed 列表不会重复创建订阅源，文章仍归属原订阅源。
4. 通过前端 OPML 导入口选择 `samples/opml/example.opml`。
5. 确认导入后 Feed 列表出现多个订阅源。
6. 选择导入的 Feed，确认文章列表和阅读区能显示对应内容。
7. 点击单个 Feed 的刷新按钮，确认新增文章会同步到本地数据库。
8. 点击 OPML 导出入口，保存为 `.opml` 文件。
9. 用文本编辑器打开导出的文件，确认其中包含本地订阅源的 `outline` 和 `xmlUrl`。
