# INIT.md

## Project Name

BookiBuddy - AI Reader

## Project Goal

构建一个跨平台、模型中立的 AI 阅读器。

## Must-have Features

1. Feed / OPML 解析、本地刷新同步、内容呈现
2. Cleaned HTML、Cleaned Markdown、定制阅读样式
3. Summary Agent + LLM Providers
4. Translation Agent

## Technical Constraints

1. 产品体验：界面简洁，阅读体验清晰
2. 隐私保护：无需注册登录，不主动采集用户数据
3. 平台中立：一份代码支持 Windows / Linux / macOS
4. 大模型中立：支持本地模型和标准 API 模型服务

## Out of Scope for MVP

- 不做云端 Web 部署
- 不做账号系统
- 不做 macOS native 专用版本
- 暂不做标签系统、笔记导出、用量统计、日志上报
