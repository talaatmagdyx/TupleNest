Audit complete for the areas below; nothing in the repository was modified (`git status` is clean, all scratch work is under the scratch folder). No P0. Three P1s, all reproduced by tests I ran.

## (a) Commands run

| Command (from `apps/desktop`, Homebrew Node) | Outcome |
|---|---|
| `npx tsc --noEmit` | exit 0, no output |
| `npx eslint src` | exit 0, no output |
| `npx vitest run --coverage --testTimeout=20000` (coverage dir redirected to scratch) | 76 files, 2047 tests, all passed, 40s. Coverage 97.39 stmts / 92.02 branch / 97.31 funcs / 98.7 lines; thresholds met. No flakes. |
| `npx vite build --outDir <scratch>/dist` | built in 629ms. Main chunk 378.9 kB (116.5 kB gzip), CSS 63 kB, font 114 kB, 13 lazy modal chunks of 1.4–11 kB each, `explain` 12 kB. |
| Scratch reproductions (`*.audit.test.tsx`, run with a scratch vitest config rooted at `apps/desktop`) | 18 assertions of correct behaviour, all fail as predicted. Evidence quoted per finding. |

Scratch files are in `docs/audits/2026-11-24/evidence/audit-fe/`: `pure.audit.test.tsx`, `app.audit.test.tsx`, `grid.audit.test.tsx`, `lazy.audit.test.tsx`, `vitest.scratch.config.ts`.

## (b) Findings

Paths are relative to `/Users/talaatmagdyx/work_talaat/TupleNest/apps/desktop/src/` unless absolute.

### F1 — "Explain" executes a data-modifying CTE for real, with no warning and no prod guard
- **Category:** correctness / misleading safety. **Severity:** P1. **Confidence:** Confirmed.
- **Location:** `hooks/useExplain.ts:86`, `lib/sql.tsx:212-214` (`looksLikeSelect`), `lib/explain.ts:49-53` (`isMutating`), `lib/explain.ts:69-74`.
- **Evidence:** for `with gone as (delete from users returning id) select count(*) from gone`, `looksLikeSelect` is true, `isMutating` is false, `optionIssues` returns `[]`, and the hook sent `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) with gone as (delete from users …`.
- **Repro:** put that statement in the editor and click Explain or the Plan tab. Expected: ANALYZE off, or a warning. Actual: ANALYZE on by default, so the DELETE runs and autocommits.
- **Impact:** one click on a "show me the plan" button deletes or updates rows. The explain path never goes through `needsGuard`, so the prod WHERE guard does not apply either. Read-only profiles are protected only if the backend enforces it.
- **Root cause:** both classifiers look only at the leading keyword. `guardReason` (`lib/sql.tsx:~160-193`) already understands verbs inside CTE bodies; explain does not reuse it. The hook's own comment (lines 66-70) states the invariant this breaks.
- **Fix:** default `analyze` to `looksLikeSelect(sql) && !containsWriteVerb(maskLiterals(sql))`, and make `isMutating` use the same check so the warning fires.
- **Verification test:** `useExplain.run` with the CTE; assert the sent statement has no `ANALYZE`, and `optionIssues({analyze:true})` includes the warning.

### F2 — Format SQL rewrites string literals and quoted identifiers
- **Category:** correctness. **Severity:** P1. **Confidence:** Confirmed.
- **Location:** `lib/sql.tsx:201-210` (`formatSQL`); callers `App.tsx:725-730`.
- **Evidence:**
  - `insert into notes(body) values ('made from scratch and love, order by mail')` becomes `VALUES ('made\nFROM scratch\n  AND love,\nORDER BY mail')`.
  - `select 'line one   \nline two'` loses the trailing spaces inside the literal.
  - `select "from" from t` becomes `SELECT "FROM"`, a different identifier.
- **Impact:** pressing Format then Run writes different data, or queries a different column. The toast says only "Formatted".
- **Root cause:** regexes run on raw text; every other scanner in the file works on masked text.
- **Fix:** format only the code segments between literals, comments and quoted identifiers (reuse the tokenizer or `maskLiterals` spans).
- **Verification test:** the three inputs above must round-trip their literals byte-for-byte. A property test fits well (see section e).
- **Test gap:** the existing `formatSQL` tests (`lib/sql.test.tsx:341-361`) contain no literal at all.

