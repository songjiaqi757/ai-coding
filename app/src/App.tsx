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
import MarkdownIt from "markdown-it";
import { Sidebar } from "./components/Sidebar";
import { ArticleList } from "./components/ArticleList";
import type { Feed, Article, ReadFilter, UnreadSummary, SyncStatus, Annotation, AppLanguage, AiJobStatus } from "./types";
import "./App.css";

/* ── Mock data (pure frontend dev — Tauri invoke unavailable) ── */
const MOCK_FEEDS: Feed[] = [];
const MOCK_ARTICLES: Article[] = [];

type ReadView = "original" | "translation";
type ReaderSnapshot = {
  article: Article | null;
  pdfUrl: string | null;
  pdfTitle: string | null;
  originalUrl: string | null;
  originalTitle: string | null;
  originalHtml: string | null;
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
const SAVED_ARTICLES_FEED_ID = "saved";
const SAVED_ARTICLES_FEED_URL = "mercury://internal/captured-articles";
const HIGHLIGHT_COLORS = ["#ffd400", "#ff5f67", "#58b83d", "#33a6d8", "#9b7de3", "#d85be9", "#f59a32", "#a3a3a3"];
const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0];
const DEFAULT_HIGHLIGHT_STYLE: HighlightStyle = "background";
const DEFAULT_READER_FONT_SCALE = 1;
const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

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

type ReaderContentBlock = {
  id: string;
  text: string;
  html: string;
  kind: "heading" | "paragraph" | "quote" | "list" | "code";
};

function extractReaderContentBlocks(html: string): ReaderContentBlock[] {
  if (!html.trim()) return [];
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const nodes = Array.from(
    document.body.querySelectorAll("h1, h2, h3, h4, h5, h6, p, blockquote, li, pre"),
  );

  return nodes
    .map((node, index) => {
      const normalizedText = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
      if (!normalizedText) return null;
      const tagName = node.tagName.toLowerCase();
      const kind =
        tagName.startsWith("h")
          ? "heading"
          : tagName === "blockquote"
            ? "quote"
            : tagName === "pre"
              ? "code"
              : tagName === "li"
                ? "list"
                : "paragraph";

      return {
        id: `${tagName}-${index}`,
        text: normalizedText,
        html: node.outerHTML.trim(),
        kind,
      } satisfies ReaderContentBlock;
    })
    .filter((block): block is ReaderContentBlock => block !== null);
}

function stripMarkdownSyntax(text: string) {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_~`]+/g, "")
    .trim();
}

function normalizeTranslationText(text: string) {
  return stripMarkdownSyntax(text)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectArticleLanguage(article: Article | null): string {
  if (!article) return "zh";
  const sample = [
    article.title,
    article.cleanedMarkdown,
    article.cleanedHtml ? stripMarkdownSyntax(article.cleanedHtml) : "",
    article.content,
    article.excerpt,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);

  if (!sample.trim()) return "zh";

  const counts = {
    zh: (sample.match(/[\u4e00-\u9fff]/g) ?? []).length,
    ja: (sample.match(/[\u3040-\u30ff]/g) ?? []).length,
    ko: (sample.match(/[\uac00-\ud7af]/g) ?? []).length,
    en: (sample.match(/[A-Za-z]/g) ?? []).length,
  };

  if (counts.ja >= 12 && counts.ja >= counts.zh * 0.2) return "ja";
  if (counts.ko >= 12) return "ko";
  if (counts.zh >= 12) return "zh";
  if (counts.en >= 24) return "en";
  return "zh";
}

function isMetadataLine(text: string) {
  const value = text.trim();
  if (!value) return true;
  return (
    /^\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d+分钟)?$/.test(value) ||
    /^\d{4}-\d{1,2}-\d{1,2}$/.test(value) ||
    /^\d+\s*(min|mins|minutes)$/i.test(value) ||
    /^(startups|climate|ai|events|news|podcast)$/i.test(value)
  );
}

function isDecorativeMarkdownBlock(block: string) {
  const trimmed = block.trim();
  if (!trimmed) return true;

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const normalized = stripMarkdownSyntax(trimmed);
  const hasImage = /!\[[^\]]*\]\(([^)]+)\)/.test(trimmed);
  const linkMatches = Array.from(trimmed.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g));
  const onlyMetadata = lines.every((line) => isMetadataLine(stripMarkdownSyntax(line)));
  const headingCount = lines.filter((line) => /^#{1,6}\s/.test(line)).length;

  if (!normalized) return true;
  if (onlyMetadata) return true;
  if (hasImage && lines.length <= 4) return true;
  if (linkMatches.length > 0 && lines.length <= 4 && (hasImage || headingCount > 0)) return true;
  if (normalized.length < 18 && lines.length <= 2 && linkMatches.length > 0) return true;

  return false;
}

function looksLikeLiteralHtmlMarkdown(input: string | null | undefined) {
  const trimmed = input?.trim();
  if (!trimmed) return false;

  const lowercase = trimmed.toLowerCase();
  const markers = ["<p>", "</p>", "<ol>", "</ol>", "<ul>", "</ul>", "<li>", "</li>", "<h1", "<h2", "<h3", 'href="'];
  const markerCount = markers.filter((marker) => lowercase.includes(marker)).length;
  return markerCount >= 2 || (lowercase.includes("<p>") && lowercase.includes('href="'));
}

function looksLikeEncodedHtmlContent(input: string | null | undefined) {
  const trimmed = input?.trim();
  if (!trimmed) return false;

  const lowercase = trimmed.toLowerCase();
  const markers = ["&lt;p&gt;", "&lt;/p&gt;", "&lt;ol&gt;", "&lt;/ol&gt;", "&lt;ul&gt;", "&lt;/ul&gt;", "&lt;li&gt;", "&lt;/li&gt;", "&lt;h1", "&lt;h2", "&lt;h3", "href=&quot;", "href=&#34;"];
  const markerCount = markers.filter((marker) => lowercase.includes(marker)).length;
  return markerCount >= 2 || (lowercase.includes("&lt;p&gt;") && markerCount >= 1);
}

function blocksFromMarkdown(markdown: string): ReaderContentBlock[] {
  return markdown
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => !isDecorativeMarkdownBlock(block))
    .map((block, index) => {
      const normalized = stripMarkdownSyntax(block);
      const kind =
        /^#{1,6}\s/.test(block)
          ? "heading"
          : /^>\s?/.test(block)
            ? "quote"
            : /^[-*]\s|^\d+\.\s/.test(block)
              ? "list"
              : /```/.test(block)
                ? "code"
                : "paragraph";
      return {
        id: `markdown-${index}`,
        text: normalized,
        html: markdownRenderer.render(block).trim(),
        kind,
      } satisfies ReaderContentBlock;
    })
    .filter((block) => block.text);
}

