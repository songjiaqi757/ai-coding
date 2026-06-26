# PLAN.md

## Phase 0 - Scaffold

Goal: 初始化项目文档和跨平台桌面应用脚手架。

Tasks:
- 创建 INIT.md、AGENTS.md、PLAN.md
- 初始化 Tauri + React + TypeScript 应用
- 确认应用能本地运行

Verification:
- npm run tauri dev 能打开桌面窗口
- 文档已提交到 GitHub

Status: Done

## Phase 1 - Local Data and Reader Shell

Goal: 完成三栏阅读器 UI 和 SQLite 本地数据基础。

Tasks:
- Feed 列表
- Article 列表
- Reader 面板
- SQLite 初始化
- 本地 settings

Status: Done

## Phase 2 - Feed / OPML / Sync

Goal: 完成 Feed 添加、OPML 导入导出、订阅源刷新。

Tasks:
- 添加单个订阅源
- OPML 导入导出
- Feed 自动发现
- Sync All
- 自动同步配置
- 失败记录和重试

Status: Done

## Phase 3 - Content Cleaning

Goal: 完成 Cleaned HTML、Cleaned Markdown 和阅读样式。

Tasks:
- 抓取文章 HTML
- Readability / DOMPurify / Turndown 清洗
- Rust fallback 清洗
- 目标网站占位页检测
- Saved Articles 本地保存

Status: Done

## Phase 4 - LLM Provider

Goal: 完成模型中立的 LLM Provider 接口。

Tasks:
- OpenAI-compatible Provider
- 摘要和翻译独立配置
- API Key 系统凭据库存储
- 本地非敏感 settings 持久化

Status: Done

## Phase 5 - Summary Agent

Goal: 完成文章摘要功能。

Tasks:
- 摘要生成
- 多语言摘要目标
- 本地缓存
- 重新生成

Status: Done

## Phase 6 - Translation Agent

Goal: 完成文章翻译功能。

Tasks:
- 结构化分段翻译
- 翻译结果缓存
- 原文 / 对照翻译视图
- 划词翻译

Status: Done

## Phase 6.5 - Reading Workflow

Goal: 完成阅读状态、收藏、批注和搜索体验。

Tasks:
- 已读 / 未读筛选
- 长文章滚动自动已读
- 短文章停留自动已读
- 收藏智能视图
- 高亮和笔记批注
- 搜索正文和批注

Status: Done

## Phase 7 - Packaging and Demo

Goal: 完成跨平台打包、README、隐私说明和演示。

Tasks:
- macOS / Windows / Linux 构建工作流
- README 总览重构
- 隐私说明更新
- 演示材料准备

Status: In Progress
