import DOMPurify, { type Config as DomPurifyConfig } from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdownLang from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import katex from "katex";
import MarkdownIt from "markdown-it";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("go", go);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdownLang);
hljs.registerLanguage("md", markdownLang);

const MAX_CACHE_ENTRIES = 600;
const htmlCache = new Map<string, string>();

const DOMPURIFY_CONFIG: DomPurifyConfig = {
  ADD_TAGS: [
    "math",
    "semantics",
    "mrow",
    "mi",
    "mo",
    "mn",
    "msup",
    "msub",
    "mfrac",
    "annotation",
  ],
  ADD_ATTR: ["class", "style"],
};

interface SanitizerLike {
  sanitize(source: string, config?: DomPurifyConfig): string;
}

type SanitizerFactory = (win: Window) => SanitizerLike;

function getSanitizer(): SanitizerLike {
  const candidate = DOMPurify as unknown as SanitizerLike & SanitizerFactory;
  if (typeof candidate.sanitize === "function") {
    return candidate;
  }
  if (typeof candidate === "function" && typeof window !== "undefined") {
    return candidate(window);
  }
  throw new Error("DOMPurify sanitizer is unavailable");
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: true,
  highlight(str: string, lang: string): string {
    const cleanLang = lang.trim().toLowerCase();
    if (cleanLang && hljs.getLanguage(cleanLang)) {
      try {
        const result = hljs.highlight(str, { language: cleanLang, ignoreIllegals: true });
        return `<pre class="hljs"><code>${result.value}</code></pre>`;
      } catch {
        return `<pre class="hljs"><code>${escapeHtml(str)}</code></pre>`;
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(str)}</code></pre>`;
  },
});

function preprocessMathOutsideCode(input: string): {
  text: string;
  placeholders: Map<string, string>;
} {
  const placeholders = new Map<string, string>();
  let out = "";
  let i = 0;
  let seq = 0;

  while (i < input.length) {
    const atLineStart = i === 0 || input[i - 1] === "\n";

    // Protect fenced code blocks (``` or ~~~)
    if (atLineStart) {
      let spaceCount = 0;
      while (i + spaceCount < input.length && input[i + spaceCount] === " " && spaceCount < 4) {
        spaceCount += 1;
      }
      const ch = input[i + spaceCount];
      if ((ch === "`" || ch === "~") && spaceCount < 4) {
        let fenceLen = 0;
        while (input[i + spaceCount + fenceLen] === ch) {
          fenceLen += 1;
        }
        if (fenceLen >= 3) {
          const fence = ch.repeat(fenceLen);
          const firstNl = input.indexOf("\n", i + spaceCount + fenceLen);
          if (firstNl === -1) {
            out += input.slice(i);
            break;
          }
          let searchPos = firstNl + 1;
          let closeEnd = input.length;
          while (searchPos < input.length) {
            const nextNl = input.indexOf("\n", searchPos);
            const lineEnd = nextNl === -1 ? input.length : nextNl;
            const line = input.slice(searchPos, lineEnd).trim();
            if (line.startsWith(fence) && line.slice(fenceLen).trim() === "") {
              closeEnd = nextNl === -1 ? input.length : nextNl + 1;
              break;
            }
            if (nextNl === -1) {
              break;
            }
            searchPos = nextNl + 1;
          }
          out += input.slice(i, closeEnd);
          i = closeEnd;
          continue;
        }
      }
    }

    // Protect inline code spans (`...`)
    if (input[i] === "`") {
      let tickLen = 0;
      while (input[i + tickLen] === "`") {
        tickLen += 1;
      }
      const closer = "`".repeat(tickLen);
      let closeIdx = input.indexOf(closer, i + tickLen);
      while (closeIdx !== -1 && input[closeIdx + tickLen] === "`") {
        closeIdx = input.indexOf(closer, closeIdx + tickLen + 1);
      }
      if (closeIdx !== -1) {
        out += input.slice(i, closeIdx + tickLen);
        i = closeIdx + tickLen;
        continue;
      }
    }

    // Preserve escaped \$
    if (input[i] === "\\" && input[i + 1] === "$") {
      out += input.slice(i, i + 2);
      i += 2;
      continue;
    }

    // Display math $$...$$
    if (input[i] === "$" && input[i + 1] === "$") {
      const closeIdx = input.indexOf("$$", i + 2);
      if (closeIdx !== -1) {
        const expr = input.slice(i + 2, closeIdx).trim();
        if (expr.length > 0) {
          const rendered = katex.renderToString(expr, {
            displayMode: true,
            throwOnError: false,
          });
          const token = `AXIOMMATHBLOCK${seq}END`;
          seq += 1;
          placeholders.set(token, `<div class="katex-block">${rendered}</div>`);
          out += token;
          i = closeIdx + 2;
          continue;
        }
      }
    }

    // Inline math $...$
    if (input[i] === "$" && input[i + 1] !== "$") {
      const nextCh = input[i + 1];
      if (nextCh && !/\s/.test(nextCh)) {
        let closeIdx = i + 1;
        let found = -1;
        while (closeIdx < input.length) {
          if (input[closeIdx] === "\n") {
            break;
          }
          if (input[closeIdx] === "\\" && closeIdx + 1 < input.length) {
            closeIdx += 2;
            continue;
          }
          if (input[closeIdx] === "$") {
            const prevCh = input[closeIdx - 1];
            const afterCh = input[closeIdx + 1];
            if (prevCh && !/\s/.test(prevCh) && (!afterCh || !/\d/.test(afterCh))) {
              found = closeIdx;
              break;
            }
          }
          closeIdx += 1;
        }
        if (found !== -1) {
          const expr = input.slice(i + 1, found);
          const rendered = katex.renderToString(expr, {
            displayMode: false,
            throwOnError: false,
          });
          const token = `AXIOMMATHINLINE${seq}END`;
          seq += 1;
          placeholders.set(token, rendered);
          out += token;
          i = found + 1;
          continue;
        }
      }
    }

    out += input[i];
    i += 1;
  }

  return { text: out, placeholders };
}

export function renderMarkdownToSanitizedHtml(markdown: string): string {
  if (!markdown || markdown.trim().length === 0) {
    return "";
  }
  const { text, placeholders } = preprocessMathOutsideCode(markdown);
  let html = md.render(text);
  for (const [token, katexHtml] of placeholders.entries()) {
    html = html.split(token).join(katexHtml);
  }
  return getSanitizer().sanitize(html, DOMPURIFY_CONFIG);
}

export function getRenderedMarkdown(contentHash: string, markdown: string): string {
  if (contentHash.length > 0) {
    const cached = htmlCache.get(contentHash);
    if (cached !== undefined) {
      // Refresh LRU recency
      htmlCache.delete(contentHash);
      htmlCache.set(contentHash, cached);
      return cached;
    }
  }

  const sanitized = renderMarkdownToSanitizedHtml(markdown);
  if (contentHash.length > 0) {
    if (htmlCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = htmlCache.keys().next().value;
      if (oldestKey !== undefined) {
        htmlCache.delete(oldestKey);
      }
    }
    htmlCache.set(contentHash, sanitized);
  }
  return sanitized;
}

export function clearMarkdownCache(): void {
  htmlCache.clear();
}

export function getMarkdownCacheSize(): number {
  return htmlCache.size;
}
