# 刷新订阅源 Save Article 问题分工指南

> **适用人员**：A、B、C 三位成员
>
> **任务目标**：修复“刷新订阅源后出现新的 save article 问题”，并尽量多测试真实 Feed。
>
> **核心原则**：后端先定位数据问题，前端验证状态展示，C 负责多 Feed 回归和最终验收。

---

## 0. 快速开始

1. `git checkout main && git pull origin main`
2. `git checkout -b fix/你的名字-feed-refresh-save-article`
3. 阅读本文档中属于自己的章节
4. 先复现问题，再修改代码或补充测试记录
5. 完成后运行对应验收命令，并把结果交给 C 汇总

---

## 1. 分工总览

| 成员 | 角色 | 主要负责文件 | 不能随便改 |
|---|---|---|---|
| **A** | Rust 后端问题定位 | `app/src-tauri/src/lib.rs`、`app/src-tauri/src/sync.rs` | `app/src/` |
| **B** | 前端复现与状态验证 | `app/src/App.tsx`、`app/src/components/Sidebar.tsx`、`app/src/components/ArticleList.tsx`、`app/src/types.ts` | `src-tauri/` |
| **C** | 多 Feed 测试 + 文档验收 | `samples/opml/`、`docs/`、测试记录 | 业务代码只读，除非修文档 |

> **冲突预防规则**
> - A 只改刷新、同步、文章入库相关后端逻辑。
> - B 只改 UI 复现、状态展示和刷新后的前端状态处理。
> - C 不直接抢修业务代码，除非 A/B 确认需要协助。

---

## 2. 问题范围

当前项目已经包含 Feed、Sync、Saved Articles、本地阅读状态、收藏、稍后读、摘要翻译和内容清洗能力。

本次问题里的 “save article” 需要重点区分三类逻辑：

- 普通 Feed 文章入库：`save_articles()`，当前主要依赖 `UNIQUE(feed_id, url)` 去重。
- 单 Feed 刷新：`refresh_feed(feed_id)`，普通 Feed 会调用 `sync::sync_one_feed()`。
- 本地保存文章 Feed：`SAVED_ARTICLES_FEED_ID = "saved"`，它是本地虚拟订阅源，不应该被远程刷新或同步污染。

重点排查方向：

- 刷新普通订阅源后，是否错误新增了 `Saved Articles` 里的文章。
- 同一篇文章刷新后是否重复插入。
- `is_favorite`、`read_later`、`read_status`、`summary`、`translation` 等本地状态是否被刷新覆盖。
- `start_sync(None)` 是否始终跳过 `saved` 本地 Feed。
- 前端刷新后是否因为重新 `list_articles` 导致选中状态或文章状态看起来变成“新保存文章”。

---

## 3. Person A 专属指南：Rust 后端修复

**负责文件**：

- `app/src-tauri/src/lib.rs`
- `app/src-tauri/src/sync.rs`

**目标**：

- 定位刷新后新增 save article 的根因。
- 保证普通 Feed 刷新只更新对应远程 Feed。
- 保证 `Saved Articles` 本地 Feed 永远不参与远程 sync。
- 保证刷新不会覆盖用户本地状态字段。

### A-1. 重点检查点

- `save_articles()` 的去重逻辑是否稳定。
- `select_article_url()` 是否对不同 Feed 生成稳定 URL。
- `refresh_feed(feed_id)` 遇到 `feed_id == "saved"` 时是否只返回本地文章，不请求网络。
- `sync::start_sync(None)` 是否跳过 `SAVED_ARTICLES_FEED_ID`。
- `fetch_and_clean_article()` 保存到 `saved` Feed 时，是否可能和普通 Feed 文章混淆。
- `INSERT OR IGNORE` 是否保护了 `is_favorite/read_later/read_status/summary/translation`。

### A-2. 后端验收清单

- [ ] `cd app/src-tauri && cargo check` 通过
- [ ] 普通 Feed 连续刷新 3 次，文章数不异常增长
- [ ] Saved Articles 不会被 Sync All 远程刷新
- [ ] 已收藏、稍后读、已读状态刷新后不丢
- [ ] 同一 URL 的已保存文章不会被重复插入到 Saved Articles
- [ ] 如果涉及数据结构或隐私边界，更新 `docs/`

---

