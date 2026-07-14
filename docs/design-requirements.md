# TupleNest — UI Design Requirements

Handoff document for designing the TupleNest desktop database IDE.
Everything in here is either already implemented in the backend/frontend
(marked **[built]**) or planned and expected in the design (**[planned]**).
Design every state listed — loading, empty, error, and success are all
first-class.

Reference material: `tuplenest-redesign.html` (approved direction),
Miro board "TupleNest — Database IDE Design" (5 screens).

---

## 1. Product summary

TupleNest is a cross-platform (macOS/Windows/Linux) desktop IDE for
relational databases. PostgreSQL first; more engines later. It is built on
Tauri 2: the UI is a WebView (React + plain CSS), all database work happens
in a Rust core. Target users: backend engineers, data engineers, DBAs —
people who live in this tool for hours and value density, speed, and
keyboard flow over decoration.

Design principles:

1. **Data is the hero.** Chrome recedes; monospace data surfaces dominate.
2. **Safety is visible.** Prod is unmistakably red. Open transactions are
   impossible to miss. TLS state is always shown. Nothing destructive is
   ever one accidental click away.
3. **Dense but calm.** 13px base UI, 24px data rows, small caps labels —
   closer to Linear/DataGrip than to a marketing site.
4. **Keyboard first.** Every primary action has a shortcut and shows it.

---

## 2. Hard technical constraints (do not design against these)

- Desktop window, resizable; **minimum 1100×700**, design target 1440×900.
- Dark theme is primary and ships first; light theme is a token swap —
  deliver both palettes but dark leads.
- Fonts: UI = Inter (system-ui fallback); data/code = JetBrains Mono
  (ui-monospace fallback). No other families.
- **Result grid rows must be a fixed height** (currently 24px). The grid is
  virtualized; variable-height rows are not possible. Header and row-number
  column are sticky.
- The grid may hold up to **100,000 rows**; scrolling must stay 60fps, so no
  per-cell shadows/gradients/blurs inside the grid body.
- No browser storage APIs assumed; state persists via app settings (SQLite).
- Styling is hand-written CSS with custom properties (design tokens). No
  Tailwind, no component library — deliver tokens + specs, not framework
  classes.
- Single window, no detachable panels in v1.

---

## 3. Screen inventory

| # | Screen / surface | Status |
|---|------------------|--------|
| 1 | App shell: title bar, sidebar, main column, status bar | [built, needs design] |
| 2 | Connections: saved list + connection editor + staged test | [built] |
| 3 | Explorer: schema tree with cache mode | [built] |
| 4 | Query editor + toolbar + transaction controls | [built] |
| 5 | Results grid (virtualized) | [built] |
| 6 | History panel | [built] |
| 7 | Prod safety mode (banner + variants) | [built] |
| 8 | Query tabs | [planned] |
| 9 | Command palette (⌘K) | [planned] |
| 10 | EXPLAIN plan view | [planned] |
| 11 | Settings, About, Update available | [planned] |
| 12 | First-run / empty workspace onboarding | [planned] |

---

## 4. App shell

**Title bar** (custom, height ~44px): app brand, connection switcher
(current profile name + user@host + live/off dot + env badge), right side:
command palette trigger, theme toggle, settings. macOS traffic lights space
must be respected on the left.

**Status bar** (bottom, ~30px, monospace 11px): connection state dot + name,
TLS state (`🔒 verify-full` / `plaintext`), explorer source (`live` /
`cached`), row range shown, server version. Right-aligned auxiliary info.
When a transaction is open ≥ 60s, show an amber elapsed-time warning here.

