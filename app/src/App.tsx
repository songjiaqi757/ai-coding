import { useMemo, useState } from "react";
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

const feeds: Feed[] = [
  { id: "all", title: "All Feeds", unread: 7 },
  { id: "tech", title: "Technology", unread: 3 },
  { id: "design", title: "Design", unread: 2 },
  { id: "ai", title: "AI Research", unread: 2 },
];

const articles: Article[] = [
  {
    id: "a1",
    feedId: "ai",
    title: "Local-first AI apps are becoming practical",
    source: "AI Weekly",
    publishedAt: "Today",
    excerpt:
      "A new wave of AI tools keeps data local while allowing users to connect their own model providers.",
    content:
      "Local-first AI applications combine private local storage with optional model providers. This architecture allows users to keep their reading data, summaries, translations, and preferences on their own device. When an AI feature is triggered, the app can call a user-configured local or remote model provider without requiring a central server.",
  },
  {
    id: "a2",
    feedId: "tech",
    title: "Why desktop apps still matter",
    source: "Software Notes",
    publishedAt: "Yesterday",
    excerpt:
      "For tools that manage personal data, a desktop app can offer better privacy and reliability than a cloud-only web app.",
    content:
      "Desktop applications remain useful for privacy-sensitive workflows. They can run without accounts, store data locally, and continue working even when network services are unavailable. For a reader application, this means feeds, articles, cleaned content, summaries, and translations can remain under the user's control.",
  },
  {
    id: "a3",
    feedId: "design",
    title: "Designing a calm reading interface",
    source: "Interface Lab",
    publishedAt: "May 21",
    excerpt:
      "A good reader should reduce visual noise and make the article itself the primary focus.",
    content:
      "Reader interfaces benefit from simple layouts, consistent spacing, readable typography, and clear hierarchy. A three-column layout can separate navigation, article selection, and reading without overwhelming the user.",
  },
];

function App() {
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState(articles[0].id);

  const visibleArticles = useMemo(() => {
    if (selectedFeedId === "all") {
      return articles;
    }

    return articles.filter((article) => article.feedId === selectedFeedId);
  }, [selectedFeedId]);

  const selectedArticle =
    articles.find((article) => article.id === selectedArticleId) ??
    visibleArticles[0] ??
    articles[0];

  function handleSelectFeed(feedId: string) {
    setSelectedFeedId(feedId);

    const nextArticle =
      feedId === "all"
        ? articles[0]
        : articles.find((article) => article.feedId === feedId);

    if (nextArticle) {
      setSelectedArticleId(nextArticle.id);
    }
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
            {feeds.map((feed) => (
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
            <p>{visibleArticles.length} local items</p>
          </div>
          <button className="primary-button">Refresh</button>
        </div>

        <div className="search-box">
          <input placeholder="Search articles..." />
        </div>

        <div className="cards">
          {visibleArticles.map((article) => (
            <button
              key={article.id}
              className={
                article.id === selectedArticle.id
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
        <div className="reader-header">
          <div>
            <div className="article-meta">
              <span>{selectedArticle.source}</span>
              <span>{selectedArticle.publishedAt}</span>
            </div>
            <h2>{selectedArticle.title}</h2>
          </div>

          <div className="reader-actions">
            <button>Summary</button>
            <button>Translate</button>
          </div>
        </div>

        <div className="reader-content">
          <p>{selectedArticle.content}</p>

          <h3>Why this matters</h3>
          <p>
            Mercury will store feeds, articles, cleaned content, summaries, and
            translations locally. AI features will only run when the user
            explicitly requests them.
          </p>

          <blockquote>
            Next step: replace this mock content with local SQLite data and real
            feed parsing.
          </blockquote>
        </div>
      </article>
    </main>
  );
}

export default App;
