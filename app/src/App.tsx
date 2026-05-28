import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { ArticleList } from "./components/ArticleList";
import type { Feed, Article } from "./types";
import "./App.css";

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
  const [articles, setArticles] = useState<ArticleWithAI[]>([]);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

<<<<<<< HEAD
=======
  // AI feature states
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ baseUrl: "", apiKey: "", modelName: "" });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [readView, setReadView] = useState<ReadView>("original");
  const [targetLang, setTargetLang] = useState("zh");

>>>>>>> 2ef95399824ea16cd6c12648ffa15fe21d04b941
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
<<<<<<< HEAD
      setFeeds(MOCK_FEEDS);
      setArticles(MOCK_ARTICLES);
      setSelectedArticleId((current) => current ?? MOCK_ARTICLES[0].id);
      setErrorMessage("当前未连接 Tauri 后端，已展示本地示例数据。");
=======
      /* Pure frontend dev — Tauri invoke unavailable, fall back to mock */
      setFeeds(MOCK_FEEDS);
      setArticles(MOCK_ARTICLES);
      setSelectedArticleId((current) => current ?? MOCK_ARTICLES[0]?.id ?? null);
>>>>>>> 2ef95399824ea16cd6c12648ffa15fe21d04b941
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

<<<<<<< HEAD
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

  const selectedArticleHtml = selectedArticle
    ? getReaderHtml(selectedArticle)
    : "";
=======
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
>>>>>>> 2ef95399824ea16cd6c12648ffa15fe21d04b941

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
<<<<<<< HEAD
=======

>>>>>>> 2ef95399824ea16cd6c12648ffa15fe21d04b941
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
<<<<<<< HEAD
                <button onClick={() => alert("Summary Agent - Phase 5")}>
                  摘要
                </button>
                <button onClick={() => alert("Translation Agent - Phase 6")}>
                  翻译
                </button>
              </div>
            </div>
            <div className="reader-content">
              {selectedArticleHtml ? (
                <div dangerouslySetInnerHTML={{ __html: selectedArticleHtml }} />
              ) : (
                <p className="reader-empty-content">
                  这篇文章还没有可展示的正文。
                </p>
              )}
              <a
                className="source-link"
                href={selectedArticle.finalUrl ?? selectedArticle.url}
                target="_blank"
                rel="noreferrer"
              >
                打开原文
              </a>
=======
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
                <button
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
                <div dangerouslySetInnerHTML={{ __html: selectedArticle.content }} />
              )}

              {(readView === "translation" || readView === "bilingual") && selectedArticle.translation && (
                <div className="translation-block">
                  <h3>Translation</h3>
                  <p>{selectedArticle.translation}</p>
                </div>
              )}
>>>>>>> 2ef95399824ea16cd6c12648ffa15fe21d04b941
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
