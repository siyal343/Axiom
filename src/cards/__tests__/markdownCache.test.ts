// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMarkdownCache,
  getMarkdownCacheSize,
  getRenderedMarkdown,
  renderMarkdownToSanitizedHtml,
} from "../markdownCache";

describe("UT-TS-02: markdownCache KaTeX, highlighting, LRU & DOMPurify XSS sanitization", () => {
  beforeEach(() => {
    clearMarkdownCache();
  });

  it("renders inline and display KaTeX math and highlighted code blocks", () => {
    const src = [
      "Latency bound $O(n \\log n)$ and display:",
      "",
      "$$E = mc^2$$",
      "",
      "```rust",
      "let x: u32 = 42;",
      "```",
      "",
      "Inline code `$not_math$` stays literal.",
    ].join("\n");

    const html = renderMarkdownToSanitizedHtml(src);
    expect(html).toContain("katex");
    expect(html).toContain("katex-block");
    expect(html).toContain("hljs");
    expect(html).toContain("let");
    expect(html).toContain("<code>$not_math$</code>");
  });

  it("strips <script>, onerror=, and javascript: XSS vectors via DOMPurify", () => {
    const malicious = [
      '<script>window.__xss = 1;</script>',
      '<img src="x" onerror="alert(1)">',
      '[click me](javascript:alert(1))',
      '<a href="javascript:void(0)" onclick="alert(2)">link</a>',
    ].join("\n\n");

    const sanitized = renderMarkdownToSanitizedHtml(malicious);
    expect(sanitized.toLowerCase()).not.toContain("<script");
    expect(sanitized.toLowerCase()).not.toContain("onerror");
    expect(sanitized.toLowerCase()).not.toContain("onclick");
    expect(sanitized.toLowerCase()).not.toContain("javascript:");
  });

  it("caches rendered HTML by content_hash and enforces 600-entry LRU bound", () => {
    const first = getRenderedMarkdown("hash_a", "**hello**");
    const second = getRenderedMarkdown("hash_a", "**ignored**");
    expect(first).toBe(second);
    expect(first).toContain("<strong>hello</strong>");

    for (let i = 0; i < 620; i += 1) {
      getRenderedMarkdown(`hash_${i}`, `item ${i}`);
    }
    expect(getMarkdownCacheSize()).toBe(600);
  });
});
