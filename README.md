# Lain

A local web viewer for agent-published software explanations. Agents publish a domain model, behavioral diagrams, and concrete scenarios through MCP. The browser walks each scenario's recorded path and shows the values before and after every event.

## Build

Requirements: Rust 1.96+, Node 24+, npm, and Linux for systemd setup.

```sh
./scripts/build.sh
./scripts/install.sh
lain setup
lain demo
lain
```

The installer copies one executable to your user bin directory. The executable embeds the production Vue frontend. Node and PostgreSQL are not required after installation.

`lain setup` installs and starts a systemd user service. The service starts at login and restarts after a crash. Setup preserves configuration and credentials. Starting before login requires user lingering; setup reports the relevant `loginctl` command without invoking sudo.

## Development

Requires Linux, Node 24+, npm, and Rust 1.96+. From the project root:

```sh
npm start
```

The launcher installs locked frontend dependencies, builds the Vue assets, then builds and starts the Rust/Axum backend and Vite. First startup needs dependency downloads and compilation. It checks authenticated backend readiness, publishes the bundled demo only when the library is empty, and opens a development URL with a single-use fragment code. Open the printed URL within 60 seconds if browser opening fails. Use `LAIN_DEV_OPEN=0 npm start` to skip browser opening.

Keep loopback ports 38475 (backend) and 5173 (Vite) free. An installed Lain service uses the same default backend port. The launcher fails on occupied ports without stopping their listeners. Vite proxies API/WebSocket traffic to Rust; Vue changes hot-reload. After Rust edits, press Ctrl+C and rerun `npm start`. Ctrl+C, SIGTERM, or a failed build/server stops all launcher-owned processes. No services or global settings are installed or changed.

Development state lives in the ignored project-root `.lain-dev/` directory. Restarts preserve credentials and the database. The project `opencode.json` connects `lain-dev` to `http://127.0.0.1:38475/mcp` and reads its bearer credential from `.lain-dev/token`. Start `npm start` once before opening OpenCode on a fresh checkout so that file exists. Connect through `/mcps`; use `opencode mcp list` to check status.

Tests run with `node --test tests/dev-start.test.mjs` and use isolated state. `LAIN_DEV_HOME=/absolute/path` overrides the development home for tests; the default OpenCode token reference still points to `.lain-dev/token` and must be configured separately when using an override.

## Run without installing a service

```sh
./scripts/build.sh
target/release/lain --home /tmp/opencode/lain-demo serve
```

In another terminal:

```sh
target/release/lain --home /tmp/opencode/lain-demo demo
target/release/lain --home /tmp/opencode/lain-demo open --print-url
```

Open the printed URL promptly. Its one-use fragment code expires after 60 seconds. The browser exchanges it for an HttpOnly session cookie. Reloading the page keeps the session; starting the daemon again requires a fresh launch URL.

## Commands

| Command | Purpose |
| --- | --- |
| `lain` / `lain open` | Open the existing daemon in a browser |
| `lain open --print-url` | Print a short-lived browser launch URL |
| `lain serve` | Run the daemon in the foreground |
| `lain setup` | Install, enable, and start the user service |
| `lain setup --dry-run` | Preview the service and MCP settings |
| `lain status` | Check daemon readiness |
| `lain demo` | Publish the bundled Order lifecycle example |

Global `--home` or `LAIN_HOME` selects an isolated state directory. The default is `$XDG_DATA_HOME/lain`, falling back to `~/.local/share/lain`. Global `--port` overrides the saved port; the default is 38475. Successful setup saves the selected port for later commands. Use distinct ports when running isolated instances concurrently.

SQLite lives at `LAIN_HOME/lain.sqlite`. Keep it on local disk. The daemon is the sole application persistence owner. Back up the state directory while the daemon is stopped, or use SQLite's backup facilities while it runs; copying only the database during WAL writes is not a safe live backup.

An OS file lock allows one daemon per runtime home, even across different ports. Separate instances need separate homes and ports. Do not delete `daemon.lock` while a daemon runs; the OS releases ownership when the process exits.

## Agent connection

The MCP endpoint is `http://127.0.0.1:38475/mcp`. Configure a Streamable HTTP client with an `Authorization: Bearer …` header using the credential stored in `LAIN_HOME/token`. Use your client's secret or environment-variable support. Do not commit the credential or put it in a URL.

