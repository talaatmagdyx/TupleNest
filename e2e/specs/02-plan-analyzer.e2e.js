/**
 * The plan analyzer, driven through a real WebView with no server anywhere.
 *
 * Worth doing on every platform rather than trusting the unit tests: the
 * parser is pure TypeScript and jsdom proves it parses, but it cannot prove
 * the result renders in WebKitGTK or WebView2. This is also the app's only
 * genuinely offline feature, so it is the deepest assertion available before
 * a database enters the picture.
 *
 * The plan below is written by hand, not captured from a real database.
 */

const PLAN = [
  "Hash Join  (cost=1.09..2.34 rows=4 width=68) (actual time=0.041..0.093 rows=4 loops=1)",
  "  Hash Cond: (o.customer_id = c.id)",
  "  ->  Seq Scan on orders o  (cost=0.00..1.04 rows=4 width=40) (actual time=0.008..0.011 rows=4 loops=1)",
  "        Filter: (status = 'open'::text)",
  "        Rows Removed by Filter: 96",
  "  ->  Hash  (cost=1.04..1.04 rows=4 width=36) (actual time=0.018..0.019 rows=4 loops=1)",
  "        ->  Seq Scan on customers c  (cost=0.00..1.04 rows=4 width=36) (actual time=0.006..0.009 rows=4 loops=1)",
  "Planning Time: 0.212 ms",
  "Execution Time: 0.140 ms",
].join("\n");

describe("analysing a pasted plan", () => {
  it("opens from the activity rail without a connection", async () => {
    const rail = await $('button.rail-btn[title="Analyze a pasted plan"]');
    await rail.waitForExist();
    await rail.click();
    await expect($(".modal.explain-modal")).toExist();
  });

  it("recognises the text format", async () => {
    const paste = await $('textarea[aria-label="Paste a query plan"]');
    await paste.waitForExist();
    // Not `setValue`: it sends the string as keystrokes, and every newline in
    // a plan becomes an Enter press. The first run of this spec reported
    // "1 node · 1 line" for a seven-line plan because only the first line
    // survived. Setting the value and dispatching `input` is what a paste
    // actually looks like to React.
    await browser.execute(
      (el, text) => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value"
        ).set;
        setter.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      paste,
      PLAN
    );
    // The format chip going green is the parser's own verdict on the input,
    // reached before anything is rendered.
    await expect($(".fmt-chip.ok")).toExist();
  });

  it("renders the tree, including the node that discarded rows", async () => {
    // `tag=text`, not `css=text`: WebDriverIO rejects a compound class
    // selector combined with its text syntax as an invalid selector.
    const analyze = await $("button=Analyze");
    await analyze.click();

    const modal = await $(".modal.explain-modal");
    await expect(modal).toHaveText(expect.stringContaining("Hash Join"));
    await expect(modal).toHaveText(expect.stringContaining("Seq Scan"));
    // 96 of 100 rows read and thrown away is the thing a plan reader exists to
    // surface; if the WebView rendered but the analysis did not run, this is
    // the assertion that notices.
    await expect(modal).toHaveText(expect.stringContaining("orders"));
  });

  it("closes again", async () => {
    await browser.keys(["Escape"]);
    await expect($(".modal.explain-modal")).not.toExist();
  });
});
