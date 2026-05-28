# Privacy

## Privacy Rules

- 用户无需注册登录。
- Feed、文章、摘要、翻译和设置由应用进行管理。
- 应用不主动采集用户数据。
- 应用不依赖自建云端服务。
- 用户主动输入文章 URL 并点击抓取时，应用会访问该 URL 获取网页 HTML。
- 抓取到的 raw_html、cleaned_html、cleaned_markdown 默认保存到本地 SQLite。

## LLM Usage

只有用户主动触发摘要或翻译时，文章内容才会发送到用户配置的 LLM Provider。
用户可以选择本地模型或兼容标准 API 的模型服务。
