# INIT.md

## Project Name

BookiBuddy - AI Reader

## Project Goal

构建一个跨平台、本地优先、模型中立的 AI 阅读器。

BookiBuddy 面向 RSS / Atom / JSON Feed 阅读场景，提供订阅源管理、OPML 导入导出、文章同步、正文清洗、批注、AI 摘要和 AI 翻译能力。

## Must-have Features

1. Feed / OPML 解析、本地刷新同步、内容呈现
2. Cleaned HTML、Cleaned Markdown、定制阅读样式
3. Summary Agent + LLM Providers
4. Translation Agent
5. 本地已读状态、收藏、批注和搜索
6. 自动同步配置与失败重试

## Technical Constraints

1. 产品体验：界面简洁，阅读体验清晰
2. 隐私保护：无需注册登录，不主动采集用户数据
3. 平台中立：一份代码支持 Windows / Linux / macOS
4. 大模型中立：支持本地模型和标准 API 模型服务
5. 架构边界：UI 必须通过 Tauri commands 访问数据库和文件系统
6. 内容清洗：保持 `raw_html -> cleaned_html -> cleaned_markdown` pipeline 清晰

## Out of Scope for MVP

- 不做云端 Web 部署
- 不做账号系统
- 不做 macOS native 专用版本
- 暂不做标签系统、笔记导出、用量统计、日志上报

## Current Status

MVP 主链路已经接通：

- Feed / OPML / Sync 已实现；
- 本地 SQLite 数据结构已覆盖订阅源、文章、设置、同步失败记录和批注；
- 文章正文清洗已实现，并包含目标网站占位页 fallback；
- Summary Agent 和 Translation Agent 已接入统一 LLM Provider；
- API Key 已改为保存到系统凭据库；
- README 已更新为当前项目总览。
