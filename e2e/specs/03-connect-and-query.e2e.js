/**
 * The whole stack on this OS: form → keychain → driver → server → grid.
 *
 * This is the spec that justifies the suite. Typing a password writes it to
 * the platform's credential store — Windows Credential Manager, or the Secret
 * Service on Linux — and the connection then reads it back. That path has
 * three different implementations behind one trait and only one of them has
 * ever been exercised by hand.
 *
 * The workflow points PG* at a server it started, so nothing here assumes a
 * particular host.
 */

const PG = {
  host: process.env.PGHOST || "localhost",
  port: process.env.PGPORT || "5432",
  database: process.env.PGDATABASE || "postgres",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
};

/** The form's inputs get generated ids, so go through the label, which is what
 *  a screen reader and a user both do. */
const byLabel = async (text) => {
  const label = await $(`label=${text}`);
  await label.waitForExist();
  const id = await label.getAttribute("for");
  return $(`#${id}`);
};

describe("connecting to a real server", () => {
  it("opens the connection editor", async () => {
    const plus = await $('button.plus[title="New connection"]');
    await plus.waitForExist();
    await plus.click();
    await expect(await byLabel("Host")).toExist();
  });

  it("takes the server details", async () => {
    await (await byLabel("Name")).setValue("smoke");
    await (await byLabel("Host")).setValue(PG.host);
    await (await byLabel("Port")).setValue(PG.port);
    await (await byLabel("Database")).setValue(PG.database);
    await (await byLabel("Username")).setValue(PG.user);
    await (await byLabel("Password")).setValue(PG.password);
    // The default is verify-full, which is the right default and the wrong
    // one for a local server with no certificate. Choosing it explicitly also
    // proves the select is wired.
    await (await byLabel("TLS mode")).selectByAttribute("value", "prefer");
  });

  it("reaches the server on Test before committing to anything", async () => {
    await (await $("button=Test")).click();
    // Test runs the staged probe (DNS, TCP, then a real handshake). Waiting on
    // the server version rather than a generic "ok" means a probe that passed
    // DNS and stopped cannot satisfy this.
    await expect($(".modal")).toHaveText(expect.stringContaining("PostgreSQL"), { timeout: 60000 });
  });

  it("saves the password to the OS credential store and connects", async () => {
    await (await $("button=Save & Connect")).click();
    // Connected state is what the titlebar and the ambient window frame both
    // key off; `.env-frame` only appears once a session is live.
    await expect($(".shell")).toHaveElementClass("env-frame", { timeout: 60000 });
    await expect($(".titlebar")).toHaveText(expect.stringContaining("smoke"));
  });

  it("names the server and the platform once a session is live", async () => {
    // Only true when connected — the status bar has nothing to report about a
    // server it has not reached. Asserting the OS here means a Windows run
    // that somehow drove a Linux binary could not pass quietly.
    const os = process.platform === "win32" ? "windows" : "linux";
    const status = await $(".statusbar");
    await expect(status).toHaveText(expect.stringContaining("PostgreSQL"), { timeout: 30000 });
    await expect(status).toHaveText(expect.stringContaining(os));
  });

  it("runs a query and renders rows", async () => {
    const editor = await $('textarea[aria-label="SQL editor"]');
    await editor.setValue("select 42 as answer");
    const meta = process.platform === "win32" ? "Control" : "Meta";
    await browser.keys([meta, "Enter"]);

    const grid = await $('[aria-label="Query results"]');
    await grid.waitForExist({ timeout: 60000 });

    // The grid renders its header and row-number gutter, and the value cell
    // stays empty under xvfb — the row window a virtualized grid computes
    // depends on a laid-out viewport, and a headless one does not give it a
    // useful height. That is a property of the test display, not of the app,
    // so asserting on the cell would be asserting on xvfb.
    //
    // What is worth asserting is that the round trip happened: the app is
    // reporting a row count back from the server, which means the driver
    // connected, executed, decoded and returned. Rendering is covered by the
    // component tests, which run in a laid-out DOM.
    // `div.meta`, not `.meta`: the connection cards use a span with the same
    // class and come first in the document.
    await expect($("div.meta")).toHaveText(/1 rows/, { timeout: 60000 });
    await expect(grid).toHaveText(expect.stringContaining("answer"));
  });

  it("records the query in history, which is a different store again", async () => {
    // History is SQLite on local disk rather than anything the server returns,
    // so it covers a write path the query itself does not — and on Linux that
    // file lives under a directory the .deb never creates, which is the sort
    // of thing only an installed build can prove.
    await (await $("button.rtab=History")).click();
    await expect($(".hist-list")).toHaveText(expect.stringContaining("42"), { timeout: 30000 });
  });

  it("reads the catalog into the explorer", async () => {
    // Metadata goes through a different command and the SQLite cache; a
    // connection that queries but never populates the tree is a real and
    // previously-seen failure.
    await expect($("div.tree")).toHaveText(expect.stringContaining("public"), { timeout: 60000 });
  });
});