function translationSourceBlocks(article: Article | null, emptyText: string): ReaderContentBlock[] {
  if (!article) return [];
  if (article.cleanedMarkdown?.trim() && !looksLikeLiteralHtmlMarkdown(article.cleanedMarkdown)) {
    const markdownBlocks = blocksFromMarkdown(article.cleanedMarkdown);
    if (markdownBlocks.length > 0) return markdownBlocks;
  }
  if (article.cleanedHtml?.trim() && !looksLikeEncodedHtmlContent(article.cleanedHtml)) {
    const htmlBlocks = extractReaderContentBlocks(article.cleanedHtml);
    if (htmlBlocks.length > 0) return htmlBlocks;
  }
  const fallback = (article.content || article.excerpt || emptyText).trim();
  return fallback
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => ({
      id: `fallback-${index}`,
      text: block,
      html: `<p>${escapeHtml(block)}</p>`,
      kind: "paragraph" as const,
    }));
}

function splitTranslationBlocks(translation: string): string[] {
  const structuredBlocks = Array.from(
    translation.matchAll(/\[BLOCK\s+(\d+)\]([\s\S]*?)\[END BLOCK\s+\1\]/g),
    (match) => normalizeTranslationText(match[2]),
  ).filter(Boolean);
  if (structuredBlocks.length > 0) return structuredBlocks;

  return translation
    .split(/\n\s*\n+/)
    .map((block) => normalizeTranslationText(block))
    .filter(Boolean);
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

function isSavedArticlesFeed(feed: Pick<Feed, "id" | "url"> | null | undefined) {
  if (!feed) return false;
  return feed.id === SAVED_ARTICLES_FEED_ID || feed.url === SAVED_ARTICLES_FEED_URL;
}

function isSavedArticlesItem(item: Pick<Article, "feedId"> | null | undefined) {
  if (!item) return false;
  return item.feedId === SAVED_ARTICLES_FEED_ID;
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
  const readerContentRef = useRef<HTMLDivElement | null>(null);
  const readerPaneRef = useRef<HTMLDivElement | null>(null);
  const annotationPanelRef = useRef<HTMLElement | null>(null);
  const pendingTextSelectionRef = useRef<PendingTextSelection | null>(null);
  const suppressSelectionUntilRef = useRef(0);
  const autoReadMarkedIdsRef = useRef<Set<string>>(new Set());
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [searchResults, setSearchResults] = useState<Article[] | null>(null);
  const [allArticleCount, setAllArticleCount] = useState(0);
  const [allUnreadCount, setAllUnreadCount] = useState(0);
  const [favoriteCount, setFavoriteCount] = useState(0);
  const [favoriteUnreadCount, setFavoriteUnreadCount] = useState(0);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [readerArticle, setReaderArticle] = useState<Article | null>(null);
  const [readerPdfUrl, setReaderPdfUrl] = useState<string | null>(null);
  const [readerPdfTitle, setReaderPdfTitle] = useState<string | null>(null);
  const [readerOriginalUrl, setReaderOriginalUrl] = useState<string | null>(null);
  const [readerOriginalTitle, setReaderOriginalTitle] = useState<string | null>(null);
  const [readerOriginalHtml, setReaderOriginalHtml] = useState<string | null>(null);
  const [readerHistory, setReaderHistory] = useState<ReaderSnapshot[]>([]);
  const [readerForwardHistory, setReaderForwardHistory] = useState<ReaderSnapshot[]>([]);
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
  const [settingsForm, setSettingsForm] = useState({
    summaryBaseUrl: "",
    summaryApiKey: "",
    summaryModelName: "",
    translationBaseUrl: "",
    translationApiKey: "",
    translationModelName: "",
  });
  const [appLanguage, setAppLanguage] = useState<AppLanguage>("zh");
  const [settingsLanguage, setSettingsLanguage] = useState<AppLanguage>("zh");
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [summaryJob, setSummaryJob] = useState<AiJobStatus | null>(null);
  const [translationJob, setTranslationJob] = useState<AiJobStatus | null>(null);
  const [selectionOverlay, setSelectionOverlay] = useState<SelectionOverlay | null>(null);
  const [selectionTranslation, setSelectionTranslation] = useState<string | null>(null);
  const [isTranslatingSelection, setIsTranslatingSelection] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [readView, setReadView] = useState<ReadView>("original");
  const [targetLang, setTargetLang] = useState("zh");
  const [summaryLang, setSummaryLang] = useState("zh");
  const [summaryCache, setSummaryCache] = useState<Record<string, Record<string, string>>>({});
  const isSummaryLangPinnedRef = useRef(false);

  // Sync status
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const isZh = appLanguage === "zh";

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

      const [nextFeeds, nextArticlesRaw, allArticlesRaw] = await Promise.all([
        invoke<Feed[]>("list_feeds"),
        articlesPromise,
        allArticlesPromise,
      ]);

      const allArticles = allArticlesRaw.filter((a) => !isSavedArticlesItem(a));
      const nextArticles = listFeedId === null
        ? nextArticlesRaw.filter((a) => !isSavedArticlesItem(a))
        : nextArticlesRaw;

      setFeeds(nextFeeds.filter((f) => !isSavedArticlesFeed(f)));
      setArticles(nextArticles);
      setSearchResults(null);
      setActiveSearchQuery("");
      setSearchMatchIndex(0);
      setAllArticleCount(allArticles.length);
      setAllUnreadCount(allArticles.filter((article) => !article.isRead).length);
      setFavoriteCount(allArticles.filter((article) => article.isFavorite).length);
      setFavoriteUnreadCount(allArticles.filter((article) => article.isFavorite && !article.isRead).length);
    } catch {
      /* Pure frontend dev — Tauri invoke unavailable, fall back to mock */
      setFeeds(MOCK_FEEDS);
      setArticles(MOCK_ARTICLES);
      setAllArticleCount(MOCK_ARTICLES.length);
      setAllUnreadCount(MOCK_ARTICLES.filter((article) => !article.isRead).length);
      setFavoriteCount(MOCK_ARTICLES.filter((article) => article.isFavorite).length);
      setFavoriteUnreadCount(MOCK_ARTICLES.filter((article) => article.isFavorite && !article.isRead).length);
    } finally {
      setIsLoading(false);
    }
  }, [selectedFeedId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    let cancelled = false;
    async function loadAppLanguage() {
      try {
        const savedLanguage = await invoke<AppLanguage | null>("load_setting", { key: "app_language" });
        if (!cancelled && (savedLanguage === "zh" || savedLanguage === "en")) {
          setAppLanguage(savedLanguage);
          setSettingsLanguage(savedLanguage);
        }
      } catch {
        // Keep default language.
      }
    }
    void loadAppLanguage();
    return () => {
      cancelled = true;
    };
  }, []);

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
      const [
        legacyBaseUrl,
        legacyApiKey,
        legacyModelName,
        summaryBaseUrl,
        summaryApiKey,
        summaryModelName,
        translationBaseUrl,
        translationApiKey,
        translationModelName,
        savedLanguage,
      ] = await Promise.all([
        invoke<string | null>("load_setting", { key: "llm_base_url" }),
        invoke<string | null>("load_setting", { key: "llm_api_key" }),
        invoke<string | null>("load_setting", { key: "llm_model_name" }),
        invoke<string | null>("load_setting", { key: "llm_summary_base_url" }),
        invoke<string | null>("load_setting", { key: "llm_summary_api_key" }),
        invoke<string | null>("load_setting", { key: "llm_summary_model_name" }),
        invoke<string | null>("load_setting", { key: "llm_translation_base_url" }),
        invoke<string | null>("load_setting", { key: "llm_translation_api_key" }),
        invoke<string | null>("load_setting", { key: "llm_translation_model_name" }),
        invoke<AppLanguage | null>("load_setting", { key: "app_language" }),
      ]);
      setSettingsForm({
        summaryBaseUrl: summaryBaseUrl ?? legacyBaseUrl ?? "",
        summaryApiKey: summaryApiKey ?? legacyApiKey ?? "",
        summaryModelName: summaryModelName ?? legacyModelName ?? "",
        translationBaseUrl: translationBaseUrl ?? legacyBaseUrl ?? "",
        translationApiKey: translationApiKey ?? legacyApiKey ?? "",
        translationModelName: translationModelName ?? legacyModelName ?? "",
      });
      setSettingsLanguage(savedLanguage === "en" ? "en" : "zh");
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
        invoke("save_setting", { key: "llm_base_url", value: settingsForm.summaryBaseUrl }),
        invoke("save_setting", { key: "llm_api_key", value: settingsForm.summaryApiKey }),
        invoke("save_setting", { key: "llm_model_name", value: settingsForm.summaryModelName }),
        invoke("save_setting", { key: "llm_summary_base_url", value: settingsForm.summaryBaseUrl }),
        invoke("save_setting", { key: "llm_summary_api_key", value: settingsForm.summaryApiKey }),
        invoke("save_setting", { key: "llm_summary_model_name", value: settingsForm.summaryModelName }),
        invoke("save_setting", { key: "llm_translation_base_url", value: settingsForm.translationBaseUrl }),
        invoke("save_setting", { key: "llm_translation_api_key", value: settingsForm.translationApiKey }),
        invoke("save_setting", { key: "llm_translation_model_name", value: settingsForm.translationModelName }),
        invoke("save_setting", { key: "app_language", value: settingsLanguage }),
      ]);
      setAppLanguage(settingsLanguage);
      setShowSettings(false);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingSettings(false);
    }
  }

  function applySummaryResult(articleId: string, lang: string, summary: string) {
      setSummaryCache((prev) => ({
        ...prev,
        [articleId]: {
          ...(prev[articleId] ?? {}),
          [lang]: summary,
        },
      }));
      setArticles((prev) =>
        prev.map((a) => (a.id === articleId ? { ...a, summary, summaryLang: lang } : a)),
      );
      setReaderArticle((prev) => (prev?.id === articleId ? { ...prev, summary, summaryLang: lang } : prev));
  }

  function applyTranslationResult(articleId: string, lang: string, translation: string) {
      setArticles((prev) =>
        prev.map((a) => (a.id === articleId ? { ...a, translation, translationLang: lang } : a)),
      );
      setReaderArticle((prev) => (prev?.id === articleId ? { ...prev, translation, translationLang: lang } : prev));
      if (selectedArticle?.id === articleId) {
        setReadView("translation");
      }
  }

  async function handleSummarize(force = false, lang = summaryLang) {
    if (!selectedArticle) return;
    try {
      setIsSummarizing(true);
      setAiError(null);
      const job = await invoke<AiJobStatus>("start_summary_job", {
        articleId: selectedArticle.id,
        targetLang: lang,
        force,
      });
      setSummaryJob(job);
      if (job.status === "completed" && job.result) {
        applySummaryResult(job.articleId, job.targetLang, job.result);
        setIsSummarizing(false);
      } else if (job.status === "failed") {
        setAiError(job.error ?? "Summary generation failed");
        setIsSummarizing(false);
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
      setIsSummarizing(false);
    }
  }

  async function handleTranslate() {
    if (!selectedArticle) return;
    try {
      setIsTranslating(true);
      setAiError(null);
      const job = await invoke<AiJobStatus>("start_translation_job", {
        articleId: selectedArticle.id,
        targetLang,
      });
      setTranslationJob(job);
      if (job.status === "completed" && job.result) {
        applyTranslationResult(job.articleId, job.targetLang, job.result);
        setIsTranslating(false);
      } else if (job.status === "failed") {
        setAiError(job.error ?? "Translation failed");
        setIsTranslating(false);
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
      setIsTranslating(false);
    }
  }

  useEffect(() => {
    if (!summaryJob || summaryJob.status !== "running") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await invoke<AiJobStatus>("get_ai_job_status", { jobId: summaryJob.id });
        if (cancelled) return;
        setSummaryJob(next);
        if (next.status === "completed") {
          if (next.result) {
            applySummaryResult(next.articleId, next.targetLang, next.result);
          }
          setIsSummarizing(false);
        } else if (next.status === "failed") {
          setAiError(next.error ?? "Summary generation failed");
          setIsSummarizing(false);
        }
      } catch (error) {
        if (!cancelled) {
          setAiError(error instanceof Error ? error.message : String(error));
          setIsSummarizing(false);
        }
      }
    };
    const timer = window.setInterval(() => void poll(), 1200);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [summaryJob?.id, summaryJob?.status]);

  useEffect(() => {
    if (!translationJob || translationJob.status !== "running") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await invoke<AiJobStatus>("get_ai_job_status", { jobId: translationJob.id });
        if (cancelled) return;
        setTranslationJob(next);
        if (next.status === "completed") {
          if (next.result) {
            applyTranslationResult(next.articleId, next.targetLang, next.result);
          }
          setIsTranslating(false);
        } else if (next.status === "failed") {
          setAiError(next.error ?? "Translation failed");
          setIsTranslating(false);
        }
      } catch (error) {
        if (!cancelled) {
          setAiError(error instanceof Error ? error.message : String(error));
          setIsTranslating(false);
        }
      }
    };
    const timer = window.setInterval(() => void poll(), 1200);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [translationJob?.id, translationJob?.status]);

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
  const hasStaleCleanedContent = !!selectedArticle && (
    looksLikeEncodedHtmlContent(selectedArticle.cleanedHtml) ||
    looksLikeLiteralHtmlMarkdown(selectedArticle.cleanedMarkdown)
  );

  const readerHtml = useMemo(() => {
    if (!selectedArticle) return "";
    const source = selectedArticle.cleanedHtml?.trim() && !looksLikeEncodedHtmlContent(selectedArticle.cleanedHtml)
      ? selectedArticle.cleanedHtml
      : selectedArticle.content?.trim()
        ? selectedArticle.content
        : selectedArticle.excerpt.trim()
          ? `<p>${escapeHtml(selectedArticle.excerpt)}</p>`
          : `<p>${isZh ? "暂无可显示内容" : "No readable content available."}</p>`;
    return locateHighlights(source, annotations, activeSearchQuery);
  }, [activeSearchQuery, annotations, isZh, selectedArticle]);

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
  const activeSummary = selectedArticle
    ? summaryCache[selectedArticle.id]?.[summaryLang] ??
      (selectedArticle.summaryLang === summaryLang ? selectedArticle.summary ?? null : null)
    : null;
  const hasActiveSummary = !!activeSummary;
  const hasActiveTranslation = !!selectedArticle?.translation && selectedArticle.translationLang === targetLang;
  const isCurrentSummaryRunning =
    !!selectedArticle &&
    isSummarizing &&
    summaryJob?.status === "running" &&
    summaryJob.articleId === selectedArticle.id &&
    summaryJob.targetLang === summaryLang;
  const isCurrentTranslationRunning =
    !!selectedArticle &&
    isTranslating &&
    translationJob?.status === "running" &&
    translationJob.articleId === selectedArticle.id &&
    translationJob.targetLang === targetLang;
  const displayedBodyLang =
    readView === "translation" && hasActiveTranslation
      ? targetLang
      : detectArticleLanguage(selectedArticle);
  const translationPairs = useMemo(() => {
    if (!hasActiveTranslation || !selectedArticle?.translation) return [];
    const originalBlocks = translationSourceBlocks(
      selectedArticle,
      isZh ? "暂无可显示内容" : "No readable content available.",
    );
    const translatedBlocks = splitTranslationBlocks(selectedArticle.translation);
    const total = Math.max(originalBlocks.length, translatedBlocks.length);
    return Array.from({ length: total }, (_, index) => ({
      id: `pair-${index}`,
      original: originalBlocks[index] ?? null,
      translation: translatedBlocks[index] ?? "",
    })).filter((pair) => pair.original || pair.translation);
  }, [hasActiveTranslation, isZh, selectedArticle]);

  useEffect(() => {
    if (!selectedArticle) return;
    const hasCleanedHtml = !!selectedArticle.cleanedHtml?.trim();
    if (hasCleanedHtml && !hasStaleCleanedContent) return;
    if (!hasStaleCleanedContent && !selectedArticle.content?.trim() && !selectedArticle.excerpt.trim()) return;

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
        setErrorMessage(error instanceof Error ? `${isZh ? "正文清洗失败" : "Content cleanup failed"}: ${error.message}` : `${isZh ? "正文清洗失败" : "Content cleanup failed"}: ${String(error)}`);
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
  }, [hasStaleCleanedContent, isZh, selectedArticle]);

  useEffect(() => {
    if (!hasActiveTranslation && readView !== "original") {
      setReadView("original");
    }
  }, [hasActiveTranslation, readView]);

  useEffect(() => {
    if (isSummaryLangPinnedRef.current) return;
    setSummaryLang(displayedBodyLang);
  }, [displayedBodyLang]);

  useEffect(() => {
    if (!selectedArticle?.id || !selectedArticle.summary || !selectedArticle.summaryLang) return;
    setSummaryCache((prev) => ({
      ...prev,
      [selectedArticle.id]: {
        ...(prev[selectedArticle.id] ?? {}),
        [selectedArticle.summaryLang as string]: selectedArticle.summary as string,
      },
    }));
  }, [selectedArticle?.id, selectedArticle?.summary, selectedArticle?.summaryLang]);

  useEffect(() => {
    if (!selectedArticle?.id) return;
    if (!selectedArticle.isRead) {
      autoReadMarkedIdsRef.current.delete(selectedArticle.id);
    }
  }, [selectedArticle?.id, selectedArticle?.isRead]);

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
    if (readerPdfUrl) return isZh ? "正在预览 PDF 文档" : "Previewing PDF document";
    if (readerOriginalUrl) return isZh ? "正在查看原文网页" : "Viewing original webpage";
    if (!selectedArticle) return null;
    if (isOpeningReaderLink) return isZh ? "正在打开文章..." : "Opening article...";
    if (isCleaningArticle) return isZh ? "正在清洗正文..." : "Cleaning article content...";
    if (selectedArticle.cleanedHtml?.trim()) return isZh ? "已显示清洗正文" : "Showing cleaned article";
    if (selectedArticle.content?.trim()) return isZh ? "当前显示 Feed 原文" : "Showing feed content";
    if (selectedArticle.excerpt.trim()) return isZh ? "当前显示 Feed 摘要" : "Showing feed excerpt";
    return isZh ? "暂无正文内容" : "No article content available";
  }, [isCleaningArticle, isOpeningReaderLink, isZh, readerOriginalUrl, readerPdfUrl, selectedArticle]);

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
      originalHtml: readerOriginalHtml,
    };
  }

  function derivePdfTitle(url: string, fallback?: string) {
    if (fallback?.trim()) return fallback.trim();
    try {
      const pathname = new URL(url).pathname;
      const segment = pathname.split("/").filter(Boolean).pop();
      return segment || (isZh ? "PDF 文档" : "PDF Document");
    } catch {
      return isZh ? "PDF 文档" : "PDF Document";
    }
  }

  async function openArticleInReader(url: string, fallbackTitle?: string) {
    try {
      setIsOpeningReaderLink(true);
      setErrorMessage(null);

      if (isPdfUrl(url)) {
        setReaderHistory((prev) => [...prev, buildReaderSnapshot()]);
        setReaderForwardHistory([]);
        setReaderArticle(null);
        setReaderPdfUrl(url);
        setReaderPdfTitle(derivePdfTitle(url, fallbackTitle));
        setReaderOriginalUrl(null);
        setReaderOriginalTitle(null);
        setReaderOriginalHtml(null);
        setReadView("original");
        return;
      }

      const openedArticle = await invoke<Article>("fetch_and_clean_article", { url });
      setReaderHistory((prev) => [...prev, buildReaderSnapshot()]);
      setReaderForwardHistory([]);
      setReaderArticle(openedArticle);
      setReaderPdfUrl(null);
      setReaderPdfTitle(null);
      setReaderOriginalUrl(null);
      setReaderOriginalTitle(null);
      setReaderOriginalHtml(null);
      setReadView("original");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? `${isZh ? "打开文章失败" : "Failed to open article"}: ${error.message}` : `${isZh ? "打开文章失败" : "Failed to open article"}: ${String(error)}`,
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
    setReaderOriginalHtml(null);
    setReaderHistory([]);
    setReaderForwardHistory([]);
    setSelectionOverlay(null);
    setSelectionTranslation(null);
    pendingTextSelectionRef.current = null;
    isSummaryLangPinnedRef.current = false;
    setSelectedArticleId(articleId);
    setReadView("original");
  }

  function handleSelectFeed(feedId: string) {
    setReaderArticle(null);
    setReaderPdfUrl(null);
    setReaderPdfTitle(null);
    setReaderOriginalUrl(null);
    setReaderOriginalTitle(null);
    setReaderOriginalHtml(null);
    setReaderHistory([]);
    setReaderForwardHistory([]);
    setSelectionOverlay(null);
    setSelectionTranslation(null);
    pendingTextSelectionRef.current = null;
    setSelectedFeedId(feedId);
    setReadView("original");
    setReadFilter("all");
    resetSearch();
  }

  function handleReaderBack() {
    const currentSnapshot = buildReaderSnapshot();
    setReaderHistory((prev) => {
      if (prev.length === 0) return prev;
      const nextHistory = prev.slice(0, -1);
      const previousSnapshot = prev[prev.length - 1] ?? null;
      setReaderForwardHistory((forward) => [...forward, currentSnapshot]);
      setReaderArticle(previousSnapshot?.article ?? null);
      setReaderPdfUrl(previousSnapshot?.pdfUrl ?? null);
      setReaderPdfTitle(previousSnapshot?.pdfTitle ?? null);
      setReaderOriginalUrl(previousSnapshot?.originalUrl ?? null);
      setReaderOriginalTitle(previousSnapshot?.originalTitle ?? null);
      setReaderOriginalHtml(previousSnapshot?.originalHtml ?? null);
      setSelectionOverlay(null);
      setSelectionTranslation(null);
      pendingTextSelectionRef.current = null;
      return nextHistory;
    });
  }

  function handleReaderForward() {
    const currentSnapshot = buildReaderSnapshot();
    setReaderForwardHistory((prev) => {
      if (prev.length === 0) return prev;
      const nextForwardHistory = prev.slice(0, -1);
      const nextSnapshot = prev[prev.length - 1] ?? null;
      setReaderHistory((back) => [...back, currentSnapshot]);
      setReaderArticle(nextSnapshot?.article ?? null);
      setReaderPdfUrl(nextSnapshot?.pdfUrl ?? null);
      setReaderPdfTitle(nextSnapshot?.pdfTitle ?? null);
      setReaderOriginalUrl(nextSnapshot?.originalUrl ?? null);
      setReaderOriginalTitle(nextSnapshot?.originalTitle ?? null);
      setReaderOriginalHtml(nextSnapshot?.originalHtml ?? null);
      setSelectionOverlay(null);
      setSelectionTranslation(null);
      pendingTextSelectionRef.current = null;
      return nextForwardHistory;
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

  function tryAutoMarkArticleRead(container: HTMLDivElement | null) {
    if (readerPdfUrl || readerOriginalUrl || !selectedArticle || selectedArticle.isRead) return;
    if (autoReadMarkedIdsRef.current.has(selectedArticle.id)) return;
    if (!container) return;

    const scrollableHeight = container.scrollHeight - container.clientHeight;
    if (scrollableHeight <= 120) return;

    const progress = container.scrollTop / scrollableHeight;
    const reachedBottom = scrollableHeight - container.scrollTop <= 24;
    if (!reachedBottom && progress < 0.35) return;

    autoReadMarkedIdsRef.current.add(selectedArticle.id);
    void handleToggleReadStatus(selectedArticle);
  }

  function handleReaderContentScroll() {
    if (isAnnotationDrawerOpen) return;
    tryAutoMarkArticleRead(readerContentRef.current);
  }

  function handleReaderPaneScroll() {
    if (!isAnnotationDrawerOpen) return;
    tryAutoMarkArticleRead(readerPaneRef.current);
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
      setErrorMessage(isZh ? "没有可用的原文链接。" : "No original article URL is available.");
      return;
    }

    try {
      setIsOpeningReaderLink(true);
      setErrorMessage(null);
      const originalHtml = await invoke<string>("fetch_article_html", { url: originalArticleUrl });
      setReaderHistory((prev) => [...prev, buildReaderSnapshot()]);
      setReaderForwardHistory([]);
      setReaderArticle(null);
      setReaderPdfUrl(null);
      setReaderPdfTitle(null);
      setReaderOriginalUrl(originalArticleUrl);
      setReaderOriginalTitle(selectedArticle?.title ? `${isZh ? "网页" : "Webpage"}: ${selectedArticle.title}` : isZh ? "原始网页" : "Original Webpage");
      setReaderOriginalHtml(originalHtml);
      setReadView("original");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? `${isZh ? "打开原文失败" : "Failed to open original"}: ${error.message}` : `${isZh ? "打开原文失败" : "Failed to open original"}: ${String(error)}`,
      );
    } finally {
      setIsOpeningReaderLink(false);
    }
  }

  async function createHighlight() {
    const root = readerHtmlRef.current;
    const selection = window.getSelection();
    setIsAnnotationDrawerOpen(true);
    setNewNoteDraft(null);
    setPendingDeleteId(null);
    if (!root || !selectedArticle) {
      setAnnotationMessage(isZh ? "请先在文章中选择文本。" : "Select text inside the article first.");
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
      setAnnotationMessage(isZh ? "请先在文章中选择文本。" : "Select text inside the article first.");
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
        favoriteCount={favoriteCount}
        favoriteUnreadCount={favoriteUnreadCount}
        appLanguage={appLanguage}
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
        appLanguage={appLanguage}
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
                {isTranslatingSelection ? (isZh ? "翻译中..." : "Translating...") : isZh ? "翻译" : "Translate"}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void createHighlight()}
              >
                {isZh ? "高亮" : "Highlight"}
              </button>
              <button
                type="button"
                onClick={clearSelectionOverlay}
              >
                {isZh ? "关闭" : "Close"}
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
              <div className="reader-toolbar">
                <div className="reader-nav" aria-label="Reader navigation">
                  <button
                    type="button"
                    className="reader-nav-button"
                    onClick={handleReaderBack}
                    disabled={readerHistory.length === 0}
                    title={readerHistory.length > 0 ? (isZh ? "回退" : "Back") : isZh ? "没有可回退的内容" : "Nothing to go back to"}
                    aria-label={isZh ? "回退" : "Back"}
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="m11.5 4.5-6 5.5 6 5.5" />
                      <path d="M6 10h8.5" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="reader-nav-button"
                    onClick={handleReaderForward}
                    disabled={readerForwardHistory.length === 0}
                    title={readerForwardHistory.length > 0 ? (isZh ? "前进" : "Forward") : isZh ? "没有可前进的内容" : "Nothing to go forward to"}
                    aria-label={isZh ? "前进" : "Forward"}
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="m8.5 4.5 6 5.5-6 5.5" />
                      <path d="M14 10H5.5" />
                    </svg>
                  </button>
                </div>
                <div className="reader-actions">
                  <button
                    type="button"
                    className="reader-action-button"
                    onClick={() => void handleViewOriginal()}
                    disabled={!originalArticleUrl}
                    title={isZh ? "查看原始网页" : "View original webpage"}
                    aria-label={isZh ? "查看原始网页" : "View original webpage"}
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="M4.5 5.5h11v9h-11z" />
                      <path d="M7.5 8.5h5" />
                      <path d="M7.5 11.5h4" />
                    </svg>
                    <span>{isZh ? "网页" : "Webpage"}</span>
                  </button>
                  <button
                    type="button"
                    className={isAnnotationDrawerOpen ? "reader-action-button active" : "reader-action-button"}
                    onClick={() => setIsAnnotationDrawerOpen((current) => !current)}
                    disabled={!selectedArticle || !!readerPdfUrl}
                    title={isAnnotationDrawerOpen ? (isZh ? `关闭批注 (${annotations.length})` : `Close notes (${annotations.length})`) : isZh ? `打开批注 (${annotations.length})` : `Open notes (${annotations.length})`}
                    aria-label={isAnnotationDrawerOpen ? (isZh ? `关闭批注 (${annotations.length})` : `Close notes (${annotations.length})`) : isZh ? `打开批注 (${annotations.length})` : `Open notes (${annotations.length})`}
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="M4.5 5.5h11v8h-6l-3 2v-2h-2z" />
                      <path d="M7.5 8.5h5" />
                      <path d="M7.5 11h3.5" />
                    </svg>
                    <span>{isZh ? "批注" : "Notes"}</span>
                    {annotations.length > 0 && <span className="reader-action-count">{annotations.length}</span>}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSummarize()}
                    disabled={isSummarizing || !selectedArticle}
                    className={isSummarizing ? "reader-action-button action-loading" : "reader-action-button"}
                    title={isSummarizing ? (isZh ? "正在生成摘要" : "Generating summary") : hasActiveSummary ? (isZh ? "重新生成摘要" : "Regenerate summary") : isZh ? "生成摘要" : "Generate summary"}
                    aria-label={isSummarizing ? (isZh ? "正在生成摘要" : "Generating summary") : hasActiveSummary ? (isZh ? "重新生成摘要" : "Regenerate summary") : isZh ? "生成摘要" : "Generate summary"}
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="M5 5.5h10" />
                      <path d="M5 9h10" />
                      <path d="M5 12.5h6.5" />
                      <path d="M13 13.5h2.5" />
                    </svg>
                    <span>{isSummarizing ? (isZh ? "生成中..." : "Generating...") : isZh ? "摘要" : "Summary"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTranslate()}
                    disabled={isTranslating || !selectedArticle}
                    className={isTranslating ? "reader-action-button action-loading" : "reader-action-button"}
                    title={isTranslating ? (isZh ? "正在翻译" : "Translating") : isZh ? "翻译全文" : "Translate article"}
                    aria-label={isTranslating ? (isZh ? "正在翻译" : "Translating") : isZh ? "翻译全文" : "Translate article"}
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="M4.5 6h6" />
                      <path d="M7.5 4.5v1.5c0 2.8-1.1 5.2-3 6.8" />
                      <path d="m4.8 10.8 2.7 3 2.7-3" />
                      <path d="M12 7h3.5" />
                      <path d="m13.7 5.5-1.7 8" />
                      <path d="m11.8 11.8 1.9-2 1.9 2" />
                    </svg>
                    <span>{isTranslating ? (isZh ? "翻译中..." : "Translating...") : isZh ? "翻译" : "Translate"}</span>
                  </button>
                  <button
                    type="button"
                    className="reader-action-button settings-toggle-btn"
                    onClick={() => setShowSettings(true)}
                    title={isZh ? "阅读设置" : "Reader settings"}
                    aria-label={isZh ? "阅读设置" : "Reader settings"}
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="M10 4.5 11 3l2 .8.3 2a5.9 5.9 0 0 1 1.2.7l1.9-.8 1.4 1.4-.8 1.9c.3.4.5.8.7 1.2l2 .3.8 2-1.5 1-1.3-.9a6 6 0 0 1-1.4 1l-.2 1.7-2 .8-1-1.5a6 6 0 0 1-1.5 0L9 18l-2-.8-.2-1.7a6 6 0 0 1-1.4-1l-1.7.9-1.5-1 .8-2 .3-.1a6 6 0 0 1 0-1.4L2.5 9l1.4-1.4 1.9.8c.4-.3.8-.5 1.2-.7l.3-2 2-.8 1 1.5c.5-.1 1-.1 1.5 0Z" />
                      <circle cx="10" cy="10" r="2.2" />
                    </svg>
                    <span>{isZh ? "设置" : "Settings"}</span>
                  </button>
                </div>
              </div>
              <div className="reader-heading">
                <h2>{displayTitle}</h2>
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
              </div>
            </div>

            {aiError && <div className="error-box">{aiError}</div>}

            {(hasActiveSummary || isCurrentSummaryRunning) && selectedArticle && (
              <div className="ai-result-section">
                <div className="ai-result-header">
                  <div className="ai-result-label">{isZh ? "摘要" : "Summary"}</div>
                  <select
                    className="summary-lang-select"
                    value={summaryLang}
                    onChange={(event) => {
                      const nextLang = event.target.value;
                      isSummaryLangPinnedRef.current = nextLang !== targetLang;
                      setSummaryLang(nextLang);
                      if (!selectedArticle) return;
                      const cachedSummary = summaryCache[selectedArticle.id]?.[nextLang];
                      const currentArticleSummary = selectedArticle.summaryLang === nextLang ? selectedArticle.summary : null;
                      if (!cachedSummary && !currentArticleSummary) {
                        void handleSummarize(false, nextLang);
                      }
                    }}
                  >
                    <option value="zh">{isZh ? "中文" : "Chinese"}</option>
                    <option value="en">{isZh ? "英文" : "English"}</option>
                    <option value="ja">{isZh ? "日文" : "Japanese"}</option>
                    <option value="ko">{isZh ? "韩文" : "Korean"}</option>
                  </select>
                </div>
                <div className="ai-result-content">
                  {hasActiveSummary
                    ? activeSummary
                    : isCurrentSummaryRunning
                      ? (isZh ? "正在生成该语言的摘要..." : "Generating summary in this language...")
                      : (isZh ? "当前语言还没有摘要。" : "No summary yet in this language.")}
                </div>
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
                    {isZh ? "正文" : "Article"}
                  </button>
                  <button
                    type="button"
                    className={readView === "translation" ? "view-tab active" : "view-tab"}
                    onClick={() => setReadView("translation")}
                    disabled={!hasActiveTranslation}
                    title={hasActiveTranslation ? (isZh ? "按原文段落对照显示翻译" : "Show translation aligned with each paragraph") : isZh ? "请先生成当前语言译文" : "Generate a translation first"}
                  >
                    {isZh ? "对照翻译" : "Translation"}
                  </button>
                </div>
                {isCurrentTranslationRunning ? (
                  <div className="view-tabs-hint">{isZh ? "正在翻译当前文章，完成后可切换对照视图。" : "Translating this article. The paired view will be available when it finishes."}</div>
                ) : !hasActiveTranslation && (
                  <div className="view-tabs-hint">{isZh ? "请先点击“翻译”生成当前所选语言的译文后再切换对照视图。" : "Generate a translation first, then switch to the paired translation view."}</div>
                )}
              </div>
            )}

            <div
              ref={readerContentRef}
              className={isAnnotationDrawerOpen ? "reader-content with-annotations" : "reader-content"}
              onScroll={handleReaderContentScroll}
            >
              {contentStatusLabel && (
                <div className="content-status" aria-live="polite">
                  {contentStatusLabel}
                </div>
              )}
              {readerPdfUrl || readerOriginalUrl ? (
                readerPdfUrl ? (
                  <iframe
                    className="reader-document-frame"
                    src={readerPdfUrl}
                    title={readerPdfTitle ?? (isZh ? "PDF 文档" : "PDF Document")}
                  />
                ) : (
                  <iframe
                    className="reader-document-frame"
                    srcDoc={readerOriginalHtml ?? ""}
                    title={readerOriginalTitle ?? (isZh ? "原始网页" : "Original Webpage")}
                  />
                )
              ) : (
                <div className={isAnnotationDrawerOpen ? "reader-workspace with-annotations" : "reader-workspace"}>
                  <div
                    ref={readerPaneRef}
                    className="reader-article-pane"
                    style={{ "--reader-font-scale": readerFontScale } as CSSProperties}
                    onScroll={handleReaderPaneScroll}
                  >
              {readView === "original" && (
                <div
                  ref={readerHtmlRef}
                  className="reader-html-content"
                  onMouseUp={handleReaderSelection}
                  onClick={handleReaderContentClick}
                  dangerouslySetInnerHTML={{ __html: readerHtml }}
                />
              )}

              {readView === "translation" && hasActiveTranslation && (
                <div className="translation-pairs">
                  {translationPairs.map((pair) => (
                    <section className="translation-pair" key={pair.id}>
                      {pair.original && (
                        <div
                          className={`translation-original translation-original-${pair.original.kind}`}
                          dangerouslySetInnerHTML={{ __html: pair.original.html }}
                        />
                      )}
                      {pair.translation && (
                        <div className="translation-rendered">
                          {pair.translation.split("\n").map((line, index) => (
                            <p key={`${pair.id}-line-${index}`}>{line}</p>
                          ))}
                        </div>
                      )}
                    </section>
                  ))}
                </div>
              )}
                  </div>
                  {isAnnotationDrawerOpen && selectedArticle && (
                    <aside ref={annotationPanelRef} className="annotation-panel">
                      <div className="annotation-panel-header">
                        <strong>{isZh ? `批注 (${annotations.length})` : `Notes (${annotations.length})`}</strong>
                        <button type="button" onClick={() => setIsAnnotationDrawerOpen(false)}>
                          {isZh ? "关闭" : "Close"}
                        </button>
                      </div>
                      <div className="annotation-toolbar">
                        <button type="button" onClick={beginCreateNote}>
                          {isZh ? "添加批注" : "Add note"}
                        </button>
                        <button type="button" onClick={() => void createHighlight()}>
                          {isZh ? "高亮选中" : "Highlight selection"}
                        </button>
                      </div>
                      {annotationMessage && <p className="annotation-message">{annotationMessage}</p>}
                      {newNoteDraft !== null && (
                        <div className="annotation-editor">
                          <label htmlFor="new-note">{isZh ? "新的文章批注" : "New article note"}</label>
                          <textarea
                            id="new-note"
                            value={newNoteDraft}
                            onChange={(event) => setNewNoteDraft(event.target.value)}
                            rows={5}
                            autoFocus
                          />
                          <div className="annotation-actions">
                            <button className="primary-button" type="button" onClick={() => void saveNewNote()}>
                              {isZh ? "保存" : "Save"}
                            </button>
                            <button type="button" onClick={() => setNewNoteDraft(null)}>
                              {isZh ? "取消" : "Cancel"}
                            </button>
                          </div>
                        </div>
                      )}
                      {annotations.length === 0 && <p className="annotation-empty">{isZh ? "还没有批注。" : "No annotations yet."}</p>}
                      {annotations.map((annotation) => (
                        <div className="annotation-card" key={annotation.id}>
                          <small>{annotation.kind === "highlight" ? (isZh ? "高亮" : "Highlight") : isZh ? "批注" : "Note"}</small>
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
                                {annotation.kind === "highlight" ? (isZh ? "可选高亮说明" : "Optional highlight note") : isZh ? "批注" : "Note"}
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
                                  {isZh ? "保存" : "Save"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingAnnotationId(null);
                                    setAnnotationDraft("");
                                    setAnnotationMessage(null);
                                  }}
                                >
                                  {isZh ? "取消" : "Cancel"}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {annotation.noteText && <p>{highlightText(annotation.noteText, activeSearchQuery)}</p>}
                              {pendingDeleteId === annotation.id ? (
                                <div className="annotation-delete-confirm">
                                  <span>{isZh ? "删除这条批注？" : "Delete this annotation?"}</span>
                                  <div className="annotation-actions">
                                    <button className="danger-button" type="button" onClick={() => void deleteAnnotation(annotation.id)}>
                                      {isZh ? "确认删除" : "Confirm delete"}
                                    </button>
                                    <button type="button" onClick={() => setPendingDeleteId(null)}>
                                      {isZh ? "取消" : "Cancel"}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="annotation-actions">
                                  <button type="button" onClick={() => beginEditAnnotation(annotation)}>
                                    {isZh ? "编辑" : "Edit"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPendingDeleteId(annotation.id);
                                      setEditingAnnotationId(null);
                                      setNewNoteDraft(null);
                                    }}
                                  >
                                    {isZh ? "删除" : "Delete"}
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
          </>
        ) : (
          <div className="empty-reader">
            {isLoading ? (isZh ? "加载中..." : "Loading...") : isZh ? "请从左侧选择文章" : "Select an article from the left"}
          </div>
        )}
      </article>

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>{isZh ? "阅读设置" : "Reader Settings"}</h2>
            <p className="modal-desc">
              {isZh ? "配置 AI 服务、界面语言、翻译目标语言和阅读偏好。" : "Configure the AI provider, app language, translation target, and reading preferences."}
            </p>

            <div className="settings-form">
              <section className="settings-section">
                <div className="settings-section-heading">
                  <strong>{isZh ? "应用版本" : "App Version"}</strong>
                  <span>{isZh ? "切换整个应用的中文或英文界面。" : "Switch the entire app between Chinese and English."}</span>
                </div>
                <label>
                  {isZh ? "界面语言" : "Interface Language"}
                  <select
                    className="settings-select"
                    value={settingsLanguage}
                    onChange={(e) => setSettingsLanguage(e.target.value as AppLanguage)}
                  >
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                  </select>
                </label>
              </section>
              <section className="settings-section">
                <div className="settings-section-heading">
                  <strong>{isZh ? "摘要 AI 服务" : "Summary AI Provider"}</strong>
                  <span>{isZh ? "生成摘要时使用这一套 API 地址、密钥和模型。" : "Used only when generating article summaries."}</span>
                </div>
                <label>
                  API Base URL
                  <input
                    placeholder={isZh ? "https://api.openai.com 或 http://localhost:11434" : "https://api.openai.com or http://localhost:11434"}
                    value={settingsForm.summaryBaseUrl}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, summaryBaseUrl: e.target.value }))}
                  />
                </label>

                <label>
                  API Key
                  <input
                    type="password"
                    placeholder={isZh ? "sk-...（使用 Ollama 可留空）" : "sk-... (leave empty for Ollama)"}
                    value={settingsForm.summaryApiKey}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, summaryApiKey: e.target.value }))}
                  />
                </label>

                <label>
                  {isZh ? "摘要模型" : "Summary Model"}
                  <input
                    placeholder="gpt-4o-mini, deepseek-chat, llama3"
                    value={settingsForm.summaryModelName}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, summaryModelName: e.target.value }))}
                  />
                </label>
              </section>

              <section className="settings-section">
                <div className="settings-section-heading">
                  <strong>{isZh ? "翻译 AI 服务" : "Translation AI Provider"}</strong>
                  <span>{isZh ? "全文翻译和选中文本翻译使用这一套 API 地址、密钥和模型。" : "Used for full-article and selected-text translation."}</span>
                </div>
                <label>
                  API Base URL
                  <input
                    placeholder={isZh ? "https://api.openai.com 或 http://localhost:11434" : "https://api.openai.com or http://localhost:11434"}
                    value={settingsForm.translationBaseUrl}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, translationBaseUrl: e.target.value }))}
                  />
                </label>

                <label>
                  API Key
                  <input
                    type="password"
                    placeholder={isZh ? "sk-...（使用 Ollama 可留空）" : "sk-... (leave empty for Ollama)"}
                    value={settingsForm.translationApiKey}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, translationApiKey: e.target.value }))}
                  />
                </label>

                <label>
                  {isZh ? "翻译模型" : "Translation Model"}
                  <input
                    placeholder="gpt-4o-mini, deepseek-chat, llama3"
                    value={settingsForm.translationModelName}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, translationModelName: e.target.value }))}
                  />
                </label>
              </section>

              <section className="settings-section">
                <div className="settings-section-heading">
                  <strong>{isZh ? "翻译" : "Translation"}</strong>
                  <span>{isZh ? "设置“翻译”操作默认使用的目标语言。" : "Choose the default target language used by the Translate action."}</span>
                </div>
                <label>
                  {isZh ? "目标语言" : "Target Language"}
                  <select
                    className="settings-select"
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                  >
                    <option value="zh">{isZh ? "中文" : "Chinese"}</option>
                    <option value="en">{isZh ? "英文" : "English"}</option>
                    <option value="ja">{isZh ? "日文" : "Japanese"}</option>
                    <option value="ko">{isZh ? "韩文" : "Korean"}</option>
                  </select>
                </label>
              </section>

              <section className="settings-section">
                <div className="settings-section-heading">
                  <strong>{isZh ? "阅读" : "Reading"}</strong>
                  <span>{isZh ? "调整当前会话的文章字号。" : "Adjust the article text size for the current session."}</span>
                </div>
                <label className="settings-range-field">
                  <span>{isZh ? "阅读字号" : "Reader Font Size"}</span>
                  <div className="settings-range-control">
                    <input
                      type="range"
                      min="0.8"
                      max="1.4"
                      step="0.05"
                      value={readerFontScale}
                      onChange={(event) => setReaderFontScale(normalizeReaderFontScale(Number(event.target.value)))}
                    />
                    <strong>{Math.round(readerFontScale * 100)}%</strong>
                  </div>
                </label>
              </section>

              <div className="modal-actions">
                <button type="button" className="primary-button" onClick={handleSaveSettings} disabled={isSavingSettings}>
                  {isSavingSettings ? (isZh ? "保存中..." : "Saving...") : isZh ? "保存" : "Save"}
                </button>
                <button type="button" onClick={() => setShowSettings(false)}>{isZh ? "取消" : "Cancel"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