### F3 — Titlebar and status bar name the profile in the form, not the live session
- **Category:** misleading state. **Severity:** P1 (mitigated by a correct env pill and prod banner). **Confidence:** Confirmed.
- **Location:** `App.tsx:1449`, `1508-1512`, `1711`; `App.tsx:422-427` (`loadProfile`); `App.tsx:1941-1944` (Reconnect).
- **Evidence:** connected to "local dev", clicked the "prod db" card in the sidebar, pressed Escape. Titlebar read `prod db | root@prod.internal:5432`, env pill `dev`, one `pg_connect` call, no prod banner.
- **Impact:**
  - The user reads the wrong database name and host while running SQL.
  - "New connection…" blanks the name, and typing in the host field changes the titlebar live.
  - After a dropped connection, Reconnect calls `doConnect`, which connects to whatever the form holds — possibly a different database (code evidence, not separately tested).
- **Root cause:** `useConnection` keeps `connectedEnv` but no identity for the live session.
- **Fix:** have `useConnection.connect` record `{profileId, name, host, port, username, params}` and render and reconnect from that.
- **Verification test:** my `app.audit.test.tsx` case, with the assertion `titleName() === "local dev"`.

### F4 — Switching profile keeps the previous database's result grid
- **Category:** stale state. **Severity:** P2. **Confidence:** Confirmed.
- **Location:** `App.tsx:454-490` (`selectProfile`) and `389-397` (`doConnect`); neither calls `query.reset()`, which only `reallyDisconnect` (399-412) does.
- **Evidence:** ran a query on dev, switched to "prod db" from the titlebar. Afterwards: grid present, cell `13109` present, prod banner on, status `✓ 2 row(s)`.
- **Impact:** dev rows are shown under a PRODUCTION banner. Staged edits survive because the epoch is unchanged, and Apply would send those UPDATEs to the new database. Scrolling asks the new session's store for blocks.
- **Fix:** call `query.reset()`, `tx.forget()` and `setChart(null)` in one "session changed" helper used by all three paths.

### F5 — A BEGIN typed in the editor is invisible to disconnect, profile switch and update install
- **Category:** misleading state / data loss. **Severity:** P2. **Confidence:** Confirmed for disconnect; High-confidence for the other two.
- **Location:** `App.tsx:414-420`, `457-460`, `1487-1490`; contrast with the window-close path at `953-955`, which does ask the server.
- **Evidence:** with `pg_in_transaction` returning true, "Disconnect current session" sent `pg_disconnect` with zero server checks and no prompt.
- **Related:** the flag is never reconciled after a typed COMMIT or ROLLBACK, so the "IN TRANSACTION" chip can also be stale in the other direction.
- **Fix:** one `await serverInTransaction()` in `doDisconnect`, `selectProfile` and `installUpdate`; refresh the flag after every `doRun`.

### F6 — Explorer load failure shows "Loading schemas…" forever and the error nowhere
- **Category:** error presentation. **Severity:** P2. **Confidence:** Confirmed.
- **Location:** `App.tsx:379-387`, `368`; `status` is rendered only inside the connection editor (`App.tsx:1777`).
- **Evidence:** `list_schemas` rejects after connect. "Loading schemas…" stays; the "permission denied" text is not in the document.
- **Fix:** route explorer errors to the toast and an inline retry row; set `schemas` to `[]` on failure.

### F7 — Grid row-block fetch failures are swallowed
- **Category:** error recovery. **Severity:** P2. **Confidence:** Confirmed.
- **Location:** `results/Grid.tsx:319-334` (`.catch(() => {})`).
- **Evidence:** `pg_rows` rejects. Two "…" placeholder rows, one call, no error text, no retry until the user scrolls.
- **Fix:** keep a per-block error state, show "Could not load rows — retry", and pass connection-lost messages up to `noticeLost`.

### F8 — A running import can be dismissed by Escape when focus is outside the dialog
- **Category:** modal lifecycle. **Severity:** P2. **Confidence:** Confirmed in jsdom with focus on `<body>`.
- **Location:** `App.tsx:1328-1333` (global handler does `setOverlay(null)` unconditionally) against `overlays/ImportModal.tsx:243`.
- **Evidence:** with an INSERT in flight and focus on body, Escape removed `.modal.import`; no commit or rollback had happened.
- **Caveat:** jsdom did not move focus to body on a backdrop click as a real browser does, so I blurred manually.
- **Impact:** the import keeps running with no progress display and no Cancel button. This contradicts the comment at ImportModal 240-243.
- **Test gap:** the existing test (`ImportModal.test.tsx:255-273`) fires Escape on the dialog element only.
- **Fix:** `if (overlay && !writingRef.current) setOverlay(null)`.

