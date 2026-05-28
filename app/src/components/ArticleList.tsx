import type { Article } from "../types";

type Props = {
  articles: Article[];
  selectedArticleId: string | null;
  isLoading: boolean;
  onSelectArticle: (id: string) => void;
};

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function getPreview(article: Article) {
  return stripHtml(article.excerpt || article.content || article.cleanedHtml || "");
}

export function ArticleList({
  articles,
  selectedArticleId,
  isLoading,
  onSelectArticle,
}: Props) {
  return (
    <section className="article-list">
      <div className="toolbar">
        <div>
          <h2>文章</h2>
          <p>{isLoading ? "加载中..." : `${articles.length} 篇文章`}</p>
        </div>
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
          <button
            key={article.id}
            className={
              article.id === selectedArticleId
                ? "article-card active"
                : "article-card"
            }
            onClick={() => onSelectArticle(article.id)}
          >
            <div className="article-meta">
              <span>{article.author ?? "未知作者"}</span>
              <span>
                {article.publishedAt
                  ? new Date(article.publishedAt).toLocaleDateString("zh-CN")
                  : ""}
              </span>
            </div>
            <h3>{article.title}</h3>
            <p>{getPreview(article)}</p>
          </button>
        ))}
      </div>
    </section>
  );
}
import type { Article } from "../types";

type Props = {
  articles: Article[];
  selectedArticleId: string | null;
  isLoading: boolean;
  onSelectArticle: (id: string) => void;
};

export function ArticleList({
  articles,
  selectedArticleId,
  isLoading,
  onSelectArticle,
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
          <button
            key={article.id}
            className={
              article.id === selectedArticleId
                ? "article-card active"
                : "article-card"
            }
            onClick={() => onSelectArticle(article.id)}
          >
            <div className="article-meta">
              <span>{article.author ?? "未知作者"}</span>
              <span>
                {article.publishedAt
                  ? new Date(article.publishedAt).toLocaleDateString("zh-CN")
                  : ""}
              </span>
            </div>
            <h3>{article.title}</h3>
            <p>{article.excerpt}</p>
          </button>
        ))}
      </div>
    </section>
  );
}
