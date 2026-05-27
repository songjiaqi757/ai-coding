# Feed / OPML 导入说明

## 功能范围

当前 Phase 2 集成了 OPML 导入后端：

- 解析 OPML 2.0 文件中的嵌套 `outline`
- 提取带有 `xmlUrl` 的订阅源
- 拉取 RSS / Atom Feed
- 将订阅源和文章保存到本地 SQLite
- 已存在的 Feed URL 会直接返回本地记录，避免重复导入

示例文件位于 `samples/opml/example.opml`。

## 隐私边界

OPML 导入只会读取用户选择的本地 OPML 文件，并访问文件中列出的 Feed URL。导入结果保存到本地 SQLite，不上传到自建云端服务。

摘要和翻译仍然只在用户主动点击对应按钮时，才会把当前文章内容发送给用户配置的 LLM Provider。

## 手动验收步骤

1. 运行 `cd app/src-tauri && cargo check`，确认 Rust 后端编译通过。
2. 启动应用后，通过前端 OPML 导入口选择 `samples/opml/example.opml`。
3. 确认导入后 Feed 列表出现多个订阅源。
4. 选择导入的 Feed，确认文章列表和阅读区能显示对应内容。
5. 再次导入同一个 OPML，确认不会重复创建相同 URL 的订阅源。