### F9 — A failed lazy-modal chunk, or any render error, blanks the whole window
- **Category:** failure path. **Severity:** P2 (rare trigger, total loss). **Confidence:** Confirmed.
- **Location:** `overlays/lazy.tsx:28-39`; `main.tsx:12-16`. There is no error boundary anywhere in `src`.
- **Evidence:** a rejecting loader left the root's innerHTML as `""`.
- **Impact:** tabs are not persisted (`hooks/useQueryTabs.ts:27`), so all unsaved SQL is lost.
- **Fix:** one error boundary around each lazy modal ("Could not open this panel — retry") and one around the shell.

### F10 — Clipboard and chart actions with no failure handling; one claims success early
- **Category:** misleading success. **Severity:** P3. **Confidence:** Confirmed for copy-result; High-confidence for the rest.
- **Location:** `App.tsx:1163-1180` (`doCopyResult`), `1077-1085` (`copyPlan`), `1182-1199` (`buildChart`), `1314-1322` (copy cell).
- **Evidence:** `copy_result_text` rejects. No toast; an unhandled rejection `clipboard unavailable`.
- **Detail:** copy-cell toasts "Copied cell" before the write resolves and swallows the error.

### F11 — Palette list is rebuilt on every editor keystroke; the palette is not virtualized
- **Category:** performance. **Severity:** P2 on large catalogs. **Confidence:** Confirmed (rebuild) / High-confidence (render).
- **Location:** `App.tsx:1356-1445`; deps include `doRun`, `doFormat`, `saveSnippet`, `runExplain`, which depend on `tabs` (`730`, `742`, `822`, `1036`). `overlays/Overlays.tsx:154`, `188-195`.
- **Evidence:** with 3,000 objects loaded, 20 keystrokes caused 20 full walks (about 6,000 item objects and closures each). The comment at 1346-1355 claims this was fixed.
- **Also:** the global keydown listener is removed and re-added on every keystroke (`1342-1344`), and the palette renders every filtered item as a button.
- **Fix:** read the SQL through a ref inside those callbacks so they stay stable; cap or window the palette list.

### F12 — Grid keyboard focus is lost after End/Home on wide results; first ArrowDown skips row 1
- **Category:** accessibility / correctness. **Severity:** P2 / P3. **Confidence:** Confirmed.
- **Location:** `results/Grid.tsx:190-201`, `450-455`, `501-527`.
- **Evidence:** 60 columns, End pressed. Selection moves to `v59`, `activeElement` is BODY, and a following ArrowLeft does nothing. From a header, the first ArrowDown selected `20`, not `10` (`cur = {r: first}` then `+1`).
- **Fix:** park focus on the grid container when the focused cell leaves the window — `explorer/ExplorerTree.tsx:632-647` already does this — and start from the row above `first` when nothing is selected.

### F13 — Live cancel-on-disconnect test never runs in CI
- **Category:** testing. **Severity:** P2. **Confidence:** High-confidence.
- **Location:** `apps/desktop/src-tauri/src/pg.rs:1909-1911` (`taking_the_session_cancels_a_running_query_instead_of_waiting`, `#[ignore]`); `.github/workflows/ci.yml` live jobs run `--include-ignored` only for `-p tuplenest-driver-postgres` and `-p tuplenest-ssh-core`.
- **Fix:** add `cargo test -p <desktop crate> -- --include-ignored taking_the_session` to the live-postgres job.

### F14 — Smaller items (High-confidence, P3)
- **Explain bypasses the one-query-at-a-time guard** (`hooks/useExplain.ts:118`): it calls `pg_query` directly, and the Explain button is enabled while a query runs. `runExplain` then calls `query.reset()` (`App.tsx:1026`), which drops the running query's result and clears the spinner.
- **Closing a dirty tab discards its SQL** with no confirmation (`editor/TabsBar.tsx:22-39`); tabs do not survive the window.
- **Run with no connection does nothing and says nothing** (`App.tsx:791`). "Import CSV…" and "Show EXPLAIN plan" are offered in the palette while disconnected (`1367-1368`).
- **Wrong tab can be marked clean** (`App.tsx:812-816`): `doRun` marks a tab clean by index captured before the await.
- **StrictMode-unsafe updaters** (`hooks/useQueryTabs.ts:48-51`, `86-98`): `setState` is called inside another state updater, so dev builds double-apply.
- **Stale comments about the row cap:** `App.tsx:1674-1676` and `results/Grid.tsx:20-24` say 100,000 rows; the backend cap is `RESULT_STORE_CAP = 20_000` (`pg.rs:950`).
- **Undo, Potential, not validated:** `SqlEditor.tsx:355-363` and `406-409` route Enter, Tab and auto-pairing through `preventDefault` plus a controlled value write, and there is no custom undo stack. WebKit normally clears native undo history on programmatic value changes, so Cmd+Z after a newline may be broken. Needs a check in the real webview.

