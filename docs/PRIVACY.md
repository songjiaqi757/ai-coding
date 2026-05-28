# Privacy

## Privacy Rules

- 用户无需注册登录。
- Feed、文章、摘要、翻译和设置由应用在本地管理。
- 应用不主动采集用户数据。
- 应用不依赖自建云端服务。
- OPML 导入只读取用户选择的本地 OPML 文件，并访问文件中列出的 Feed URL。
- OPML 导出只读取本地 SQLite 中的订阅源信息，并写入用户选择的本地文件。
- 用户主动输入文章 URL 并点击抓取时，应用会访问该 URL 获取网页 HTML。
- 抓取到的 raw_html、cleaned_html、cleaned_markdown 默认保存到本地 SQLite。
- Feed / OPML / 刷新阶段只访问用户添加或导入的 Feed URL；文章原网页正文只在用户主动点击清洗或抓取时访问。

## LLM Usage

只有用户主动触发摘要或翻译时，文章内容才会发送到用户配置的 LLM Provider。

用户可以选择本地模型或兼容标准 API 的模型服务。
