import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult } from "../ipc/types";
import {
  buildCreateTable,
  buildInsert,
  inferTypes,
  normalizeHeader,
  parseCsv,
  type CsvTable,
  type InferredType,
} from "../lib/csv";

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

/** CSV → table. Parses locally, lets you fix names/types, then inserts in
 *  batches inside one transaction. */
export default function ImportModal(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [table, setTable] = useState<CsvTable | null>(null);
  const [schema, setSchema] = useState(p.schemas.includes("public") ? "public" : p.schemas[0] ?? "public");
  const [target, setTarget] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [types, setTypes] = useState<InferredType[]>([]);
  const [delimiter, setDelimiter] = useState(",");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = async (f: File) => {
    setError(null);
    const text = await f.text();
    const t = parseCsv(text, delimiter);
    if (t.header.length === 0) {
      setError("That file has no header row.");
      return;
    }
    setTable(t);
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
    if (!table || !target) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    const joinExisting = p.inTx;
    try {
      if (!joinExisting) await invoke("pg_begin");
      await invoke<QueryResult>("pg_query", { sql: createSql, params: null });

      for (let i = 0; i < table.rows.length; i += BATCH) {
        const batch = table.rows.slice(i, i + BATCH);
        const ins = buildInsert(schema, target, columns, batch);
        await invoke<QueryResult>("pg_query", { sql: ins.sql, params: ins.params });
        setProgress(Math.min(i + BATCH, table.rows.length));
      }

      if (!joinExisting) await invoke("pg_commit");
      p.onDone(`Imported ${table.rows.length.toLocaleString()} rows into ${schema}.${target}`);
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
        <div className="modal-head">
          <span className="t">Import CSV</span>
          <button className="x" onClick={p.onClose} disabled={busy}>
            ×
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
                <span className="imp-count">{table.rows.length.toLocaleString()} rows</span>
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
                  <strong>Production.</strong> This creates a table and writes {table.rows.length.toLocaleString()} rows
                  to a live database.
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
        {table && error && <div className="er-error imp-error">{error}</div>}

        {table && (
          <div className="modal-foot">
            {busy ? (
              <span className="er-note">
                Inserting {progress.toLocaleString()} / {table.rows.length.toLocaleString()}…
              </span>
            ) : (
              <span className="er-note">One transaction — any failure rolls back the whole import.</span>
            )}
            <div className="grow" />
            <button className="btn" onClick={p.onClose} disabled={busy}>
              Cancel
            </button>
            <button
              className={`btn ${isProd ? "danger" : "primary"}`}
              onClick={run}
              disabled={busy || !target.trim() || names.some((n) => !n.trim())}
            >
              {busy ? "Importing…" : `Import ${table.rows.length.toLocaleString()} rows`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
