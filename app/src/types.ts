export type Feed = {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  unread: number;
  lastSyncAt: string | null;
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
  isRead: boolean;
};

export type ReadFilter = "all" | "unread" | "read";

export type FeedUnread = {
  feedId: string;
  feedTitle: string;
  unread: number;
};

export type UnreadSummary = {
  totalUnread: number;
  feedUnread: FeedUnread[];
};
