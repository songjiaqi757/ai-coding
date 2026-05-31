import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { ArticleList } from "./components/ArticleList";
import type { Feed, Article, ReadFilter, UnreadSummary } from "./types";
import "./App.css";

/* ── Extended Article type with AI-generated fields ── */
type ArticleWithAI = Article & {
  summary?: string;
  translation?: string;
};

/* ── Mock data (pure frontend dev — Tauri invoke unavailable) ── */
const MOCK_FEEDS: Feed[] = [];
const MOCK_ARTICLES: ArticleWithAI[] = [];

type ReadView = "original" | "translation" | "bilingual";

function App() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<ArticleWithAI[]>([]);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdatingReadStatus, setIsUpdatingReadStatus] = useState(false);
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

  const loadData = useCallback(async (feedId = selectedFeedId, filter = readFilter) => {
    try {
      setIsLoading(true);
      setErrorMessage(null);
      const listFeedId = feedId === "all" ? null : feedId;

      const [nextFeeds, nextArticles] = await Promise.all([
        invoke<Feed[]>("list_feeds"),
        invoke<Article[]>("list_articles", { feedId: listFeedId, readFilter: filter }),
      ]);

      setFeeds(nextFeeds);
      setArticles(nextArticles);

      setSelectedArticleId((current) =>
        nextArticles.some((article) => article.id === current)
          ? current
          : nextArticles[0]?.id ?? null,
      );
    } catch {
      /* Pure frontend dev — Tauri invoke unavailable, fall back to mock */
      setFeeds(MOCK_FEEDS);
      setArticles(MOCK_ARTICLES);
      setSelectedArticleId((current) => current ?? MOCK_ARTICLES[0]?.id ?? null);
    } finally {
      setIsLoading(false);
    }
  }, [selectedFeedId, readFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const refreshFeeds = useCallback(async () => {
    try {
      setFeeds(await invoke<Feed[]>("list_feeds"));
    } catch {
      setFeeds(MOCK_FEEDS);
    }
  }, []);

  async function handleToggleReadStatus(article: ArticleWithAI) {
    try {
      setIsUpdatingReadStatus(true);
      const updated = await invoke<Article>("set_article_read_status", {
        articleId: article.id,
        isRead: !article.isRead,
      });
      setArticles((prev) => {
        const next = prev.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        );
        if (readFilter === "all") return next;
        return next.filter((item) =>
          readFilter === "read" ? item.isRead : !item.isRead,
        );
      });
      await refreshFeeds();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsUpdatingReadStatus(false);
    }
  }

  async function handleMarkCurrentFeedRead() {
    try {
      setIsUpdatingReadStatus(true);
      await invoke<UnreadSummary>("mark_articles_read", {
        feedId: selectedFeedId === "all" ? null : selectedFeedId,
        articleIds: null,
      });
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsUpdatingReadStatus(false);
    }
  }

  const loadSettings = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    if (showSettings) {
      void loadSettings();
    }
  }, [showSettings, loadSettings]);

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

  const visibleArticles = articles;

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
        readFilter={readFilter}
        isUpdatingReadStatus={isUpdatingReadStatus}
        onSelectArticle={setSelectedArticleId}
        onReadFilterChange={setReadFilter}
        onToggleReadStatus={handleToggleReadStatus}
        onMarkCurrentFeedRead={handleMarkCurrentFeedRead}
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
                <button
                  type="button"
                  onClick={() => handleSummarize()}
                  disabled={isSummarizing}
                  className={isSummarizing ? "action-loading" : ""}
                >
                  {isSummarizing ? "Summarizing..." : selectedArticle.summary ? "Regenerate Summary" : "Summary"}
                </button>
                <button
                  type="button"
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
                <button
                  type="button"
                  className="settings-toggle-btn"
                  onClick={() => setShowSettings(true)}
                  title="LLM Settings"
                >
                  &#9881;
                </button>
              </div>
            </div>

            {aiError && <div className="error-box">{aiError}</div>}

            {selectedArticle.summary && (
              <div className="ai-result-section">
                <div className="ai-result-label">Summary</div>
                <div className="ai-result-content">{selectedArticle.summary}</div>
              </div>
            )}

            {selectedArticle.translation && (
              <div className="view-tabs">
                <button
                  type="button"
                  className={readView === "original" ? "view-tab active" : "view-tab"}
                  onClick={() => setReadView("original")}
                >
                  Original
                </button>
                <button
                  type="button"
                  className={readView === "translation" ? "view-tab active" : "view-tab"}
                  onClick={() => setReadView("translation")}
                >
                  Translation
                </button>
                <button
                  type="button"
                  className={readView === "bilingual" ? "view-tab active" : "view-tab"}
                  onClick={() => setReadView("bilingual")}
                >
                  Bilingual
                </button>
              </div>
            )}

            <div className="reader-content">
              {(readView === "original" || readView === "bilingual") && (
                <div dangerouslySetInnerHTML={{ __html: selectedArticle.content }} />
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
            {isLoading ? "加载中..." : "请从左侧选择文章"}
          </div>
        )}
      </article>

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-overlay">
          <div className="modal-content">
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
                <button type="button" className="primary-button" onClick={handleSaveSettings} disabled={isSavingSettings}>
                  {isSavingSettings ? "Saving..." : "Save"}
                </button>
                <button type="button" onClick={() => setShowSettings(false)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
