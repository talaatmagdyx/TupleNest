/**
 * The editor's layout and key handling, in a browser that actually lays out.
 *
 * This file exists because the unit tests cannot do this. They run in jsdom,
 * which has no layout engine: every rect is zero and nothing ever wraps. So
 * the assertion "a long line wraps instead of scrolling sideways" — the whole
 * point of the change that introduced it — is not something 2,000 passing
 * tests can say anything about. They can prove the line number is a child of
 * its line; only a real WebKit can prove the line wrapped.
 *
 * The key handling is here for a different reason: `setValue` sets a value, it
 * does not press keys, so Tab, Enter and the bracket pairing are only
 * exercised end to end by sending real key events to a real window.
 */

const editor = () => $('textarea[aria-label="SQL editor"]');
const META = process.platform === "win32" ? "Control" : "Meta";

/** Empty the editor and put the caret in it. */
async function clear() {
  const ta = await editor();
  await ta.waitForExist({ timeout: 60000 });
  await ta.click();
  await browser.keys([META, "a"]);
  await browser.keys(["Backspace"]);
  return ta;
}

/** Replace the content without pressing keys.
 *
 *  Deliberate: typing this text character by character would run it through
 *  the bracket and quote pairing, so the editor would end up holding something
 *  other than what was asked for. These tests want the text; the key tests
 *  below want the keys. `setValue` on a controlled React textarea appends
 *  rather than replaces, hence the clear first. */
async function setFresh(text) {
  const ta = await clear();
  await ta.setValue(text);
  return ta;
}

describe("the editor lays out long lines", () => {
  it("wraps rather than scrolling sideways", async () => {
    // The line that started it: a channel filter wide enough to run off the
    // right edge of any window.
    const ta = await setFresh(
      "select * from eng_interactions where channel = any(array['email', 'facebook', " +
        "'facebook_dm', 'instagram', 'instagram_dm', 'livechat_dm', 'twitter', 'twitter_dm'])",
    );

    // The real assertion: no horizontal overflow. A textarea that scrolls
    // sideways has a scrollWidth beyond its clientWidth; a wrapping one does
    // not. A pixel of slack for sub-pixel rounding.
    const [scrollWidth, clientWidth] = await browser.execute(
      (el) => [el.scrollWidth, el.clientWidth],
      ta,
    );
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // And it wrapped rather than being clipped: one logical line occupying
    // more than a single row of vertical space.
    const [scrollHeight, lineHeight] = await browser.execute(
      (el) => [el.scrollHeight, parseFloat(getComputedStyle(el).lineHeight)],
      ta,
    );
    expect(scrollHeight).toBeGreaterThan(lineHeight * 1.5);
  });

  it("keeps every line number beside its own line", async () => {
    await setFresh("select 1\nselect 2\nselect 3");
    await browser.waitUntil(async () => (await $$(".editor-pre .eline .lnum")).length === 3, {
      timeoutMsg: "expected one line number per line",
    });
    const numbers = await $$(".editor-pre .eline .lnum");
    await expect(numbers[2]).toHaveText("3");
  });
});

describe("the editor's keys reach the text", () => {
  it("indents on Tab instead of leaving the editor", async () => {
    const ta = await setFresh("select 1");
    await browser.keys([META, "ArrowLeft"]); // caret to the start of the line
    await browser.keys(["Tab"]);
    await expect(ta).toHaveValue(expect.stringContaining("  select 1"));
    // Focus stayed put — Tab was taken by the editor, not by the browser.
    const stillFocused = await browser.execute((el) => document.activeElement === el, ta);
    expect(stillFocused).toBe(true);
  });

  it("closes a bracket as it is opened", async () => {
    const ta = await setFresh("select count");
    await browser.keys([META, "ArrowRight"]); // caret to the end of the line
    await browser.keys(["("]);
    await expect(ta).toHaveValue(expect.stringContaining("count()"));
  });

  it("carries the indentation onto the next line", async () => {
    const ta = await setFresh("  select 1");
    await browser.keys([META, "ArrowRight"]);
    await browser.keys(["Enter"]);
    await browser.keys(["x"]);
    // The new line starts where the old one did, not at column zero.
    await expect(ta).toHaveValue(expect.stringContaining("\n  x"));
  });
});
