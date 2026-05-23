# AGENTS.md

## Role of AI Coding Agent

AI 负责代码生成、重构、测试补充和文档草稿。
人类负责需求判断、架构决策、代码审查和最终验收。

## Architecture Rules

- UI 不直接操作数据库和文件系统，必须通过 Tauri commands。
- 用户数据默认保存在本地 SQLite。
- Feed、Article、LLM Provider、Agent 必须模块化。
- LLM 调用必须经过统一 Provider 接口，禁止在业务代码里绑定单一模型厂商。
- 内容清洗 pipeline 必须清晰：raw_html -> cleaned_html -> cleaned_markdown。
- Summary Agent 和 Translation Agent 不直接关心具体模型厂商。

## Privacy Rules

- 不实现注册登录。
- 不自建云端服务器。
- 不主动上传用户数据。
- 只有用户主动点击摘要或翻译时，才允许把文章内容发送到用户配置的 LLM Provider。
- API key 只能保存在本地配置中，禁止提交到 GitHub。

## Coding Rules

- TypeScript 开启 strict。
- Rust 代码必须能通过 cargo check。
- 新功能必须提供手动验收步骤。
- 涉及架构、隐私、数据结构的修改必须同步更新 docs。
