import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { renderMarkdown } from "./markdown";

const html = (src: string) => render(<div>{renderMarkdown(src)}</div>).container.firstElementChild!.innerHTML;

describe("renderMarkdown", () => {
  it("renders headings, paragraphs, lists and fenced code", () => {
    expect(html("# Title\n\nOne\nline\n\n- a\n* b\n\n```\nselect 1;\n```")).toBe(
      '<h3>Title</h3><p>One line</p><ul><li>a</li><li>b</li></ul><pre class="md-code">select 1;</pre>',
    );
    expect(html("## Two\n### Three")).toBe("<h4>Two</h4><h5>Three</h5>");
  });

  it("renders numbered lists, keeping a start other than one, and deeper headings as the smallest", () => {
    expect(html("1. add an index\n2) run it\n\nafter")).toBe("<ol><li>add an index</li><li>run it</li></ol><p>after</p>");
    expect(html("3. third\n4. fourth")).toBe('<ol start="3"><li>third</li><li>fourth</li></ol>');
    expect(html("text\n1. item")).toBe("<p>text</p><ol><li>item</li></ol>");
    expect(html("#### Four")).toBe("<h5>Four</h5>");
  });

  it("renders inline code, bold, italic, and a link as text beside its address", () => {
    expect(html("a `x*y*` **b** *c* [docs](https://example.com) end")).toBe(
      '<p>a <code>x*y*</code> <strong>b</strong> <em>c</em> <span class="md-link" title="https://example.com">docs <span class="md-url">(https://example.com)</span></span> end</p>',
    );
  });

  it("never renders raw HTML", () => {
    const out = html('<img src=x onerror="alert(1)"><script>alert(2)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img");
  });

  it("closes an unterminated fence at the end", () => {
    expect(html("```\nselect 1")).toBe('<pre class="md-code">select 1</pre>');
    expect(html("\r\n\r\ntext")).toBe("<p>text</p>");
  });
});