**Layout**: left sidebar 260–280px (collapsible [planned]), main column
fills. Main column stacks: tabs [planned] → toolbar → editor → results area
→ (status bar spans full width or main column — designer's choice).

---

## 5. Connections

### 5.1 Saved connections list (sidebar top) [built]

Each profile row shows: engine avatar (PG), profile name, `user@host:port/db`
in mono, environment badge (dev/test/staging/prod), connected dot when
active, delete affordance on hover. Click loads the profile; "+" starts a
new one. Empty state: friendly prompt to create the first connection.

Environment badge colors are semantic and fixed: dev=green, test=neutral,
staging=amber, prod=red. Prod must be the most visually aggressive.

### 5.2 Connection editor [built]

Currently an inline panel; the approved direction moves it to a **modal**.
Fields (exact, all built):

- Name (text), Environment (dev/test/staging/prod — segmented control)
- Host, Port (default 5432), Database, Username
- Password — **entered at most once**; after save it reads
  "password saved in keychain". Show a lock hint: "Stored in macOS
  Keychain — never in config files". There is no "show password".
- TLS mode select: `verify-full` (default), `verify-ca`, `prefer
  (no verification)`, `disabled (local only)`; when verifying, optional
  CA file path input.
- SSH tunnel toggle revealing: SSH host, port (22), SSH user, private key
  path, host-key SHA256 fingerprint (placeholder: "empty → known_hosts").
- Buttons: Save, Test, Connect/Disconnect (Connect swaps to Disconnect when
  live). [planned] Save & Connect combined primary.

### 5.3 Staged connection test [built]

Running Test produces an ordered checklist of stages, each with: pass/fail
icon, stage name, duration in ms, detail text. Stage names (fixed):
`dns`, `tcp`, `ssh` (only when tunneling), `auth`, `server version`.
The test stops at the first failure — design the partial list state.
Detail examples: "1 address, 127.0.0.1", "tls: VerifyFull",
"PostgreSQL 18.0", or an error message on the failed stage.
States: idle (no list), running (spinner per current stage [planned]),
all-passed (green summary "OK — server 18.0"), failed-at-stage.

### 5.4 Connect flow states

disconnected → connecting… → connected | error. Errors are sentence-length
strings (e.g. "SSH tunnel: SSH host key rejected…"). Connected state
changes: switcher dot, status bar, explorer loads, editor enables.

---

## 6. Explorer (schema tree) [built]

Three lazy levels: schemas → objects → columns. Every level has a
loading state ("loading…") and an empty state ("empty").

- Schema row: disclosure caret, name, object count badge [planned].
- Object row: caret, kind icon — table (T), view (V), matview (M),
  foreign (F) — name; tooltip shows comment. **Clicking the name inserts
  `select * from "schema"."table" limit 100` into the editor** — this is
  the primary explorer action, design it discoverable.
- Column row (mono): 🔑 for primary key, name, type, "not null" marker;
  comment on hover.
- **Cached mode**: when data comes from the local metadata cache (offline
  or pre-connect), show an amber "CACHED" chip on the Explorer header.
  Selecting a saved profile shows its cached tree *before* connecting.
- Search box over object names [planned — backend exists].

---

## 7. Query editor & toolbar [built]

- Toolbar: **Run** (primary, shows ⌘↵), **Cancel** (enabled only while
  running), separator, transaction cluster (below), right side: Export
  [planned], Format [planned].
- Editor: monospace, line numbers, min 4 rows, grows/splits with results
  (splitter [planned]). Syntax highlighting [planned] — design the token
  colors (keyword/function/string/number/comment).
- Disabled state when not connected (with hint).
- Status line messages (single line, after run):
  - `1,204 row(s) in 132ms`
  - `1,204 row(s) in 132ms (first 100,000 kept for scrolling)`
  - `3 row(s) affected in 8ms`
  - `Error: <normalized message>` — errors carry SQLSTATE and sometimes a
    query position [planned: inline error marker in editor].
  - `Connection lost: … — the session was closed. Reconnect to continue;
    nothing was re-run.` → app flips to disconnected. Design this as a
    distinct, calm-but-serious error surface.

### 7.1 Transactions [built]

- No transaction: a quiet **Begin** button.
- Open transaction: amber **IN TRANSACTION** chip (pulsing dot) +
  **Commit** (green accent) + **Rollback** (red accent).
- Disconnect with open transaction NEVER just disconnects: a prompt offers
  exactly three actions: *Commit & disconnect*, *Rollback & disconnect*,
  *Stay connected*. Currently an inline bar; may be a modal. No default
  button — the user must choose.
- Failed commit keeps the session alive for inspection (show error).

---

## 8. Results grid [built]

- Virtualized, fixed 24px rows, sticky header, sticky row-number column.
- Header cells: column name + small type hint (e.g. `total  numeric`).
- Cell rendering rules: `null` → italic muted "null"; numbers right or
  left aligned (designer decides, be consistent) in amber-ish tint; booleans
  tinted; JSON shown inline as text [planned: JSON cell inspector popover].
- Rows beyond the fetched window show a subtle "…" placeholder while a
  block loads (200-row blocks).
- Truncation: when the server returned more than 100k rows, a persistent
  notice: "showing first 100,000 of N".
- Row hover + single row selection highlight. Cell selection/copy
  [planned].
- Result meta line: `✓ 1,204 rows · 132 ms · streamed`.
- Secondary result tabs: Results / Messages [planned] / History; Plan
  [planned].

---

## 9. History panel [built]

Row anatomy: status glyph (✓ green success, ✕ red error, ⊘ amber
cancelled), SQL text (mono, single line, ellipsized; clicking loads it into
the editor), meta (`rows · duration · time`), favorite star toggle.
Special case: prod-tagged connections store **no SQL text** — render
"(query text hidden — prod)" italic muted, not clickable.
Header: search input (substring, live) + Clear button (clears
non-favorites only — favorites survive; retention is newest 1,000).
Error rows show the error message in the meta/tooltip.

---

## 10. Prod safety mode [built]

When the connected profile's environment is `prod`:
- Persistent banner under the title bar: red, unmissable, e.g.
  "PRODUCTION — changes are live. Query text is excluded from history."
- Switcher/env badge red; status bar dot red.
- [planned] Destructive statement guard: UPDATE/DELETE without WHERE asks
  for confirmation — design that dialog.

---

## 11. Planned surfaces (design now, built next)

- **Query tabs**: file-like tabs above the toolbar; dirty dot; middle-click
  close; "+" new tab; overflow behavior.
- **Command palette (⌘K)**: centered overlay, groups: Actions, Recent
  queries, Tables. Footer hints (↑↓, ↵, esc). See screen 5 on the board.
- **EXPLAIN plan**: nested node cards with kind tags (SCAN/JOIN/SORT/AGG),
  per-node cost bar, HOT flag for dominant nodes, right stats sidebar
  (planning/execution time, buffers), suggestion tip card. See screen 4.
- **Exports**: CSV/JSON/Markdown of current result — a small menu.
- **Settings**: theme, default row limit, history retention, telemetry
  opt-in. Simple single-page.
- **Empty/onboarding**: first launch (no connections), connected-but-no-
  query-yet, and query-returned-zero-rows states.
- **Update available** toast/badge (Tauri updater, dormant until release).

---

## 12. Design tokens to deliver

Palette (dark + light values for each): background, raised surface ×2,
border ×2 (hard/soft), text ×3 (primary/soft/muted), accent + accent-soft,
success, danger, warning, purple (views/plan), focus ring.
Reference dark values live in `tuplenest-redesign.html` `:root`.

Also: radius scale (currently 6/7/10px), spacing scale, type scale
(11/12/12.5/13/15px), elevation/shadow for modal + palette, icon set
direction (16px, 1.5px stroke — currently unicode placeholders; a real set
like Lucide is welcome), motion guidelines (fast: 120–160ms; no large
animations; pulsing dot for open transaction).

Deliverables checklist:

1. Token sheet (dark + light).
2. Component specs: buttons (primary/secondary/ghost/danger + kbd chip),
   inputs/select/segmented control/toggle, badges & chips (env, cached,
   tx), tree rows, grid header/cells, tabs, modal, palette, toasts.
3. The 12 screens above at 1440×900 (dark; light for screens 1–3).
4. Interaction notes for: staged test progression, tx close prompt,
   connection-lost, truncation notice, cached explorer.

---

## 13. Data shapes the UI binds to (exact fields)

These are the real IPC payloads — labels in designs should map to them.

- ConnectionRecord: `name, environment(dev|test|staging|prod), readOnly,
  host, port, database, username, secretRef?, tlsMode, tlsCaPath?,
  sshJson?`
- TestStage: `name, passed, durationMs, detail?` (ordered list)
- DbObject: `name, kind(table|view|matview|foreign), comment?`
- DbColumn: `name, dbType, nullable, primaryKey, comment?`
- QueryResult: `columns[{name,dbType}], totalRows, storedRows, truncated,
  rowsAffected?, elapsedMs`
- HistoryEntry: `sqlText?, status(success|error|cancelled), errorText?,
  rowsReturned, rowsAffected?, startedAt, durationMs, favorite`
- Metadata responses carry `cached: boolean` — drives the CACHED chip.

---

## 14. Out of scope for this design round

Multiple windows, ER diagrams, table data editing, user management,
collaboration, non-PostgreSQL engines' specific UI, mobile.
