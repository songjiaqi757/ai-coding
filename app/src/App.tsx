import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { ArticleList } from "./components/ArticleList";
import type { Feed, Article } from "./types";
import "./App.css";

const MOCK_FEEDS: Feed[] = [
  {
    id: "1",
    title: "阮一峰的网络日志",
    url: "https://feeds.feedburner.com/ruanyifeng",
    siteUrl: "https://ruanyifeng.com",
    unread: 3,
    lastSyncAt: null,
  },
  {
    id: "2",
    title: "InfoQ",
    url: "https://feed.infoq.com",
    siteUrl: "https://infoq.com",
    unread: 7,
    lastSyncAt: "2024-01-15",
  },
];

const MOCK_ARTICLES: Article[] = [
  {
    id: "a1",
    feedId: "1",
    title: "示例文章一",
    url: "https://example.com/1",
    author: "阮一峰",
    publishedAt: "2024-01-15",
    excerpt: "这是一篇示例文章的摘要，用于展示文章列表的样式。",
    content:
      "<p>这是示例正文内容。在实际运行中，这里将显示从 RSS Feed 抓取的文章正文。</p>",
  },
  {
    id: "a2",
    feedId: "1",
    title: "示例文章二",
    url: "https://example.com/2",
    author: "阮一峰",
    publishedAt: "2024-01-14",
    excerpt: "这是第二篇示例文章的摘要。",
    content: "<p>第二篇示例正文。</p>",
  },
  {
    id: "a3",
    feedId: "2",
    title: "InfoQ 示例文章",
    url: "https://example.com/3",
    author: "InfoQ",
    publishedAt: "2024-01-13",
    excerpt: "来自 InfoQ 的示例文章摘要。",
    content: "<p>InfoQ 示例正文内容。</p>",
  },
];

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
      setFeeds(MOCK_FEEDS);
      setArticles(MOCK_ARTICLES);
      setSelectedArticleId((current) => current ?? MOCK_ARTICLES[0].id);
      setErrorMessage("当前未连接 Tauri 后端，已展示本地示例数据。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  const visibleArticles = useMemo(() => {
    if (selectedFeedId === "all") return articles;
    return articles.filter((article) => article.feedId === selectedFeedId);
  }, [articles, selectedFeedId]);

  const selectedArticle = useMemo(
    () =>
      articles.find((article) => article.id === selectedArticleId) ??
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
