import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult } from "../ipc/types";
import {
  buildCreateTable,
  buildInsert,
  CsvStreamParser,
  inferTypes,
  normalizeHeader,
  type CsvTable,
  type InferredType,
} from "../lib/csv";

/**
 * Read a file as text, a chunk at a time, feeding rows to `onRows`.
 *
 * Bytes are decoded here rather than with `TextDecoderStream` so the caller can
 * report progress against `file.size` — a row count is not available until the
 * file has been read, which is the whole thing we are avoiding. `{stream:true}`
 * keeps a multi-byte character split across two chunks intact.
 *
 * `onRows` returning false stops the read and releases the stream, which is how
 * the preview reads only its first few hundred rows of a very large file.
 */
async function streamRows(
  file: File,
  delimiter: string,
  onRows: (rows: string[][], bytesRead: number) => boolean | Promise<boolean>,
): Promise<void> {
  const reader = file.stream().getReader();
  const parser = new CsvStreamParser(delimiter);
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const rows = parser.push(decoder.decode(value, { stream: true }));
      if (rows.length && !(await onRows(rows, bytes))) return;
    }
    const tail = parser.end();
    if (tail.length) await onRows(tail, bytes);
  } finally {
    // Releasing matters on the early-exit path: without it the preview would
    // hold the file open after it has what it needs.
    reader.cancel().catch(() => {});
  }
}

type Props = {
  schemas: string[];
  env: string | null;
  inTx: boolean;
  onDone: (msg: string) => void;
  onClose: () => void;
};

const TYPES: InferredType[] = ["int8", "numeric", "boolean", "timestamptz", "date", "text"];
const BATCH = 500;
const PREVIEW_ROWS = 8;
/** Rows read up front, to show a preview and infer types. Deliberately small:
 *  the point of streaming is never to hold the file, and `inferTypes` samples
 *  500 anyway. */
const SAMPLE_ROWS = 500;

/** CSV → table. Parses locally, lets you fix names/types, then inserts in
 *  batches inside one transaction. */
