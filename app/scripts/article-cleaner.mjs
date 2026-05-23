import { Readability } from "@mozilla/readability";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const ALLOWED_TAGS = [
  "article",
  "section",
  "main",
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "strong",
  "em",
  "b",
  "i",
  "a",
  "img",
  "figure",
  "figcaption",
  "br",
  "hr",
];

const ALLOWED_ATTR = ["href", "src", "alt", "title", "width", "height", "loading", "class"];
const FORBID_TAGS = ["script", "style", "iframe", "object", "embed", "form"];
const BLOCK_LINE_BREAK_TAGS = new Set([
  "DIV",
  "P",
  "LI",
  "TR",
  "SECTION",
  "ARTICLE",
  "FIGURE",
  "FIGCAPTION",
]);

function readStdin() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", reject);
  });
}

function normalizeBaseUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return "https://example.com/";
  }
}

function isDangerousUrl(value) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:text/html")
  );
}

function absolutizeUrl(value, baseUrl) {
  const trimmed = value.trim();
  if (!trimmed || isDangerousUrl(trimmed)) {
    return null;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeHeadingLinks(root) {
  root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((heading) => {
    const text = heading.textContent?.trim();
    if (text) {
      heading.textContent = text;
    }
  });
}

function extractByline(document) {
  const metaSelectors = [
    "meta[name='author']",
    "meta[property='article:author']",
    "meta[name='twitter:creator']",
  ];

  for (const selector of metaSelectors) {
    const node = document.querySelector(selector);
    const value = node?.getAttribute("content")?.trim()?.replace(/^@/, "");
    if (value) {
      return value;
    }
  }

  const textSelectors = [
    "[itemprop='author']",
    "a[rel='author']",
    ".author",
    ".authors",
    ".byline",
  ];

  for (const selector of textSelectors) {
    const value = document.querySelector(selector)?.textContent?.trim()?.replace(/^By\s+/i, "");
    if (value && value.length <= 120 && !/sponsor/i.test(value)) {
      return value;
    }
  }

  return null;
}

function extractExcerpt(document) {
  const metaSelectors = [
    "meta[property='og:description']",
    "meta[name='description']",
    "meta[name='twitter:description']",
  ];

  for (const selector of metaSelectors) {
    const value = document.querySelector(selector)?.getAttribute("content")?.trim();
    if (value) {
      return value;
    }
  }

  return null;
}

function pickFallbackContent(document) {
  const selectors = [
    "article",
    "main",
    "[role='main']",
    ".entry-content",
    ".article-content",
    ".post-content",
    ".sl-markdown-content",
    ".content-panel",
    ".entryPage",
    ".entry",
  ];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const html = node?.innerHTML?.trim();
    if (html) {
      return html;
    }
  }

  return document.body?.innerHTML?.trim() || "";
}

function countHeadings(html, baseUrl) {
  if (!html?.trim()) {
    return 0;
  }

  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  const count = dom.window.document.querySelectorAll("h1, h2, h3, h4, h5, h6").length;
  dom.window.close();
  return count;
}

function extractStructuredCodeText(node) {
  let output = "";

  for (const child of node.childNodes) {
    if (child.nodeType === child.TEXT_NODE) {
      output += child.nodeValue || "";
      continue;
    }

    if (child.nodeType !== child.ELEMENT_NODE) {
      continue;
    }

    if (child.nodeName === "BR") {
      output += "\n";
      continue;
    }

    output += extractStructuredCodeText(child);

    if (BLOCK_LINE_BREAK_TAGS.has(child.nodeName) && !output.endsWith("\n")) {
      output += "\n";
    }
  }

  return output;
}

function normalizeCodeBlocks(root) {
  root.querySelectorAll("pre").forEach((pre) => {
    const source = pre.querySelector("code") || pre;
    const normalizedText = extractStructuredCodeText(source)
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();

    if (!normalizedText) {
      return;
    }

    pre.innerHTML = "";
    const code = root.createElement("code");
    code.textContent = normalizedText;
    pre.append(code);
  });
}

function removeLeadingMetadata(root) {
  const selectors = [
    ".metadata",
    ".authors",
    ".author",
    ".byline",
    "[class*='metadata']",
    "[class*='author']",
    "[class*='byline']",
    "[class*='not-content']",
  ];

  const candidates = root.querySelectorAll(selectors.join(", "));
  candidates.forEach((node) => {
    const className = (node.getAttribute("class") || "").toLowerCase();
    const text = node.textContent?.trim() || "";
    const images = node.querySelectorAll("img");
    const hasSmallImage = Array.from(images).some((image) => {
      const width = Number.parseInt(image.getAttribute("width") || "", 10);
      const height = Number.parseInt(image.getAttribute("height") || "", 10);
      return (
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0 &&
        width <= 120 &&
        height <= 120
      );
    });

    const looksLikeMeta =
      className.includes("metadata") ||
      className.includes("author") ||
      className.includes("byline") ||
      className.includes("not-content");

    if ((looksLikeMeta && text.length <= 220) || hasSmallImage) {
      node.remove();
    }
  });
}

function prepareContent(rawHtml, url) {
  const baseUrl = normalizeBaseUrl(url);
  const readabilityDom = new JSDOM(rawHtml, { url: baseUrl });
  const readabilityArticle = new Readability(readabilityDom.window.document).parse();

  const fallbackDom = new JSDOM(rawHtml, { url: baseUrl });
  const fallbackDocument = fallbackDom.window.document;
  const fallbackContent = pickFallbackContent(fallbackDocument);
  const fallbackTextLength = fallbackDocument.body?.textContent?.trim()?.length || 0;
  const readabilityTextLength = readabilityArticle?.textContent?.trim()?.length || 0;
  const readabilityHeadingCount = countHeadings(readabilityArticle?.content || "", baseUrl);
  const fallbackHeadingCount = countHeadings(fallbackContent, baseUrl);
  const preferFallback =
    fallbackHeadingCount > readabilityHeadingCount && fallbackHeadingCount >= 1;

  const content =
    readabilityArticle?.content &&
    readabilityTextLength > 160 &&
    !preferFallback
      ? readabilityArticle.content
      : fallbackContent;

  const title =
    readabilityArticle?.title?.trim() ||
    fallbackDocument.querySelector("title")?.textContent?.trim() ||
    null;
  const byline = readabilityArticle?.byline?.trim() || extractByline(fallbackDocument);
  const excerpt =
    readabilityArticle?.excerpt?.trim() ||
    extractExcerpt(fallbackDocument) ||
    (fallbackTextLength > 0
      ? fallbackDocument.body.textContent.trim().slice(0, 220)
      : null);

  return {
    baseUrl,
    title,
    byline,
    excerpt,
    content,
  };
}

function sanitizeHtml(content, baseUrl) {
  const contentDom = new JSDOM(`<body>${content}</body>`, { url: baseUrl });
  const { document } = contentDom.window;
  normalizeHeadingLinks(document);
  removeLeadingMetadata(document);
  normalizeCodeBlocks(document);

  const purifyDom = new JSDOM("", { url: baseUrl });
  const DOMPurify = createDOMPurify(purifyDom.window);
  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    const attrName = data.attrName.toLowerCase();
    if (attrName.startsWith("on") || attrName === "style" || attrName === "srcset") {
      data.keepAttr = false;
      return;
    }

    if (attrName === "href" || attrName === "src") {
      const normalized = absolutizeUrl(data.attrValue, baseUrl);
      if (!normalized) {
        data.keepAttr = false;
        return;
      }
      data.attrValue = normalized;
    }
  });

  const sanitized = DOMPurify.sanitize(document.body.innerHTML, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS,
    KEEP_CONTENT: true,
  });

  purifyDom.window.close();
  contentDom.window.close();

  return sanitized.trim();
}