## (c) Flows

| Flow | Verdict | Evidence |
|---|---|---|
| First launch | Works | Onboarding card, editor usable offline; e2e `01-shell`. |
| Create connection | Works, friction | Save / Test / Save & connect. Save errors go to the form footer status. |
| Test connection | Works | Staged reveal, timers cleaned (`useConnection.ts:53-60`), stale report cleared. |
| First query | Friction | Run while disconnected is silent (F14). Whole editor text is sent as one statement; multi-statement scripts are rejected by the server (extended protocol). |
| Explore schemas | Defect | F6. Otherwise a solid windowed tree. |
| Edit rows | Works, with defect | Optimistic WHERE, rows-affected check and savepoint logic are good. F4 lets stale edits cross sessions. |
| Import CSV | Defect | F8. Creates a new table only. Rollback and savepoint logic reads correctly. |
| Export results | Works | Dialog first, paged, cancel removes the partial file, runs blocked during export. Copy path is F10. |
| Production connection | Defect | F1 bypasses the guard; F3 and F4 mislabel what is on screen. Banner and env frame are correct. |
| Cancel a query | Works, friction | Toast says "Cancel requested" only; outcome arrives as the query error. F14 Explain race. |
| Recover from disconnect | Defect | The lost-connection dialog works, but Reconnect uses the form (F3) and the old grid stays with dead block fetches (F7). |
| Update the app | Friction | Update toast blocks on the UI transaction flag only (F5). The only progress display is a 2.1s "Downloading update…" toast. Not exercised by any test beyond mocks. |

## (d) Accessibility

| Check | Result | Evidence |
|---|---|---|
| Dialog role, focus trap, focus return, Escape | Pass | `Overlays.tsx:38-110`. |
| Dialog accessible names | Fail | Only 3 of about 24 `<Overlay>` uses pass `label`; there is no `aria-labelledby`. The comment at lines 31-33 says otherwise. |
| Grid semantics | Partial | Role, row/col indices and `aria-selected` are present. `aria-rowcount` omits the header; the editing cell has no role; F12. |
| Tree | Partial | Roving focus and parking are good. Leaf rows (index, constraint, type, routine) have no `treeitem` role; the filter input has no label. |
| Query tabs and result tabs | Fail | Plain buttons; no `tablist`/`tab`/`aria-selected`. The tab close "×" is a span (not keyboard reachable) and there is no close-tab shortcut. The dirty state is a colour dot only. |
| Menus (connection, export) | Fail | No `aria-haspopup`/`aria-expanded` or menu roles. |
| Autocomplete popup | Fail | No `listbox`/`option`/`aria-activedescendant` (`SqlEditor.tsx:598-616`). |
| Splitter and sidebar resize | Fail | Mouse only (`QueryPanel.tsx:179`, `App.tsx:1601-1608`). |
| Query completion and errors announced | Fail | `.run-status` and `.error-box` have no live region. Toasts and the find count do. |
| Visible focus | Partial | Explicit ring on button/input/select/textarea (`styles.css:971`); focusable divs (cells, headers, tree rows) rely on the browser default. |
| Colour-only signalling | Partial | Prod has a text banner and a text env pill. Nulls are italic plus the word "null". The titlebar connected dot and tab dirty dot are colour only. |
| Reduced motion | Pass | `styles.css:1846-1869`; spinners deliberately kept. |
| Contrast (computed from tokens) | Partial | See below. |

Contrast ratios against the panel backgrounds, AA threshold 4.5 for small text:
- **Dark, muted text `--tn-tm`:** 4.97 on bg, 4.40 on s1, 3.65 on s2, about 2.9 where the background glow shows through.
- **Light, muted text:** 3.33.
- **Light, accent:** 2.87.
- **Light, warning:** 2.83. This is the colour of every numeric grid cell.
- **Light, success:** 3.31. **Light, danger:** 3.84.
- **Secondary text `--tn-ts`:** passes in both themes (above 7).

