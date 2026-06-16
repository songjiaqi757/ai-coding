# Privacy

## Privacy Rules

- 用户无需注册登录。
- Feed、文章、摘要、翻译和设置由应用在本地管理。
- 应用不主动采集用户数据。
- 应用不依赖自建云端服务。
- OPML 导入只读取用户选择的本地 OPML 文件，并访问文件中列出的 URL；如果该 URL 是网页，应用会在该网页声明的 feed 链接和同站点常见 feed 路径中继续发现 RSS / Atom / JSON Feed。
- OPML 导出只读取本地 SQLite 中的订阅源信息，并写入用户选择的本地文件。
- 用户主动输入文章 URL 并点击抓取时，应用会访问该 URL 获取网页 HTML。
- 抓取到的 raw_html、cleaned_html、cleaned_markdown 默认保存到本地 SQLite。
- 用户创建的文章笔记、高亮文本、高亮颜色和高亮样式默认保存到本地 SQLite。
- Feed / OPML / 刷新阶段只访问用户添加或导入的 URL，以及由这些 URL 指向网页声明或同站点常见路径发现到的 Feed URL。
- 如果用户在系统中配置了网络代理，Feed / OPML / 刷新、网页抓取和 LLM Provider 请求会按系统代理设置发出；应用不自建代理或云端转发服务。
- 用户打开订阅文章时，应用会访问该文章 URL 获取网页 HTML，并在本地完成清洗后展示 cleaned_html。
- 文章原网页正文只在用户主动打开订阅文章、点击清洗或点击抓取时访问。

## LLM Usage

只有用户主动触发摘要或翻译时，文章内容才会发送到用户配置的 LLM Provider。

用户可以选择本地模型或兼容标准 API 的模型服务。

API key 仅保存在用户本地配置中，不会作为应用默认值内置到仓库或发布包中。
