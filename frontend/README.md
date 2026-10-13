# Lain browser

Requires Node 24 or newer. Dependencies are pinned in `package.json` and `package-lock.json`. PrimeVue 4.5.5 and PrimeUIX themes 2.0.3 use the MIT license.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Build output is `dist/`. Build the frontend before Rust so the daemon embeds current production assets. The public shell contains no explanation data. `node_modules/` and `dist/` are ignored.

`npm run dev` binds `127.0.0.1:5173` and proxies `/api` and `/ws` to a daemon on `127.0.0.1:38475`. The development proxy forwards the backend authority and translates only the two local development Origins. Foreign Origins pass through for backend rejection. Production uses the daemon's same-origin routes. Any local client can access Lain.

WebSocket subscription precedes library reads; reconnection refetches summaries. Last-write-wins publications automatically refresh the active document while preserving surviving selections. Internal revisions reject stale reads and invalidations, including across deletion and recreation; the GUI shows update status and retry actions. Cursors are occurrence IDs stored per scenario for the current explanation.

Query parameters `explanation`, `scenario`, and `occurrence` identify the current location. User navigation pushes browser history; defaults and live-update normalization replace the current entry. Reload and Back/Forward restore occurrence-specific state without putting snapshots in the URL.

Library deletion requires user confirmation, then sends bodyless `DELETE /api/explanations/{id}`. Success removes the card immediately. Failures refresh the library and require reviewing the current card before a fresh confirmation. Internal revisions order deletion responses and notifications so delayed responses preserve newer publications.

Sequence diagrams render participant lifelines and message arrows from structured data. Scenario occurrence IDs identify message rows, including repeated sends. Compact views show the previous and current messages.

Human/system icons precede participant labels inside their boxes. Lifelines are dashed. Calls use solid filled arrows; asynchronous sends use solid open arrows; replies use dashed open arrows. Scenario relevance changes color and opacity while preserving semantic line styles. Omitted kinds use system participants and call messages. Chart exports retain the same icons and notation.

Chart export menus offer Scenario only or All scenarios, then SVG, PNG, or PDF. The UI downloads through the local export endpoints. Each file contains the full current Diagram or Domain chart in the active theme, without playback or inspection state. Scenario only preserves off-path muting. SVG is vector artwork; PNG and PDF use bounded high-resolution images. The daemon requires Chrome/Chromium on PATH or `LAIN_CHROMIUM_EXECUTABLE`.

Tests cover browser wiring, live invalidations and fetch races, route restoration, cursor preservation, sequence message selection, snapshot semantics, explicit revisit selection, off-path inspection, chart export, and hostile authored text. After building the frontend and running `cargo build` at the repository root, `node ../tests/chart-export-browser.cjs` verifies themed downloads with Playwright against an isolated daemon and runtime home. Set `LAIN_PLAYWRIGHT_MODULE`, `LAIN_BINARY`, or `LAIN_CHROMIUM_EXECUTABLE` when using external installations.
