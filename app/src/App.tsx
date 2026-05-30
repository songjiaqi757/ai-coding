import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import MarkdownIt from "markdown-it";
import { Sidebar } from "./components/Sidebar";
import "./App.css";

type Feed = {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  lastSyncAt: string | null;
  unread: number;
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
  is_favorite: boolean;
  read_later: boolean;
};

type Annotation = {
  id: string;
  article_id: string;
  kind: "highlight" | "note";
  selected_text?: string | null;
  prefix_text?: string | null;
  suffix_text?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
  note_text?: string | null;
  created_at: string;
  updated_at: string;
};

type ReaderState = "empty" | "loading" | "error" | "success";
type ReaderMode = "cleaned" | "original-url" | "link-preview";
type SearchScope = "all" | "feed";

const SMART_FAVORITES = "favorites";
const SMART_READ_LATER = "read-later";

function hasTauriBackend() {
  return "__TAURI_INTERNALS__" in window;
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, query: string): ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return text;
  const pattern = new RegExp(`(${escapedPattern(normalizedQuery)})`, "gi");
  return text.split(pattern).map((part, index) =>
    part.toLocaleLowerCase() === normalizedQuery.toLocaleLowerCase()
      ? <mark className="search-highlight" key={`${part}-${index}`}>{part}</mark>
      : part,
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

function locateHighlight(html: string, annotations: Annotation[], searchQuery: string) {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");

  for (const annotation of annotations.filter((item) => item.kind === "highlight")) {
    const selectedText = annotation.selected_text?.trim();
    if (!selectedText) {
      continue;
    }

    const fullText = document.body.textContent ?? "";
    let start = annotation.start_offset ?? -1;
    if (start < 0 || fullText.slice(start, start + selectedText.length) !== selectedText) {
      const contextualMatch = `${annotation.prefix_text ?? ""}${selectedText}${annotation.suffix_text ?? ""}`;
      const contextualStart = contextualMatch ? fullText.indexOf(contextualMatch) : -1;
      start =
        contextualStart >= 0
          ? contextualStart + (annotation.prefix_text?.length ?? 0)
          : fullText.indexOf(selectedText);
    }

    if (start < 0) {
      continue;
    }

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
      if (endNode === null && end > cursor && end <= nextCursor) {
        endNode = node;
        endInNode = end - cursor;
        break;
      }
      cursor = nextCursor;
      node = walker.nextNode();
    }

    if (!startNode || !endNode) {
      continue;
    }

    const range = document.createRange();
    range.setStart(startNode, startInNode);
    range.setEnd(endNode, endInNode);
    const mark = document.createElement("mark");
    mark.className = "annotation-highlight";
    mark.dataset.annotationId = annotation.id;
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

function PreviewFrame({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setFailed(false);
    setLoading(true);
    setCopied(false);
    timeoutRef.current = window.setTimeout(() => {
      setLoading(false);
      setFailed(true);
    }, 10_000);
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, [url]);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="preview-frame-shell">
      {loading && <div className="preview-notice">Loading page preview...</div>}
      {failed && (
        <div className="preview-error">
          <strong>Page preview could not be loaded.</strong>
          <span>The site may block embedded viewing or be temporarily unavailable.</span>
          <button onClick={() => void copyUrl()}>{copied ? "Copied" : "Copy link"}</button>
        </div>
      )}
      <iframe
        className="preview-frame"
        src={url}
        title="Embedded article preview"
        sandbox="allow-forms allow-popups allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => {
          if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
          setLoading(false);
        }}
        onError={() => {
          setLoading(false);
          setFailed(true);
        }}
      />
    </div>
  );
}

