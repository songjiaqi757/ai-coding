import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { ArticleList } from "./components/ArticleList";
import type { Feed, Article } from "./types";
import "./App.css";

/* ── Mock data (pure frontend dev — Tauri invoke unavailable) ── */
const MOCK_FEEDS: Feed[] = [];

const MOCK_ARTICLES: Article[] = [];

function App() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadData() {
    try {
      setIsLoading(true);
      setErrorMessage(null);

      const [nextFeeds, nextArticles] = await Promise.all([
        invoke<Feed[]>("list_feeds"),
        invoke<Article[]>("list_articles", { feedId: null }),
      ]);

      setFeeds(nextFeeds);
      setArticles(nextArticles);

      if (nextArticles.length > 0) {
        setSelectedArticleId((current) => current ?? nextArticles[0].id);
      }
    } catch {
      /* Pure frontend dev — Tauri invoke unavailable, fall back to mock */
      setFeeds(MOCK_FEEDS);
      setArticles(MOCK_ARTICLES);
      setSelectedArticleId((current) => current ?? MOCK_ARTICLES[0].id);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  const visibleArticles = useMemo(() => {
    if (selectedFeedId === "all") return articles;
    return articles.filter((a) => a.feedId === selectedFeedId);
  }, [articles, selectedFeedId]);

  const selectedArticle = useMemo(
    () =>
      articles.find((a) => a.id === selectedArticleId) ??
      visibleArticles[0] ??
      null,
    [articles, selectedArticleId, visibleArticles],
  );

  return (
    <main className="app-shell">
      <Sidebar
        feeds={feeds}
        selectedFeedId={selectedFeedId}
        onSelectFeed={setSelectedFeedId}
        onFeedsChange={loadData}
      />
      <ArticleList
        articles={visibleArticles}
        selectedArticleId={selectedArticle?.id ?? null}
        isLoading={isLoading}
        onSelectArticle={setSelectedArticleId}
      />
      <article className="reader">
        {errorMessage && <div className="error-box">{errorMessage}</div>}
        {selectedArticle ? (
          <>
            <div className="reader-header">
              <div>
                <div className="article-meta">
                  <span>{selectedArticle.author ?? "未知作者"}</span>
                  <span>
                    {selectedArticle.publishedAt
                      ? new Date(selectedArticle.publishedAt).toLocaleDateString("zh-CN")
                      : ""}
                  </span>
                </div>
                <h2>{selectedArticle.title}</h2>
              </div>
              <div className="reader-actions">
                <button onClick={() => alert("Summary Agent - Phase 5")}>摘要</button>
                <button onClick={() => alert("Translation Agent - Phase 6")}>翻译</button>
              </div>
            </div>
            <div className="reader-content">
              <div dangerouslySetInnerHTML={{ __html: selectedArticle.content }} />
            </div>
          </>
        ) : (
          <div className="empty-reader">
            {isLoading ? "加载中..." : "请从左侧选择文章"}
          </div>
        )}
      </article>
    </main>
  );
}

export default App;
