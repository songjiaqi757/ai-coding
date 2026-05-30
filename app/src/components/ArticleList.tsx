import { useState, type FormEvent } from "react";
import type { Article } from "../types";

type Props = {
  articles: Article[];
  selectedArticleId: string | null;
  isLoading: boolean;
  isFetchingArticle: boolean;
  fetchError: string | null;
  onFetchArticle: (url: string) => void;
  onSelectArticle: (id: string) => void;
};

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trimEnd()}...`;
}

function getPreview(article: Article) {
  const preview = stripHtml(
    article.excerpt || article.content || article.cleanedHtml || "",
  );
  return truncate(preview, 140);
}

export function ArticleList({
  articles,
  selectedArticleId,
  isLoading,
  isFetchingArticle,
  fetchError,
  onFetchArticle,
  onSelectArticle,
}: Props) {
  const [articleUrl, setArticleUrl] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = articleUrl.trim();
    if (!url || isFetchingArticle) return;
    onFetchArticle(url);
    setArticleUrl("");
  }

  return (
    <section className="article-list">
      <div className="toolbar">
        <div>
          <h2>文章</h2>
          <p>{isLoading ? "加载中..." : `${articles.length} 篇文章`}</p>
        </div>
      </div>

      <form className="url-fetcher" onSubmit={handleSubmit}>
        <input
          placeholder="输入文章 URL..."
          value={articleUrl}
          onChange={(event) => setArticleUrl(event.target.value)}
          disabled={isFetchingArticle}
        />
        <button
          className="primary-button"
          type="submit"
          disabled={isFetchingArticle}
        >
          {isFetchingArticle ? "抓取中..." : "抓取"}
        </button>
      </form>

      {fetchError && <div className="error-box">{fetchError}</div>}

      <div className="cards">
        {articles.length === 0 && !isLoading && (
          <div className="empty-state">暂无文章，请添加订阅源或刷新</div>
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