export default function ImportModal(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  /** The file itself, not its contents — `run` re-reads it from disk. */
  const [file, setFile] = useState<File | null>(null);
  const cancelRef = useRef(false);
  const [fileName, setFileName] = useState("");
  /** Header plus the first `SAMPLE_ROWS` rows: enough to preview and to infer
   *  types, and bounded regardless of how large the file is. */
  const [table, setTable] = useState<CsvTable | null>(null);
  /** True when the file held more rows than we sampled — so the UI can avoid
   *  claiming a total it has not counted. */
  const [more, setMore] = useState(false);
  const [schema, setSchema] = useState(p.schemas.includes("public") ? "public" : p.schemas[0] ?? "public");
  const [target, setTarget] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [types, setTypes] = useState<InferredType[]>([]);
  const [delimiter, setDelimiter] = useState(",");
  const [busy, setBusy] = useState(false);
  /** Percent of the file read — the honest progress metric, because the row
   *  total is not known until the import has finished reading. */
  const [progress, setProgress] = useState(0);
  const [inserted, setInserted] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = async (f: File) => {
    setError(null);
    // Read only as far as the sample needs. On a multi-gigabyte export this
    // stops after the first few kilobytes instead of materialising the file.
    let header: string[] | null = null;
    const rows: string[][] = [];
    let sawMore = false;
    try {
      await streamRows(f, delimiter, (batch) => {
        for (const r of batch) {
          if (header === null) {
            header = r;
            continue;
          }
          if (rows.length < SAMPLE_ROWS) rows.push(r);
          else {
            sawMore = true;
            return false; // one row past the sample is all we need to know
          }
        }
        return true;
      });
    } catch (e) {
      setError(`Could not read that file: ${String(e)}`);
      return;
    }
    if (!header || (header as string[]).length === 0) {
      setError("That file has no header row.");
      return;
    }
    const t: CsvTable = { header, rows };
    setTable(t);
    setMore(sawMore);
    setFile(f);
    setFileName(f.name);
    setNames(normalizeHeader(t.header));
    setTypes(inferTypes(t));
    setTarget(
      f.name
        .replace(/\.[^.]+$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 63) || "imported"
    );
  };

  const columns = useMemo(() => names.map((name, i) => ({ name, type: types[i] })), [names, types]);

  const createSql = useMemo(
    () => (table && target ? buildCreateTable(schema, target, columns) : ""),
    [table, target, schema, columns]
  );

  const run = async () => {
    if (!table || !target || !file) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    setInserted(0);
    cancelRef.current = false;
    const joinExisting = p.inTx;
    let count = 0;
    try {
      if (!joinExisting) await invoke("pg_begin");
      await invoke<QueryResult>("pg_query", { sql: createSql, params: null });

      // The file is read again rather than kept from the preview: that is the
      // point. At most BATCH rows are held at once, so peak memory is set by
      // the batch size, not the file size.
      let pending: string[][] = [];
      let isHeader = true;
      const flush = async () => {
        if (!pending.length) return;
        const ins = buildInsert(schema, target, columns, pending);
        await invoke<QueryResult>("pg_query", { sql: ins.sql, params: ins.params });
        count += pending.length;
        setInserted(count);
        pending = [];
      };

      await streamRows(file, delimiter, async (batch, bytes) => {
        for (const r of batch) {
          if (isHeader) {
            isHeader = false; // the header was already mapped in the preview
            continue;
          }
          pending.push(r);
          if (pending.length >= BATCH) await flush();
        }
        setProgress(file.size ? Math.min(100, (bytes / file.size) * 100) : 0);
        return !cancelRef.current;
      });
      await flush();

      if (cancelRef.current) throw new Error("Import cancelled — nothing was written.");

      if (!joinExisting) await invoke("pg_commit");
      p.onDone(`Imported ${count.toLocaleString()} rows into ${schema}.${target}`);
      p.onClose();
    } catch (e) {
      setError(String(e));
      if (!joinExisting) {
        try {
          await invoke("pg_rollback");
        } catch {
          /* session may be gone; the original error is what matters */
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const isProd = p.env === "prod";

  return (
    <div className="overlay center" onClick={busy ? undefined : p.onClose}>
      <div className="modal import" onClick={(e) => e.stopPropagation()}>
        {/* Fourth copy of ModalHead in this codebase; all four had lost the
            close button's accessible label. This one also has to refuse to
            close mid-import, so it keeps its own disabled state. */}
        <div className="modal-head">
          <span className="t">Import CSV</span>
          <button
            className="x"
            aria-label="Close"
            title="Close"
            onClick={p.onClose}
            disabled={busy}
          >
            <span aria-hidden>×</span>
          </button>
        </div>

        <div className="modal-body">
          {!table && (
            <div className="imp-drop">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt"
                style={{ display: "none" }}
                onChange={(e) => e.target.files?.[0] && load(e.target.files[0])}
              />
              <div className="imp-drop-in">
                <div className="imp-big">Choose a CSV or TSV file</div>
                <p className="intel-note">
                  Parsed on your machine — nothing leaves the app until you press Import.
                </p>
                <div className="intel-row" style={{ justifyContent: "center" }}>
                  <button className="btn primary" onClick={() => fileRef.current?.click()}>
                    Choose file…
                  </button>
                  <select
                    className="intel-input"
                    style={{ flex: "0 0 130px" }}
                    value={delimiter}
                    onChange={(e) => setDelimiter(e.target.value)}
                  >
                    <option value=",">Comma ,</option>
                    <option value={"\t"}>Tab</option>
                    <option value=";">Semicolon ;</option>
                    <option value="|">Pipe |</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {table && (
            <>
              <div className="intel-row">
                <span className="imp-file">{fileName}</span>
                <span className="imp-count">
                  {more ? `first ${table.rows.length.toLocaleString()} rows sampled` : `${table.rows.length.toLocaleString()} rows`}
                </span>
                <div className="grow" />
                <button className="btn" onClick={() => setTable(null)} disabled={busy}>
                  Choose another
                </button>
              </div>

              <div className="intel-row">
                <select className="intel-input" style={{ flex: "0 0 170px" }} value={schema} onChange={(e) => setSchema(e.target.value)}>
                  {p.schemas.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <span className="intel-arrow">.</span>
                <input
                  className="intel-input"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="new table name"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </div>

              {isProd && (
                <div className="er-warn">
                  <strong>Production.</strong> This creates a table and writes{" "}
                  {more ? "every row in this file" : `${table.rows.length.toLocaleString()} rows`} to a live
                  database.
                </div>
              )}

              <div className="imp-cols">
                {names.map((n, i) => (
                  <div key={i} className="imp-col">
                    <span className="imp-src" title={table.header[i]}>
                      {table.header[i]}
                    </span>
                    <input
                      className="intel-input"
                      spellCheck={false}
                      autoComplete="off"
                      value={n}
                      onChange={(e) => setNames((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                    <select
                      className="intel-input"
                      style={{ flex: "0 0 120px" }}
                      value={types[i]}
                      onChange={(e) =>
                        setTypes((a) => a.map((x, j) => (j === i ? (e.target.value as InferredType) : x)))
                      }
                    >
                      {TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <div className="imp-preview">
                <table>
                  <thead>
                    <tr>
                      {names.map((n, i) => (
                        <th key={i}>{n}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                      <tr key={i}>
                        {names.map((_, j) => (
                          <td key={j}>{r[j] ?? ""}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <pre className="er-sql">{createSql}</pre>
            </>
          )}
        </div>

        {/* Errors live in the footer, not the scrollable body — an error at the
            bottom of a scrolled body is an error nobody sees. */}
        {/* Not `table && error`: the "no header row" error fires precisely when
            there is no table, so gating on one hid the only message that
            explains why nothing happened. */}
        {error && <div className="er-error imp-error">{error}</div>}

        {table && (
          <div className="modal-foot">
            {busy ? (
              <span className="er-note">
                Read {progress.toFixed(0)}% of the file · {inserted.toLocaleString()} rows inserted…
              </span>
            ) : (
              <span className="er-note">One transaction — any failure rolls back the whole import.</span>
            )}
            <div className="grow" />
            <button
              className="btn"
              onClick={() => {
                // Mid-import this stops the read and rolls back; the modal
                // stays open so the outcome is visible rather than vanishing.
                if (busy) cancelRef.current = true;
                else p.onClose();
              }}
            >
              Cancel
            </button>
            <button
              className={`btn ${isProd ? "danger" : "primary"}`}
              onClick={run}
              disabled={busy || !target.trim() || names.some((n) => !n.trim())}
            >
              {busy ? "Importing…" : more ? "Import all rows" : `Import ${table.rows.length.toLocaleString()} rows`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
