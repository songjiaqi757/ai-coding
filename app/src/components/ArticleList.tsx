import type { FormEvent, ReactNode } from "react";
import type { Article, ReadFilter } from "../types";

type SearchScope = "all" | "feed";

type Props = {
  articles: Article[];
  totalCount: number;
  unreadCount: number;
  readCount: number;
  selectedArticleId: string | null;
  isLoading: boolean;
  readFilter: ReadFilter;
  searchQuery: string;
  searchScope: SearchScope;
  activeSearchQuery: string;
  searchMatchLabel: string | null;
  isUpdatingReadStatus: boolean;
  onSelectArticle: (id: string) => void;
  onReadFilterChange: (filter: ReadFilter) => void;
  onSearchQueryChange: (query: string) => void;
  onSearchScopeChange: (scope: SearchScope) => void;
  onSearch: (event?: FormEvent<HTMLFormElement>) => void;
  onClearSearch: () => void;
  onPreviousSearchMatch: () => void;
  onNextSearchMatch: () => void;
  onToggleReadStatus: (article: Article) => void;
  onToggleFavorite: (article: Article) => void;
  onToggleReadLater: (article: Article) => void;
  onMarkCurrentFeedRead: () => void;
  highlightText: (text: string) => ReactNode;
};

export function ArticleList({
  articles,
  totalCount,
  unreadCount,
  readCount,
  selectedArticleId,
  isLoading,
  readFilter,
  searchQuery,
  searchScope,
  activeSearchQuery,
  searchMatchLabel,
  isUpdatingReadStatus,
  onSelectArticle,
  onReadFilterChange,
  onSearchQueryChange,
  onSearchScopeChange,
  onSearch,
  onClearSearch,
  onPreviousSearchMatch,
  onNextSearchMatch,
  onToggleReadStatus,
  onToggleFavorite,
  onToggleReadLater,
  onMarkCurrentFeedRead,
  highlightText,
}: Props) {
  const currentFilterCount =
    readFilter === "all" ? totalCount : readFilter === "unread" ? unreadCount : readCount;
  const countLabel = isLoading
    ? "加载中..."
    : searchQuery.trim()
      ? `当前 ${articles.length} 篇，筛选范围 ${currentFilterCount} 篇，未读 ${unreadCount} 篇`
      : readFilter === "all"
        ? `共 ${totalCount} 篇，未读 ${unreadCount} 篇`
        : readFilter === "unread"
          ? `未读 ${unreadCount} 篇`
          : `已读 ${readCount} 篇`;

  return (
    <section className="article-list">
      <div className="toolbar">
        <div>
          <h2>Articles</h2>
          <p>{countLabel}</p>
        </div>
        <button
          type="button"
          className="mark-read-button"
          onClick={onMarkCurrentFeedRead}
          disabled={isUpdatingReadStatus || unreadCount === 0}
        >
          全部标为已读
        </button>
      </div>

      <div className="segmented-control">
        {(["all", "unread", "read"] as const).map((value) => (
          <button
            type="button"
            key={value}
            className={readFilter === value ? "active" : ""}
            onClick={() => onReadFilterChange(value)}
          >
            {value === "all"
              ? `全部 ${totalCount}`
              : value === "unread"
                ? `未读 ${unreadCount}`
                : `已读 ${readCount}`}
          </button>
        ))}
      </div>

      <form className="article-search" onSubmit={(event) => onSearch(event)}>
        <div className="search-input-shell">
          <input
            value={searchQuery}
            onChange={(event) => {
              const value = event.target.value;
              onSearchQueryChange(value);
              if (!value.trim()) onClearSearch();
            }}
            placeholder="搜索文章和批注..."
          />
          {searchQuery && (
            <button
              className="search-clear-button"
              type="button"
              aria-label="Clear search"
              onClick={onClearSearch}
            >
              <span className="search-clear-icon" aria-hidden="true" />
            </button>
          )}
        </div>
        <select
          value={searchScope}
          onChange={(event) => onSearchScopeChange(event.target.value as SearchScope)}
        >
          <option value="all">全部文章</option>
          <option value="feed">当前订阅源</option>
        </select>
        <button type="submit">搜索</button>
      </form>

      {activeSearchQuery && (
        <div className="search-navigation">
          <button type="button" disabled={searchMatchLabel === "0 / 0"} onClick={onPreviousSearchMatch}>
            Previous
          </button>
          <span>{searchMatchLabel}</span>
          <button type="button" disabled={searchMatchLabel === "0 / 0"} onClick={onNextSearchMatch}>
            Next
          </button>
        </div>
      )}

      <div className="cards">
        {articles.length === 0 && !isLoading && (
          <div className="empty-state">
            暂无文章，请添加订阅源或刷新
          </div>
        )}
        {articles.map((article) => (
          <article
            key={article.id}
            className={
              [
                "article-card",
                article.id === selectedArticleId ? "active" : "",
                article.isRead ? "read" : "unread",
              ]
                .filter(Boolean)
                .join(" ")
            }
          >
            <div className="article-card-header">
              <span className="article-meta">
                <span className={article.isRead ? "read-state" : "read-state unread"}>
                  {article.isRead ? "已读" : "未读"}
                </span>
                <span>{highlightText(article.author ?? "未知作者")}</span>
                <span>
                  {article.publishedAt
                    ? new Date(article.publishedAt).toLocaleDateString("zh-CN")
                    : ""}
                </span>
              </span>
              <button
                type="button"
                className="read-toggle"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleReadStatus(article);
                }}
              >
                标为{article.isRead ? "未读" : "已读"}
              </button>
            </div>
            <button
              type="button"
              className="article-card-main"
              onClick={() => onSelectArticle(article.id)}
            >
              <span className="article-card-title">{highlightText(article.title)}</span>
              <span className="article-card-excerpt">{highlightText(article.excerpt || article.content || "No article preview available.")}</span>
            </button>
            <div className="article-marking-actions">
              <button
                className={article.isFavorite ? "marking-icon-button favorite active" : "marking-icon-button favorite"}
                type="button"
                aria-label={article.isFavorite ? "Remove from favorites" : "Add to favorites"}
                title={article.isFavorite ? "Remove from favorites" : "Add to favorites"}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleFavorite(article);
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="m12 3.3 2.68 5.43 5.99.87-4.34 4.23 1.03 5.97L12 17l-5.36 2.8 1.03-5.97L3.33 9.6l5.99-.87L12 3.3Z" />
                </svg>
              </button>
              <button
                className={article.readLater ? "marking-icon-button read-later active" : "marking-icon-button read-later"}
                type="button"
                aria-label={article.readLater ? "Remove from read later" : "Add to read later"}
                title={article.readLater ? "Remove from read later" : "Add to read later"}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleReadLater(article);
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M6.75 4.75c0-.97.78-1.75 1.75-1.75h7c.97 0 1.75.78 1.75 1.75v16L12 17.5 6.75 20.75v-16Z" />
                </svg>
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