function htmlToMarkdown(cleanedHtml) {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  service.addRule("lineBreak", {
    filter: "br",
    replacement: () => "\n",
  });

  service.addRule("fencedCodeBlocks", {
    filter: (node) => node.nodeName === "PRE",
    replacement: (_content, node) => {
      const code = node.querySelector("code");
      const text = (code?.textContent || node.textContent || "").replace(/\n+$/, "");
      return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
    },
  });

  service.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = node.getAttribute("alt") || "";
      const src = node.getAttribute("src") || "";
      const title = node.getAttribute("title");
      const titlePart = title ? ` "${title}"` : "";
      return src ? `![${alt}](${src}${titlePart})` : "";
    },
  });

  service.keep(["table", "thead", "tbody", "tr", "th", "td"]);

  return service.turndown(cleanedHtml).trim();
}

async function main() {
  const rawInput = await readStdin();
  const input = JSON.parse(rawInput || "{}");
  const html = typeof input.html === "string" ? input.html : "";
  const url = typeof input.url === "string" ? input.url : undefined;

  if (!html.trim()) {
    throw new Error("Node article cleaner received empty HTML input");
  }

  const prepared = prepareContent(html, url);
  const cleanedHtml = sanitizeHtml(prepared.content, prepared.baseUrl);
  if (!cleanedHtml) {
    throw new Error("Node article cleaner produced empty cleaned_html");
  }

  const cleanedMarkdown = htmlToMarkdown(cleanedHtml);
  if (!cleanedMarkdown) {
    throw new Error("Node article cleaner produced empty cleaned_markdown");
  }

  const payload = {
    title: prepared.title,
    byline: prepared.byline,
    excerpt: prepared.excerpt,
    cleaned_html: cleanedHtml,
    cleaned_markdown: cleanedMarkdown,
  };

  process.stdout.write(JSON.stringify(payload));
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
