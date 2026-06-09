import type { Article, ReadFilter } from "../types";

type Props = {
  articles: Article[];
  totalCount: number;
  unreadCount: number;
  readCount: number;
  selectedArticleId: string | null;
  isLoading: boolean;
  readFilter: ReadFilter;
  searchQuery: string;
  isUpdatingReadStatus: boolean;
  onSelectArticle: (id: string) => void;
  onReadFilterChange: (filter: ReadFilter) => void;
  onSearchQueryChange: (query: string) => void;
  onToggleReadStatus: (article: Article) => void;
  onToggleFavorite: (article: Article) => void;
  onToggleReadLater: (article: Article) => void;
  onMarkCurrentFeedRead: () => void;
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
  isUpdatingReadStatus,
  onSelectArticle,
  onReadFilterChange,
  onSearchQueryChange,
  onToggleReadStatus,
  onToggleFavorite,
  onToggleReadLater,
  onMarkCurrentFeedRead,
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

      <div className="search-box">
        <input
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="搜索标题、作者..."
        />
      </div>

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
                <span>{article.author ?? "未知作者"}</span>
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
              <span className="article-card-title">{article.title}</span>
              <span className="article-card-excerpt">{article.excerpt}</span>
            </button>
            <div className="article-state-actions">
              <button
                type="button"
                className={article.isFavorite ? "state-pill active" : "state-pill"}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleFavorite(article);
                }}
                title={article.isFavorite ? "取消收藏" : "收藏文章"}
              >
                {article.isFavorite ? "已收藏" : "收藏"}
              </button>
              <button
                type="button"
                className={article.readLater ? "state-pill active" : "state-pill"}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleReadLater(article);
                }}
                title={article.readLater ? "取消稍后读" : "稍后读"}
              >
                {article.readLater ? "稍后读中" : "稍后读"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
