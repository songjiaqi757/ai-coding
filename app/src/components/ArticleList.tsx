import type { Article, ReadFilter } from "../types";

type Props = {
  articles: Article[];
  selectedArticleId: string | null;
  isLoading: boolean;
  readFilter: ReadFilter;
  isUpdatingReadStatus: boolean;
  onSelectArticle: (id: string) => void;
  onReadFilterChange: (filter: ReadFilter) => void;
  onToggleReadStatus: (article: Article) => void;
  onMarkCurrentFeedRead: () => void;
};

export function ArticleList({
  articles,
  selectedArticleId,
  isLoading,
  readFilter,
  isUpdatingReadStatus,
  onSelectArticle,
  onReadFilterChange,
  onToggleReadStatus,
  onMarkCurrentFeedRead,
}: Props) {
  return (
    <section className="article-list">
      <div className="toolbar">
        <div>
          <h2>Articles</h2>
          <p>
            {isLoading ? "加载中..." : `${articles.length} 篇文章`}
          </p>
        </div>
        <button
          type="button"
          className="mark-read-button"
          onClick={onMarkCurrentFeedRead}
          disabled={isUpdatingReadStatus || articles.length === 0}
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
            {value === "all" ? "全部" : value === "unread" ? "未读" : "已读"}
          </button>
        ))}
      </div>

      <div className="search-box">
        <input placeholder="搜索文章..." />
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
          </article>
        ))}
      </div>
    </section>
  );
}
