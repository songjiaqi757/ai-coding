import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type Feed = {
  id: string;
  title: string;
  unread: number;
};

type Article = {
  id: string;
  feedId: string;
  title: string;
  source: string;
  publishedAt: string;
  excerpt: string;
  content: string;
};

function App() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadLocalData() {
    try {
      setIsLoading(true);
      setErrorMessage(null);

      const [nextFeeds, nextArticles] = await Promise.all([
        invoke<Feed[]>("list_feeds"),
        invoke<Article[]>("list_articles"),
      ]);

      setFeeds(nextFeeds);
      setArticles(nextArticles);

      if (nextArticles.length > 0) {
        setSelectedArticleId((current) => current ?? nextArticles[0].id);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadLocalData();
  }, []);

  const allFeed: Feed = useMemo(
    () => ({
      id: "all",
      title: "All Feeds",
      unread: feeds.reduce((sum, feed) => sum + feed.unread, 0),
    }),
    [feeds],
  );

  const visibleFeeds = useMemo(() => [allFeed, ...feeds], [allFeed, feeds]);

  const visibleArticles = useMemo(() => {
    if (selectedFeedId === "all") {
      return articles;
    }

    return articles.filter((article) => article.feedId === selectedFeedId);
  }, [articles, selectedFeedId]);

  const selectedArticle = useMemo(() => {
    return (
      articles.find((article) => article.id === selectedArticleId) ??
      visibleArticles[0] ??
      null
    );
  }, [articles, selectedArticleId, visibleArticles]);

  useEffect(() => {
    if (
      visibleArticles.length > 0 &&
      !visibleArticles.some((article) => article.id === selectedArticleId)
    ) {
      setSelectedArticleId(visibleArticles[0].id);
    }
  }, [selectedArticleId, visibleArticles]);

  function handleSelectFeed(feedId: string) {
    setSelectedFeedId(feedId);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <h1>Mercury</h1>
            <p>Local-first AI Reader</p>
          </div>
        </div>

        <section className="panel-section">
          <div className="section-title">Feeds</div>
          <div className="feed-list">
            {visibleFeeds.map((feed) => (
              <button
                key={feed.id}
                className={
                  feed.id === selectedFeedId ? "feed-item active" : "feed-item"
                }
                onClick={() => handleSelectFeed(feed.id)}
              >
                <span>{feed.title}</span>
                <span className="badge">{feed.unread}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel-section bottom-section">
          <div className="section-title">MVP Status</div>
          <ul className="status-list">
            <li>Feed / OPML</li>
            <li>Cleaned HTML</li>
            <li>Summary Agent</li>
            <li>Translation Agent</li>
          </ul>
        </section>
      </aside>

      <section className="article-list">
        <div className="toolbar">
          <div>
            <h2>Articles</h2>
            <p>
              {isLoading
                ? "Loading local data..."
                : `${visibleArticles.length} local items`}
            </p>
          </div>
          <button className="primary-button" onClick={loadLocalData}>
            Refresh
          </button>
        </div>

        <div className="search-box">
          <input placeholder="Search articles..." />
        </div>

        {errorMessage && <div className="error-box">{errorMessage}</div>}

        <div className="cards">
          {visibleArticles.map((article) => (
            <button
              key={article.id}
              className={
                article.id === selectedArticle?.id
                  ? "article-card active"
                  : "article-card"
              }
              onClick={() => setSelectedArticleId(article.id)}
            >
              <div className="article-meta">
                <span>{article.source}</span>
                <span>{article.publishedAt}</span>
              </div>
              <h3>{article.title}</h3>
              <p>{article.excerpt}</p>
            </button>
          ))}
        </div>
      </section>

      <article className="reader">
        {selectedArticle ? (
          <>
            <div className="reader-header">
              <div>
                <div className="article-meta">
                  <span>{selectedArticle.source}</span>
                  <span>{selectedArticle.publishedAt}</span>
                </div>
                <h2>{selectedArticle.title}</h2>
              </div>

              <div className="reader-actions">
                <button onClick={() => alert("Summary Agent is coming next.")}>
                  Summary
                </button>
                <button
                  onClick={() => alert("Translation Agent is coming next.")}
                >
                  Translate
                </button>
              </div>
            </div>

            <div className="reader-content">
              <p>{selectedArticle.content}</p>

              <h3>Local data milestone</h3>
              <p>
                This article is now loaded from the local SQLite database through
                Tauri commands instead of being hard-coded in the React UI.
              </p>

              <blockquote>
                Next step: add real Feed / OPML parsing and store fetched
                articles into the same local database.
              </blockquote>
            </div>
          </>
        ) : (
          <div className="empty-reader">
            {isLoading ? "Loading local articles..." : "No article selected."}
          </div>
        )}
      </article>
    </main>
  );
}

export default App;
