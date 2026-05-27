import { useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Feed } from "../types";

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
    try {
      await invoke("refresh_feed", { feedId });
      onFeedsChange();
    } catch (error) {
      console.error("刷新失败", error);
    }
  }

  async function handleImportOpml() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const filePath = await open({
        filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
      });
      if (!filePath) return;
      await invoke("import_opml", { filePath });
      onFeedsChange();
    } catch (error) {
      console.error("导入 OPML 失败", error);
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
                    className="refresh-button"
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
        <div
          className="dialog-overlay"
          onClick={() => setShowAddDialog(false)}
        >
          <div className="dialog" onClick={(event) => event.stopPropagation()}>
            <h3>添加订阅源</h3>
            <input
              placeholder="输入 RSS/Atom 地址..."
              value={addUrl}
              onChange={(event) => setAddUrl(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && handleAddFeed()}
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
