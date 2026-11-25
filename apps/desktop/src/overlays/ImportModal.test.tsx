import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import ImportModal from "./ImportModal";

const invokeMock = vi.mocked(invoke);
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ columns: [], rows: [], rowsAffected: 0, durationMs: 1 });
});

const base = {
  schemas: ["public", "analytics"],
  env: "dev" as string | null,
  inTx: false,
  onDone: vi.fn(),
  onClose: vi.fn(),
};

const csv = (text: string, name = "people.csv") => {
  const f = new File([text], name, { type: "text/csv" });
  // jsdom's File does not implement text(); the component reads the file with
  // it, so give it a real one rather than mocking the component's own parse.
  Object.defineProperty(f, "text", { value: async () => text, configurable: true });
  return f;
};

/** Drive the hidden file input the way the Choose-file button does.
 *
 *  `userEvent.upload` refuses a `display: none` input — reasonably, since a
 *  user could not click it. The real click goes through `fileRef.current`, so
 *  fire the change directly and let the component's own handler run. */
const choose = async (container: HTMLElement, file: File) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input);
  });
};

const GOOD = "id,full name,active\n1,Ada,true\n2,Alan,false\n";

describe("ImportModal — choosing a file", () => {
  it("promises the file stays local until Import is pressed", () => {
    render(<ImportModal {...base} />);
    expect(screen.getByText(/nothing leaves the app until you press Import/)).toBeInTheDocument();
  });

  it("reads the header and rows", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    expect(await screen.findByText(/Import 2 rows/)).toBeInTheDocument();
  });

  it("refuses a file with no header rather than importing nothing", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(""));
    expect(await screen.findByText("That file has no header row.")).toBeInTheDocument();
  });

  it("derives a legal table name from the filename", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD, "My Report 2024.csv"));
    expect(await screen.findByDisplayValue("my_report_2024")).toBeInTheDocument();
  });

  it("falls back to a usable name when the filename has nothing legal in it", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD, "!!!.csv"));
    expect(await screen.findByDisplayValue("imported")).toBeInTheDocument();
  });

  it("normalises a header that is not a legal column name", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    expect(await screen.findByDisplayValue("full_name")).toBeInTheDocument();
  });

  it("infers types rather than making everything text", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    await screen.findByDisplayValue("id");
    const selects = screen.getAllByRole("combobox");
    const values = selects.map((s) => (s as HTMLSelectElement).value);
    expect(values).toContain("int8");
    expect(values).toContain("boolean");
  });

  it("goes back to the picker", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    await userEvent.click(await screen.findByRole("button", { name: "Choose another" }));
    expect(screen.getByText(/Choose a CSV or TSV file/)).toBeInTheDocument();
  });
});

