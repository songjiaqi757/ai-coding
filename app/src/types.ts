export type AppLanguage = "zh" | "en";

export type Feed = {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  unread: number;
  total: number;
  lastSyncAt: string | null;
};

export type OpmlImportFailure = {
  url: string;
  error: string;
};

export type OpmlImportReport = {
  importedFeeds: Feed[];
  failedFeeds: OpmlImportFailure[];
};

export type SyncPhase = "idle" | "running" | "success" | "failed";
export type ReadFilter = "all" | "unread" | "read";

export type SyncFeedFailure = {
  feedId: string;
  feedTitle: string;
  error: string;
  retryCount: number;
  failedAt: string;
};

export type SyncStatus = {
  phase: SyncPhase;
  currentFeedId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  totalFeeds: number;
  completedFeeds: number;
  failedFeeds: SyncFeedFailure[];
  lastError: string | null;
};

export type SyncConfig = {
  enabled: boolean;
  intervalMinutes: number;
  retryLimit: number;
  nextSyncAt: string | null;
};

export type SyncReport = {
  totalFeeds: number;
  syncedFeeds: number;
  failedFeeds: SyncFeedFailure[];
  newArticles: number;
  startedAt: string;
  finishedAt: string;
};

export type AiJobStatus = {
  id: string;
  kind: "summary" | "translation";
  articleId: string;
  targetLang: string;
  status: "running" | "completed" | "failed";
  result: string | null;
  error: string | null;
};

export type FeedUnread = {
  feedId: string;
  feedTitle: string;
  unread: number;
};

export type UnreadSummary = {
  totalUnread: number;
  feedUnread: FeedUnread[];
};

export type Article = {
  id: string;
  feedId: string;
  title: string;
  url: string;
  author: string | null;
  publishedAt: string | null;
  excerpt: string;
  content: string;
  rawHtml: string | null;
  cleanedHtml: string | null;
  cleanedMarkdown: string | null;
  contentFetchedAt: string | null;
  contentFetchStatus: string;
  contentFetchError: string | null;
  finalUrl: string | null;
  summary: string | null;
  summaryLang: string | null;
  translation: string | null;
  translationLang: string | null;
  isRead: boolean;
  isFavorite: boolean;
  readLater: boolean;
};

export type Annotation = {
  id: string;
  articleId: string;
  kind: "highlight" | "note";
  selectedText: string | null;
  prefixText: string | null;
  suffixText: string | null;
  startOffset: number | null;
  endOffset: number | null;
  noteText: string | null;
  highlightColor: string | null;
  highlightStyle: "background" | "text" | "underline" | null;
  createdAt: string;
  updatedAt: string;
};
