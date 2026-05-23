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
  summary?: string;
  translation?: string;
};

type ReadView = "original" | "translation" | "bilingual";

function App() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // AI feature states
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ baseUrl: "", apiKey: "", modelName: "" });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [readView, setReadView] = useState<ReadView>("original");
  const [targetLang, setTargetLang] = useState("zh");

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

  async function loadSettings() {
    try {
      const [baseUrl, apiKey, modelName] = await Promise.all([
        invoke<string | null>("load_setting", { key: "llm_base_url" }),
        invoke<string | null>("load_setting", { key: "llm_api_key" }),
        invoke<string | null>("load_setting", { key: "llm_model_name" }),
      ]);
      setSettingsForm({
        baseUrl: baseUrl ?? "",
        apiKey: apiKey ?? "",
        modelName: modelName ?? "",
      });
    } catch {
      // Settings not configured yet
    }
  }

  useEffect(() => {
    if (showSettings) {
      void loadSettings();
    }
  }, [showSettings]);

  async function handleSaveSettings() {
    try {
      setIsSavingSettings(true);
      await Promise.all([
        invoke("save_setting", { key: "llm_base_url", value: settingsForm.baseUrl }),
        invoke("save_setting", { key: "llm_api_key", value: settingsForm.apiKey }),
        invoke("save_setting", { key: "llm_model_name", value: settingsForm.modelName }),
      ]);
      setShowSettings(false);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function handleSummarize(force = false) {
    if (!selectedArticleId) return;
    try {
      setIsSummarizing(true);
      setAiError(null);
      const summary = await invoke<string>("summarize_article", {
        articleId: selectedArticleId,
        force,
      });
      setArticles((prev) =>
        prev.map((a) => (a.id === selectedArticleId ? { ...a, summary } : a)),
      );
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSummarizing(false);
    }
  }

  async function handleTranslate() {
    if (!selectedArticleId) return;
    try {
      setIsTranslating(true);
      setAiError(null);
      const translation = await invoke<string>("translate_article", {
        articleId: selectedArticleId,
        targetLang,
      });
      setArticles((prev) =>
        prev.map((a) => (a.id === selectedArticleId ? { ...a, translation } : a)),
      );
      setReadView("translation");
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTranslating(false);
    }
  }

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
          <button className="settings-btn" onClick={() => setShowSettings(true)}>
            <span className="settings-icon">&#9881;</span> Settings
          </button>
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
              {article.summary && (
                <p className="card-summary-indicator">Has summary</p>
              )}
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
                <button
                  onClick={() => handleSummarize()}
                  disabled={isSummarizing}
                  className={isSummarizing ? "action-loading" : ""}
                >
                  {isSummarizing ? "Summarizing..." : selectedArticle.summary ? "Regenerate Summary" : "Summary"}
                </button>
                <button
                  onClick={() => handleTranslate()}
                  disabled={isTranslating}
                  className={isTranslating ? "action-loading" : ""}
                >
                  {isTranslating ? "Translating..." : "Translate"}
                </button>
                <select
                  className="lang-select"
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                >
                  <option value="zh">Chinese</option>
                  <option value="en">English</option>
                  <option value="ja">Japanese</option>
                  <option value="ko">Korean</option>
                </select>
              </div>
            </div>

            {aiError && <div className="error-box">{aiError}</div>}

            {/* Summary section */}
            {selectedArticle.summary && (
              <div className="ai-result-section">
                <div className="ai-result-label">Summary</div>
                <div className="ai-result-content">{selectedArticle.summary}</div>
              </div>
            )}

            {/* View tabs */}
            {selectedArticle.translation && (
              <div className="view-tabs">
                <button
                  className={readView === "original" ? "view-tab active" : "view-tab"}
                  onClick={() => setReadView("original")}
                >
                  Original
                </button>
                <button
                  className={readView === "translation" ? "view-tab active" : "view-tab"}
                  onClick={() => setReadView("translation")}
                >
                  Translation
                </button>
                <button
                  className={readView === "bilingual" ? "view-tab active" : "view-tab"}
                  onClick={() => setReadView("bilingual")}
                >
                  Bilingual
                </button>
              </div>
            )}

            <div className="reader-content">
              {(readView === "original" || readView === "bilingual") && (
                <p>{selectedArticle.content}</p>
              )}

              {(readView === "original" || readView === "bilingual") && (
                <>
                  <h3>Local data milestone</h3>
                  <p>
                    This article is now loaded from the local SQLite database through
                    Tauri commands instead of being hard-coded in the React UI.
                  </p>
                  <blockquote>
                    Next step: add real Feed / OPML parsing and store fetched
                    articles into the same local database.
                  </blockquote>
                </>
              )}

              {(readView === "translation" || readView === "bilingual") && selectedArticle.translation && (
                <div className="translation-block">
                  <h3>Translation</h3>
                  <p>{selectedArticle.translation}</p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="empty-reader">
            {isLoading ? "Loading local articles..." : "No article selected."}
          </div>
        )}
      </article>

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2>LLM Settings</h2>
            <p className="modal-desc">
              Configure your LLM provider. Supports OpenAI, DeepSeek, Ollama, and any OpenAI-compatible API.
            </p>

            <div className="settings-form">
              <label>
                API Base URL
                <input
                  placeholder="https://api.openai.com or http://localhost:11434"
                  value={settingsForm.baseUrl}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, baseUrl: e.target.value }))}
                />
              </label>

              <label>
                API Key
                <input
                  type="password"
                  placeholder="sk-... (leave empty for Ollama)"
                  value={settingsForm.apiKey}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, apiKey: e.target.value }))}
                />
              </label>

              <label>
                Model Name
                <input
                  placeholder="gpt-3.5-turbo, deepseek-chat, llama3"
                  value={settingsForm.modelName}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, modelName: e.target.value }))}
                />
              </label>

              <div className="modal-actions">
                <button className="primary-button" onClick={handleSaveSettings} disabled={isSavingSettings}>
                  {isSavingSettings ? "Saving..." : "Save"}
                </button>
                <button onClick={() => setShowSettings(false)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
