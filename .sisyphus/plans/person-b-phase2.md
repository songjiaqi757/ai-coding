# Person B — Phase 2 前端开发计划

> **角色**: Person B（前端 UI）
> **任务**: 实现添加 Feed、OPML 导入、刷新订阅的完整 UI 交互
> **权限范围**: 只能改 `app/src/` 下的文件，可新建组件文件，不能动 `src-tauri/`
> **策略**: mock 数据先行，独立开发，不依赖 Person A

---

## 0. 前置：环境配置

### 0.1 确认已有工具
| 工具 | 版本要求 | 状态 |
|---|---|---|
| Node.js | >= 18 | 待确认（`node --version`） |
| pnpm | >= 8 | 待确认（`pnpm --version`） |
| Git | 任意 | 待确认（`git --version`） |
| VS Code | 任意 | 已有 |

> **如果 pnpm 未安装**：执行 `npm install -g pnpm`

### 0.2 安装项目依赖
```bash
cd "D:\text python\ai-coding-main\ai-coding-main\app"
pnpm install
```

### 0.3 验证前端能独立运行（不依赖 Tauri / Rust）

**关键问题**：当前 `App.tsx` 调用了 `invoke()`（Tauri 后端 API），在纯 Vite dev server 下会报错。

**解决方案**：Phase 2 代码直接用 mock 数据模式（phase2-tasks.md B-3 节已说明），用 `try/catch` 包裹 `invoke` 调用，catch 到错误时回退到 mock 数据。

---

## 1. Git 分支设置

```bash
cd "D:\text python\ai-coding-main\ai-coding-main"
git checkout -b feature/PersonB-phase2
```

> 完成后推送到远程：`git push -u origin feature/PersonB-phase2`

---

## 2. 安装前端新依赖

Phase 2 Sidebar 组件用到了 `@tauri-apps/plugin-dialog`（文件选择对话框）：

```bash
cd "D:\text python\ai-coding-main\ai-coding-main\app"
pnpm add @tauri-apps/plugin-dialog@^2
```

---

## 3. 实现步骤

### Task 1: 新建类型文件 `src/types.ts`

**文件**: `app/src/types.ts`
**参考**: phase2-tasks.md §2.3

```typescript
export type Feed = {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  unread: number;
  lastSyncAt: string | null;
};

export type Article = {
  id: string;
  feedId: string;
  title: string;
  url: string;
  author: string | null;
  publishedAt: string | null;
  excerpt: string;
  content: string;
};
```

**验收**: `pnpm build` 零 TypeScript 错误。

---

### Task 2: 拆分组件 — 新建 `src/components/` 目录

创建目录结构：
```
app/src/components/
  Sidebar.tsx
  ArticleList.tsx
```

---

### Task 3: 实现 `Sidebar.tsx`

**文件**: `app/src/components/Sidebar.tsx`
**参考**: phase2-tasks.md §B-4

**功能清单**:
- [ ] Feed 列表渲染（含 "All Feeds" 入口）
- [ ] 未读数 badge
- [ ] 点击选中 Feed
- [ ] "+" 按钮 → 弹出添加 Feed 对话框
- [ ] "↑" 按钮 → 弹出 OPML 文件选择（mock 阶段仅触发 console.log）
- [ ] Feed 项 hover 显示刷新按钮（mock 阶段仅触发 console.log）
- [ ] 添加 Feed 对话框（输入 URL + Enter / 点击添加）

**Mock 策略**: `invoke("add_feed")` 和 `invoke("refresh_feed")` 用 `try/catch` 包裹，catch 到 "Tauri is not available" 时打印 mock 成功消息并模拟 `onFeedsChange()`。

---

### Task 4: 实现 `ArticleList.tsx`

**文件**: `app/src/components/ArticleList.tsx`
**参考**: phase2-tasks.md §B-5

**功能清单**:
- [ ] 文章卡片列表渲染
- [ ] 文章元信息（作者、日期）
- [ ] 点击选中文章
- [ ] 空状态提示
- [ ] 加载状态提示

---

### Task 5: 重写 `App.tsx`

**文件**: `app/src/App.tsx`
**参考**: phase2-tasks.md §B-6

**变更内容**:
- 删除内联的 `type Feed` / `type Article`（改用 `import` from `./types`）
- 删除内联的 Sidebar 渲染（改用 `<Sidebar />` 组件）
- 删除内联的 ArticleList 渲染（改用 `<ArticleList />` 组件）
- 保留 Reader 阅读区（内联在 App.tsx 中）
- Mock 数据：当 `invoke()` 不可用时，用 phase2-tasks.md §B-3 的 `MOCK_FEEDS` / `MOCK_ARTICLES`
- 删除 "MVP Status" 底部面板（Phase 2 不再需要）

