import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Article, Feed } from "../types";

type Props = {
  feeds: Feed[];
  selectedFeedId: string;
  onSelectFeed: (id: string) => void;
  onFeedsChange: () => void;
};

export function Sidebar({
  feeds,
  selectedFeedId,
  onSelectFeed,
  onFeedsChange,
}: Props) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [refreshingFeedId, setRefreshingFeedId] = useState<string | null>(null);
  const [refreshToast, setRefreshToast] = useState<{
    message: string;
    type: "success" | "info" | "error";
  } | null>(null);

  async function handleAddFeed() {
    if (!addUrl.trim()) return;
    setIsAdding(true);
    setAddError(null);
    try {
      await invoke("add_feed", { url: addUrl.trim() });
      setAddUrl("");
      setShowAddDialog(false);
      onFeedsChange();
    } catch (e) {
      if (typeof e === "string" || e instanceof Error) {
        setAddError(e.toString());
      }
      /* Pure frontend dev — invoke unavailable, treat as success */
      else {
        setAddUrl("");
        setShowAddDialog(false);
      }
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRefreshFeed(
    feedId: string,
    e: React.MouseEvent,
  ) {
    e.stopPropagation();
    setRefreshingFeedId(feedId);
    setRefreshToast({ message: "正在刷新...", type: "info" });
    try {
      const result = await invoke<Article[]>("refresh_feed", { feedId });
      onFeedsChange();
      if (Array.isArray(result) && result.length > 0) {
        setRefreshToast({
          message: `刷新完毕，共 ${result.length} 篇文章`,
          type: "success",
        });
      } else {
        setRefreshToast({ message: "无更新内容", type: "info" });
      }
    } catch (err) {
      /* In Tauri, real errors contain meaningful messages.
         In pure-frontend dev, invoke fails because Tauri core is missing. */
      const errMsg =
        typeof err === "string" ? err : err instanceof Error ? err.message : "";
      if (errMsg.includes("Tauri") || errMsg.includes("invoke")) {
        /* Pure frontend dev — Tauri core not available, mock success */
        setRefreshToast({ message: "刷新完毕（模拟）", type: "info" });
      } else {
        /* Real Tauri error — something went wrong */
        setRefreshToast({ message: "刷新失败", type: "error" });
      }
    } finally {
      setRefreshingFeedId(null);
    }
  }

  /* Auto-hide refresh toast */
  useEffect(() => {
    if (refreshToast) {
      const timer = setTimeout(() => setRefreshToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [refreshToast]);

  async function handleImportOpml() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const filePath = await open({
        filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
      });
      if (!filePath) return;
      await invoke("import_opml", { filePath });
      onFeedsChange();
    } catch {
      /* Pure frontend dev — ignored */
    }
  }

  const allFeed: Feed = {
    id: "all",
    title: "All Feeds",
    url: "",
    siteUrl: null,
    unread: feeds.reduce((sum, f) => sum + f.unread, 0),
    lastSyncAt: null,
  };

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
          <div className="section-title">Feeds</div>
          <div className="section-actions">
            <button
              className="icon-button"
              title="添加订阅"
              onClick={() => setShowAddDialog(true)}
            >
              +
            </button>
            <button
              className="icon-button"
              title="导入 OPML"
              onClick={handleImportOpml}
            >
              &#8593;
            </button>
          </div>
        </div>

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
                style={{ flex: 1, background: "none", border: "none", cursor: "pointer", padding: 0 }}
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
                    onClick={(e) => handleRefreshFeed(feed.id, e)}
                    disabled={refreshingFeedId === feed.id}
                  >
                    &#8635;
                  </button>
                )}
                {feed.unread > 0 && <span className="badge">{feed.unread}</span>}
              </span>
            </div>
          ))}
        </div>
        {refreshToast && (
          <div
            className={`refresh-toast${
              refreshToast.type === "error" ? " failed" : ""
            }`}
          >
            {refreshToast.message}
          </div>
        )}
      </section>

      {showAddDialog && (
        <div
          className="dialog-overlay"
          onClick={() => setShowAddDialog(false)}
        >
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>添加订阅源</h3>
            <input
              placeholder="输入 RSS/Atom 地址..."
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddFeed()}
              autoFocus
            />
            {addError && <p className="error-text">{addError}</p>}
            <div className="dialog-actions">
              <button onClick={() => setShowAddDialog(false)}>取消</button>
              <button
                className="primary-button"
                onClick={handleAddFeed}
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
