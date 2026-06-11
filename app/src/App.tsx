import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { ArticleList } from "./components/ArticleList";
import type { Feed, Article, ReadFilter, UnreadSummary, SyncStatus, Annotation } from "./types";
import "./App.css";

/* ── Mock data (pure frontend dev — Tauri invoke unavailable) ── */
const MOCK_FEEDS: Feed[] = [];
const MOCK_ARTICLES: Article[] = [];

type ReadView = "original" | "translation" | "bilingual";
type ReaderSnapshot = {
  article: Article | null;
  pdfUrl: string | null;
  pdfTitle: string | null;
  originalUrl: string | null;
  originalTitle: string | null;
};
type SelectionOverlay = {
  text: string;
  x: number;
  y: number;
};
type PendingTextSelection = {
  selectedText: string;
  prefixText: string;
  suffixText: string;
  startOffset: number;
  endOffset: number;
};
type SearchScope = "all" | "feed";
type HighlightStyle = "background" | "text" | "underline";

const SMART_FAVORITES = "favorites";
const SMART_READ_LATER = "read-later";
const HIGHLIGHT_COLORS = ["#ffd400", "#ff5f67", "#58b83d", "#33a6d8", "#9b7de3", "#d85be9", "#f59a32", "#a3a3a3"];
const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0];
const DEFAULT_HIGHLIGHT_STYLE: HighlightStyle = "background";
const DEFAULT_READER_FONT_SCALE = 1;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, query: string): ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return text;
  const pattern = new RegExp(`(${escapedPattern(normalizedQuery)})`, "gi");
  return text.split(pattern).map((part, index) =>
    part.toLocaleLowerCase() === normalizedQuery.toLocaleLowerCase() ? (
      <mark className="search-highlight" key={`${part}-${index}`}>
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function textMatchesQuery(text: string | null | undefined, query: string) {
  return Boolean(query.trim() && text?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
}

function countQueryMatches(text: string | null | undefined, query: string) {
  const normalizedQuery = query.trim();
  if (!text || !normalizedQuery) return 0;
  return Array.from(text.matchAll(new RegExp(escapedPattern(normalizedQuery), "gi"))).length;
}

function leadingWhitespaceLength(value: string) {
  return value.length - value.trimStart().length;
}

function normalizeHighlightStyle(value: string | null | undefined): HighlightStyle {
  return value === "text" || value === "underline" || value === "background"
    ? value
    : DEFAULT_HIGHLIGHT_STYLE;
}

function normalizeReaderFontScale(value: number | null | undefined) {
  if (!value || Number.isNaN(value)) return DEFAULT_READER_FONT_SCALE;
  return Math.min(1.4, Math.max(0.8, value));
}

function locateHighlights(html: string, annotations: Annotation[], searchQuery: string) {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");

  for (const annotation of annotations.filter((item) => item.kind === "highlight")) {
    const selectedText = annotation.selectedText?.trim();
    if (!selectedText) continue;

    const fullText = document.body.textContent ?? "";
    let start = annotation.startOffset ?? -1;
    if (start < 0 || fullText.slice(start, start + selectedText.length) !== selectedText) {
      const contextualMatch = `${annotation.prefixText ?? ""}${selectedText}${annotation.suffixText ?? ""}`;
      const contextualStart = contextualMatch ? fullText.indexOf(contextualMatch) : -1;
      start =
        contextualStart >= 0
          ? contextualStart + (annotation.prefixText?.length ?? 0)
          : fullText.indexOf(selectedText);
    }

    if (start < 0) continue;

    const end = start + selectedText.length;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let cursor = 0;
    let startNode: Node | null = null;
    let endNode: Node | null = null;
    let startInNode = 0;
    let endInNode = 0;
    let node = walker.nextNode();

    while (node) {
      const nextCursor = cursor + (node.textContent?.length ?? 0);
      if (!startNode && start >= cursor && start < nextCursor) {
        startNode = node;
        startInNode = start - cursor;
      }
      if (!endNode && end > cursor && end <= nextCursor) {
        endNode = node;
        endInNode = end - cursor;
        break;
      }
      cursor = nextCursor;
      node = walker.nextNode();
    }

    if (!startNode || !endNode) continue;

    const range = document.createRange();
    range.setStart(startNode, startInNode);
    range.setEnd(endNode, endInNode);
    const mark = document.createElement("mark");
    const style = normalizeHighlightStyle(annotation.highlightStyle);
    const color = annotation.highlightColor || DEFAULT_HIGHLIGHT_COLOR;
    mark.className = `annotation-highlight annotation-highlight-${style}`;
    mark.dataset.annotationId = annotation.id;
    mark.style.setProperty("--annotation-color", color);
    mark.append(range.extractContents());
    range.insertNode(mark);
  }

  const normalizedQuery = searchQuery.trim();
  if (normalizedQuery) {
    const pattern = new RegExp(escapedPattern(normalizedQuery), "gi");
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node as Text);
      node = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const text = textNode.textContent ?? "";
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;

      pattern.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0;
        fragment.append(text.slice(cursor, index));
        const mark = document.createElement("mark");
        mark.className = "search-highlight";
        mark.textContent = match[0];
        fragment.append(mark);
        cursor = index + match[0].length;
      }
      fragment.append(text.slice(cursor));
      textNode.replaceWith(fragment);
    }
  }

  return document.body.innerHTML;
}