function App() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [searchResults, setSearchResults] = useState<Article[] | null>(null);
  const [selectedFeedId, setSelectedFeedId] = useState("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [selectedArticleDetail, setSelectedArticleDetail] = useState<Article | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [readerState, setReaderState] = useState<ReaderState>("empty");
  const [readerError, setReaderError] = useState<string | null>(null);
  const [articleUrl, setArticleUrl] = useState("");
  const [isFetchingArticle, setIsFetchingArticle] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchScope, setSearchScope] = useState<SearchScope>("all");
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [readerMode, setReaderMode] = useState<ReaderMode>("cleaned");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isAnnotationDrawerOpen, setIsAnnotationDrawerOpen] = useState(false);
  const [newNoteDraft, setNewNoteDraft] = useState<string | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [annotationMessage, setAnnotationMessage] = useState<string | null>(null);
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const readerContentRef = useRef<HTMLDivElement>(null);
  const annotationPanelRef = useRef<HTMLElement>(null);

  function resetAnnotationUi(closeDrawer = false) {
    if (closeDrawer) setIsAnnotationDrawerOpen(false);
    setNewNoteDraft(null);
    setEditingAnnotationId(null);
    setAnnotationDraft("");
    setPendingDeleteId(null);
    setAnnotationMessage(null);
  }

  function resetSearch() {
    setSearchText("");
    setSearchResults(null);
    setActiveSearchQuery("");
    setSearchScope("all");
    setSearchMatchIndex(0);
  }

  function mergeArticle(article: Article) {
    setArticles((current) =>
      current.map((item) => (item.id === article.id ? { ...item, ...article } : item)),
    );
    setSearchResults((current) =>
      current?.map((item) => (item.id === article.id ? { ...item, ...article } : item)) ?? null,
    );
    setSelectedArticleDetail((current) =>
      current?.id === article.id ? { ...current, ...article } : current,
    );
  }

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
      resetSearch();
      setSelectedArticleId((current) => current ?? nextArticles[0]?.id ?? null);
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
      const [article, nextAnnotations] = await Promise.all([
        invoke<Article>("get_article", { articleId }),
        invoke<Annotation[]>("list_annotations", { articleId }),
      ]);
      setSelectedArticleDetail(article);
      setAnnotations(nextAnnotations);
      setReaderState("success");
      mergeArticle(article);
    } catch (error) {
      setSelectedArticleDetail(null);
      setAnnotations([]);
      setReaderError(error instanceof Error ? error.message : String(error));
      setReaderState("error");
    }
  }

  async function handleCleanArticle(articleId: string) {
    try {
      setReaderState("loading");
      const article = await invoke<Article>("clean_article", { articleId });
      setSelectedArticleDetail(article);
      mergeArticle(article);
      setReaderState("success");
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : String(error));
      setReaderState("error");
    }
  }

  async function handleFetchArticle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = articleUrl.trim();
    if (!url) {
      setFetchError("Please enter an article URL.");
      return;
    }

    try {
      setIsFetchingArticle(true);
      setFetchError(null);
      const article = await invoke<Article>("fetch_and_clean_article", { url });
      await loadLocalData();
      setSelectedFeedId("all");
      setSelectedArticleId(article.id);
      setSelectedArticleDetail(article);
      setArticleUrl("");
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFetchingArticle(false);
    }
  }

  async function runSearch(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const query = searchText.trim();
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
    mergeArticle(
      await invoke<Article>("set_article_favorite", {
        articleId: article.id,
        isFavorite: !article.is_favorite,
      }),
    );
  }

  async function toggleReadLater(article: Article) {
    mergeArticle(
      await invoke<Article>("set_article_read_later", {
        articleId: article.id,
        readLater: !article.read_later,
      }),
    );
  }

  function beginCreateNote() {
    setNewNoteDraft("");
    setEditingAnnotationId(null);
    setPendingDeleteId(null);
    setAnnotationMessage(null);
  }

  async function saveNewNote() {
    if (!readerArticle) return;
    if (!newNoteDraft?.trim()) {
      setAnnotationMessage("Write a note before saving.");
      return;
    }
    const annotation = await invoke<Annotation>("create_annotation", {
      articleId: readerArticle.id,
      kind: "note",
      selectedText: null,
      prefixText: null,
      suffixText: null,
      startOffset: null,
      endOffset: null,
      noteText: newNoteDraft,
    });
    setAnnotations((current) => [...current, annotation]);
    setNewNoteDraft(null);
    setAnnotationMessage(null);
  }

  async function createHighlight() {
    const root = readerContentRef.current;
    const selection = window.getSelection();
    setIsAnnotationDrawerOpen(true);
    setNewNoteDraft(null);
    setPendingDeleteId(null);
    if (!root || !readerArticle || !selection || selection.rangeCount === 0) {
      setAnnotationMessage("Select text inside the cleaned article first.");
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setAnnotationMessage("Select text inside the cleaned article first.");
      return;
    }
    const selectedText = selection.toString();
    if (!selectedText.trim()) {
      setAnnotationMessage("Select text inside the cleaned article first.");
      return;
    }

    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(root);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const startOffset = beforeRange.toString().length;
    const fullText = root.textContent ?? "";
    const annotation = await invoke<Annotation>("create_annotation", {
      articleId: readerArticle.id,
      kind: "highlight",
      selectedText,
      prefixText: fullText.slice(Math.max(0, startOffset - 30), startOffset),
      suffixText: fullText.slice(startOffset + selectedText.length, startOffset + selectedText.length + 30),
      startOffset,
      endOffset: startOffset + selectedText.length,
      noteText: null,
    });
    selection.removeAllRanges();
    setAnnotations((current) => [...current, annotation]);
    setEditingAnnotationId(annotation.id);
    setAnnotationDraft("");
    setAnnotationMessage("Highlight saved. Add an optional note below.");
  }

  function beginEditAnnotation(annotation: Annotation) {
    setNewNoteDraft(null);
    setEditingAnnotationId(annotation.id);
    setAnnotationDraft(annotation.note_text ?? "");
    setPendingDeleteId(null);
    setAnnotationMessage(null);
  }

  async function saveAnnotation(annotationId: string) {
    const updated = await invoke<Annotation>("update_annotation", {
      annotationId,
      noteText: annotationDraft,
    });
    setAnnotations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setEditingAnnotationId(null);
    setAnnotationDraft("");
    setAnnotationMessage(null);
  }

  async function deleteAnnotation(annotationId: string) {
    await invoke("delete_annotation", { annotationId });
    setAnnotations((current) => current.filter((item) => item.id !== annotationId));
    setPendingDeleteId(null);
    if (editingAnnotationId === annotationId) {
      setEditingAnnotationId(null);
      setAnnotationDraft("");
    }
  }

  function openPreview(mode: ReaderMode, url: string) {
    resetAnnotationUi(true);
    setReaderMode(mode);
    setPreviewUrl(url);
  }

  function jumpToAnnotation(annotationId: string) {
    const mark = Array.from(
      readerContentRef.current?.querySelectorAll<HTMLElement>(".annotation-highlight") ?? [],
    ).find((item) => item.dataset.annotationId === annotationId);
    if (!mark) {
      setAnnotationMessage("This highlight could not be located in the cleaned article.");
      return;
    }
    mark.scrollIntoView({ behavior: "smooth", block: "center" });
    mark.classList.add("annotation-highlight-focus");
    window.setTimeout(() => mark.classList.remove("annotation-highlight-focus"), 1400);
  }

  function handleReaderLink(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href || (!href.startsWith("http://") && !href.startsWith("https://"))) return;
    event.preventDefault();
    openPreview("link-preview", href);
  }

  useEffect(() => {
    void loadLocalData();
  }, []);

  useEffect(() => {
    resetAnnotationUi(true);
    setReaderMode("cleaned");
    setPreviewUrl(null);
    if (selectedArticleId) void loadArticleDetail(selectedArticleId);
  }, [selectedArticleId]);

  const visibleArticles = useMemo(() => {
    const source = searchResults ?? articles;
    if (selectedFeedId === SMART_FAVORITES) return source.filter((item) => item.is_favorite);
    if (selectedFeedId === SMART_READ_LATER) return source.filter((item) => item.read_later);
    if (selectedFeedId === "all") return source;
    return source.filter((item) => item.feed_id === selectedFeedId);
  }, [articles, searchResults, selectedFeedId]);
  const selectedArticle = visibleArticles.find((item) => item.id === selectedArticleId) ?? visibleArticles[0] ?? null;
  const readerArticle = selectedArticleDetail?.id === selectedArticle?.id ? selectedArticleDetail : selectedArticle;
  const markdown = useMemo(() => new MarkdownIt({ html: false, linkify: true }), []);
  const renderedHtml = useMemo(() => {
    const source = readerArticle?.cleaned_markdown
      ? markdown.render(readerArticle.cleaned_markdown)
      : readerArticle?.cleaned_html;
    return source ? locateHighlight(source, annotations, activeSearchQuery) : null;
  }, [activeSearchQuery, annotations, markdown, readerArticle?.cleaned_html, readerArticle?.cleaned_markdown]);
  const bodySearchMatchCount = useMemo(() => {
    if (!renderedHtml || !activeSearchQuery) return 0;
    const document = new DOMParser().parseFromString(`<body>${renderedHtml}</body>`, "text/html");
    return document.body.querySelectorAll(".search-highlight").length;
  }, [activeSearchQuery, renderedHtml]);
  const annotationSearchMatchCount = useMemo(
    () =>
      annotations.reduce(
        (sum, annotation) =>
          sum +
          countQueryMatches(annotation.selected_text, activeSearchQuery) +
          countQueryMatches(annotation.note_text, activeSearchQuery),
        0,
      ),
    [activeSearchQuery, annotations],
  );
  const totalSearchMatchCount = bodySearchMatchCount + annotationSearchMatchCount;

  function focusSearchMatch(index: number) {
    if (totalSearchMatchCount === 0) return;
    const normalizedIndex = (index + totalSearchMatchCount) % totalSearchMatchCount;
    setSearchMatchIndex(normalizedIndex);

    document.querySelectorAll(".current-search-match").forEach((item) => {
      item.classList.remove("current-search-match");
    });

    if (normalizedIndex < bodySearchMatchCount) {
      const mark = readerContentRef.current?.querySelectorAll<HTMLElement>(".search-highlight")[normalizedIndex];
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
    if (!activeSearchQuery || readerMode !== "cleaned") return;
    const frame = window.requestAnimationFrame(() => {
      const firstMatch = readerContentRef.current?.querySelector(".search-highlight");
      if (firstMatch) {
        setSearchMatchIndex(0);
        firstMatch.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const annotationMatch = annotations.some((annotation) =>
        textMatchesQuery(annotation.selected_text, activeSearchQuery) ||
        textMatchesQuery(annotation.note_text, activeSearchQuery),
      );
      if (annotationMatch) setIsAnnotationDrawerOpen(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSearchQuery, annotations, readerArticle?.id, readerMode, renderedHtml]);

  useEffect(() => {
    setSearchMatchIndex(0);
  }, [activeSearchQuery, readerArticle?.id]);

  useEffect(() => {
    if (!visibleArticles.some((item) => item.id === selectedArticleId)) {
      setSelectedArticleId(visibleArticles[0]?.id ?? null);
    }
  }, [selectedArticleId, visibleArticles]);

  function renderArticleHeader(showAnnotations: boolean) {
    if (!readerArticle) return null;
    return (
      <div className="reader-header reader-header-compact">
        <div className="reader-heading">
          <div className="article-meta"><span>{readerArticle.author ?? readerArticle.source ?? "Unknown author"}</span><span>{readerArticle.published_at ?? "Unknown date"}</span></div>
          <h2>{readerArticle.title}</h2>
          <button className="reader-link" onClick={() => openPreview("original-url", readerArticle.url ?? "")}>View original article</button>
        </div>
        <div className="reader-actions">
          {showAnnotations && <button className={isAnnotationDrawerOpen ? "active" : ""} onClick={() => { if (isAnnotationDrawerOpen) resetAnnotationUi(true); else setIsAnnotationDrawerOpen(true); }}>Annotations ({annotations.length})</button>}
          {!readerArticle.cleaned_markdown && !readerArticle.cleaned_html && <button onClick={() => void handleCleanArticle(readerArticle.id)}>Clean</button>}
          <button onClick={() => alert("Summary Agent is coming next.")}>Summary</button>
          <button onClick={() => alert("Translation Agent is coming next.")}>Translate</button>
        </div>
      </div>
    );
  }

  function renderCleanedContent() {
    if (renderedHtml) {
      return (
        <div className={isAnnotationDrawerOpen ? "reader-workspace with-annotations" : "reader-workspace"}>
          <div className="reader-scroll">
            {renderArticleHeader(true)}
            <div className="reader-body-layer">
              <div
                ref={readerContentRef}
                className="reader-content reader-prose"
                onClick={handleReaderLink}
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />
            </div>
          </div>
          {isAnnotationDrawerOpen && (
            <aside ref={annotationPanelRef} className="annotation-panel">
              <div className="annotation-panel-header">
                <strong>Annotations ({annotations.length})</strong>
                <button onClick={() => resetAnnotationUi(true)}>Close</button>
              </div>
              <div className="annotation-toolbar">
                <button onClick={beginCreateNote}>Add note</button>
                <button onClick={() => void createHighlight()}>Highlight selection</button>
              </div>
              {annotationMessage && <p className="annotation-message">{annotationMessage}</p>}
              {newNoteDraft !== null && (
                <div className="annotation-editor">
                  <label htmlFor="new-note">New article note</label>
                  <textarea id="new-note" value={newNoteDraft} onChange={(event) => setNewNoteDraft(event.target.value)} rows={5} autoFocus />
                  <div className="annotation-actions">
                    <button className="primary-button" onClick={() => void saveNewNote()}>Save</button>
                    <button onClick={() => setNewNoteDraft(null)}>Cancel</button>
                  </div>
                </div>
              )}
              {annotations.length === 0 && <p className="annotation-empty">No annotations yet.</p>}
              {annotations.map((annotation) => (
                <div className="annotation-card" key={annotation.id}>
                  <small>{annotation.kind === "highlight" ? "Highlight" : "Note"}</small>
                  {annotation.selected_text && (
                    <button className="annotation-quote" onClick={() => jumpToAnnotation(annotation.id)}>
                      {highlightText(annotation.selected_text, activeSearchQuery)}
                    </button>
                  )}
                  {editingAnnotationId === annotation.id ? (
                    <div className="annotation-editor">
                      <label htmlFor={`annotation-${annotation.id}`}>
                        {annotation.kind === "highlight" ? "Optional highlight note" : "Note"}
                      </label>
                      <textarea id={`annotation-${annotation.id}`} value={annotationDraft} onChange={(event) => setAnnotationDraft(event.target.value)} rows={5} autoFocus />
                      <div className="annotation-actions">
                        <button className="primary-button" onClick={() => void saveAnnotation(annotation.id)}>Save</button>
                        <button onClick={() => { setEditingAnnotationId(null); setAnnotationDraft(""); setAnnotationMessage(null); }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {annotation.note_text && <p>{highlightText(annotation.note_text, activeSearchQuery)}</p>}
                      {pendingDeleteId === annotation.id ? (
                        <div className="annotation-delete-confirm">
                          <span>Delete this annotation?</span>
                          <div className="annotation-actions">
                            <button className="danger-button" onClick={() => void deleteAnnotation(annotation.id)}>Confirm delete</button>
                            <button onClick={() => setPendingDeleteId(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="annotation-actions">
                          <button onClick={() => beginEditAnnotation(annotation)}>Edit</button>
                          <button onClick={() => { setPendingDeleteId(annotation.id); setEditingAnnotationId(null); setNewNoteDraft(null); }}>Delete</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </aside>
          )}
        </div>
      );
    }
    return (
      <div className="reader-scroll">
        {renderArticleHeader(false)}
        <div className="reader-content reader-placeholder">
          <p>Content has not been cleaned yet.</p>
          {readerArticle && <button className="primary-button" onClick={() => void handleCleanArticle(readerArticle.id)}>Clean Article</button>}
        </div>
      </div>
    );
  }

  function renderReaderBody() {
    if (!readerArticle) return <div className="reader-status">No article selected.</div>;
    if (readerMode !== "cleaned") {
      return previewUrl ? <PreviewFrame url={previewUrl} /> : <div className="reader-status">本地示例文章没有原文链接</div>;
    }
    if (readerState === "loading") return <div className="reader-status">Cleaning or loading article...</div>;
    if (readerState === "error") return <div className="reader-status reader-status-error">{readerError}</div>;
    return renderCleanedContent();
  }

  return (
    <main className="app-shell">
      <Sidebar
        feeds={feeds}
        selectedFeedId={selectedFeedId}
        favoriteCount={articles.filter((article) => article.is_favorite).length}
        readLaterCount={articles.filter((article) => article.read_later).length}
        onSelectFeed={setSelectedFeedId}
        onFeedsChange={loadLocalData}
      />

      <section className="article-list">
        <div className="toolbar"><div><h2>Articles</h2><p>{isLoading ? "Loading local data..." : `${visibleArticles.length} local items`}</p></div><button className="primary-button" onClick={() => void loadLocalData()}>Refresh</button></div>
        <form className="url-fetcher" onSubmit={(event) => void handleFetchArticle(event)}>
          <input value={articleUrl} onChange={(event) => setArticleUrl(event.target.value)} placeholder="https://example.com/article" disabled={isFetchingArticle} />
          <button className="primary-button" type="submit" disabled={isFetchingArticle}>{isFetchingArticle ? "Fetching..." : "Fetch"}</button>
        </form>
        <form className="article-search" onSubmit={(event) => void runSearch(event)}>
          <div className="search-input-shell">
            <input value={searchText} onChange={(event) => { const value = event.target.value; setSearchText(value); if (!value.trim()) resetSearch(); }} placeholder="Search articles and annotations" />
            {searchText && <button className="search-clear-button" type="button" aria-label="Clear search" onClick={resetSearch}>×</button>}
          </div>
          <select value={searchScope} onChange={(event) => setSearchScope(event.target.value as SearchScope)}>
            <option value="all">All articles</option><option value="feed">Current feed</option>
          </select>
          <button type="submit">Search</button>
        </form>
        {activeSearchQuery && (
          <div className="search-navigation">
            <button type="button" disabled={totalSearchMatchCount === 0} onClick={() => focusSearchMatch(searchMatchIndex - 1)}>Previous</button>
            <span>{totalSearchMatchCount === 0 ? "0 / 0" : `${searchMatchIndex + 1} / ${totalSearchMatchCount}`}</span>
            <button type="button" disabled={totalSearchMatchCount === 0} onClick={() => focusSearchMatch(searchMatchIndex + 1)}>Next</button>
          </div>
        )}
        {fetchError && <div className="error-box">{fetchError}</div>}
        {errorMessage && <div className="error-box">{errorMessage}</div>}
        <div className="cards">
          {visibleArticles.map((article) => (
            <div
              key={article.id}
              className={article.id === selectedArticle?.id ? "article-card active" : "article-card"}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedArticleId(article.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedArticleId(article.id);
                }
              }}
            >
              <div className="article-meta"><span>{highlightText(article.source ?? article.author ?? "Local article", activeSearchQuery)}</span><span>{highlightText(article.published_at ?? "Unknown date", activeSearchQuery)}</span></div>
              <h3>{highlightText(article.title, activeSearchQuery)}</h3><p>{highlightText(article.excerpt ?? article.content ?? "No article preview available.", activeSearchQuery)}</p>
              <div className="article-marking-actions">
                <button
                  className={article.is_favorite ? "marking-icon-button favorite active" : "marking-icon-button favorite"}
                  type="button"
                  aria-label={article.is_favorite ? "Remove from favorites" : "Add to favorites"}
                  title={article.is_favorite ? "Remove from favorites" : "Add to favorites"}
                  onClick={(event) => {
                    event.stopPropagation();
                    void toggleFavorite(article);
                  }}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="m12 3.3 2.68 5.43 5.99.87-4.34 4.23 1.03 5.97L12 17l-5.36 2.8 1.03-5.97L3.33 9.6l5.99-.87L12 3.3Z" />
                  </svg>
                </button>
                <button
                  className={article.read_later ? "marking-icon-button read-later active" : "marking-icon-button read-later"}
                  type="button"
                  aria-label={article.read_later ? "Remove from read later" : "Add to read later"}
                  title={article.read_later ? "Remove from read later" : "Add to read later"}
                  onClick={(event) => {
                    event.stopPropagation();
                    void toggleReadLater(article);
                  }}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M6.75 4.75c0-.97.78-1.75 1.75-1.75h7c.97 0 1.75.78 1.75 1.75v16L12 17.5 6.75 20.75v-16Z" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <article className="reader">
        {readerArticle && readerMode !== "cleaned" && (
          <div className="preview-toolbar">
            <button className="reader-link" onClick={() => { setReaderMode("cleaned"); setPreviewUrl(null); }}>Back to article</button>
          </div>
        )}
        {renderReaderBody()}
      </article>
    </main>
  );
}

export default App;