## 4. Person B 专属指南：前端复现与状态验证

**负责文件**：

- `app/src/App.tsx`
- `app/src/components/Sidebar.tsx`
- `app/src/components/ArticleList.tsx`
- `app/src/types.ts`

**目标**：

- 从 UI 侧稳定复现 bug。
- 确认刷新按钮、同步全部按钮、文章列表状态展示没有误导。
- 确认刷新后前端没有把旧状态覆盖成“新文章状态”。

### B-1. 重点检查点

- 点击单个 Feed 刷新按钮后，`onFeedsChange()` 是否正确重新加载当前 Feed。
- `loadData(feedId, readFilter)` 是否保持当前筛选条件。
- 文章刷新后 `selectedArticleId` 是否稳定。
- `readFilter` 为 `all/unread/read` 时，刷新后的文章数量是否正确。
- 如果后续有收藏/稍后读按钮，确认 `isFavorite/readLater` 的 UI 状态刷新后不丢。

### B-2. 前端验收清单

- [ ] `cd app && pnpm build` 通过
- [ ] 单个 Feed 刷新后文章列表不重复
- [ ] Sync All 后当前 Feed 列表不乱跳
- [ ] 已读/未读状态刷新后保持
- [ ] Saved Articles 不显示远程刷新按钮，或点击后不会触发远程同步
- [ ] 网络失败时 UI 不误显示“新增保存文章”

---

## 5. Person C 专属指南：多 Feed 测试与最终验收

**负责文件**：

- `samples/opml/`
- `docs/SYNC_AND_READ_STATUS.md`
- `docs/FEED_OPML.md`
- 可新增测试记录文档，例如 `docs/feed-refresh-save-article-test.md`

**目标**：

- 尽量多测试 Feed。
- 记录哪些 Feed 会触发重复文章、URL 不稳定、guid 不稳定、无 content 等问题。
- 最终判断是否可以合入。

### C-1. 建议测试 Feed

| 类型 | Feed |
|---|---|
| RSS 2.0 | `https://hnrss.org/frontpage` |
| 中文博客 | `https://feeds.feedburner.com/ruanyifeng` |
| Atom | `https://www.theverge.com/rss/index.xml` |
| 官方新闻 | `https://www.nasa.gov/news-release/feed/` |
| OPML 批量 | `samples/opml/example.opml`、`samples/opml/live-test.opml` |

### C-2. 每个 Feed 测试步骤

- [ ] 添加 Feed
- [ ] 首次拉取文章
- [ ] 单 Feed 连续刷新 3 次
- [ ] Sync All 连续执行 2 次
- [ ] 标记文章已读后刷新
- [ ] 设置 favorite/readLater 后刷新，如果 UI 有入口
- [ ] 检查 Saved Articles 是否被错误新增
- [ ] 重启应用后再次检查状态

### C-3. 最终交付

- [ ] 测试 Feed 清单
- [ ] 每个 Feed 的刷新结果
- [ ] 是否复现 save article 问题
- [ ] 失败 Feed 的错误信息
- [ ] 最终手动验收步骤

---

## 6. 推荐执行顺序

```text
Step 1: A 先定位 lib.rs 和 sync.rs 的刷新/入库逻辑
Step 2: B 同步从 UI 复现问题，记录具体按钮路径
Step 3: C 准备 Feed 测试矩阵，先在修复前跑一轮
Step 4: A 修复后，B 做前端回归
Step 5: C 用多 Feed 做最终验收，并补 docs
```

---

## 7. 最终验收命令

```bash
cd app
pnpm build
```

```bash
cd app/src-tauri
cargo check
```

---

## 8. 手动验收重点

1. 添加 `https://hnrss.org/frontpage`，确认文章正常出现。
2. 对同一个 Feed 连续点击刷新 3 次，确认文章不重复异常增长。
3. 点击 Sync All，确认普通 Feed 被同步，Saved Articles 不被远程同步。
4. 标记文章已读，刷新 Feed 后确认状态仍然保持。
5. 如果文章已加入 favorite/readLater，刷新后确认状态仍然保持。
6. 导入 `samples/opml/example.opml`，对多个 Feed 执行同步和刷新。
7. 网络失败时确认失败状态可见，不会生成错误的 saved article。
8. 重启应用，再次检查文章数量和本地状态。

