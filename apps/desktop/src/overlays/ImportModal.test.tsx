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
