import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Article, Feed, SyncStatus, SyncReport, SyncConfig, AppLanguage, OpmlImportReport } from "../types";
import bookiBuddyLogo from "../../src-tauri/icons/128x128.png";

const LOCAL_ONLY_FEED_IDS = ["all", "favorites", "read-later", "saved"];
const SAVED_ARTICLES_FEED_URL = "bookibuddy://internal/captured-articles";

type Props = {
  feeds: Feed[];
  allArticleCount: number;
  allUnreadCount: number;
  favoriteCount: number;
  favoriteUnreadCount: number;
  appLanguage: AppLanguage;
  selectedFeedId: string;
  syncStatus: SyncStatus | null;
  searchQuery: string;
  isSearching: boolean;
  onSelectFeed: (id: string) => void;
  onFeedsChange: () => void;
  onSyncStatusChange: () => void;
  onSearchQueryChange: (query: string) => void;
  onSearch: (event?: FormEvent<HTMLFormElement>) => void;
  onClearSearch: () => void;
};

export function Sidebar({
  feeds,
  allArticleCount,
  allUnreadCount,
  favoriteCount,
  favoriteUnreadCount,
  appLanguage,
  selectedFeedId,
  syncStatus,
  searchQuery,
  isSearching,
  onSelectFeed,
  onFeedsChange,
  onSyncStatusChange,
  onSearchQueryChange,
  onSearch,
  onClearSearch,
}: Props) {
  const isZh = appLanguage === "zh";
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
      console.error(isZh ? "保存同步配置失败" : "Failed to save sync config", error);
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
        setAddError(isZh ? "添加订阅失败" : "Failed to add subscription");
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
          : isZh
            ? "刷新失败"
            : "Refresh failed";
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
          : isZh
            ? "同步失败"
            : "Sync failed";
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
          : isZh
            ? "重试失败"
            : "Retry failed";
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
      setOpmlStatus(isZh ? "正在导入 OPML..." : "Importing OPML...");
      setOpmlError(null);

      const report = await invoke<OpmlImportReport>("import_opml", { filePath });
      const importedCount = report.importedFeeds.length;
      const failedCount = report.failedFeeds.length;
      const firstFailure = report.failedFeeds[0];
      const successMessage = isZh
        ? `已导入 ${importedCount} 个订阅源`
        : `Imported ${importedCount} subscriptions`;
      const partialMessage =
        failedCount > 0
          ? isZh
            ? `，${failedCount} 个失败${firstFailure ? `：${firstFailure.url} - ${firstFailure.error}` : ""}`
            : `, ${failedCount} failed${firstFailure ? `: ${firstFailure.url} - ${firstFailure.error}` : ""}`
          : "";

      const message = `${successMessage}${partialMessage}`;
      if (importedCount === 0 && failedCount > 0) {
        setOpmlStatus(null);
        setOpmlError(message);
      } else {
        setOpmlStatus(message);
        setOpmlError(null);
      }
      onFeedsChange();
    } catch (error) {
      const message =
        typeof error === "string" || error instanceof Error
          ? error.toString()
          : isZh
            ? "导入 OPML 失败"
            : "Failed to import OPML";
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
        defaultPath: "bookibuddy-subscriptions.opml",
        filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
      });
      if (!filePath) return;

      await invoke("export_opml", { filePath });
      setOpmlStatus(isZh ? "OPML 导出成功" : "OPML exported successfully");
      setOpmlError(null);
    } catch {
      setOpmlError(isZh ? "导出 OPML 失败" : "Failed to export OPML");
    }
  }

  const allFeed = {
    id: "all",
    title: isZh ? "全部订阅" : "All Subscriptions",
    url: "",
    siteUrl: null,
    unread: allUnreadCount,
    total: allArticleCount,
    lastSyncAt: null,
  };
  const favoritesFeed = {
    id: "favorites",
    title: isZh ? "收藏" : "Favorites",
    url: "",
    siteUrl: null,
    unread: favoriteUnreadCount,
    total: favoriteCount,
    lastSyncAt: null,
  };
  const failedCount = syncStatus?.failedFeeds.length ?? 0;
  const isRunning = syncStatus?.phase === "running" || isSyncing;

  function isLocalOnlyFeed(feed: Pick<Feed, "id" | "url"> | undefined) {
    if (!feed) return false;
    return LOCAL_ONLY_FEED_IDS.includes(feed.id) || feed.url === SAVED_ARTICLES_FEED_URL;
  }

  function isVisibleFeed(feed: Feed) {
    return feed.id !== "saved" && feed.url !== SAVED_ARTICLES_FEED_URL;
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src={bookiBuddyLogo} alt="BookiBuddy" />
        <div className="brand-copy">
          <h1 className="brand-wordmark">
            <span className="brand-wordmark-booki">Booki</span>
            <span className="brand-wordmark-buddy">Buddy</span>
          </h1>
          <p>{isZh ? "Your Reading Pal!" : "Your Reading Pal!"}</p>
        </div>
      </div>
      <form className="sidebar-search" onSubmit={(event) => onSearch(event)}>
        <div className="search-input-shell">
          <input
            value={searchQuery}
            onChange={(event) => {
              const value = event.target.value;
              onSearchQueryChange(value);
              if (!value.trim()) onClearSearch();
            }}
            placeholder={isZh ? "搜索全部文章..." : "Search all articles..."}
          />
          {searchQuery && (
            <button
              className="search-clear-button"
              type="button"
              aria-label={isZh ? "清空搜索" : "Clear search"}
              onClick={onClearSearch}
            >
              <span className="search-clear-icon" aria-hidden="true" />
            </button>
          )}
        </div>
        <button type="submit" className="sidebar-search-button">
          {isSearching ? (isZh ? "搜索中..." : "Searching...") : isZh ? "搜索" : "Search"}
        </button>
      </form>

      <section className="panel-section">
        <div className="section-header">
          <div className="section-title">{isZh ? "订阅源" : "Subscriptions"}</div>
          <div className="section-actions">
            <button
              className="icon-button"
              title={isZh ? "同步全部" : "Sync all"}
              onClick={handleStartSync}
              disabled={isRunning}
            >
              {isRunning ? "..." : "↻"}
            </button>
            <button
              className="icon-button"
              title={isZh ? "添加订阅" : "Add subscription"}
              onClick={() => setShowAddDialog(true)}
            >
              +
            </button>
            <button
              className="icon-button"
              title={isImporting ? (isZh ? "正在导入 OPML" : "Importing OPML") : isZh ? "导入 OPML" : "Import OPML"}
              onClick={handleImportOpml}
              disabled={isImporting}
            >
              {isImporting ? "..." : "↑"}
            </button>
            <button
              className="icon-button"
              title={isZh ? "导出 OPML" : "Export OPML"}
              onClick={handleExportOpml}
            >
              &#8595;
            </button>
          </div>
        </div>

        {isRunning && syncStatus && (
          <div className="sync-status-bar">
            {(isZh ? "同步中" : "Syncing")} ({syncStatus.completedFeeds}/{syncStatus.totalFeeds})
          </div>
        )}

        {failedCount > 0 && !isRunning && (
          <div className="sync-failed-bar">
            <span>{isZh ? `${failedCount} 个订阅源同步失败` : `${failedCount} subscriptions failed to sync`}</span>
            <button className="retry-button" onClick={handleRetryFailed}>
              {isZh ? "重试" : "Retry"}
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
          {[allFeed, favoritesFeed, ...feeds.filter(isVisibleFeed)].map((feed) => (
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
                    title={isZh ? "刷新" : "Refresh"}
                    onClick={(event) => handleRefreshFeed(feed.id, event)}
                  >
                    &#8635;
                  </button>
                )}
                {feed.id === "all" ? (
                  <span className="badge badge-double" title={isZh ? `未读 ${allFeed.unread} 篇，共 ${allFeed.total} 篇` : `${allFeed.unread} unread, ${allFeed.total} total`}>
                    <span>{allFeed.unread}</span>
                    <span className="badge-divider">/</span>
                    <span>{allFeed.total}</span>
                  </span>
                ) : (
                  <span className="badge badge-double" title={isZh ? `未读 ${feed.unread} 篇，共 ${feed.total} 篇` : `${feed.unread} unread, ${feed.total} total`}>
                    <span>{feed.unread}</span>
                    <span className="badge-divider">/</span>
                    <span>{feed.total}</span>
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-section sync-config-section">
        <div className="section-header">
          <div className="section-title">{isZh ? "同步设置" : "Sync Settings"}</div>
          <button
            className="icon-button"
            title={isZh ? "展开/收起" : "Expand/Collapse"}
            onClick={() => setShowSyncConfig(!showSyncConfig)}
          >
            {showSyncConfig ? "−" : "+"}
          </button>
        </div>
        {showSyncConfig && (
          <div className="sync-config-panel">
            <label className="sync-config-row">
              <span>{isZh ? "自动同步" : "Auto sync"}</span>
              <input
                type="checkbox"
                checked={syncConfig.enabled}
                onChange={(e) =>
                  setSyncConfig((c) => ({ ...c, enabled: e.target.checked }))
                }
              />
            </label>
            <label className="sync-config-row">
              <span>{isZh ? "间隔（分钟）" : "Interval (min)"}</span>
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
              <span>{isZh ? "最大重试次数" : "Retry limit"}</span>
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
              {isSavingSyncConfig ? (isZh ? "保存中..." : "Saving...") : isZh ? "保存配置" : "Save settings"}
            </button>
          </div>
        )}
      </section>

      {showAddDialog && (
        <div className="dialog-overlay" onClick={() => setShowAddDialog(false)}>
          <div className="dialog" onClick={(event) => event.stopPropagation()}>
            <h3>{isZh ? "添加订阅源" : "Add Subscription"}</h3>
            <input
              placeholder={isZh ? "输入 RSS/Atom 地址..." : "Enter RSS/Atom feed URL..."}
              value={addUrl}
              onChange={(event) => setAddUrl(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void handleAddFeed()}
              autoFocus
            />
            {addError && <p className="error-text">{addError}</p>}
            <div className="dialog-actions">
              <button onClick={() => setShowAddDialog(false)}>{isZh ? "取消" : "Cancel"}</button>
              <button
                className="primary-button"
                onClick={() => void handleAddFeed()}
                disabled={isAdding}
              >
                {isAdding ? (isZh ? "添加中..." : "Adding...") : isZh ? "添加" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
