import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { ArticleList } from "./components/ArticleList";
import type { Article, Feed } from "./types";
import "./App.css";

function hasTauriBackend() {
  return "__TAURI_INTERNALS__" in window;
}

function getReaderHtml(article: Article) {
  return (
    article.cleanedHtml?.trim() ||
    article.content.trim() ||
    article.excerpt.trim()
  );
}

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
      "<p>这是 Feed 提供的临时正文。后续清洗模块写入 cleanedHtml 后，阅读区会优先显示清洗后的内容。</p>",
    rawHtml: null,
    cleanedHtml: null,
    cleanedMarkdown: null,
    contentFetchedAt: null,
    contentFetchStatus: "pending",
    contentFetchError: null,
    finalUrl: null,
  },
  {
    id: "a2",
    feedId: "1",
    title: "示例文章二",
    url: "https://example.com/2",
    author: "阮一峰",
    publishedAt: "2024-01-14",
    excerpt: "这是第二篇示例文章的摘要。",
    content: "",
    rawHtml: null,
    cleanedHtml: "<p>这是已清洗 HTML 的示例内容。</p>",
    cleanedMarkdown: "这是已清洗 HTML 的示例内容。",
    contentFetchedAt: "2024-01-14T00:00:00Z",
    contentFetchStatus: "cleaned",
    contentFetchError: null,
    finalUrl: "https://example.com/2",
  },
  {
    id: "a3",
    feedId: "2",
    title: "InfoQ 示例文章",
    url: "https://example.com/3",
    author: "InfoQ",
    publishedAt: "2024-01-13",
    excerpt: "来自 InfoQ 的示例文章摘要。",
    content: "",
    rawHtml: null,
    cleanedHtml: null,
    cleanedMarkdown: null,
    contentFetchedAt: null,
    contentFetchStatus: "pending",
    contentFetchError: null,
    finalUrl: null,
  },
];

function App() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [readerMessage, setReaderMessage] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isFetchingArticle, setIsFetchingArticle] = useState(false);
  const [isCleaningArticle, setIsCleaningArticle] = useState(false);
  const openRequestIdRef = useRef(0);

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
      } else {
        setSelectedArticleId(null);
      }
    } catch {
      setFeeds(MOCK_FEEDS);
      setArticles(MOCK_ARTICLES);
      setSelectedArticleId((current) => current ?? MOCK_ARTICLES[0]?.id ?? null);
      setErrorMessage("当前未连接 Tauri 后端，已展示本地示例数据。");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleFetchArticle(url: string) {
    if (!hasTauriBackend()) {
      setFetchError("请使用 pnpm tauri dev 启动桌面端后再抓取文章。");
      return;
    }

    try {
      setIsFetchingArticle(true);
      setFetchError(null);
      setReaderMessage("正在抓取并清洗文章...");

      const article = await invoke<Article>("fetch_and_clean_article", { url });
      const [nextFeeds, nextArticles] = await Promise.all([
        invoke<Feed[]>("list_feeds"),
        invoke<Article[]>("list_articles", { feedId: null }),
      ]);

      setFeeds(nextFeeds);
      setArticles(nextArticles);
      setSelectedFeedId("all");
      setSelectedArticleId(article.id);
      setReaderMessage(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(message);
      setReaderMessage(message);
    } finally {
      setIsFetchingArticle(false);
    }
  }

  async function cleanAndStoreArticle(articleId: string, statusMessage: string) {
    if (!hasTauriBackend()) {
      setReaderMessage("请使用 pnpm tauri dev 启动桌面端后再清洗文章。");
      return null;
    }

    try {
      setIsCleaningArticle(true);
      setReaderMessage(statusMessage);
      const article = await invoke<Article>("clean_article", { articleId });

      setArticles((current) =>
        current.map((item) => (item.id === article.id ? article : item)),
      );
      setReaderMessage(null);
      return article;
    } catch (error) {
      setReaderMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setIsCleaningArticle(false);
    }
  }

  async function handleCleanArticle(articleId: string) {
    const article = await cleanAndStoreArticle(articleId, "正在清洗文章...");
    if (article) {
      setSelectedArticleId(article.id);
    }
  }

  async function handleSelectArticle(articleId: string) {
    const requestId = openRequestIdRef.current + 1;
    openRequestIdRef.current = requestId;
    setSelectedArticleId(articleId);

    const article = articles.find((item) => item.id === articleId);
    if (!article) return;

    if (article.cleanedHtml?.trim() || article.cleanedMarkdown?.trim()) {
      setReaderMessage(null);
      return;
    }

    if (!hasTauriBackend()) {
      setReaderMessage(null);
      return;
    }

    const cleanedArticle = await cleanAndStoreArticle(
      articleId,
      "正在打开清洗后的文章...",
    );

    if (cleanedArticle && openRequestIdRef.current === requestId) {
      setSelectedArticleId(cleanedArticle.id);
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
      visibleArticles.find((article) => article.id === selectedArticleId) ??
      visibleArticles[0] ??
      null,
    [selectedArticleId, visibleArticles],
  );

  const selectedArticleHtml = selectedArticle ? getReaderHtml(selectedArticle) : "";

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
        isFetchingArticle={isFetchingArticle}
        fetchError={fetchError}
        onFetchArticle={handleFetchArticle}
        onSelectArticle={(articleId) => void handleSelectArticle(articleId)}
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
                {!selectedArticle.cleanedHtml && (
                  <button
                    onClick={() => void handleCleanArticle(selectedArticle.id)}
                    disabled={isCleaningArticle}
                  >
                    {isCleaningArticle ? "清洗中..." : "清洗"}
                  </button>
                )}
                <button onClick={() => alert("Summary Agent 尚未在当前分支接通")}>
                  摘要
                </button>
                <button onClick={() => alert("Translation Agent 尚未在当前分支接通")}>
                  翻译
                </button>
              </div>
            </div>
            {readerMessage && <div className="reader-status">{readerMessage}</div>}
            <div className="reader-content">
              {selectedArticleHtml ? (
                <div dangerouslySetInnerHTML={{ __html: selectedArticleHtml }} />
              ) : (
                <p className="reader-empty-content">这篇文章还没有可展示的正文。</p>
              )}
              <a
                className="source-link"
                href={selectedArticle.finalUrl ?? selectedArticle.url}
                target="_blank"
                rel="noreferrer"
              >
                打开原文
              </a>
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
