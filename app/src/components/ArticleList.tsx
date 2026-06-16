import type { FormEvent, ReactNode } from "react";
import type { Article, ReadFilter, AppLanguage } from "../types";

type SearchScope = "all" | "feed";

type Props = {
  articles: Article[];
  totalCount: number;
  unreadCount: number;
  readCount: number;
  appLanguage: AppLanguage;
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
  onToggleFavorite: (article: Article) => void;
  onMarkCurrentFeedRead: () => void;
  highlightText: (text: string) => ReactNode;
};

export function ArticleList({
  articles,
  totalCount,
  unreadCount,
  readCount,
  appLanguage,
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
  onToggleFavorite,
  onMarkCurrentFeedRead,
  highlightText,
}: Props) {
  const isZh = appLanguage === "zh";
  const currentFilterCount =
    readFilter === "all" ? totalCount : readFilter === "unread" ? unreadCount : readCount;
  const countLabel = isLoading
    ? isZh ? "加载中..." : "Loading..."
    : searchQuery.trim()
      ? isZh
        ? `当前 ${articles.length} 篇，筛选范围 ${currentFilterCount} 篇，未读 ${unreadCount} 篇`
        : `${articles.length} current, ${currentFilterCount} in scope, ${unreadCount} unread`
      : readFilter === "all"
        ? isZh ? `共 ${totalCount} 篇，未读 ${unreadCount} 篇` : `${totalCount} total, ${unreadCount} unread`
        : readFilter === "unread"
          ? isZh ? `未读 ${unreadCount} 篇` : `${unreadCount} unread`
          : isZh ? `已读 ${readCount} 篇` : `${readCount} read`;

  return (
    <section className="article-list">
      <div className="toolbar">
        <div>
          <h2>{isZh ? "文章" : "Articles"}</h2>
          <p>{countLabel}</p>
        </div>
        <button
          type="button"
          className="mark-read-button"
          onClick={onMarkCurrentFeedRead}
          disabled={isUpdatingReadStatus || unreadCount === 0}
        >
          {isZh ? "全部标为已读" : "Mark all read"}
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
              ? isZh ? `全部 ${totalCount}` : `All ${totalCount}`
              : value === "unread"
                ? isZh ? `未读 ${unreadCount}` : `Unread ${unreadCount}`
                : isZh ? `已读 ${readCount}` : `Read ${readCount}`}
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
            placeholder={isZh ? "搜索文章和批注..." : "Search articles and notes..."}
          />
          {searchQuery && (
            <button
              className="search-clear-button"
              type="button"
              aria-label={isZh ? "清空搜索" : "Clear search"}
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
          <option value="all">{isZh ? "全部文章" : "All articles"}</option>
          <option value="feed">{isZh ? "当前订阅源" : "Current feed"}</option>
        </select>
        <button type="submit">{isZh ? "搜索" : "Search"}</button>
      </form>

      {activeSearchQuery && (
        <div className="search-navigation">
          <button type="button" disabled={searchMatchLabel === "0 / 0"} onClick={onPreviousSearchMatch}>
            {isZh ? "上一个" : "Previous"}
          </button>
          <span>{searchMatchLabel}</span>
          <button type="button" disabled={searchMatchLabel === "0 / 0"} onClick={onNextSearchMatch}>
            {isZh ? "下一个" : "Next"}
          </button>
        </div>
      )}

      <div className="cards">
        {articles.length === 0 && !isLoading && (
          <div className="empty-state">
            {isZh ? "暂无文章，请添加订阅源或刷新" : "No articles yet. Add a subscription or refresh."}
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
                <span>
                  {article.publishedAt
                    ? new Date(article.publishedAt).toLocaleDateString("zh-CN")
                    : ""}
                </span>
              </span>
              <div className="article-card-top-actions">
                <button
                  className={article.isFavorite ? "marking-icon-button favorite active" : "marking-icon-button favorite"}
                  type="button"
                  aria-label={article.isFavorite ? (isZh ? "取消收藏" : "Remove from favorites") : isZh ? "加入收藏" : "Add to favorites"}
                  title={article.isFavorite ? (isZh ? "取消收藏" : "Remove from favorites") : isZh ? "加入收藏" : "Add to favorites"}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleFavorite(article);
                  }}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="m12 3.3 2.68 5.43 5.99.87-4.34 4.23 1.03 5.97L12 17l-5.36 2.8 1.03-5.97L3.33 9.6l5.99-.87L12 3.3Z" />
                  </svg>
                </button>
              </div>
            </div>
            <button
              type="button"
              className="article-card-main"
              onClick={() => onSelectArticle(article.id)}
            >
              <span className="article-card-title-row">
                {!article.isRead && <span className="article-card-unread-dot" aria-hidden="true" />}
                <span className="article-card-title">{highlightText(article.title)}</span>
              </span>
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
