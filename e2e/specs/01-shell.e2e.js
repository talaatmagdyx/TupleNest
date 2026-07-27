/**
 * The window opens, and the parts of the app that need no database work.
 *
 * If a Linux build is missing a shared library, or WebView2 fails to
 * initialise on Windows, this file is where it shows up — as a session that
 * never starts or a shell that never renders. Everything after it would fail
 * too, but this says why.
 */

describe("the app comes up", () => {
  it("renders the shell rather than a blank window", async () => {
    // A blank WebView is the specific failure this whole suite exists to
    // catch, and it is indistinguishable from a slow one until you wait.
    const shell = await $(".shell");
    await shell.waitForExist({ timeout: 60000 });
    await expect($(".brand-word")).toHaveText("TupleNest");
  });

  it("stamps the build it is running", async () => {
    // The OS and server version only appear here once a session is live, so
    // that assertion belongs in the connected spec. What the status bar can
    // prove while disconnected is which build this is — worth pinning, since
    // an installer that quietly left an older binary in place is exactly the
    // kind of thing this suite exists to catch.
    const status = await $(".statusbar");
    await status.waitForExist();
    await expect(status).toHaveText(expect.stringContaining("disconnected"));
    await expect(status).toHaveText(/[0-9a-f]{7} · \d{4}-\d{2}-\d{2}/);
  });

  it("starts disconnected, and says so", async () => {
    await expect($(".titlebar")).toHaveText(expect.stringContaining("Not connected"));
  });
});

describe("the editor works with no server", () => {
  it("accepts typing while disconnected", async () => {
    // This regressed once already: the editor was disabled until a connection
    // was up, which is exactly when you want to draft a query.
    const editor = await $('textarea[aria-label="SQL editor"]');
    await editor.waitForExist();
    await editor.setValue("select 1 -- typed by the smoke test");
    await expect(editor).toHaveValue(/typed by the smoke test/);
  });

  it("opens the command palette and filters it", async () => {
    const meta = process.platform === "win32" ? "Control" : "Meta";
    await browser.keys([meta, "k"]);
    const search = await $('input[aria-label="Search commands and tables"]');
    await search.waitForExist();
    await search.setValue("Analyze");
    // Assert on the palette, not on `.pal-item`: `$` returns the first match,
    // and each row's icon and type badge are separate children, so the first
    // one reads "📋ACTION" and an assertion on it says nothing about filtering.
    await expect($(".modal.palette")).toHaveText(expect.stringContaining("plan"));
    await browser.keys(["Escape"]);
  });
});
