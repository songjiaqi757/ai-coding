import { useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Article, Feed, SyncStatus, SyncReport } from "../types";

type Props = {
  feeds: Feed[];
  selectedFeedId: string;
  syncStatus: SyncStatus | null;
  onSelectFeed: (id: string) => void;
  onFeedsChange: () => void;
  onSyncStatusChange: () => void;
};

export function Sidebar({
  feeds,
  selectedFeedId,
  syncStatus,
  onSelectFeed,
  onFeedsChange,
  onSyncStatusChange,
}: Props) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [opmlStatus, setOpmlStatus] = useState<string | null>(null);
  const [opmlError, setOpmlError] = useState<string | null>(null);
  const [refreshingFeedId, setRefreshingFeedId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  async function handleAddFeed() {
    if (!addUrl.trim()) return;
    setIsAdding(true);
    setAddError(null);
    try {
      await invoke("add_feed", { url: addUrl.trim() });
      setAddUrl("");
      setShowAddDialog(false);
      onFeedsChange();
    } catch (error) {
      if (typeof error === "string" || error instanceof Error) {
        setAddError(error.toString());
      } else {
        setAddError("添加订阅失败");
      }
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRefreshFeed(feedId: string, event: MouseEvent) {
    event.stopPropagation();
    setRefreshingFeedId(feedId);
    try {
      await invoke<Article[]>("refresh_feed", { feedId });
      onFeedsChange();
    } catch (error) {
      console.error("刷新失败", error);
    } finally {
      setRefreshingFeedId(null);
    }
  }

  async function handleStartSync() {
    setIsSyncing(true);
    try {
      await invoke<SyncReport>("start_sync", { feedId: null });
      onSyncStatusChange();
      onFeedsChange();
    } catch (error) {
      console.error("同步失败", error);
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleRetryFailed() {
    try {
      await invoke<SyncReport>("retry_failed_syncs");
      onSyncStatusChange();
      onFeedsChange();
    } catch (error) {
      console.error("重试失败", error);
    }
  }

  async function handleImportOpml() {
    if (isImporting) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const filePath = await open({
        filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
      });
      if (!filePath || Array.isArray(filePath)) return;

      setIsImporting(true);
      setOpmlStatus("正在导入 OPML...");
      setOpmlError(null);

      const importedFeeds = await invoke<Feed[]>("import_opml", { filePath });
      setOpmlStatus(`已导入 ${importedFeeds.length} 个订阅源`);
      onFeedsChange();
    } catch (error) {
      const message =
        typeof error === "string" || error instanceof Error
          ? error.toString()
          : "导入 OPML 失败";
      setOpmlError(message);
      setOpmlStatus(null);
    } finally {
      setIsImporting(false);
    }
  }

  async function handleExportOpml() {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const filePath = await save({
        defaultPath: "mercury-subscriptions.opml",
        filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
      });
      if (!filePath) return;

      await invoke("export_opml", { filePath });
      setOpmlStatus("OPML 导出成功");
      setOpmlError(null);
    } catch {
      setOpmlError("导出 OPML 失败");
    }
  }

  const allFeed: Feed = {
    id: "all",
    title: "全部订阅",
    url: "",
    siteUrl: null,
    unread: feeds.reduce((sum, feed) => sum + feed.unread, 0),
    lastSyncAt: null,
  };

  const failedCount = syncStatus?.failedFeeds.length ?? 0;
  const isRunning = syncStatus?.phase === "running" || isSyncing;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">M</div>
        <div>
          <h1>Mercury</h1>
          <p>AI Reader</p>
        </div>
      </div>

      <section className="panel-section">
        <div className="section-header">
          <div className="section-title">订阅源</div>
          <div className="section-actions">
            <button
              className="icon-button"
              title="同步全部"
              onClick={handleStartSync}
              disabled={isRunning}
            >
              {isRunning ? "..." : "↻"}
            </button>
            <button
              className="icon-button"
              title="添加订阅"
              onClick={() => setShowAddDialog(true)}
            >
              +
            </button>
            <button
              className="icon-button"
              title={isImporting ? "正在导入 OPML" : "导入 OPML"}
              onClick={handleImportOpml}
              disabled={isImporting}
            >
              {isImporting ? "..." : "↑"}
            </button>
            <button
              className="icon-button"
              title="导出 OPML"
              onClick={handleExportOpml}
            >
              &#8595;
            </button>
          </div>
        </div>

        {isRunning && syncStatus && (
          <div className="sync-status-bar">
            同步中 ({syncStatus.completedFeeds}/{syncStatus.totalFeeds})
          </div>
        )}

        {failedCount > 0 && !isRunning && (
          <div className="sync-failed-bar">
            <span>{failedCount} 个订阅源同步失败</span>
            <button className="retry-button" onClick={handleRetryFailed}>
              重试
            </button>
          </div>
        )}

        {(opmlStatus || opmlError) && (
          <div className={opmlError ? "opml-status error" : "opml-status"}>
            {opmlError ?? opmlStatus}
          </div>
        )}

        <div className="feed-list">
          {[allFeed, ...feeds].map((feed) => (
            <div
              key={feed.id}
              className={
                feed.id === selectedFeedId ? "feed-item active" : "feed-item"
              }
            >
              <button
                className="feed-title"
                style={{
                  flex: 1,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
                onClick={() => onSelectFeed(feed.id)}
              >
                {feed.title}
              </button>
              <span className="feed-right">
                {feed.id !== "all" && (
                  <button
                    className={
                      refreshingFeedId === feed.id
                        ? "refresh-button refreshing"
                        : "refresh-button"
                    }
                    title="刷新"
                    onClick={(event) => handleRefreshFeed(feed.id, event)}
                  >
                    &#8635;
                  </button>
                )}
                {feed.unread > 0 && <span className="badge">{feed.unread}</span>}
              </span>
            </div>
          ))}
        </div>
      </section>

      {showAddDialog && (
        <div className="dialog-overlay" onClick={() => setShowAddDialog(false)}>
          <div className="dialog" onClick={(event) => event.stopPropagation()}>
            <h3>添加订阅源</h3>
            <input
              placeholder="输入 RSS/Atom 地址..."
              value={addUrl}
              onChange={(event) => setAddUrl(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void handleAddFeed()}
              autoFocus
            />
            {addError && <p className="error-text">{addError}</p>}
            <div className="dialog-actions">
              <button onClick={() => setShowAddDialog(false)}>取消</button>
              <button
                className="primary-button"
                onClick={() => void handleAddFeed()}
                disabled={isAdding}
              >
                {isAdding ? "添加中..." : "添加"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
