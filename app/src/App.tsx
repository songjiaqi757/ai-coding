import { useEffect, useMemo, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import MarkdownIt from "markdown-it";
import "./App.css";

type Feed = {
  id: string;
  title: string;
  url?: string | null;
  site_url?: string | null;
  last_sync_at?: string | null;
  unread?: number;
};

type Article = {
  id: string;
  feed_id: string;
  title: string;
  url?: string | null;
  author?: string | null;
  published_at?: string | null;
  raw_html?: string | null;
  cleaned_html?: string | null;
  cleaned_markdown?: string | null;
  summary?: string | null;
  translation?: string | null;
  source?: string | null;
  excerpt?: string | null;
  content?: string | null;
};

type ReaderState = "empty" | "loading" | "error" | "success";

function hasTauriBackend() {
  return "__TAURI_INTERNALS__" in window;
}

function App() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [selectedArticleDetail, setSelectedArticleDetail] = useState<Article | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [readerState, setReaderState] = useState<ReaderState>("empty");
  const [readerError, setReaderError] = useState<string | null>(null);
  const [articleUrl, setArticleUrl] = useState("");
  const [isFetchingArticle, setIsFetchingArticle] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  async function loadLocalData() {
    if (!hasTauriBackend()) {
      setIsLoading(false);
      setErrorMessage("Desktop backend is unavailable. Start the app with pnpm tauri dev to load local articles.");
      setReaderState("empty");
      return;
    }

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
      } else {
        setSelectedArticleId(null);
        setSelectedArticleDetail(null);
        setReaderState("empty");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadArticleDetail(articleId: string) {
    try {
      setReaderState("loading");
      setReaderError(null);

      const article = await invoke<Article>("get_article", { articleId });
      setSelectedArticleDetail(article);
      setReaderState("success");
      setArticles((current) =>
        current.map((item) => (item.id === article.id ? { ...item, ...article } : item)),
      );
    } catch (error) {
      setSelectedArticleDetail(null);
      setReaderError(error instanceof Error ? error.message : String(error));
      setReaderState("error");
    }
  }

  async function handleCleanArticle(articleId: string) {
    if (!hasTauriBackend()) {
      setReaderError("Desktop backend is unavailable. Start the app with pnpm tauri dev to clean articles.");
      setReaderState("error");
      return;
    }

    try {
      setReaderState("loading");
      setReaderError(null);
      const article = await invoke<Article>("clean_article", { articleId });
      setSelectedArticleDetail(article);
      setReaderState("success");
      setArticles((current) =>
        current.map((item) => (item.id === article.id ? { ...item, ...article } : item)),
      );
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : String(error));
      setReaderState("error");
    }
  }

  async function handleFetchArticle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!hasTauriBackend()) {
      const message = "Desktop backend is unavailable. Start the app with pnpm tauri dev to fetch and clean article URLs.";
      setFetchError(message);
      setReaderError(message);
      setReaderState("empty");
      return;
    }

    const url = articleUrl.trim();
    if (!url) {
      setFetchError("Please enter an article URL.");
      return;
    }

    try {
      setIsFetchingArticle(true);
      setFetchError(null);
      setReaderState("loading");
      setReaderError(null);

      const article = await invoke<Article>("fetch_and_clean_article", { url });
      const [nextFeeds, nextArticles] = await Promise.all([
        invoke<Feed[]>("list_feeds"),
        invoke<Article[]>("list_articles"),
      ]);

      setFeeds(nextFeeds);
      setArticles(nextArticles);
      setSelectedFeedId("all");
      setSelectedArticleId(article.id);
      setSelectedArticleDetail(article);
      setReaderState("success");
      setArticleUrl("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(message);
      setReaderError(message);
      setReaderState(selectedArticleId ? "error" : "empty");
    } finally {
      setIsFetchingArticle(false);
    }
  }

  useEffect(() => {
    void loadLocalData();
  }, []);

  const allFeed: Feed = useMemo(
    () => ({
      id: "all",
      title: "All Feeds",
      unread: feeds.reduce((sum, feed) => sum + (feed.unread ?? 0), 0),
    }),
    [feeds],
  );

  const visibleFeeds = useMemo(() => [allFeed, ...feeds], [allFeed, feeds]);

  const visibleArticles = useMemo(() => {
    if (selectedFeedId === "all") {
      return articles;
    }

    return articles.filter((article) => article.feed_id === selectedFeedId);
  }, [articles, selectedFeedId]);

  const selectedArticle = useMemo(() => {
    return (
      visibleArticles.find((article) => article.id === selectedArticleId) ??
      visibleArticles[0] ??
      null
    );
  }, [selectedArticleId, visibleArticles]);

  const readerArticle = useMemo(() => {
    if (selectedArticleDetail?.id === selectedArticle?.id) {
      return selectedArticleDetail;
    }

    return selectedArticle;
  }, [selectedArticle, selectedArticleDetail]);

  const markdown = useMemo(() => {
    return new MarkdownIt({
      html: false,
      linkify: true,
      breaks: false,
      typographer: false,
    });
  }, []);

  const renderedMarkdown = useMemo(() => {
    if (!readerArticle?.cleaned_markdown) {
      return null;
    }

    return markdown.render(readerArticle.cleaned_markdown);
  }, [markdown, readerArticle?.cleaned_markdown]);

  useEffect(() => {
    if (
      visibleArticles.length > 0 &&
      !visibleArticles.some((article) => article.id === selectedArticleId)
    ) {
      setSelectedArticleId(visibleArticles[0].id);
      return;
    }

    if (visibleArticles.length === 0) {
      setSelectedArticleId(null);
      setSelectedArticleDetail(null);
      setReaderState("empty");
    }
  }, [selectedArticleId, visibleArticles]);

  useEffect(() => {
    if (!selectedArticleId) {
      setSelectedArticleDetail(null);
      setReaderState(isLoading ? "loading" : "empty");
      return;
    }

    void loadArticleDetail(selectedArticleId);
  }, [isLoading, selectedArticleId]);

  function handleSelectFeed(feedId: string) {
    setSelectedFeedId(feedId);
  }

  function renderCleanedContent() {
    if (renderedMarkdown) {
      return (
        <div
          className="reader-content reader-prose"
          dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
        />
      );
    }

    if (readerArticle?.cleaned_html) {
      return (
        <div
          className="reader-content reader-prose"
          dangerouslySetInnerHTML={{ __html: readerArticle.cleaned_html }}
        />
      );
    }

    if (!readerArticle) {
      return null;
    }

    return (
      <div className="reader-content reader-placeholder">
        <p>Content has not been cleaned yet.</p>
        <button
          className="primary-button"
          onClick={() => void handleCleanArticle(readerArticle.id)}
        >
          Clean Article
        </button>
      </div>
    );
  }

  function renderReaderBody() {
    if (!readerArticle) {
      return (
        <div className="reader-status empty-reader">
          {isLoading ? "Loading local articles..." : "No article selected."}
        </div>
      );
    }

    if (readerState === "loading") {
      return <div className="reader-status">Cleaning or loading article...</div>;
    }

    if (readerState === "error") {
      return <div className="reader-status reader-status-error">{readerError}</div>;
    }

    return renderCleanedContent();
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <h1>Mercury</h1>
            <p>AI Reader</p>
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
                <span className="badge">{feed.unread ?? 0}</span>
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
          <button className="primary-button" onClick={() => void loadLocalData()}>
            Refresh
          </button>
        </div>

        <form
          className="url-fetcher"
          onSubmit={(event) => void handleFetchArticle(event)}
        >
          <input
            value={articleUrl}
            onChange={(event) => setArticleUrl(event.target.value)}
            placeholder="https://example.com/article"
            disabled={isFetchingArticle}
          />
          <button
            className="primary-button"
            type="submit"
            disabled={isFetchingArticle}
          >
            {isFetchingArticle ? "Fetching..." : "Fetch"}
          </button>
        </form>

        {fetchError && <div className="error-box">{fetchError}</div>}

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
                <span>{article.source ?? article.author ?? "Local article"}</span>
                <span>{article.published_at ?? "Unknown date"}</span>
              </div>
              <h3>{article.title}</h3>
              <p>{article.excerpt ?? article.content ?? "No article preview available."}</p>
            </button>
          ))}
        </div>
      </section>

      <article className="reader">
        {readerArticle ? (
          <>
            <div className="reader-header">
              <div>
                <div className="article-meta">
                  <span>{readerArticle.author ?? readerArticle.source ?? "Unknown author"}</span>
                  <span>{readerArticle.published_at ?? "Unknown date"}</span>
                </div>
                <h2>{readerArticle.title}</h2>
                {readerArticle.url && (
                  <a
                    className="reader-link"
                    href={readerArticle.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View original article
                  </a>
                )}
              </div>

              <div className="reader-actions">
                {!readerArticle.cleaned_markdown && !readerArticle.cleaned_html && (
                  <button onClick={() => void handleCleanArticle(readerArticle.id)}>
                    Clean
                  </button>
                )}
                <button onClick={() => alert("Summary Agent is coming next.")}>
                  Summary
                </button>
                <button onClick={() => alert("Translation Agent is coming next.")}>
                  Translate
                </button>
              </div>
            </div>

            {renderReaderBody()}
          </>
        ) : (
          renderReaderBody()
        )}
      </article>
    </main>
  );
}

export default App;