## (e) Testing strategy

- **What the suite is good at:** pure logic (dml, csv, explain parsing, guard), hook invariants, and regression pins with written reasons. The 97% coverage is real execution, not snapshot padding.
- **What the fake backend cannot catch:**
  - It is stateless: there is no session, no transaction state, no row store tied to a query, no ordering or latency. Every race in F4, F5, F7 and F14 is invisible unless a test hand-builds it.
  - It also answers `pg_rows` identically regardless of sort or offset.
  - A 60-line stateful fake (connected?, in-tx?, store epoch, deferred promises) would make these one-liners.
- **Assertions that only check a call was made:** many App tests assert `be.sent("x").toHaveLength(1)`. Fine for wiring, but F3/F4/F5 show that state after the call is under-asserted.
- **No meaningful test for:**
  - EXPLAIN on writing statements other than leading-keyword ones.
  - Formatter with literals.
  - Session-switch state.
  - Escape with focus outside a busy modal.
  - Chunk-load failure.
  - Updater download and failure.
  - Shutdown during a running query.
  - Large-result scroll against a real store.
- **e2e:** four WebDriver specs (shell, pasted plan, connect+query+history+explorer, editor keys). They run only from `smoke.yml` on `workflow_dispatch` against release artifacts for Linux and Windows. They never run on a PR, and macOS is not covered.
- **Rust:** the live matrix (PostgreSQL 13/15/17) runs `driver-postgres` with ignored tests included. It does not run the Tauri command layer's live test (F13), and 14/16/18 are absent although fixtures and options reference 17+ and 18.
- **No property or fuzz testing anywhere.** Worth adding (fast-check / proptest):
  - `formatSQL`: masked literal, comment and quoted-identifier spans are unchanged; formatting is idempotent.
  - CSV: `parse(serialize(rows)) == rows`; the result is identical for any chunk split of the same bytes (`CsvStreamParser`).
  - `guardReason`: appending comments or literals containing "where" never disarms it; any UPDATE/DELETE without a top-level WHERE is guarded.
  - `maskLiterals`: length preserved, newlines preserved.
  - `export.rs` formula neutralisation: no output cell starts with `= + - @` or tab/CR in safe mode, and stripping the prefix recovers the input.

**CI gate proposal**
- **Per PR (about 10 min):** current jobs; the F13 test added to live-postgres; one Linux xvfb run of `e2e` specs 01–04 against a debug build; property tests at a low iteration count.
- **Nightly:** PostgreSQL 14/16/18 added to the matrix; property tests at high iteration count; a bundle-size check (main chunk budget about 400 kB).
- **Release:** the existing smoke workflow, made a required step of `release.yml` rather than manual.

## (f) Strengths worth keeping

- **Epoch/token discipline** in `useQuery` (token + busy ref), `Grid` (`sortGen`), and render-phase resets for edits and grid state.
- **Row edits:** optimistic WHERE on old values, rows-affected must equal 1, savepoint when joining the user's transaction, and never committing the user's work.
- **Streamed export** with dialog-first, between-page cancel and partial-file removal; clipboard and file writes kept in Rust.
- **Transaction ownership by tab**, and the window-close prompt that asks the server.
- **`lib/shortcuts.ts`** as the single source for handler and cheatsheet.
- **Explorer tree** windowing with focus parking.
- **Effect hygiene:** every `listen`, timer and observer I read has a cleanup.
- **Comments that record why a bug happened** — useful, but several have drifted (F8, F11, F14, the dialog-label comment).

## (g) Not validated

- Anything in the real WebKit webview: native undo behaviour, actual focus movement on backdrop click, real scroll performance, screen-reader output.
- Per-keystroke timings: my benchmark ran but its output was not captured, so I have no numbers for `tokenizeLines` or `getCompletions`; from reading, they are linear with 3–4 full passes per keystroke.
- Backend behaviour behind F1, F4 and F14: whether read-only mode blocks the CTE, what `pg_rows` returns after a reconnect, how concurrent `pg_query` calls are serialised.
- The updater end to end, the e2e suite itself (not run), and Rust tests (not run; read only).
- Not reviewed in depth: `MonitorModal` polling, `useSearch`/`useHealth` race guards, `lib/intel.ts` and `index-advisor.ts` retention, `ConnectionForm` field-level validation, `lib/dml.ts` editability edge cases.
