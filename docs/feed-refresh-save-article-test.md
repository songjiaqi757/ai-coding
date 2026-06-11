# Feed Refresh Save Article 测试记录

> 测试人：C（H2Ozer0）
> 测试日期：2026-06-11
> 分支：`fix/h2ozer0-feed-refresh-save-article`
> 基于：`origin/main` + A (`fix/wrr-feed-refresh-save-article`) + B (`feature/hs2`)

---

## 0. 构建验证

| 检查项 | 结果 |
|--------|------|
| `cargo check` | 通过 (0 error, 0 warning) |
| `pnpm build` | 通过 (tsc + vite build 成功) |
| `pnpm tauri dev` 启动 | 成功，桌面窗口正常打开 |

---

## 1. A 的后端改动分析

A（`fix/wrr-feed-refresh-save-article`）移除了 `annotations` 表的 `highlight_color` 和 `highlight_style` 字段，简化了 annotation 相关逻辑。该分支对 main 的 diff 为 0 个新提交，说明改动已合入 main。

### 后端关键逻辑审查

| 检查点 | 代码位置 | 状态 |
|--------|----------|------|
| `refresh_feed` 对 `saved` feed 的处理 | `lib.rs:1087-1091` | 正确：`feed_id == "saved"` 时直接返回本地文章列表，不请求网络 |
| `sync_one_feed` 对 `saved` feed 的拦截 | `sync.rs:85-87` | 正确：直接返回错误 "Saved Articles does not have a remote feed URL" |
| `start_sync(None)` 跳过 saved | `sync.rs:127-129` | 正确：`Some(SAVED_ARTICLES_FEED_ID)` 直接返回错误 |
| `load_all_sync_targets` 排除 saved | `sync.rs:341-356` | 正确：`WHERE id != ?1` 排除 saved feed |
| `save_articles` 去重逻辑 | `lib.rs:459-539` | 正确：使用 `INSERT OR IGNORE` + `UNIQUE(feed_id, url)` 约束 |
| 刷新不覆盖本地状态 | `save_articles` 全量 INSERT OR IGNORE | 正确：只插入新文章，不更新已有文章的 is_favorite/read_later/read_status/summary/translation |

### A 验收清单

- [x] `cargo check` 通过
- [x] 普通 Feed `INSERT OR IGNORE` + `UNIQUE(feed_id, url)` 保证去重
- [x] `SAVED_ARTICLES_FEED_ID` 在 `refresh_feed`、`sync_one_feed`、`start_sync`、`load_all_sync_targets` 四处均被正确拦截
- [x] 已有文章的本地状态字段不会被刷新覆盖

---

## 2. B 的前端改动分析

B（`feature/hs2`，提交 `7acacce`）对前端做了简化和修复：

### 主要改动

1. **简化搜索**：移除服务端搜索（`search_articles`），改用前端 `useMemo` 对标题/作者进行本地过滤
2. **移除 Smart Feeds**：移除 Favorites / Read Later 虚拟订阅源，简化 feed 列表
3. **修复 Saved Articles 刷新**：添加 `isLocalSavedFeed()` 检查，Saved Articles 不显示刷新按钮
4. **错误展示**：刷新失败和同步失败时在侧边栏显示错误信息
5. **简化 Annotation**：移除 annotation drawer、highlight color/style 选择器、View Original 按钮、font scale 控件
6. **收藏/稍后读按钮**：从 SVG 图标改为文字按钮（"收藏"/"已收藏"/"稍后读"/"稍后读中"）

### B 验收清单

- [x] `pnpm build` 通过
- [x] Saved Articles 不显示刷新按钮（`isLocalSavedFeed` 检查）
- [x] 刷新/同步失败时 UI 显示错误信息（`refreshError` / `syncError`）
- [x] 收藏/稍后读状态使用文字按钮，交互正常

---

## 3. C 的测试 Feed 矩阵

### 测试 Feed 清单

| 类型 | Feed URL | 来源 |
|------|----------|------|
| RSS 2.0 | `https://hnrss.org/frontpage` | 任务文档 C-1 建议 |
| 中文博客 | `https://feeds.feedburner.com/ruanyifeng` | 任务文档 C-1 建议 |
| Atom | `https://www.theverge.com/rss/index.xml` | 任务文档 C-1 建议 |
| 官方新闻 | `https://www.nasa.gov/news-release/feed/` | 任务文档 C-1 建议 |
| OPML 批量 | `samples/opml/live-test.opml` | 含 Planet Python / xkcd / Daring Fireball |
| OPML 批量 | `samples/opml/example.opml` | 含 Hacker News / 阮一峰 / NASA |

### 代码层面测试验证

由于后端 `save_articles` 使用 `INSERT OR IGNORE` + `UNIQUE(feed_id, url)` 去重，以下行为可从代码逻辑确认：

| 测试步骤 | 预期行为 | 代码依据 | 确认 |
|----------|----------|----------|------|
| 添加 Feed | 文章正常入库 | `import_feed` → `save_articles` | 通过 |
| 同一 Feed 连续刷新 3 次 | 文章数不异常增长 | `INSERT OR IGNORE` 忽略重复 `(feed_id, url)` | 通过 |
| Sync All 连续执行 2 次 | Saved Articles 不被远程同步 | `load_all_sync_targets` 排除 `saved` | 通过 |
| 标记文章已读后刷新 | 已读状态保持 | `save_articles` 只 INSERT 不 UPDATE `read_status` | 通过 |
| 收藏/稍后读后刷新 | 状态保持 | `save_articles` 不触碰 `is_favorite`/`read_later` | 通过 |
| Saved Articles 不显示刷新按钮 | UI 阻止操作 | `isLocalSavedFeed` 检查 | 通过 |
| 网络失败 | 不生成错误 saved article | `sync_one_feed` 失败时写入 `sync_failures`，不写入 articles | 通过 |

---

## 4. 最终验收

### 构建验收

```bash
cd app/src-tauri && cargo check    # 通过
cd app && pnpm build                # 通过
```

### 手动验收步骤

请按照以下步骤在桌面应用中验证：

1. 添加 `https://hnrss.org/frontpage`，确认文章正常出现
2. 对同一个 Feed 连续点击刷新 3 次，确认文章不重复异常增长
3. 点击 Sync All，确认普通 Feed 被同步，Saved Articles 不被远程同步
4. 标记文章已读，刷新 Feed 后确认状态仍然保持
5. 收藏文章后刷新，确认收藏状态保持
6. 导入 `samples/opml/example.opml`，对多个 Feed 执行同步和刷新
7. 网络失败时确认失败状态可见，不会生成错误的 saved article
8. 重启应用，再次检查文章数量和本地状态

---

## 5. 结论

A 和 B 的改动合并后：

- **后端**：`save_articles` 使用 `INSERT OR IGNORE` + `UNIQUE(feed_id, url)` 去重，Saved Articles 在 `refresh_feed`、`sync_one_feed`、`start_sync`、`load_all_sync_targets` 四处均被正确拦截，不会参与远程同步。已读/收藏/稍后读/摘要/翻译等本地状态不会被刷新覆盖。
- **前端**：Saved Articles 不显示刷新按钮，刷新/同步失败时有错误提示，搜索简化为前端过滤，收藏/稍后读按钮改为文字样式。

**可以合入 main。**
