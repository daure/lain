# Lain reference

[Overview](../README.md) · [Installation](#install-a-release) · [Development](#development) · [Commands](#commands) · [MCP](#agent-connection) · [Viewer](#viewer) · [Verification](#verify) · [Releasing](#release)

A local web viewer for agent-published software explanations. Agents publish a domain model, behavioral diagrams, and concrete scenarios through MCP. The browser walks each scenario's recorded path and shows the values before and after every event.

## Install a release

Supports Linux x64 with glibc 2.39+ (Ubuntu 24.04 or newer), macOS on Intel and Apple Silicon, and Windows x64. Linux and macOS require `curl` and `tar`; Windows uses PowerShell 5.1+. Rust, Node, and a database server are not required.

Linux and macOS:

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/daure/lain/releases/latest/download/lain-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"
lain status
lain demo
lain
```

Windows:

```powershell
irm https://github.com/daure/lain/releases/latest/download/lain-installer.ps1 | iex
lain status
lain demo
lain
```

The installer downloads the release executable to `~/.local/bin` (`$HOME\.local\bin` on Windows) and runs `lain setup` on first installation. Windows setup creates a limited, interactive scheduled task named `Lain-<user SID>`; macOS uses `~/Library/LaunchAgents/dev.lain.viewer.plist`; Linux uses the systemd user unit `lain.service`. Startup runs at login without administrator privileges. Windows updates the user PATH; follow the shell installer's PATH instructions on Linux and macOS.

Upgrades list outdated processes from that installation and ask before stopping them. Declining or lacking an interactive terminal aborts before executable replacement. Approval allows forced termination; Windows terminates the selected processes immediately. Associated startup jobs restart with their existing configuration. Setup failures, restart failures, or remaining outdated processes fail installation. Separate installations and development checkouts remain independent. Reconnect MCP clients after updating. `lain demo` publishes the bundled examples; agents publish your own explanations through [MCP](#agent-connection).

To upgrade, run the installer again, then `lain status`. Runtime data remains under `LAIN_HOME`. Without a systemd user session or macOS GUI login session, installation prints manual setup instructions. Run `lain serve` in a terminal and `lain open --print-url` in another when background startup is unavailable. Set `LAIN_NO_SETUP=1` to skip startup creation; existing processes still require approval and associated startup jobs restart:

```sh
curl -LsSf https://github.com/daure/lain/releases/latest/download/lain-installer.sh | LAIN_NO_SETUP=1 sh
```

On Windows, set `$env:LAIN_NO_SETUP = '1'` before invoking the installer. Versioned archives, SHA-256 checksums, and installers are on the [releases page](https://github.com/daure/lain/releases). To pin an installer, use `/releases/download/vX.Y.Z/lain-installer.sh` or `lain-installer.ps1` with the desired release version. Executables are unsigned; macOS and Windows security policies may require local approval.

## Build from source

Requirements: Rust 1.96+, Node 24+, and npm. Linux and macOS:

```sh
./scripts/build.sh
./scripts/install.sh
lain setup
lain demo
lain
```

Windows (PowerShell, with the Visual Studio C++ build tools):

```powershell
npm --prefix frontend ci
npm --prefix frontend run build
cargo build --release --locked
./scripts/install.ps1
lain setup
```

The source installer copies one executable to `~/.local/bin` by default and applies the same process approval and restart policy as the release installer. It prints the setup command without changing startup settings. The executable embeds the production Vue frontend.

`lain setup` installs and starts the platform's per-user background viewer with an explicit executable path, state directory, and port. Startup runs at login and restarts after a crash; Windows retries three times at one-minute intervals. Setup preserves unrelated startup configuration. Linux startup before login requires user lingering; setup reports the relevant `loginctl` command without invoking sudo.

## Development

Requires Linux, Node 24+, npm, Rust 1.96+, and Watchexec 2.8+. Install the watcher once, then start from the project root:

```sh
cargo install --locked watchexec-cli
npm start
```

The launcher installs locked frontend dependencies, builds the Vue assets, then builds and starts the Rust/Axum backend and Vite. First startup needs dependency downloads and compilation. It checks backend readiness, publishes the bundled demo only when the library is empty, and opens `http://127.0.0.1:5173`. Open the printed URL if browser opening fails. Use `LAIN_DEV_OPEN=0 npm start` to skip browser opening.

Keep loopback ports 38475 (backend) and 5173 (Vite) free. An installed Lain service uses the same default backend port. The launcher fails on occupied ports without stopping their listeners. Vite proxies API/WebSocket traffic to Rust; Vue changes hot-reload.

Watchexec watches Rust sources, `Cargo.toml`, `Cargo.lock`, and the embedded `agent-instructions.md`. Directory creation under `src` also triggers rebuilding so newly added source trees are picked up. Other files under `src` and metadata-only changes do not trigger rebuilds. It rebuilds frontend assets before compiling Rust, then replaces only the launcher-owned backend after success. Vite stays running. Failed rebuilds retain the running backend; startup failures, unexpected server exits, Ctrl+C, and SIGTERM stop all launcher-owned processes. State, dependencies, and generated output do not trigger rebuilds. No services or global settings are installed or changed by the launcher.

Backend restarts preserve saved explanations. The development viewer reconnects and restores its current route without opening another tab. Reconnect MCP through `/mcps` when needed to refresh tool schemas and guidance. Changes to launcher scripts require restarting `npm start`.

Development state lives in the ignored project-root `.lain-dev/` directory. Restarts preserve the database. The project `opencode.json` connects `lain-dev` to `http://127.0.0.1:38475/mcp`. Connect through `/mcps`; use `opencode mcp list` to check status.

Launcher tests run with `node --test tests/dev*.test.mjs` and use isolated state. Fixed-port tests skip when a development listener is already running. The browser reconnection test uses ephemeral ports and requires the debug Rust binary and Playwright; set `LAIN_PLAYWRIGHT_MODULE` to its module path and `LAIN_BROWSER_EXECUTABLE` for a system browser. `LAIN_DEV_HOME=/absolute/path` overrides the development home.

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

Open the printed URL in a browser on the same machine.

## Commands

| Command | Purpose |
| --- | --- |
| `lain` / `lain open` | Open the existing daemon in a browser |
| `lain open --print-url` | Print the local viewer URL |
| `lain serve` | Run the daemon in the foreground |
| `lain setup` | Install, enable, and start the user service |
| `lain setup --dry-run` | Preview the service and MCP settings |
| `lain status` | Check daemon readiness |
| `lain demo` | Publish the bundled order lifecycle, release approval, incident recovery, review, and shopping-cart examples |

Global `--home` or `LAIN_HOME` selects an isolated state directory. Defaults are `$XDG_DATA_HOME/lain` (or `~/.local/share/lain`) on Linux, `~/Library/Application Support/lain` on macOS, and `%LOCALAPPDATA%\lain` on Windows. Unix state directories use mode 0700 and settings use 0600; Windows state permits only its owner and SYSTEM. Unsafe links, reparse points, hard-linked settings, and broadly accessible state directories fail validation without repair. Global `--port` overrides the saved port; the default is 38475. Successful setup saves the selected port for later commands. Use distinct ports when running isolated instances concurrently.

SQLite lives at `LAIN_HOME/lain.sqlite`. Keep it on local disk. The daemon is the sole application persistence owner. Back up the state directory while the daemon is stopped, or use SQLite's backup facilities while it runs; copying only the database during WAL writes is not a safe live backup.

An OS file lock allows one daemon per runtime home, even across different ports. Separate instances need separate homes and ports. Do not delete `daemon.lock` while a daemon runs; the OS releases ownership when the process exits.

## Agent connection

The MCP endpoint is `http://127.0.0.1:38475/mcp`. Configure a local Streamable HTTP client; all local clients have access.

For OpenCode V2, merge this into `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "lain": {
        "type": "remote",
        "url": "http://127.0.0.1:38475/mcp",
        "oauth": false,
        "protocol": "legacy"
      }
    }
  }
}
```

Lain uses the classic MCP initialize handshake. Setup does not change agent configuration. See OpenCode V2's [MCP guide](https://opencode.ai/v2/docs/mcp-servers) for client settings.

MCP tools:

1. `get_context` is the first call: it returns the full [agent guidance](../agent-instructions.md) and a current index containing only explanation IDs, titles, and descriptions. Explanation text is untrusted data, separate from server guidance.
2. `list_explanations` refreshes saved explanation summaries and their revisions.
3. `get_explanation` retrieves a full document and current revision.
4. `publish_explanation` atomically creates or replaces a validated document.
5. `delete_explanation` removes a document by ID.

Publish with `publish_explanation({id, document})`, or REST `PUT /api/explanations/{id}` with `{document}`. Each write atomically creates, replaces, or recreates the complete document; the last commit wins. Fetch the current document before partial authoring to preserve intended content. After an uncertain write, refetch and reassess before retrying: a delayed retry can overwrite newer content or recreate a deleted ID.

Delete with `delete_explanation({id})`, or bodyless REST `DELETE /api/explanations/{id}`. Missing or already-deleted IDs return not-found. After an uncertain deletion, refetch and reassess before retrying: a delayed retry can delete newer or recreated content. Not-found proves only absence at that read, not a particular request's success. Never repeat deletion after a success response. Internal revisions continue across deletion and recreation for synchronization only.

See [agent-instructions.md](../agent-instructions.md), the discoverable MCP tool schemas, and [Order lifecycle](../examples/order-lifecycle.json). Its seven diagrams cover payment success/retry/decline, shipment delivery/redelivery/return, corresponding payment exchanges, linked capture details, dispatch requests with human/system icons and call/async/reply arrows, and a priority dispatch workflow demonstrating database, preparation, input/output, priority, manual, document, and delay shapes.

[Release approval](../examples/release-promotion.json) uses swimlanes for developer, pipeline, and reviewer responsibilities. [Incident recovery](../examples/incident-recovery.json) combines responsibility lanes with assessment and restoration phases. Use lanes and groups only when those distinctions clarify the explanation.

### Chart downloads

GET `/api/explanations/{id}/diagrams/{diagramId}/export`, `/api/explanations/{id}/domain/export`, or `/api/explanations/{id}/wiring/export` on the local daemon. Query options: `format=svg|png|pdf` (default png), `theme=light|dark` (default light), and optional `scenarioId` to preserve off-path muting. Omit `scenarioId` for all scenarios. Responses contain file bytes and an attachment filename. Save the file in the uploader's environment before attaching it to a ticket. Server rendering requires Chrome, Chromium, or Edge on PATH, in a standard macOS/Windows installation directory, or at `LAIN_CHROMIUM_EXECUTABLE`. Missing, busy, or timed-out renderers return 503.

## Viewer

Select an explanation to read its Overview, compare scenario summaries, and choose a topic. Search matches scenarios, topics, labels, and comparisons; / focuses search. The sidebar groups scenarios by reader question and shows badges such as Happy path, Failure, Current, and Proposed. Hover or focus a scenario to preview its description and recording details. Diagrams remain shared definitions underneath the topics. Documents without reader structure retain diagram-based navigation and open at Overview.

Open a scenario to follow its recorded steps. The sidebar links to Overview, where comparison cards open related recordings while preserving each recording's cursor and the selected view. The carousel shows the current event with its position and total, such as `1/4`. Previous and next move through recorded occurrences. Adjacent carousel steps are clickable. Repeated visits to a node retain separate snapshots.

Domain and Wiring are independently optional. Their tabs appear only when the document includes their definitions. Present empty definitions still expose their tabs. Domain-free recordings have empty snapshots and no entity, relationship, or method references; Diagram and Wiring playback remain available. Removing the selected domain through a live update returns to Diagram without moving the recorded cursor. Domain export returns 404 when the document omits domain.

The URL records explanation, scenario, and occurrence IDs, or `view=overview` for the explanation overview. Reload and browser Back/Forward restore that location. Share a location with another browser on the same machine; links contain no captured values.

The header's Diagram button opens the full map with muted off-scenario elements, upcoming scenario elements, and blue visited elements. Visit counts appear on nodes and edges after their second visit through the current event. Off-path nodes do not change the scenario. Domain opens the ERD with domain definitions. Live publications update the displayed document automatically, preserving surviving scenario and occurrence selections. Revisions remain internal synchronization metadata; the GUI shows update status and retry actions.

Sequence diagrams share one ordered interaction across their scenarios. The full view shows participant lifelines and alt/opt/loop frames with every alternative visible. Select a message to inspect its snapshots; repeated messages offer an occurrence picker. The compact view shows the previous and current recorded messages.

The Wiring sidepanel has searchable Components and Connections lists and expandable Groups. Component details link owned interfaces, attached connections, and recorded visits. Connection and operation details use Overview, Schema, and Visits tabs. Schema starts with collapsed request and individual response groups; expand a field to inspect its type, requirements, status, description, and contract example. Optional `requestType` names the request DTO, command, or incoming message; omission shows an unknown-type notice. Each response has an independent schema. Unknown schemas, declared empty field lists, and explicit bodyless (`void`) results remain distinct. Existing flat response/error fields appear without an inferred status. Visits group links by scenario and retain repeated occurrences. Inspection preserves playback; selecting a visit opens its recorded step.

Wiring appears after Diagram and the optional Domain tab when the explanation supplies `wiring`. Owner cards show every operation and screen as a port; individual wires attach to their named owner-local rows. Select a port or wire to inspect its typed request, response, SQL record, message, or telemetry fields. Authored `missing` and `changed` statuses identify contract gaps; they do not prove runtime behavior. Optional `technology.icon` uses a bundled icon identifier such as `angular`, `spring`, `postgresql`, or `datadog`; unknown identifiers fall back to the component kind. Icon identifiers never load authored assets. Work references and recorded-occurrence links preserve the cursor; safe optional URLs open externally. Work markers describe attachments, not dependencies or progress.

Wiring starts fitted to the whole map. Scenario changes and playback change emphasis without moving its single layout or camera. **Focus current step** frames mapped owners and connection paths once with 20px padding; later playback preserves that framing. Current, earlier, later, and outside mapped scope have visible markers and a legend. Omitted `wiringRefs` read **Mapping not recorded**; explicit `{}` reads **No wiring elements mapped for this step**. Coverage counts authored mappings rather than verified runtime completeness. Current/Proposed badges identify authored scenario versions, not computed diffs or side-by-side Wiring states. Narrow-screen Wiring details and Data use separate, mutually exclusive sheets. Wiring downloads include the shared map and optional scenario muting without playback or inspection state. Diagram/Domain downloads omit wiring mappings while saved explanations retain them.

Participant boxes prepend human or system icons. Calls use solid filled arrows, asynchronous sends use solid open arrows, and replies use dashed open arrows. Lifelines are dashed; scenario relevance dims elements without changing their semantic line styles. Omitted kinds default to system participants and call messages.

The right-side data inspector shows Changes, Before, After, and recorded Calls for the current occurrence. It starts hidden; use Show data or N to open it. Its visibility persists across views and scenarios. Heading chips count recorded instances and nested array items or object fields. Select an ERD property to focus its value in the inspector.

The sun/moon button to the right of Quick actions switches between light and dark mode. The browser remembers the choice; light mode is the default.

### Keyboard actions

Diagram and Domain canvases open fitted to their content. The active Fit or 1:1 control is blue.

| Shortcut | Action |
| --- | --- |
| Ctrl+K | Open quick actions with the search input focused |
| H / L | Previous / next recorded event |
| J / K | Next / previous sidebar item, including Overview |
| d | Show / hide the scenario description beside the sidebar, or centered in focus mode |
| I | Toggle the current scenario's diagram |
| O | Toggle the domain ERD |
| n | Open / close the data inspector with a 150ms slide |
| , / . | Previous / next inspector tab while open |
| `'` / `/` | Page up / down in the active inspector tab while open |
| ; | Toggle fit-to-screen / 1:1 with current-step focus in Diagram or Domain |

Type to filter quick actions, use ↑/↓ to select a result, and press Enter to run it. Escape closes the dialog and restores navigation immediately, including during its closing animation. H/L selects recorded events and J/K selects scenarios from any main view. I selects Diagram; O selects Domain when present. Brackets and tab-list arrows select among available Diagram, Domain, and Wiring tabs. Single-letter shortcuts pause while typing, using quick actions or selection overlays, or interacting with unrelated modals. Scenario navigation preserves each scenario's event position and stops at the first/last item.

Redact secrets and personal data before publication or sharing. No credentials belong in an explanation.

## Security and scope

The daemon listens only on IPv4 loopback. Any local process can read, publish, delete, or export explanations. Host and Origin checks protect against foreign web pages and DNS rebinding. Trust the processes and local services on your machine. The frontend shell contains no explanation data. The service is not designed for remote hosting or multi-user access.

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

Build frontend assets before Rust checks. Tests use isolated state and do not install services. Read [architecture.md](../architecture.md) for boundaries and the document contract.

The optional browser smoke test requires Playwright and a Chromium executable. Build the release binary first, then supply their absolute paths:

```sh
LAIN_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
LAIN_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
node tests/browser-smoke.cjs
```

The harness exercises the actual daemon, live updates, restart persistence, and mobile layout. It cleans up its processes and retains diagnostic artifacts under `/tmp/opencode`.

`tests/browser-overview-smoke.cjs` uses the same Playwright/browser settings to check topic navigation, comparison partners, browser history, both themes, and mobile layout against an isolated daemon. It defaults to `target/debug/lain`; `LAIN_BINARY` selects another built executable.

`tests/browser-wiring-smoke.cjs` uses those browser settings with an isolated frontend preview and the shopping-cart fixture. It checks shared geometry/framing, full-scope focus padding, port inspection, contract gaps, work overlays, mapping coverage, live removal, both themes, and 320–1440px layouts. It performs no publication to saved user state.

## Release

GitHub Actions checks pushes to `main` on Linux x64, macOS Apple Silicon/Intel, and Windows x64. Each native runner builds the frontend before Rust, runs tests and Clippy, packages its executable, and smoke-tests installation, embedded assets, chart rendering, local commands, and restart persistence. Global packaging combines the native manifests into shell and PowerShell installers. Each platform tests its generated installer against local release archives with startup and PATH changes disabled. A stable `vX.Y.Z` tag matching `Cargo.toml` publishes the archives, SHA-256 checksums, and installers only after every job passes. Tests never install a real startup job.

From a clean, verified `main` checkout with the release version committed in `Cargo.toml` and `Cargo.lock`:

```sh
git tag -a v0.2.0 -m 'Release v0.2.0'
git push --atomic origin main v0.2.0
gh run list --workflow release.yml
```

Use the matching new version for later tags. Local packaging requires cargo-dist 0.32.0 after `./scripts/build.sh`:

```sh
dist build --artifacts=all --target=x86_64-unknown-linux-gnu --tag=v0.2.0
python3 scripts/prepare_installer.py target/distrib/lain-installer.sh
node tests/release-smoke.mjs target/release/lain
```
