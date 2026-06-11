import { useEffect, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Article, Feed, SyncStatus, SyncReport, SyncConfig } from "../types";

const LOCAL_ONLY_FEED_IDS = ["all", "favorites", "read-later", "saved"];
const SAVED_ARTICLES_FEED_URL = "mercury://saved-articles";

type Props = {
  feeds: Feed[];
  allArticleCount: number;
  allUnreadCount: number;
  favoriteCount: number;
  readLaterCount: number;
  selectedFeedId: string;
  syncStatus: SyncStatus | null;
  onSelectFeed: (id: string) => void;
  onFeedsChange: () => void;
  onSyncStatusChange: () => void;
};

export function Sidebar({
  feeds,
  allArticleCount,
  allUnreadCount,
  favoriteCount,
  readLaterCount,
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
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [showSyncConfig, setShowSyncConfig] = useState(false);
  const [syncConfig, setSyncConfig] = useState<SyncConfig>({
    enabled: false,
    intervalMinutes: 30,
    retryLimit: 3,
    nextSyncAt: null,
  });
  const [isSavingSyncConfig, setIsSavingSyncConfig] = useState(false);

  useEffect(() => {
    void loadSyncConfig();
  }, []);

  async function loadSyncConfig() {
    try {
      const config = await invoke<SyncConfig>("get_sync_config");
      setSyncConfig(config);
    } catch {
      // Config not available yet
    }
  }

  async function handleSaveSyncConfig() {
    setIsSavingSyncConfig(true);
    try {
      const updated = await invoke<SyncConfig>("update_sync_config", {
        enabled: syncConfig.enabled,
        intervalMinutes: syncConfig.intervalMinutes,
        retryLimit: syncConfig.retryLimit,
      });
      setSyncConfig(updated);
      setShowSyncConfig(false);
    } catch (error) {
      console.error("保存同步配置失败", error);
    } finally {
      setIsSavingSyncConfig(false);
    }
  }

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
    const feed = feeds.find((item) => item.id === feedId);
    if (isLocalOnlyFeed(feed)) {
      setRefreshError("Saved Articles 是本地列表，不会远程刷新。");
      return;
    }
    setRefreshingFeedId(feedId);
    setRefreshError(null);
    try {
      await invoke<Article[]>("refresh_feed", { feedId });
      onFeedsChange();
    } catch (error) {
      const message =
        typeof error === "string" || error instanceof Error
          ? error.toString()
          : "刷新失败";
      setRefreshError(message);
    } finally {
      setRefreshingFeedId(null);
    }
  }

  async function handleStartSync() {
    setIsSyncing(true);
    setSyncError(null);
    try {
      await invoke<SyncReport>("start_sync", { feedId: null });
      onSyncStatusChange();
      onFeedsChange();
    } catch (error) {
      const message =
        typeof error === "string" || error instanceof Error
          ? error.toString()
          : "同步失败";
      setSyncError(message);
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleRetryFailed() {
    setSyncError(null);
    try {
      await invoke<SyncReport>("retry_failed_syncs");
      onSyncStatusChange();
      onFeedsChange();
    } catch (error) {
      const message =
        typeof error === "string" || error instanceof Error
          ? error.toString()
          : "重试失败";
      setSyncError(message);
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

  const allFeed = {
    id: "all",
    title: "全部订阅",
    url: "",
    siteUrl: null,
    unread: allUnreadCount,
    total: allArticleCount,
    lastSyncAt: null,
  };
  const smartFeeds = [
    {
      id: "favorites",
      title: "Favorites",
      url: "",
      siteUrl: null,
      unread: favoriteCount,
      total: favoriteCount,
      lastSyncAt: null,
    },
    {
      id: "read-later",
      title: "Read Later",
      url: "",
      siteUrl: null,
      unread: readLaterCount,
      total: readLaterCount,
      lastSyncAt: null,
    },
  ];

  const failedCount = syncStatus?.failedFeeds.length ?? 0;
  const isRunning = syncStatus?.phase === "running" || isSyncing;

  function isLocalOnlyFeed(feed: Pick<Feed, "id" | "url"> | undefined) {
    if (!feed) return false;
    return LOCAL_ONLY_FEED_IDS.includes(feed.id) || feed.url === SAVED_ARTICLES_FEED_URL;
  }

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

        {(refreshError || syncError) && (
          <div className="sync-failed-bar">
            <span>{refreshError ?? syncError}</span>
          </div>
        )}

        {(opmlStatus || opmlError) && (
          <div className={opmlError ? "opml-status error" : "opml-status"}>
            {opmlError ?? opmlStatus}
          </div>
        )}

        <div className="feed-list">
          {[allFeed, ...smartFeeds, ...feeds].map((feed) => (
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
                {!isLocalOnlyFeed(feed) && (
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
                {feed.id === "all" ? (
                  <span className="badge badge-double" title={`未读 ${allFeed.unread} 篇，共 ${allFeed.total} 篇`}>
                    <span>{allFeed.unread}</span>
                    <span className="badge-divider">/</span>
                    <span>{allFeed.total}</span>
                  </span>
                ) : (
                  feed.unread > 0 && <span className="badge">{feed.unread}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-section sync-config-section">
        <div className="section-header">
          <div className="section-title">同步设置</div>
          <button
            className="icon-button"
            title="展开/收起"
            onClick={() => setShowSyncConfig(!showSyncConfig)}
          >
            {showSyncConfig ? "−" : "+"}
          </button>
        </div>
        {showSyncConfig && (
          <div className="sync-config-panel">
            <label className="sync-config-row">
              <span>自动同步</span>
              <input
                type="checkbox"
                checked={syncConfig.enabled}
                onChange={(e) =>
                  setSyncConfig((c) => ({ ...c, enabled: e.target.checked }))
                }
              />
            </label>
            <label className="sync-config-row">
              <span>间隔（分钟）</span>
              <input
                type="number"
                min={1}
                value={syncConfig.intervalMinutes}
                onChange={(e) =>
                  setSyncConfig((c) => ({
                    ...c,
                    intervalMinutes: Number(e.target.value) || 30,
                  }))
                }
                style={{ width: 60 }}
              />
            </label>
            <label className="sync-config-row">
              <span>最大重试次数</span>
              <input
                type="number"
                min={0}
                value={syncConfig.retryLimit}
                onChange={(e) =>
                  setSyncConfig((c) => ({
                    ...c,
                    retryLimit: Number(e.target.value) || 3,
                  }))
                }
                style={{ width: 60 }}
              />
            </label>
            <button
              className="primary-button"
              onClick={handleSaveSyncConfig}
              disabled={isSavingSyncConfig}
              style={{ marginTop: 8, width: "100%" }}
            >
              {isSavingSyncConfig ? "保存中..." : "保存配置"}
            </button>
          </div>
        )}
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
