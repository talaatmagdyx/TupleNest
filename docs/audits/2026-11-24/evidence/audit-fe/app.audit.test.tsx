import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "@app/App";
import { CONNECTION, PROD, RESULT, backend, type Backend } from "@app/test/backend";

let be: Backend;
beforeEach(() => { be = backend(); });

const mount = async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText(CONNECTION.name);
  return user;
};
const palette = async (user: ReturnType<typeof userEvent.setup>, term: string) => {
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(await screen.findByPlaceholderText(/type a command/i), term);
  await user.keyboard("{Enter}");
};
const connected = async () => {
  const user = await mount();
  await palette(user, "Connect to local dev");
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  await screen.findByText(/Connected — local dev/);
  return user;
};
const titleName = () => document.querySelector(".conn-switch .name")?.textContent;
const titleHost = () => document.querySelector(".conn-switch .host")?.textContent;

describe("AUDIT titlebar identity follows the form, not the session", () => {
  it("shows another profile's name while still connected to the first", async () => {
    be.on("connection_list", () => [CONNECTION, { ...PROD, host: "prod.internal", username: "root" }]);
    const user = await connected();
    expect(titleName()).toBe("local dev");
    const cards = document.querySelectorAll(".conn-open");
    await user.click(cards[1] as HTMLElement); // open "prod db" in the editor
    await screen.findByText("Edit connection");
    await user.keyboard("{Escape}");
    console.log("TITLEBAR after viewing other profile:", titleName(), "|", titleHost(),
      "| pg_connect calls:", be.sent("pg_connect").length, "| pg_disconnect:", be.sent("pg_disconnect").length,
      "| prod banner:", !!document.querySelector(".prod-banner"),
      "| env pill:", document.querySelector(".conn-switch .env-pill")?.textContent);
    expect(be.sent("pg_connect")).toHaveLength(1);
    expect(titleName()).toBe("local dev"); // expected: still names the live session
  });
});

describe("AUDIT switching profile keeps the previous database's result", () => {
  it("still shows the old grid after connecting elsewhere", async () => {
    const user = await connected();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await screen.findByRole("grid");
    await waitFor(() => expect(screen.getByText("13109")).toBeInTheDocument());
    await user.click(document.querySelector(".conn-switch > button") as HTMLElement);
    const row = [...document.querySelectorAll(".conn-menu .row")].find((r) => r.textContent?.includes("prod db")) as HTMLElement;
    await user.click(row);
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(2));
    await screen.findByText(/Connected — prod db/);
    const grid = screen.queryByRole("grid");
    console.log("AFTER SWITCH: grid present:", !!grid, "| cell 13109:", !!screen.queryByText("13109"),
      "| prod banner:", !!document.querySelector(".prod-banner"),
      "| run status:", document.querySelector(".run-status")?.textContent);
    expect(grid).toBeNull(); // expected: a new session starts with no result
  });
});

describe("AUDIT a BEGIN typed in the editor is invisible to disconnect / switch", () => {
  it("disconnects without the transaction prompt", async () => {
    const user = await connected();
    be.on("pg_in_transaction", () => true); // the server has an open transaction
    await palette(user, "Disconnect current session");
    await waitFor(() => expect(be.sent("pg_disconnect").length).toBeGreaterThan(0)).catch(() => {});
    console.log("DISCONNECT with server-side tx: pg_disconnect calls:", be.sent("pg_disconnect").length,
      "| asked server:", be.sent("pg_in_transaction").length,
      "| prompt shown:", !!screen.queryByText(/open transaction|uncommitted/i));
    expect(be.sent("pg_disconnect")).toHaveLength(0); // expected: prompt first
  });
});

describe("AUDIT explorer failure is silent", () => {
  it("leaves 'Loading schemas…' forever and shows the error nowhere", async () => {
    const user = await mount();
    be.on("pg_metadata", (a) => {
      const req = (a.request ?? {}) as { kind?: string };
      if (req.kind === "list_schemas") throw new Error("permission denied for schema pg_catalog");
      return { payload: { version: "PostgreSQL 18.0" }, cached: false };
    });
    await palette(user, "Connect to local dev");
    await screen.findByText(/Connected — local dev/);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    console.log("EXPLORER FAILURE: loading note:", !!screen.queryByText(/Loading schemas/),
      "| error visible:", !!screen.queryByText(/permission denied/));
    expect(screen.queryByText(/permission denied/)).not.toBeNull(); // expected: the user is told
  });
});

describe("AUDIT grid block fetch failure", () => {
  it("shows a placeholder row with no error and never retries", async () => {
    const user = await connected();
    be.on("pg_rows", () => { throw new Error("result store was replaced"); });
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await screen.findByRole("grid");
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    const loading = document.querySelectorAll(".g-cell.loading").length;
    console.log("GRID FETCH FAILURE: loading rows:", loading, "| pg_rows calls:", be.sent("pg_rows").length,
      "| error text:", !!screen.queryByText(/result store was replaced/));
    expect(screen.queryByText(/result store was replaced/)).not.toBeNull(); // expected: surfaced
  });
});

describe("AUDIT palette list is rebuilt on every editor keystroke", () => {
  it("walks every catalog object per keystroke", async () => {
    let walks = 0;
    const objs = Array.from({ length: 3000 }, (_, i) => ({ name: `t${i}`, kind: "table", isPartitioned: false, partitionCount: 0 }));
    // Instrument the array the app stores for the schema's objects.
    const orig = objs.flatMap.bind(objs);
    (objs as unknown as { flatMap: unknown }).flatMap = (...a: Parameters<typeof orig>) => { walks++; return orig(...a); };
    const user = await mount();
    be.on("pg_metadata", (a) => {
      const req = (a.request ?? {}) as { kind?: string };
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      if (req.kind === "list_objects") return { payload: objs, cached: false };
      if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
      return { payload: [], cached: false };
    });
    await palette(user, "Connect to local dev");
    await screen.findByText(/Connected — local dev/);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const ta = screen.getByLabelText("SQL editor") as HTMLTextAreaElement;
    const before = walks;
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) fireEvent.change(ta, { target: { value: "select " + "x".repeat(i + 1) } });
    const ms = performance.now() - t0;
    console.log("PALETTE MEMO: walks before typing:", before, "| walks caused by 20 keystrokes:", walks - before, "| ms:", ms.toFixed(0));
    expect(walks - before).toBe(0); // expected: typing does not rebuild the palette
  });
});

describe("AUDIT copy-result failure", () => {
  it("shows nothing when the backend clipboard write fails", async () => {
    const user = await connected();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await screen.findByRole("grid");
    be.on("copy_result_text", () => { throw new Error("clipboard unavailable"); });
    const seen: unknown[] = [];
    const h = (r: unknown) => seen.push(r);
    process.on("unhandledRejection", h);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    const btns = [...document.querySelectorAll(".drop-menu button")].filter((b) => b.textContent === "CSV");
    await user.click(btns[btns.length - 1] as HTMLElement);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    process.off("unhandledRejection", h);
    console.log("COPY FAILURE: toast:", document.querySelector(".toast")?.textContent ?? null, "| unhandled rejections:", seen.map(String));
    expect(document.querySelector(".toast")?.textContent ?? "").toMatch(/fail|error|unavailable/i);
  });
});