describe("ImportModal — safety", () => {
  it("will not import without a table name", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    const name = await screen.findByPlaceholderText("new table name");
    await userEvent.clear(name);
    expect(screen.getByRole("button", { name: /Import 2 rows/ })).toBeDisabled();
  });

  it("will not import with a blank column name", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    await userEvent.clear(await screen.findByDisplayValue("full_name"));
    expect(screen.getByRole("button", { name: /Import 2 rows/ })).toBeDisabled();
  });

  it("promises one transaction", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    expect(await screen.findByText(/any failure rolls back the whole import/)).toBeInTheDocument();
  });

  it("makes the import button loud on production", async () => {
    const { container } = render(<ImportModal {...base} env="prod" />);
    await choose(container, csv(GOOD));
    expect(await screen.findByRole("button", { name: /Import 2 rows/ })).toHaveClass("danger");
  });

  it("keeps it calm off production", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    expect(await screen.findByRole("button", { name: /Import 2 rows/ })).toHaveClass("primary");
  });

  it("gives the close button a real name", () => {
    render(<ImportModal {...base} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<ImportModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ImportModal — running", () => {
  it("creates the table and inserts, then reports", async () => {
    const onDone = vi.fn();
    const { container } = render(<ImportModal {...base} onDone={onDone} />);
    await choose(container, csv(GOOD));
    await userEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const sent = invokeMock.mock.calls.map((c) => JSON.stringify(c[1]));
    expect(sent.some((s) => /create table/i.test(s))).toBe(true);
    expect(sent.some((s) => /insert into/i.test(s))).toBe(true);
  });

  it("wraps the whole import in one transaction", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    await userEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    await waitFor(() => expect(base.onDone).toHaveBeenCalled());
    const names = invokeMock.mock.calls.map((c) => c[0]);
    expect(names).toContain("pg_begin");
    expect(names).toContain("pg_commit");
  });

  it("reports the import error even when the rollback also fails", async () => {
    // The session being gone is often *why* the insert failed. Replacing the
    // message with "rollback failed" loses the only useful explanation.
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pg_query") return Promise.reject(new Error("duplicate key"));
      if (cmd === "pg_rollback") return Promise.reject(new Error("no connection"));
      return Promise.resolve(undefined);
    });
    await userEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    expect(await screen.findByText(/duplicate key/)).toBeInTheDocument();
  });

  it("lets a wrong inference be corrected before the table is built", async () => {
    // The type guess comes from a sample of rows. Locking it in would make a
    // column that is text-in-row-500 fail the import at row 500.
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    await screen.findByDisplayValue("id");
    // The first combobox is the target schema; the type selects are the ones
    // holding an inferred type.
    const select = (screen.getAllByRole("combobox") as HTMLSelectElement[]).find((x) => x.value === "int8")!;
    await userEvent.selectOptions(select, "text");
    expect(select.value).toBe("text");
    await userEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    const ddl = invokeMock.mock.calls.find((c) => String((c[1] as { sql?: string })?.sql).includes("CREATE TABLE"));
    expect(String((ddl?.[1] as { sql: string }).sql)).toMatch(/"id"\s+text/i);
  });

  it("rolls back and surfaces the error rather than leaving half a table", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(GOOD));
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pg_query") return Promise.reject(new Error("duplicate key"));
      return Promise.resolve(undefined);
    });
    await userEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    expect(await screen.findByText(/duplicate key/)).toBeInTheDocument();
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain("pg_rollback");
  });
});