---

### Task 6: 补充 CSS

**文件**: `app/src/App.css`
**参考**: phase2-tasks.md §B-8

在文件末尾追加 Phase 2 新增样式：
- `.section-header`, `.section-actions`
- `.icon-button`, `.feed-right`, `.refresh-button`
- `.dialog-overlay`, `.dialog`, `.dialog-actions`
- `.error-text`, `.empty-state`

---

## 4. 开发、验证流程

### 4.1 纯前端开发模式

因无 Rust 环境，**不用 `pnpm tauri dev`**。改用 Vite dev server：

```bash
cd "D:\text python\ai-coding-main\ai-coding-main\app"
pnpm dev
```

浏览器打开 `http://localhost:1420`（或 Vite 输出的地址）。

### 4.2 Mock 数据回退方案

`App.tsx` 中 `loadData()` 改为：

```typescript
async function loadData() {
  try {
    const [nextFeeds, nextArticles] = await Promise.all([
      invoke<Feed[]>("list_feeds"),
      invoke<Article[]>("list_articles", { feedId: null }),
    ]);
    setFeeds(nextFeeds);
    setArticles(nextArticles);
  } catch {
    // 纯前端开发时 Tauri invoke 不可用，回退到 mock
    setFeeds(MOCK_FEEDS);
    setArticles(MOCK_ARTICLES);
  } finally {
    setIsLoading(false);
  }
}
```

同理，`Sidebar.tsx` 中的 `handleAddFeed`、`handleRefreshFeed`、`handleImportOpml` 全部 `try/catch`，catch 中模拟成功。

### 4.3 TypeScript 编译验证

```bash
pnpm build
```

必须零错误。

---

## 5. 验收清单

### 5.1 开发环境验证
- [ ] `pnpm install` 成功
- [ ] `pnpm dev` 启动，浏览器能看到三栏布局
- [ ] `pnpm build` 零 TypeScript 错误

### 5.2 UI 功能验证（mock 数据）
- [ ] 左侧显示 Feed 列表（含 All Feeds + mock 的订阅源）
- [ ] 点击 "+" 弹出添加对话框，输入 URL 后点击添加 → 有反馈
- [ ] 点击 "↑" 弹出文件选择对话框（Tauri 环境下）/ 打印日志（Vite 环境下）
- [ ] Feed 项 hover 显示刷新按钮
- [ ] 切换 Feed → 中间文章列表正确过滤
- [ ] 选中文章 → 右侧阅读区展示内容
- [ ] 未读数 badge 正确显示

### 5.3 代码规范
- [ ] 所有组件使用 `types.ts` 导出的类型
- [ ] 无 `any` 类型
- [ ] 组件文件放在 `components/` 下
- [ ] 未修改 `src-tauri/` 任何文件

---

## 6. 与 Person A 的交接

### Person B → Person A（需要 A 配合的事项）
1. 在 `lib.rs` 的 `run()` 里加 `.plugin(tauri_plugin_dialog::init())`
2. 在 `Cargo.toml` 里加 `tauri-plugin-dialog = "2"`
3. `list_articles` 命令参数 `feed_id` 接受 `Option<String>`

### 集成时（Person C 负责合并）
- Person A 分支合并到 main
- Person B 分支合并到 main
- 将 mock 数据替换为真实 `invoke` 调用（大部分已就绪，只需移除 catch 中的 mock 回退）

---

## 7. 文件变更清单

| 操作 | 文件路径 | 说明 |
|---|---|---|
| 新建 | `app/src/types.ts` | TypeScript 类型定义 |
| 新建 | `app/src/components/Sidebar.tsx` | Feed 列表 + 添加/导入/刷新 |
| 新建 | `app/src/components/ArticleList.tsx` | 文章列表 |
| 修改 | `app/src/App.tsx` | 重写为组件拼装 + mock 回退 |
| 修改 | `app/src/App.css` | 追加 Phase 2 样式 |
| 修改 | `app/package.json` | 加 `@tauri-apps/plugin-dialog` |

---

## 8. 时间估算

| 步骤 | 预计耗时 |
|---|---|
| 环境配置 + 依赖安装 | 15 分钟 |
| Task 1: types.ts | 5 分钟 |
| Task 2: 组件目录 | 2 分钟 |
| Task 3: Sidebar.tsx | 30 分钟 |
| Task 4: ArticleList.tsx | 15 分钟 |
| Task 5: 重写 App.tsx | 20 分钟 |
| Task 6: CSS 补充 | 10 分钟 |
| 验收 + Git 提交 | 15 分钟 |
| **总计** | **约 1.5 小时** |