function App() {
  const readerHtmlRef = useRef<HTMLDivElement | null>(null);
  const annotationPanelRef = useRef<HTMLElement | null>(null);
  const pendingTextSelectionRef = useRef<PendingTextSelection | null>(null);
  const suppressSelectionUntilRef = useRef(0);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [searchResults, setSearchResults] = useState<Article[] | null>(null);
  const [allArticleCount, setAllArticleCount] = useState(0);
  const [allUnreadCount, setAllUnreadCount] = useState(0);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [readerArticle, setReaderArticle] = useState<Article | null>(null);
  const [readerPdfUrl, setReaderPdfUrl] = useState<string | null>(null);
  const [readerPdfTitle, setReaderPdfTitle] = useState<string | null>(null);
  const [readerOriginalUrl, setReaderOriginalUrl] = useState<string | null>(null);
  const [readerOriginalTitle, setReaderOriginalTitle] = useState<string | null>(null);
  const [readerHistory, setReaderHistory] = useState<ReaderSnapshot[]>([]);
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState<SearchScope>("all");
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [isAnnotationDrawerOpen, setIsAnnotationDrawerOpen] = useState(false);
  const [newNoteDraft, setNewNoteDraft] = useState<string | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [annotationMessage, setAnnotationMessage] = useState<string | null>(null);
  const [selectedHighlightColor, setSelectedHighlightColor] = useState(DEFAULT_HIGHLIGHT_COLOR);
  const [selectedHighlightStyle, setSelectedHighlightStyle] = useState<HighlightStyle>(DEFAULT_HIGHLIGHT_STYLE);
  const [readerFontScale, setReaderFontScale] = useState(DEFAULT_READER_FONT_SCALE);
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
      const listFeedId =
        feedId === "all" || feedId === SMART_FAVORITES || feedId === SMART_READ_LATER
          ? null
          : feedId;
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
      setSearchResults(null);
      setActiveSearchQuery("");
      setSearchMatchIndex(0);
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

  function mergeArticle(updated: Article) {
    setArticles((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
    setSearchResults((prev) =>
      prev?.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)) ?? null,
    );
    setReaderArticle((prev) => (prev?.id === updated.id ? { ...prev, ...updated } : prev));
  }

  function resetSearch() {
    setSearchQuery("");
    setSearchScope("all");
    setSearchResults(null);
    setActiveSearchQuery("");
    setSearchMatchIndex(0);
  }

  async function runSearch(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const query = searchQuery.trim();
    if (!query) {
      resetSearch();
      return;
    }
    const feedId =
      searchScope === "feed" && !["all", SMART_FAVORITES, SMART_READ_LATER].includes(selectedFeedId)
        ? selectedFeedId
        : null;
    try {
      setErrorMessage(null);
      setSearchResults(await invoke<Article[]>("search_articles", { query, feedId }));
      setActiveSearchQuery(query);
      setSearchMatchIndex(0);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleFavorite(article: Article) {
    try {
      mergeArticle(
        await invoke<Article>("set_article_favorite", {
          articleId: article.id,
          isFavorite: !article.isFavorite,
        }),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleReadLater(article: Article) {
    try {
      mergeArticle(
        await invoke<Article>("set_article_read_later", {
          articleId: article.id,
          readLater: !article.readLater,
        }),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const visibleArticles = useMemo(() => {
    const source = searchResults ?? articles;
    const smartMatchedArticles = source.filter((article) => {
      if (selectedFeedId === SMART_FAVORITES) return article.isFavorite;
      if (selectedFeedId === SMART_READ_LATER) return article.readLater;
      return true;
    });

    const filterMatchedArticles = smartMatchedArticles.filter((article) => {
      if (readFilter === "all") return true;
      return readFilter === "read" ? article.isRead : !article.isRead;
    });

    return filterMatchedArticles;
  }, [articles, readFilter, searchResults, selectedFeedId]);

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

  const selectedArticle = readerPdfUrl || readerOriginalUrl ? null : (readerArticle ?? selectedListArticle);
  const displayTitle = readerPdfTitle ?? readerOriginalTitle ?? selectedArticle?.title ?? "";

  const readerHtml = useMemo(() => {
    if (!selectedArticle) return "";
    const source = selectedArticle.cleanedHtml?.trim()
      ? selectedArticle.cleanedHtml
      : selectedArticle.content?.trim()
        ? selectedArticle.content
        : selectedArticle.excerpt.trim()
          ? `<p>${escapeHtml(selectedArticle.excerpt)}</p>`
          : "<p>暂无可显示内容</p>";
    return locateHighlights(source, annotations, activeSearchQuery);
  }, [activeSearchQuery, annotations, selectedArticle]);

  const bodySearchMatchCount = useMemo(() => {
    if (!readerHtml || !activeSearchQuery) return 0;
    const document = new DOMParser().parseFromString(`<body>${readerHtml}</body>`, "text/html");
    return document.body.querySelectorAll(".search-highlight").length;
  }, [activeSearchQuery, readerHtml]);

  const annotationSearchMatchCount = useMemo(
    () =>
      annotations.reduce(
        (sum, annotation) =>
          sum +
          countQueryMatches(annotation.selectedText, activeSearchQuery) +
          countQueryMatches(annotation.noteText, activeSearchQuery),
        0,
      ),
    [activeSearchQuery, annotations],
  );
  const totalSearchMatchCount = bodySearchMatchCount + annotationSearchMatchCount;

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

        mergeArticle(updatedArticle);
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
    setReaderOriginalUrl(null);
    setReaderOriginalTitle(null);
    setReaderHistory([]);
    setSelectionOverlay(null);
    setSelectionTranslation(null);
    setIsAnnotationDrawerOpen(false);
  }, [selectedFeedId, readFilter]);

  useEffect(() => {
    setAnnotations([]);
    setIsAnnotationDrawerOpen(false);
    setNewNoteDraft(null);
    setEditingAnnotationId(null);
    setAnnotationDraft("");
    setPendingDeleteId(null);
    setAnnotationMessage(null);
    if (!selectedArticle?.id || readerPdfUrl || readerOriginalUrl) return;
    const articleId = selectedArticle.id;
    let cancelled = false;
    async function loadAnnotations() {
      try {
        const nextAnnotations = await invoke<Annotation[]>("list_annotations", {
          articleId,
        });
        if (!cancelled) setAnnotations(nextAnnotations);
      } catch (error) {
        if (!cancelled) setAnnotationMessage(error instanceof Error ? error.message : String(error));
      }
    }
    void loadAnnotations();
    return () => {
      cancelled = true;
    };
  }, [readerOriginalUrl, readerPdfUrl, selectedArticle?.id]);

  const contentStatusLabel = useMemo(() => {
    if (readerPdfUrl) return "正在预览 PDF 文档";
    if (readerOriginalUrl) return "正在查看原文网页";
    if (!selectedArticle) return null;
    if (isOpeningReaderLink) return "正在打开文章...";
    if (isCleaningArticle) return "正在清洗正文...";
    if (selectedArticle.cleanedHtml?.trim()) return "已显示清洗正文";
    if (selectedArticle.content?.trim()) return "当前显示 Feed 原文";
    if (selectedArticle.excerpt.trim()) return "当前显示 Feed 摘要";
    return "暂无正文内容";
  }, [isCleaningArticle, isOpeningReaderLink, readerOriginalUrl, readerPdfUrl, selectedArticle]);

  const originalArticleUrl = selectedArticle?.finalUrl?.trim() || selectedArticle?.url?.trim() || "";

  function isPdfUrl(url: string) {
    return /\.pdf(?:$|[?#])/i.test(url);
  }

  function buildReaderSnapshot(): ReaderSnapshot {
    return {
      article: selectedArticle,
      pdfUrl: readerPdfUrl,
      pdfTitle: readerPdfTitle,
      originalUrl: readerOriginalUrl,
      originalTitle: readerOriginalTitle,
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
        setReaderOriginalUrl(null);
        setReaderOriginalTitle(null);
        setReadView("original");
        return;
      }

      const openedArticle = await invoke<Article>("fetch_and_clean_article", { url });
      setReaderHistory((prev) => [...prev, buildReaderSnapshot()]);
      setReaderArticle(openedArticle);
      setReaderPdfUrl(null);
      setReaderPdfTitle(null);
      setReaderOriginalUrl(null);
      setReaderOriginalTitle(null);
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
    setReaderOriginalUrl(null);
    setReaderOriginalTitle(null);
    setReaderHistory([]);
    setSelectionOverlay(null);
    setSelectionTranslation(null);
    pendingTextSelectionRef.current = null;
    setSelectedArticleId(articleId);
    setReadView("original");
  }

  function handleSelectFeed(feedId: string) {
    setReaderArticle(null);
    setReaderPdfUrl(null);
    setReaderPdfTitle(null);
    setReaderOriginalUrl(null);
    setReaderOriginalTitle(null);
    setReaderHistory([]);
    setSelectionOverlay(null);
    setSelectionTranslation(null);
    pendingTextSelectionRef.current = null;
    setSelectedFeedId(feedId);
    setReadView("original");
    setReadFilter("all");
    resetSearch();
  }

  function handleReaderBack() {
    setReaderHistory((prev) => {
      if (prev.length === 0) return prev;
      const nextHistory = prev.slice(0, -1);
      const previousSnapshot = prev[prev.length - 1] ?? null;
      setReaderArticle(previousSnapshot?.article ?? null);
      setReaderPdfUrl(previousSnapshot?.pdfUrl ?? null);
      setReaderPdfTitle(previousSnapshot?.pdfTitle ?? null);
      setReaderOriginalUrl(previousSnapshot?.originalUrl ?? null);
      setReaderOriginalTitle(previousSnapshot?.originalTitle ?? null);
      setSelectionOverlay(null);
      setSelectionTranslation(null);
      pendingTextSelectionRef.current = null;
      return nextHistory;
    });
  }

  function clearSelectionOverlay() {
    suppressSelectionUntilRef.current = Date.now() + 200;
    setSelectionOverlay(null);
    setSelectionTranslation(null);
    pendingTextSelectionRef.current = null;
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
      pendingTextSelectionRef.current = null;
      return;
    }

    const anchorNode = selection?.anchorNode;
    const readerRoot = readerHtmlRef.current;
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    if (
      !(readerRoot instanceof HTMLElement) ||
      !anchorNode ||
      !readerRoot.contains(anchorNode) ||
      !range ||
      !readerRoot.contains(range.commonAncestorContainer)
    ) {
      return;
    }

    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 600) {
      return;
    }

    const rect = range?.getBoundingClientRect();
    if (!range || !rect) return;
    const rawSelectedText = range.toString();
    const selectedText = rawSelectedText.trim();
    const leadingWhitespace = leadingWhitespaceLength(rawSelectedText);
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(readerRoot);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const startOffset = beforeRange.toString().length + leadingWhitespace;
    const fullText = readerRoot.textContent ?? "";
    pendingTextSelectionRef.current = {
      selectedText,
      prefixText: fullText.slice(Math.max(0, startOffset - 30), startOffset),
      suffixText: fullText.slice(startOffset + selectedText.length, startOffset + selectedText.length + 30),
      startOffset,
      endOffset: startOffset + selectedText.length,
    };
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

  async function handleViewOriginal() {
    if (!originalArticleUrl) {
      setErrorMessage("No original article URL is available.");
      return;
    }

    setErrorMessage(null);
    setReaderHistory((prev) => [...prev, buildReaderSnapshot()]);
    setReaderArticle(null);
    setReaderPdfUrl(null);
    setReaderPdfTitle(null);
    setReaderOriginalUrl(originalArticleUrl);
    setReaderOriginalTitle(selectedArticle?.title ? `Original: ${selectedArticle.title}` : "Original Article");
    setReadView("original");
  }

  async function createHighlight() {
    const root = readerHtmlRef.current;
    const selection = window.getSelection();
    setIsAnnotationDrawerOpen(true);
    setNewNoteDraft(null);
    setPendingDeleteId(null);
    if (!root || !selectedArticle) {
      setAnnotationMessage("Select text inside the article first.");
      return;
    }

    let pendingSelection = pendingTextSelectionRef.current;
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (root.contains(range.commonAncestorContainer)) {
        const rawSelectedText = range.toString();
        const selectedText = rawSelectedText.trim();
        if (selectedText) {
          const leadingWhitespace = leadingWhitespaceLength(rawSelectedText);
          const beforeRange = range.cloneRange();
          beforeRange.selectNodeContents(root);
          beforeRange.setEnd(range.startContainer, range.startOffset);
          const startOffset = beforeRange.toString().length + leadingWhitespace;
          const fullText = root.textContent ?? "";
          pendingSelection = {
            selectedText,
            prefixText: fullText.slice(Math.max(0, startOffset - 30), startOffset),
            suffixText: fullText.slice(startOffset + selectedText.length, startOffset + selectedText.length + 30),
            startOffset,
            endOffset: startOffset + selectedText.length,
          };
          pendingTextSelectionRef.current = pendingSelection;
        }
      }
    }

    if (!pendingSelection?.selectedText.trim()) {
      setAnnotationMessage("Select text inside the article first.");
      return;
    }

    try {
      const annotation = await invoke<Annotation>("create_annotation", {
        articleId: selectedArticle.id,
        kind: "highlight",
        selectedText: pendingSelection.selectedText,
        prefixText: pendingSelection.prefixText,
        suffixText: pendingSelection.suffixText,
        startOffset: pendingSelection.startOffset,
        endOffset: pendingSelection.endOffset,
        noteText: null,
        highlightColor: selectedHighlightColor,
        highlightStyle: selectedHighlightStyle,
      });
      selection?.removeAllRanges();
      pendingTextSelectionRef.current = null;
      setSelectionOverlay(null);
      setAnnotations((current) => [...current, annotation]);
      setEditingAnnotationId(annotation.id);
      setAnnotationDraft("");
      setAnnotationMessage("Highlight saved. Add an optional note below.");
    } catch (error) {
      setAnnotationMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function beginCreateNote() {
    setIsAnnotationDrawerOpen(true);
    setNewNoteDraft("");
    setEditingAnnotationId(null);
    setPendingDeleteId(null);
    setAnnotationMessage(null);
  }

  async function saveNewNote() {
    if (!selectedArticle) return;
    if (!newNoteDraft?.trim()) {
      setAnnotationMessage("Write a note before saving.");
      return;
    }
    try {
      const annotation = await invoke<Annotation>("create_annotation", {
        articleId: selectedArticle.id,
        kind: "note",
        selectedText: null,
        prefixText: null,
        suffixText: null,
        startOffset: null,
        endOffset: null,
        noteText: newNoteDraft,
        highlightColor: null,
        highlightStyle: null,
      });
      setAnnotations((current) => [...current, annotation]);
      setNewNoteDraft(null);
      setAnnotationMessage(null);
    } catch (error) {
      setAnnotationMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function beginEditAnnotation(annotation: Annotation) {
    setNewNoteDraft(null);
    setEditingAnnotationId(annotation.id);
    setAnnotationDraft(annotation.noteText ?? "");
    setPendingDeleteId(null);
    setAnnotationMessage(null);
  }

  async function saveAnnotation(annotationId: string) {
    try {
      const updated = await invoke<Annotation>("update_annotation", {
        annotationId,
        noteText: annotationDraft,
      });
      setAnnotations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setEditingAnnotationId(null);
      setAnnotationDraft("");
      setAnnotationMessage(null);
    } catch (error) {
      setAnnotationMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteAnnotation(annotationId: string) {
    try {
      await invoke("delete_annotation", { annotationId });
      setAnnotations((current) => current.filter((item) => item.id !== annotationId));
      setPendingDeleteId(null);
      if (editingAnnotationId === annotationId) {
        setEditingAnnotationId(null);
        setAnnotationDraft("");
      }
    } catch (error) {
      setAnnotationMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function jumpToAnnotation(annotationId: string) {
    const mark = Array.from(
      readerHtmlRef.current?.querySelectorAll<HTMLElement>(".annotation-highlight") ?? [],
    ).find((item) => item.dataset.annotationId === annotationId);
    if (!mark) {
      setAnnotationMessage("This highlight could not be located in the article.");
      return;
    }
    mark.scrollIntoView({ behavior: "smooth", block: "center" });
    mark.classList.add("annotation-highlight-focus");
    window.setTimeout(() => mark.classList.remove("annotation-highlight-focus"), 1400);
  }

  function focusSearchMatch(index: number) {
    if (totalSearchMatchCount === 0) return;
    const normalizedIndex = (index + totalSearchMatchCount) % totalSearchMatchCount;
    setSearchMatchIndex(normalizedIndex);

    document.querySelectorAll(".current-search-match").forEach((item) => {
      item.classList.remove("current-search-match");
    });

    if (normalizedIndex < bodySearchMatchCount) {
      const mark = readerHtmlRef.current?.querySelectorAll<HTMLElement>(".search-highlight")[normalizedIndex];
      if (mark) {
        mark.classList.add("current-search-match");
        mark.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }

    setIsAnnotationDrawerOpen(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const annotationIndex = normalizedIndex - bodySearchMatchCount;
        const mark = annotationPanelRef.current?.querySelectorAll<HTMLElement>(".search-highlight")[annotationIndex];
        if (mark) {
          mark.classList.add("current-search-match");
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    });
  }

  useEffect(() => {
    if (!activeSearchQuery) return;
    const frame = window.requestAnimationFrame(() => {
      const firstMatch = readerHtmlRef.current?.querySelector(".search-highlight");
      if (firstMatch) {
        setSearchMatchIndex(0);
        firstMatch.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const annotationMatch = annotations.some((annotation) =>
        textMatchesQuery(annotation.selectedText, activeSearchQuery) ||
        textMatchesQuery(annotation.noteText, activeSearchQuery),
      );
      if (annotationMatch) setIsAnnotationDrawerOpen(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSearchQuery, annotations, selectedArticle?.id, readerHtml]);

  return (
    <main className="app-shell">
      <Sidebar
        feeds={feeds}
        allArticleCount={allArticleCount}
        allUnreadCount={allUnreadCount}
        favoriteCount={articles.filter((article) => article.isFavorite).length}
        readLaterCount={articles.filter((article) => article.readLater).length}
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
        searchScope={searchScope}
        activeSearchQuery={activeSearchQuery}
        searchMatchLabel={
          activeSearchQuery
            ? totalSearchMatchCount === 0
              ? "0 / 0"
              : `${searchMatchIndex + 1} / ${totalSearchMatchCount}`
            : null
        }
        isUpdatingReadStatus={isUpdatingReadStatus}
        onSelectArticle={handleSelectArticle}
        onReadFilterChange={setReadFilter}
        onSearchQueryChange={setSearchQuery}
        onSearchScopeChange={setSearchScope}
        onSearch={runSearch}
        onClearSearch={resetSearch}
        onPreviousSearchMatch={() => focusSearchMatch(searchMatchIndex - 1)}
        onNextSearchMatch={() => focusSearchMatch(searchMatchIndex + 1)}
        onToggleReadStatus={handleToggleReadStatus}
        onToggleFavorite={toggleFavorite}
        onToggleReadLater={toggleReadLater}
        onMarkCurrentFeedRead={handleMarkCurrentFeedRead}
        highlightText={(text) => highlightText(text, activeSearchQuery)}
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
            <div className="highlight-color-row" aria-label="Highlight colors">
              {HIGHLIGHT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={color === selectedHighlightColor ? "highlight-color active" : "highlight-color"}
                  style={{ backgroundColor: color }}
                  aria-label={`Use highlight color ${color}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setSelectedHighlightColor(color)}
                />
              ))}
            </div>
            <div className="highlight-style-row" aria-label="Highlight style">
              {(["background", "text", "underline"] as const).map((style) => (
                <button
                  key={style}
                  type="button"
                  className={style === selectedHighlightStyle ? "highlight-style active" : "highlight-style"}
                  style={{ "--sample-color": selectedHighlightColor } as CSSProperties}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setSelectedHighlightStyle(style)}
                >
                  {style === "background" ? "A" : style === "text" ? "A" : "A"}
                  <span
                    className={`highlight-style-sample ${style}`}
                    style={{ "--sample-color": selectedHighlightColor } as CSSProperties}
                  />
                </button>
              ))}
            </div>
            <div className="selection-floating-actions">
              <button
                type="button"
                onClick={handleTranslateSelection}
                disabled={isTranslatingSelection}
              >
                {isTranslatingSelection ? "Translating..." : "Translate"}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void createHighlight()}
              >
                Highlight
              </button>
              <button
                type="button"
                onClick={clearSelectionOverlay}
              >
                Close
              </button>
            </div>
            {selectionTranslation && (
              <div className="selection-floating-translation">{selectionTranslation}</div>
            )}
          </div>
        )}
        {selectedArticle || readerPdfUrl || readerOriginalUrl ? (
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
                  onClick={() => void handleViewOriginal()}
                  disabled={!originalArticleUrl}
                >
                  View Original
                </button>
                <button
                  type="button"
                  className={isAnnotationDrawerOpen ? "active" : ""}
                  onClick={() => setIsAnnotationDrawerOpen((current) => !current)}
                  disabled={!selectedArticle || !!readerPdfUrl}
                >
                  Annotations ({annotations.length})
                </button>
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
                <label className="reader-font-control" title="Adjust reader font size">
                  <span>Aa</span>
                  <input
                    type="range"
                    min="0.8"
                    max="1.4"
                    step="0.05"
                    value={readerFontScale}
                    onChange={(event) => setReaderFontScale(normalizeReaderFontScale(Number(event.target.value)))}
                  />
                  <span>{Math.round(readerFontScale * 100)}%</span>
                </label>
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

            <div className={isAnnotationDrawerOpen ? "reader-content with-annotations" : "reader-content"}>
              {contentStatusLabel && (
                <div className="content-status" aria-live="polite">
                  {contentStatusLabel}
                </div>
              )}
              {readerPdfUrl || readerOriginalUrl ? (
                <iframe
                  className="reader-document-frame"
                  src={readerPdfUrl ?? readerOriginalUrl ?? ""}
                  title={readerPdfTitle ?? readerOriginalTitle ?? "Original Article"}
                />
              ) : (
                <div className={isAnnotationDrawerOpen ? "reader-workspace with-annotations" : "reader-workspace"}>
                  <div
                    className="reader-article-pane"
                    style={{ "--reader-font-scale": readerFontScale } as CSSProperties}
                  >
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
                  </div>
                  {isAnnotationDrawerOpen && selectedArticle && (
                    <aside ref={annotationPanelRef} className="annotation-panel">
                      <div className="annotation-panel-header">
                        <strong>Annotations ({annotations.length})</strong>
                        <button type="button" onClick={() => setIsAnnotationDrawerOpen(false)}>
                          Close
                        </button>
                      </div>
                      <div className="annotation-toolbar">
                        <button type="button" onClick={beginCreateNote}>
                          Add note
                        </button>
                        <button type="button" onClick={() => void createHighlight()}>
                          Highlight selection
                        </button>
                      </div>
                      {annotationMessage && <p className="annotation-message">{annotationMessage}</p>}
                      {newNoteDraft !== null && (
                        <div className="annotation-editor">
                          <label htmlFor="new-note">New article note</label>
                          <textarea
                            id="new-note"
                            value={newNoteDraft}
                            onChange={(event) => setNewNoteDraft(event.target.value)}
                            rows={5}
                            autoFocus
                          />
                          <div className="annotation-actions">
                            <button className="primary-button" type="button" onClick={() => void saveNewNote()}>
                              Save
                            </button>
                            <button type="button" onClick={() => setNewNoteDraft(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                      {annotations.length === 0 && <p className="annotation-empty">No annotations yet.</p>}
                      {annotations.map((annotation) => (
                        <div className="annotation-card" key={annotation.id}>
                          <small>{annotation.kind === "highlight" ? "Highlight" : "Note"}</small>
                          {annotation.selectedText && (
                            <button
                              className={`annotation-quote annotation-quote-${normalizeHighlightStyle(annotation.highlightStyle)}`}
                              style={{ "--annotation-color": annotation.highlightColor || DEFAULT_HIGHLIGHT_COLOR } as CSSProperties}
                              type="button"
                              onClick={() => jumpToAnnotation(annotation.id)}
                            >
                              {highlightText(annotation.selectedText, activeSearchQuery)}
                            </button>
                          )}
                          {editingAnnotationId === annotation.id ? (
                            <div className="annotation-editor">
                              <label htmlFor={`annotation-${annotation.id}`}>
                                {annotation.kind === "highlight" ? "Optional highlight note" : "Note"}
                              </label>
                              <textarea
                                id={`annotation-${annotation.id}`}
                                value={annotationDraft}
                                onChange={(event) => setAnnotationDraft(event.target.value)}
                                rows={5}
                                autoFocus
                              />
                              <div className="annotation-actions">
                                <button className="primary-button" type="button" onClick={() => void saveAnnotation(annotation.id)}>
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingAnnotationId(null);
                                    setAnnotationDraft("");
                                    setAnnotationMessage(null);
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {annotation.noteText && <p>{highlightText(annotation.noteText, activeSearchQuery)}</p>}
                              {pendingDeleteId === annotation.id ? (
                                <div className="annotation-delete-confirm">
                                  <span>Delete this annotation?</span>
                                  <div className="annotation-actions">
                                    <button className="danger-button" type="button" onClick={() => void deleteAnnotation(annotation.id)}>
                                      Confirm delete
                                    </button>
                                    <button type="button" onClick={() => setPendingDeleteId(null)}>
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="annotation-actions">
                                  <button type="button" onClick={() => beginEditAnnotation(annotation)}>
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPendingDeleteId(annotation.id);
                                      setEditingAnnotationId(null);
                                      setNewNoteDraft(null);
                                    }}
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </aside>
                  )}
                </div>
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
