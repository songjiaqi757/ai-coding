import type { ReactNode } from "react";
import type { Article, ReadFilter, AppLanguage } from "../types";

type Props = {
  articles: Article[];
  totalCount: number;
  unreadCount: number;
  readCount: number;
  appLanguage: AppLanguage;
  selectedArticleId: string | null;
  isLoading: boolean;
  readFilter: ReadFilter;
  isUpdatingReadStatus: boolean;
  onSelectArticle: (id: string) => void;
  onReadFilterChange: (filter: ReadFilter) => void;
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
  isUpdatingReadStatus,
  onSelectArticle,
  onReadFilterChange,
  onToggleFavorite,
  onMarkCurrentFeedRead,
  highlightText,
}: Props) {
  const isZh = appLanguage === "zh";
  const countLabel = isLoading
    ? isZh ? "加载中..." : "Loading..."
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
