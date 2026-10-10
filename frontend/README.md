# Lain browser

Requires Node 24 or newer. Dependencies are pinned in `package.json` and `package-lock.json`. PrimeVue 4.5.5 and PrimeUIX themes 2.0.3 use the MIT license.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Build output is `dist/`. Build the frontend before Rust so the daemon embeds current production assets. The public shell contains no explanation data. `node_modules/` and `dist/` are ignored.

`npm run dev` binds `127.0.0.1:5173` and proxies `/api` and `/ws` to a daemon on `127.0.0.1:38475`. The development proxy forwards the backend authority and translates only the two local development Origins. Foreign Origins pass through for backend rejection. Exchange a fresh launch code by opening the development URL with the launch fragment from `lain open --print-url`. Production uses the daemon’s same-origin routes without a proxy.

The browser exchanges `#launch=…` through `/api/session` and removes the fragment before sending the request. API fetches use same-origin cookies. WebSocket subscription precedes library reads; reconnection refetches summaries. Loaded revisions stay pinned until the user reloads. Cursors are occurrence IDs stored per scenario for the current explanation.

Query parameters `explanation`, `scenario`, and `occurrence` identify the current location. User navigation pushes browser history; defaults and revision normalization replace the current entry. Authentication precedes deep-link restoration. Reload and Back/Forward restore occurrence-specific state without putting snapshots or credentials in the URL.

Sequence diagrams render participant lifelines and message arrows from structured data. Scenario occurrence IDs identify message rows, including repeated sends. Compact views show the previous and current messages.

Tests cover browser wiring, live invalidations and fetch races, route restoration, cursor preservation, sequence message selection, snapshot semantics, explicit revisit selection, off-path inspection, and hostile authored text.
