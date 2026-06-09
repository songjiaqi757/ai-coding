import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { ArticleList } from "./components/ArticleList";
import type { Feed, Article, ReadFilter, UnreadSummary, SyncStatus } from "./types";
import "./App.css";

/* ── Mock data (pure frontend dev — Tauri invoke unavailable) ── */
const MOCK_FEEDS: Feed[] = [];
const MOCK_ARTICLES: Article[] = [];

type ReadView = "original" | "translation" | "bilingual";
type ReaderSnapshot = {
  article: Article | null;
  pdfUrl: string | null;
  pdfTitle: string | null;
};
type SelectionOverlay = {
  text: string;
  x: number;
  y: number;
};

function App() {
  const readerHtmlRef = useRef<HTMLDivElement | null>(null);
  const suppressSelectionUntilRef = useRef(0);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [allArticleCount, setAllArticleCount] = useState(0);
  const [allUnreadCount, setAllUnreadCount] = useState(0);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [readerArticle, setReaderArticle] = useState<Article | null>(null);
  const [readerPdfUrl, setReaderPdfUrl] = useState<string | null>(null);
  const [readerPdfTitle, setReaderPdfTitle] = useState<string | null>(null);
  const [readerHistory, setReaderHistory] = useState<ReaderSnapshot[]>([]);
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdatingReadStatus, setIsUpdatingReadStatus] = useState(false);
  const [isCleaningArticle, setIsCleaningArticle] = useState(false);
  const [isOpeningReaderLink, setIsOpeningReaderLink] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // AI feature states
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ baseUrl: "", apiKey: "", modelName: "" });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [selectionOverlay, setSelectionOverlay] = useState<SelectionOverlay | null>(null);
  const [selectionTranslation, setSelectionTranslation] = useState<string | null>(null);
  const [isTranslatingSelection, setIsTranslatingSelection] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [readView, setReadView] = useState<ReadView>("original");
  const [targetLang, setTargetLang] = useState("zh");

  // Sync status
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

  const refreshSyncStatus = useCallback(async () => {
    try {
      setSyncStatus(await invoke<SyncStatus>("get_sync_status"));
    } catch {
      // Sync status unavailable
    }
  }, []);

  useEffect(() => {
    void refreshSyncStatus();
  }, [refreshSyncStatus]);

  useEffect(() => {
    if (syncStatus?.phase !== "running") return;
    const timer = window.setInterval(() => {
      void refreshSyncStatus();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [syncStatus?.phase, refreshSyncStatus]);

  const loadData = useCallback(async (feedId = selectedFeedId) => {
    try {
      setIsLoading(true);
      setErrorMessage(null);
      const listFeedId = feedId === "all" ? null : feedId;
      const articlesPromise = invoke<Article[]>("list_articles", { feedId: listFeedId, readFilter: "all" });
      const allArticlesPromise =
        listFeedId === null
          ? articlesPromise
          : invoke<Article[]>("list_articles", { feedId: null, readFilter: "all" });

      const [nextFeeds, nextArticles, allArticles] = await Promise.all([
        invoke<Feed[]>("list_feeds"),
        articlesPromise,
        allArticlesPromise,
      ]);

      setFeeds(nextFeeds);
      setArticles(nextArticles);
      setAllArticleCount(allArticles.length);
      setAllUnreadCount(allArticles.filter((article) => !article.isRead).length);
    } catch {
      /* Pure frontend dev — Tauri invoke unavailable, fall back to mock */
      setFeeds(MOCK_FEEDS);
      setArticles(MOCK_ARTICLES);
      setAllArticleCount(MOCK_ARTICLES.length);
      setAllUnreadCount(MOCK_ARTICLES.filter((article) => !article.isRead).length);
    } finally {
      setIsLoading(false);
    }
  }, [selectedFeedId]);

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

  async function handleToggleReadStatus(article: Article) {
    try {
      setIsUpdatingReadStatus(true);
      const updated = await invoke<Article>("set_article_read_status", {
        articleId: article.id,
        isRead: !article.isRead,
      });
      setArticles((prev) =>
        prev.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        ),
      );
      await refreshFeeds();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsUpdatingReadStatus(false);
    }
  }

  async function handleToggleFavorite(article: Article) {
    try {
      setErrorMessage(null);
      const updated = await invoke<Article>("set_article_favorite", {
        articleId: article.id,
        isFavorite: !article.isFavorite,
      });
      setArticles((prev) =>
        prev.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        ),
      );
      if (readerArticle?.id === updated.id) {
        setReaderArticle((current) => current ? { ...current, ...updated } : current);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleToggleReadLater(article: Article) {
    try {
      setErrorMessage(null);
      const updated = await invoke<Article>("set_article_read_later", {
        articleId: article.id,
        readLater: !article.readLater,
      });
      setArticles((prev) =>
        prev.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        ),
      );
      if (readerArticle?.id === updated.id) {
        setReaderArticle((current) => current ? { ...current, ...updated } : current);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleMarkCurrentFeedRead() {
    try {
      setIsUpdatingReadStatus(true);
      setErrorMessage(null);
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
    if (!selectedArticle) return;
    try {
      setIsSummarizing(true);
      setAiError(null);
      const summary = await invoke<string>("summarize_article", {
        articleId: selectedArticle.id,
        force,
      });
      setArticles((prev) =>
        prev.map((a) => (a.id === selectedArticle.id ? { ...a, summary } : a)),
      );
      if (readerArticle?.id === selectedArticle.id) {
        setReaderArticle({ ...selectedArticle, summary });
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSummarizing(false);
    }
  }

  async function handleTranslate() {
    if (!selectedArticle) return;
    try {
      setIsTranslating(true);
      setAiError(null);
      const translation = await invoke<string>("translate_article", {
        articleId: selectedArticle.id,
        targetLang,
      });
      setArticles((prev) =>
        prev.map((a) => (a.id === selectedArticle.id ? { ...a, translation, translationLang: targetLang } : a)),
      );
      if (readerArticle?.id === selectedArticle.id) {
        setReaderArticle({ ...selectedArticle, translation, translationLang: targetLang });
      }
      setReadView("translation");
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTranslating(false);
    }
  }

  const visibleArticles = useMemo(() => {
    const filterMatchedArticles = articles.filter((article) => {
      if (readFilter === "all") return true;
      return readFilter === "read" ? article.isRead : !article.isRead;
    });

    const trimmedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!trimmedQuery) return filterMatchedArticles;

    return filterMatchedArticles.filter((article) => {
      const title = article.title.toLocaleLowerCase();
      const author = article.author?.toLocaleLowerCase() ?? "";
      return title.includes(trimmedQuery) || author.includes(trimmedQuery);
    });
  }, [articles, readFilter, searchQuery]);

  const totalCount = articles.length;
  const unreadCount = useMemo(
    () => articles.filter((article) => !article.isRead).length,
    [articles],
  );
  const readCount = totalCount - unreadCount;

  useEffect(() => {
    setSelectedArticleId((current) =>
      visibleArticles.some((article) => article.id === current)
        ? current
        : visibleArticles[0]?.id ?? null,
    );
  }, [visibleArticles]);

  const selectedListArticle = useMemo(
    () =>
      visibleArticles.find((a) => a.id === selectedArticleId) ??
      visibleArticles[0] ??
      null,
    [selectedArticleId, visibleArticles],
  );

  const selectedArticle = readerPdfUrl ? null : (readerArticle ?? selectedListArticle);
  const displayTitle = readerPdfTitle ?? selectedArticle?.title ?? "";

  const readerHtml = useMemo(() => {
    if (!selectedArticle) return "";
    if (selectedArticle.cleanedHtml?.trim()) return selectedArticle.cleanedHtml;
    if (selectedArticle.content?.trim()) return selectedArticle.content;
    if (selectedArticle.excerpt.trim()) return `<p>${selectedArticle.excerpt}</p>`;
    return "<p>暂无可显示内容</p>";
  }, [selectedArticle]);

  useEffect(() => {
    if (!selectedArticle) return;
    if (selectedArticle.cleanedHtml?.trim()) return;
    if (!selectedArticle.content?.trim() && !selectedArticle.excerpt.trim()) return;

    let cancelled = false;
    const articleId = selectedArticle.id;

    async function ensureCleanedContent() {
      try {
        setIsCleaningArticle(true);
        setErrorMessage(null);
        const updatedArticle = await invoke<Article>("clean_article", {
          articleId,
        });
        if (cancelled) return;

        setArticles((prev) =>
          prev.map((article) =>
            article.id === updatedArticle.id ? { ...article, ...updatedArticle } : article,
          ),
        );
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(
          error instanceof Error ? `正文清洗失败：${error.message}` : `正文清洗失败：${String(error)}`,
        );
      } finally {
        if (!cancelled) {
          setIsCleaningArticle(false);
        }
      }
    }

    void ensureCleanedContent();

    return () => {
      cancelled = true;
    };
  }, [selectedArticle]);

  const hasActiveTranslation = !!selectedArticle?.translation && selectedArticle.translationLang === targetLang;

  useEffect(() => {
    if (!hasActiveTranslation && readView !== "original") {
      setReadView("original");
    }
  }, [hasActiveTranslation, readView]);

  useEffect(() => {
    setReaderArticle(null);
    setReaderPdfUrl(null);
    setReaderPdfTitle(null);
    setReaderHistory([]);
    setSelectionOverlay(null);
    setSelectionTranslation(null);
  }, [selectedFeedId, readFilter]);

  const contentStatusLabel = useMemo(() => {
    if (readerPdfUrl) return "正在预览 PDF 文档";
    if (!selectedArticle) return null;
    if (isOpeningReaderLink) return "正在打开文章...";
    if (isCleaningArticle) return "正在清洗正文...";
    if (selectedArticle.cleanedHtml?.trim()) return "已显示清洗正文";
    if (selectedArticle.content?.trim()) return "当前显示 Feed 原文";
    if (selectedArticle.excerpt.trim()) return "当前显示 Feed 摘要";
    return "暂无正文内容";
  }, [isCleaningArticle, isOpeningReaderLink, readerPdfUrl, selectedArticle]);

  const originalArticleUrl = selectedArticle?.finalUrl?.trim() || selectedArticle?.url?.trim() || "";

  function isPdfUrl(url: string) {
    return /\.pdf(?:$|[?#])/i.test(url);
  }

  function buildReaderSnapshot(): ReaderSnapshot {
    return {
      article: selectedArticle,
      pdfUrl: readerPdfUrl,
      pdfTitle: readerPdfTitle,
    };
  }

  function derivePdfTitle(url: string, fallback?: string) {
    if (fallback?.trim()) return fallback.trim();
    try {
      const pathname = new URL(url).pathname;
      const segment = pathname.split("/").filter(Boolean).pop();
      return segment || "PDF Document";
    } catch {
      return "PDF Document";
    }
  }

  async function openArticleInReader(url: string, fallbackTitle?: string) {
    try {
      setIsOpeningReaderLink(true);
      setErrorMessage(null);

      if (isPdfUrl(url)) {
        setReaderHistory((prev) => [...prev, buildReaderSnapshot()]);
        setReaderArticle(null);
        setReaderPdfUrl(url);
        setReaderPdfTitle(derivePdfTitle(url, fallbackTitle));
        setReadView("original");
        return;
      }

      const openedArticle = await invoke<Article>("fetch_and_clean_article", { url });
      setReaderHistory((prev) => [...prev, buildReaderSnapshot()]);
      setReaderArticle(openedArticle);
      setReaderPdfUrl(null);
      setReaderPdfTitle(null);
      setReadView("original");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? `打开文章失败：${error.message}` : `打开文章失败：${String(error)}`,
      );
    } finally {
      setIsOpeningReaderLink(false);
    }
  }

  async function handleReaderContentClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const link = target.closest("a");
    if (!(link instanceof HTMLAnchorElement)) return;

    const href = link.getAttribute("href")?.trim();
    if (!href || href.startsWith("#")) return;

    event.preventDefault();
    event.stopPropagation();

    const resolvedUrl = (() => {
      try {
        return new URL(href, originalArticleUrl || undefined).toString();
      } catch {
        return href;
      }
    })();

    await openArticleInReader(resolvedUrl, link.textContent ?? undefined);
  }

  function handleSelectArticle(articleId: string) {
    setReaderArticle(null);
    setReaderPdfUrl(null);
    setReaderPdfTitle(null);
    setReaderHistory([]);
    setSelectionOverlay(null);
    setSelectionTranslation(null);
    setSelectedArticleId(articleId);
    setReadView("original");
  }

  function handleSelectFeed(feedId: string) {
    setReaderArticle(null);
    setReaderPdfUrl(null);
    setReaderPdfTitle(null);
    setReaderHistory([]);
    setSelectionOverlay(null);
    setSelectionTranslation(null);
    setSelectedFeedId(feedId);
    setReadView("original");
  }

  function handleReaderBack() {
    setReaderHistory((prev) => {
      if (prev.length === 0) return prev;
      const nextHistory = prev.slice(0, -1);
      const previousSnapshot = prev[prev.length - 1] ?? null;
      setReaderArticle(previousSnapshot?.article ?? null);
      setReaderPdfUrl(previousSnapshot?.pdfUrl ?? null);
      setReaderPdfTitle(previousSnapshot?.pdfTitle ?? null);
      setSelectionOverlay(null);
      setSelectionTranslation(null);
      return nextHistory;
    });
  }

  function clearSelectionOverlay() {
    suppressSelectionUntilRef.current = Date.now() + 200;
    setSelectionOverlay(null);
    setSelectionTranslation(null);
    window.getSelection()?.removeAllRanges();
  }

  function handleReaderSelection() {
    if (readerPdfUrl || !selectedArticle) return;
    if (Date.now() < suppressSelectionUntilRef.current) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!text) {
      setSelectionOverlay(null);
      setSelectionTranslation(null);
      return;
    }

    const anchorNode = selection?.anchorNode;
    const readerRoot = readerHtmlRef.current;
    if (!(readerRoot instanceof HTMLElement) || !anchorNode || !readerRoot.contains(anchorNode)) {
      return;
    }

    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 600) {
      return;
    }

    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const rect = range?.getBoundingClientRect();
    if (!range || !rect) return;
    setSelectionOverlay({
      text: normalized,
      x: rect.left + rect.width / 2,
      y: Math.max(16, rect.top - 12),
    });
    setSelectionTranslation(null);
  }

  async function handleTranslateSelection() {
    if (!selectionOverlay?.text) return;
    try {
      setIsTranslatingSelection(true);
      setAiError(null);
      const translation = await invoke<string>("translate_text", {
        text: selectionOverlay.text,
        targetLang,
      });
      setSelectionTranslation(translation);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTranslatingSelection(false);
    }
  }

  return (
    <main className="app-shell">
      <Sidebar
        feeds={feeds}
        allArticleCount={allArticleCount}
        allUnreadCount={allUnreadCount}
        selectedFeedId={selectedFeedId}
        syncStatus={syncStatus}
        onSelectFeed={handleSelectFeed}
        onFeedsChange={loadData}
        onSyncStatusChange={refreshSyncStatus}
      />
      <ArticleList
        articles={visibleArticles}
        totalCount={totalCount}
        unreadCount={unreadCount}
        readCount={readCount}
        selectedArticleId={selectedListArticle?.id ?? null}
        isLoading={isLoading}
        readFilter={readFilter}
        searchQuery={searchQuery}
        isUpdatingReadStatus={isUpdatingReadStatus}
        onSelectArticle={handleSelectArticle}
        onReadFilterChange={setReadFilter}
        onSearchQueryChange={setSearchQuery}
        onToggleReadStatus={handleToggleReadStatus}
        onToggleFavorite={handleToggleFavorite}
        onToggleReadLater={handleToggleReadLater}
        onMarkCurrentFeedRead={handleMarkCurrentFeedRead}
      />

      <article className="reader">
        {errorMessage && <div className="error-box">{errorMessage}</div>}
        {selectionOverlay && (
          <div
            className="selection-floating-panel"
            style={{
              left: `${selectionOverlay.x}px`,
              top: `${selectionOverlay.y}px`,
            }}
          >
            <div className="selection-floating-text">{selectionOverlay.text}</div>
            <div className="selection-floating-actions">
              <button
                type="button"
                onClick={handleTranslateSelection}
                disabled={isTranslatingSelection}
              >
                {isTranslatingSelection ? "翻译中..." : "翻译"}
              </button>
              <button
                type="button"
                onClick={clearSelectionOverlay}
              >
                关闭
              </button>
            </div>
            {selectionTranslation && (
              <div className="selection-floating-translation">{selectionTranslation}</div>
            )}
          </div>
        )}
        {selectedArticle || readerPdfUrl ? (
          <>
            <div className="reader-header">
              <div className="reader-heading">
                {selectedArticle && (
                  <div className="article-meta">
                    <span>{selectedArticle.author ?? "未知作者"}</span>
                    <span>
                      {selectedArticle.publishedAt
                        ? new Date(selectedArticle.publishedAt).toLocaleDateString("zh-CN")
                        : ""}
                    </span>
                  </div>
                )}
                <h2>{displayTitle}</h2>
              </div>
              <div className="reader-actions">
                <button
                  type="button"
                  onClick={() => handleSummarize()}
                  disabled={isSummarizing || !selectedArticle}
                  className={isSummarizing ? "action-loading" : ""}
                >
                  {isSummarizing ? "Summarizing..." : selectedArticle?.summary ? "Regenerate Summary" : "Summary"}
                </button>
                <button
                  type="button"
                  onClick={() => handleTranslate()}
                  disabled={isTranslating || !selectedArticle}
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

            {selectedArticle?.summary && (
              <div className="ai-result-section">
                <div className="ai-result-label">Summary</div>
                <div className="ai-result-content">{selectedArticle.summary}</div>
              </div>
            )}

            {selectedArticle && (
              <div className="view-tabs-section">
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
                    disabled={!hasActiveTranslation}
                    title={hasActiveTranslation ? "Show translation only" : "请先生成当前语言译文"}
                  >
                    Translation
                  </button>
                  <button
                    type="button"
                    className={readView === "bilingual" ? "view-tab active" : "view-tab"}
                    onClick={() => setReadView("bilingual")}
                    disabled={!hasActiveTranslation}
                    title={hasActiveTranslation ? "Show original and translation" : "请先生成当前语言译文"}
                  >
                    Bilingual
                  </button>
                </div>
                {!hasActiveTranslation && (
                  <div className="view-tabs-hint">请先点击 Translate 生成当前所选语言的译文后再切换双语视图。</div>
                )}
              </div>
            )}

            <div className="reader-content">
              {contentStatusLabel && (
                <div className="content-status" aria-live="polite">
                  {contentStatusLabel}
                </div>
              )}
              {readerPdfUrl ? (
                <iframe
                  className="reader-document-frame"
                  src={readerPdfUrl}
                  title={readerPdfTitle ?? "PDF Document"}
                />
              ) : (
                <>
              {(readView === "original" || readView === "bilingual") && (
                <div
                  ref={readerHtmlRef}
                  className="reader-html-content"
                  onMouseUp={handleReaderSelection}
                  onClick={handleReaderContentClick}
                  dangerouslySetInnerHTML={{ __html: readerHtml }}
                />
              )}

              {(readView === "translation" || readView === "bilingual") && hasActiveTranslation && selectedArticle?.translation && (
                <div className="translation-block">
                  <h3>Translation</h3>
                  <p>{selectedArticle.translation}</p>
                </div>
              )}
                </>
              )}
            </div>
            <div className="reader-footer">
              <button
                type="button"
                className="reader-back-button"
                onClick={handleReaderBack}
                disabled={readerHistory.length === 0}
                title={readerHistory.length > 0 ? "返回上一篇阅读内容" : "当前没有可返回的文章"}
              >
                返回上一页
              </button>
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