describe("ImportModal — streaming a file it never holds whole", () => {
  /** A file whose stream fails partway, to exercise the read-error path. */
  const brokenFile = (name = "broken.csv") => {
    const f = new File(["id\n1\n"], name, { type: "text/csv" });
    Object.defineProperty(f, "stream", {
      value: () =>
        new ReadableStream({
          start(c) {
            c.error(new Error("disk went away"));
          },
        }),
      configurable: true,
    });
    return f;
  };

  it("reports a read failure instead of pretending the file was empty", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, brokenFile());
    expect(await screen.findByText(/Could not read that file/)).toBeInTheDocument();
    // And it must not offer to import something it never read.
    expect(screen.queryByRole("button", { name: /^Import/ })).not.toBeInTheDocument();
  });

  it("samples a large file rather than counting every row up front", async () => {
    // 600 data rows against a 500-row sample: the modal must not claim a total
    // it has not counted, because it deliberately stopped reading.
    const many = "id,name\n" + Array.from({ length: 600 }, (_, i) => `${i},n${i}`).join("\n") + "\n";
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv(many, "big.csv"));
    expect(await screen.findByText(/first 500 rows sampled/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import all rows/ })).toBeInTheDocument();
  });

  it("reports the true row count after streaming the whole file", async () => {
    const many = "id,name\n" + Array.from({ length: 600 }, (_, i) => `${i},n${i}`).join("\n") + "\n";
    const onDone = vi.fn();
    const { container } = render(<ImportModal {...base} onDone={onDone} />);
    await choose(container, csv(many, "big.csv"));
    await userEvent.click(await screen.findByRole("button", { name: /Import all rows/ }));
    // 600 rows in batches of 500 — the count comes from what was inserted, not
    // from the 500-row preview.
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.stringContaining("600")));
  });

  it("is a real dialog, and Escape cannot close it while an import runs", async () => {
    // It used to sit outside the shared Overlay: no focus trap, no dialog
    // role, and the app-wide Escape closed it mid-import while the import
    // carried on with no UI.
    invokeMock.mockImplementation(async (_cmd: string, a?: unknown) => {
      const sql = String((a as { sql?: string } | undefined)?.sql ?? "");
      if (/^insert into/i.test(sql)) return new Promise(() => {}); // never finishes
      return { columns: [], rows: [], rowsAffected: 0, durationMs: 1 };
    });
    const onClose = vi.fn();
    const { container } = render(<ImportModal {...base} onClose={onClose} />);
    await choose(container, csv(GOOD));
    expect(screen.getByRole("dialog", { name: "Import CSV" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    await waitFor(() =>
      expect(invokeMock.mock.calls.some((c) => /insert into/i.test(String((c[1] as { sql?: string })?.sql)))).toBe(true),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("inside the user's own transaction, a cancel undoes only the import", async () => {
    // The user typed BEGIN, so the UI's inTx is false but the server has a
    // transaction open. The import must not BEGIN again, and a cancel must
    // neither ROLLBACK their transaction nor write the batch still pending.
    const many = "id,name\n" + Array.from({ length: 2000 }, (_, i) => `${i},n${i}`).join("\n") + "\n";
    let cancelBtn: HTMLElement | null = null;
    let inserts = 0;
    invokeMock.mockImplementation(async (cmd: string, a?: unknown) => {
      if (cmd === "pg_in_transaction") return true;
      const sql = String((a as { sql?: string } | undefined)?.sql ?? "");
      if (/^insert into/i.test(sql)) {
        inserts++;
        if (cancelBtn) fireEvent.click(cancelBtn);
      }
      return { columns: [], rows: [], rowsAffected: 0, durationMs: 1 };
    });
    const onDone = vi.fn();
    const { container } = render(<ImportModal {...base} onDone={onDone} />);
    await choose(container, csv(many, "big.csv"));
    const importBtn = await screen.findByRole("button", { name: /Import all rows/ });
    cancelBtn = screen.getByRole("button", { name: "Cancel" });
    await userEvent.click(importBtn);

    await waitFor(() => expect(screen.getByText(/cancelled/i)).toBeInTheDocument());
    const names = invokeMock.mock.calls.map((c) => c[0]);
    const sqls = invokeMock.mock.calls.map((c) => String((c[1] as { sql?: string } | undefined)?.sql ?? ""));
    expect(names).not.toContain("pg_begin");
    expect(names).not.toContain("pg_rollback");
    expect(names).not.toContain("pg_commit");
    expect(sqls).toContain("SAVEPOINT tuplenest_import");
    expect(sqls).toContain("ROLLBACK TO SAVEPOINT tuplenest_import");
    expect(inserts).toBe(1); // the batch pending at cancel was not flushed
    expect(onDone).not.toHaveBeenCalled();
  });

  it("cancels mid-import and rolls back rather than leaving a half-filled table", async () => {
    const many = "id,name\n" + Array.from({ length: 2000 }, (_, i) => `${i},n${i}`).join("\n") + "\n";
    // Flip cancel as soon as the first batch insert goes out.
    let cancelBtn: HTMLElement | null = null;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pg_query" && cancelBtn) fireEvent.click(cancelBtn);
      return { columns: [], rows: [], rowsAffected: 0, durationMs: 1 };
    });
    const onDone = vi.fn();
    const { container } = render(<ImportModal {...base} onDone={onDone} />);
    await choose(container, csv(many, "big.csv"));
    // The footer only exists once the preview has streamed in, so wait for the
    // Import button before reaching for the Cancel beside it.
    const importBtn = await screen.findByRole("button", { name: /Import all rows/ });
    cancelBtn = screen.getByRole("button", { name: "Cancel" });
    await userEvent.click(importBtn);

    await waitFor(() => expect(screen.getByText(/cancelled/i)).toBeInTheDocument());
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain("pg_rollback");
    expect(onDone).not.toHaveBeenCalled();
  });
});

// Audit TN-023, the parts that live in the dialog.
describe("ImportModal — a file that cannot be imported faithfully", () => {
  const bytes = (b: number[], name = "export.csv") => new File([new Uint8Array(b)], name, { type: "text/csv" });

  it("refuses a file that is not UTF-8 instead of importing replacement characters", async () => {
    // "name\ncafé\n" in Latin-1: 0xE9 alone is not valid UTF-8.
    const latin1 = [0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x0a];
    const { container } = render(<ImportModal {...base} />);
    await choose(container, bytes(latin1));
    expect(await screen.findByText(/not UTF-8 text/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Import \d/ })).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses a UTF-16 export", async () => {
    // BOM FF FE, then "a\n1\n" in UTF-16LE.
    const { container } = render(<ImportModal {...base} />);
    await choose(container, bytes([0xff, 0xfe, 0x61, 0x00, 0x0a, 0x00, 0x31, 0x00, 0x0a, 0x00]));
    expect(await screen.findByText(/not UTF-8 text/)).toBeInTheDocument();
  });

  it("refuses a file cut off inside a character", async () => {
    // "a\n" then the first two bytes of a three-byte character.
    const { container } = render(<ImportModal {...base} />);
    await choose(container, bytes([0x61, 0x0a, 0xe2, 0x82]));
    expect(await screen.findByText(/not UTF-8 text/)).toBeInTheDocument();
  });

  it("still reads real UTF-8, accents and all", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv("name\ncafé\n日本\n"));
    expect(await screen.findByText(/Import 2 rows/)).toBeInTheDocument();
    expect(screen.getByText("café")).toBeInTheDocument();
  });

  it("says where an unclosed quote starts, and offers nothing to import", async () => {
    const { container } = render(<ImportModal {...base} />);
    await choose(container, csv('id,note\n1,ok\n2,"oops\n3,x\n'));
    expect(await screen.findByText(/starts on line 3 is never closed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Import \d/ })).not.toBeInTheDocument();
  });

  it("does not count blank lines as rows, and says how many it skipped", async () => {
    const onDone = vi.fn();
    const { container } = render(<ImportModal {...base} onDone={onDone} />);
    await choose(container, csv("id,name\n1,Ada\n\n2,Alan\n\n\n"));
    await userEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toMatch(/Imported 2 rows .*\(3 blank lines skipped\)/);
    const insert = invokeMock.mock.calls.find((c) => /insert into/i.test(JSON.stringify(c[1])));
    expect((insert![1] as { params: unknown[] }).params).toEqual(["1", "Ada", "2", "Alan"]);
  });

  it("says nothing about blank lines when there were none", async () => {
    const onDone = vi.fn();
    const { container } = render(<ImportModal {...base} onDone={onDone} />);
    await choose(container, csv(GOOD));
    await userEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).not.toMatch(/blank/);
  });

  it("keeps zero-padded codes as text all the way to the INSERT", async () => {
    const onDone = vi.fn();
    const { container } = render(<ImportModal {...base} onDone={onDone} />);
    await choose(container, csv("zip,n\n02134,1\n00501,2\n"));
    await userEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const sent = invokeMock.mock.calls.map((c) => c[1] as { sql?: string; params?: unknown[] });
    expect(sent.find((s) => /create table/i.test(s?.sql ?? ""))!.sql).toMatch(/"zip" text/);
    expect(sent.find((s) => /insert into/i.test(s?.sql ?? ""))!.params).toEqual(["02134", "1", "00501", "2"]);
  });
});
