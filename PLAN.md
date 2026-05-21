# PLAN.md

## Phase 0 - Scaffold

Goal: 初始化项目文档和跨平台桌面应用脚手架。

Tasks:
- 创建 INIT.md、AGENTS.md、PLAN.md
- 初始化 Tauri + React + TypeScript 应用
- 确认应用能本地运行

Verification:
- pnpm tauri dev 能打开桌面窗口
- 文档已提交到 GitHub

## Phase 1 - Local Data and Reader Shell

Goal: 完成三栏阅读器 UI 和 SQLite 本地数据基础。

Tasks:
- Feed 列表
- Article 列表
- Reader 面板
- SQLite 初始化
- 本地 settings

## Phase 2 - Feed / OPML / Sync

Goal: 完成 Feed 添加、OPML 导入导出、订阅源刷新。

## Phase 3 - Content Cleaning

Goal: 完成 Cleaned HTML、Cleaned Markdown 和阅读样式。

## Phase 4 - LLM Provider

Goal: 完成模型中立的 LLM Provider 接口。

## Phase 5 - Summary Agent

Goal: 完成文章摘要功能。

## Phase 6 - Translation Agent

Goal: 完成文章翻译功能。

## Phase 7 - Packaging and Demo

Goal: 完成 Windows / Linux 打包、README、隐私说明和演示。