For OpenCode V2, merge this into `opencode.json` and provide `LAIN_TOKEN` in the agent service's environment:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "lain": {
        "type": "remote",
        "url": "http://127.0.0.1:38475/mcp",
        "oauth": false,
        "protocol": "legacy",
        "headers": {
          "Authorization": "Bearer {env:LAIN_TOKEN}"
        }
      }
    }
  }
}
```

Lain uses the classic MCP initialize handshake. Setup does not change agent configuration. OpenCode V2's [MCP guide](https://opencode.ai/v2/docs/mcp-servers) documents remote headers and environment substitution.

MCP tools:

1. `list_explanations` discovers saved explanations and their revisions.
2. `get_explanation` retrieves a full document and current revision.
3. `publish_explanation` atomically creates or replaces a validated document.
4. `delete_explanation` removes a document using its current revision.

Use `expectedRevision: 0` to create an ID. To replace it, retrieve the current revision and supply that revision. A conflict means another publish won; fetch and reconcile before retrying.

See [agent-instructions.md](agent-instructions.md), the discoverable MCP tool schemas, and [Order lifecycle](examples/order-lifecycle.json). Its three diagrams each offer three scenarios: payment success/retry/decline, shipment delivery/redelivery/return, and corresponding payment message exchanges.

## Viewer

Select an explanation, then a scenario under its diagram. Header breadcrumbs show the explanation, diagram, scenario, and current event with its occurrence position. Previous and next move through recorded occurrences. The sidebar shows visited, current, and upcoming events; every event is clickable. Repeated visits to a node retain separate snapshots.

The URL records explanation, scenario, and occurrence IDs. Reload and browser Back/Forward restore that location. Share a location with another authenticated browser session; links contain no captured values or credentials.

The header's Diagram button opens the full map with muted off-scenario elements, upcoming scenario elements, and blue visited elements. Visit counts appear on nodes and edges after their second visit through the current event. Off-path nodes do not change the scenario. Domain opens the ERD with domain definitions. Live publications mark a newer revision available; reload explicitly to update the displayed document.

Sequence diagrams share one ordered interaction across their scenarios. The full view shows participant lifelines and alt/opt/loop frames with every alternative visible. Select a message to inspect its snapshots; repeated messages offer an occurrence picker. The compact view shows the previous and current recorded messages.

The sun/moon button to the right of Quick actions switches between light and dark mode. The browser remembers the choice; light mode is the default.

### Keyboard actions

| Shortcut | Action |
| --- | --- |
| Ctrl+K | Open quick actions with the search input focused |
| H / L | Previous / next recorded event |
| J / K | Next / previous scenario in sidebar order |
| I | Toggle the current scenario's diagram |
| O | Toggle the domain ERD |

Type to filter quick actions, use ↑/↓ to select a result, and press Enter to run it. Escape closes the dialog and restores navigation immediately, including during its closing animation. H/L works inside the scenario diagram. J/K works inside both diagram views. I/O switches between those views instantly. Single-letter shortcuts pause while typing, using quick actions or selection overlays, or interacting with unrelated modals. Scenario navigation preserves each scenario's event position and stops at the first/last item.

Redact secrets and personal data before publication or sharing. No credentials belong in an explanation.

## Security and scope

The daemon listens only on IPv4 loopback. Data routes require a bearer credential or browser session. Host and Origin checks protect against foreign web pages and DNS rebinding. The public frontend shell contains no explanation data. The service is not designed for remote hosting or multi-user access.

Browser cookies use a port-specific name so isolated Lain instances do not overwrite each other's sessions. Cookies are still host-scoped: trust other local services you visit on the same hostname. Use a separate browser profile when local services have different trust levels.

The MVP stores whole versioned documents in SQLite. Agent clients author explanations through MCP, and browser playback reads recorded states. Scenarios describe different paths or implementations. Domain definitions belong to the explanation; scenario-specific domain composition is a future extension.

## Verify

```sh
npm --prefix frontend ci
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
```

Build frontend assets before Rust checks. Tests use isolated state and do not install services. Read [architecture.md](architecture.md) for boundaries and the document contract.

The optional browser smoke test requires Playwright and a Chromium executable. Build the release binary first, then supply their absolute paths:

```sh
LAIN_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
LAIN_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
node tests/browser-smoke.cjs
```

The harness exercises the actual daemon, live updates, restart persistence, and mobile layout. It cleans up its processes and retains diagnostic artifacts under `/tmp/opencode`.
