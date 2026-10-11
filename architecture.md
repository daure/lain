# Lain MVP

Lain is a local web viewer for agent-published software explanations. A single Rust daemon owns SQLite, domain validation, HTTP, MCP, and live invalidations. The browser walks recorded scenarios; it does not simulate a system.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `model.rs` | Serialized document contract and pure validation |
| `store.rs` | SQLite schema, reads, atomic revision-checked replacement |
| `service.rs` | Validate, persist, then notify; shared by REST and MCP |
| `auth.rs` | Bearer credential, short-lived launch codes, browser sessions |
| `http.rs` | REST, WebSocket, host/origin guard, embedded frontend |
| `mcp.rs` | rmcp Streamable HTTP tools over the same service |
| `runtime.rs` | Local paths, configuration, credential permissions, systemd setup |
| `main.rs` | CLI and daemon lifetime |
| `frontend/src/` | Vue, PrimeVue, navigation, safe structured SVG |

Use Axum 0.8, Tokio, SQLx 0.9 SQLite, rmcp 0.12, serde/schemars, Vue 3, TypeScript, Vite, and MIT PrimeVue 4. SQLx isolates SQLite work from async handlers. Rust embeds `frontend/dist`; the installed executable needs neither Node nor a database daemon. A frontend build must precede a Rust build. Use Dagre for SVG layout; authored labels render as text, never HTML or executable diagram syntax.

## Document contract

All JSON field names are camelCase. Arrays preserve authored order. Unknown fields are rejected. Definitions use stable string IDs. Server metadata is outside the authored document.

```ts
type Explanation = {
  schemaVersion: 1;
  title: string;
  description: string;
  domain: {
    entities: {
      id: string;
      label: string;
      attributes: { id: string; label: string }[];
      methods?: { id: string; signature: string; description: string }[];
    }[];
    relationships: {
      id: string;
      label: string;
      sourceEntityId: string;
      targetEntityId: string;
      sourceCardinality: 'one' | 'many';
      targetCardinality: 'one' | 'many';
    }[];
  };
  diagrams: {
    id: string;
    title: string;
    kind: 'flow' | 'state' | 'process' | 'sequence';
    nodes: { id: string; label: string; entityIds: string[] }[];
    edges: {
      id: string;
      sourceNodeId: string;
      targetNodeId: string;
      label: string;
    }[];
    sequence?: {
      participants: { id: string; label: string }[];
      messages: {
        nodeId: string;
        fromParticipantId: string;
        toParticipantId: string;
      }[];
      body: SequenceStep[];
    };
  }[];
  scenarios: {
    id: string;
    title: string;
    diagramId: string;
    occurrences: {
      id: string;
      nodeId: string;
      incomingEdgeId: string | null;
      trigger: string | null;
      narration: string;
      before: Snapshot;
      after: Snapshot;
    }[];
  }[];
};
type Snapshot = {
  instances: {
    id: string;
    entityId: string;
    values: Record<string, unknown>;
  }[];
  links: {
    relationshipId: string;
    sourceInstanceId: string;
    targetInstanceId: string;
  }[];
};
type SequenceStep =
  | { kind: 'message'; nodeId: string }
  | { kind: 'alt'; id: string; operands: SequenceOperand[] }
  | { kind: 'opt' | 'loop'; id: string; guard: string; body: SequenceStep[] };
type SequenceOperand = { id: string; guard: string; body: SequenceStep[] };
type StoredExplanation = {
  id: string;
  revision: number;
  updatedAtMs: number;
  document: Explanation;
};
type PublishRequest = { expectedRevision: number; document: Explanation };
type DeleteRequest = { expectedRevision: number };
type ExplanationSummary = {
  id: string;
  title: string;
  description: string;
  revision: number;
  updatedAtMs: number;
  diagramCount: number;
  scenarioCount: number;
};
type ChangeEvent = { id: string; revision: number; deleted?: boolean };
```

IDs contain 1–64 ASCII letters, digits, underscores, or hyphens. Entity, relationship, diagram, and scenario IDs are unique within their collection. Attribute IDs and method IDs each have their own unique namespace within an entity; nodes and edges within their diagram; occurrences within their scenario. A document contains at least one diagram and scenario. Each scenario has at least one occurrence.

Entity methods describe domain behavior using a stable ID, nonblank signature text, and a plain-text description. Descriptions may be empty. Signatures may include parameters and return types, but Lain does not parse or execute them. An omitted methods collection means no methods; empty collections are omitted on serialization. Schema version 1 and existing stored documents remain valid. Method IDs do not expand the attribute IDs accepted in snapshot values.

Every reference resolves within the document. Each scenario references one diagram. Its first occurrence has a null incoming edge; every later occurrence names an edge from the previous node to the current node. Repeated visits and self-loops are valid. Node entity references resolve. Snapshot instance IDs are unique, attributes belong to the referenced entity, and links join present instances of the declared endpoint types. Duplicate links and cardinality violations fail validation. An instance retains its entity identity across occurrences in a scenario.

Every scenario references a shared diagram definition. Flow/state/process scenarios traverse its declared nodes and edges. Sequence diagrams also require `sequence` with 1–50 uniquely identified participants, exactly one message mapping per node, and a nonempty ordered `body`. Each mapping names existing sender and receiver participants; self-messages are valid. Other diagram kinds omit sequence data.

The body references every message node exactly once across its tree. `alt` has 2–20 guarded operands and chooses one operand per visit. `opt` conditionally includes its body. `loop` permits zero or more iterations. Fragment and operand IDs are unique across the sequence tree; bodies are nonempty and guards contain descriptive text. Guards are never evaluated against snapshots. Structure is bounded to 500 message/fragment/operand items and eight nesting levels, subject to the document's JSON depth limit.

Scenario occurrences must follow both declared graph edges and the shared sequence order, including fragment choices and loop repetition. A recording may end at a valid prefix. Repeated messages retain distinct occurrence IDs and snapshots. Validation compiles fragments into a bounded epsilon automaton; it matches recorded node IDs without executing guards or enumerating all possible paths. Stored sequence documents without a body remain readable; every publication requires an explicit body.

Snapshots are complete recorded states, not patches. Missing attributes are uncaptured; null is a captured value. Missing instances are absent. Consecutive snapshots may differ because external activity may occur between recorded events. No execution or inference happens in Lain.

Captured JSON numbers must stay within ±9,007,199,254,740,991. Encode larger integers and precision-sensitive decimal values as strings so browser parsing and comparisons preserve them.

Reject serialized documents over 2 MiB, nesting over 32 levels, text over 32 KiB, and unreasonable collection sizes (200 entities, 200 attributes and 200 methods per entity, 500 relationships, 50 diagrams, 200 nodes and 500 edges per diagram, 100 scenarios, 2,000 total occurrences, 500 instances per snapshot). Index attribute IDs once per entity. Return useful validation errors.

## Rust interfaces

`model` exports the contract structs above and `validate_id(&str) -> Result<(), String>`, `Explanation::validate() -> Result<(), String>`. Struct names mirror TypeScript names. Derive Clone, Debug, serde Serialize/Deserialize, and schemars JsonSchema where MCP requires it. Schema version is `u32`; revisions/timestamps/counts are `u64`/`usize` as appropriate.

`service` exports:

```rust
#[derive(Clone)]
pub struct AppService { /* shared store + broadcast sender */ }
impl AppService {
    pub async fn open(path: &std::path::Path) -> Result<Self, ServiceError>;
    pub async fn list(&self) -> Result<Vec<ExplanationSummary>, ServiceError>;
    pub async fn get(&self, id: &str) -> Result<StoredExplanation, ServiceError>;
    pub async fn publish(&self, id: &str, request: PublishRequest)
        -> Result<StoredExplanation, ServiceError>;
    pub async fn delete(&self, id: &str, request: DeleteRequest)
        -> Result<ChangeEvent, ServiceError>;
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<ChangeEvent>;
}
pub enum ServiceError {
    Invalid(String), NotFound, Conflict, Storage(String),
}
```

`auth` exports `Auth::new(token: String) -> Self` (Clone), `Auth::launch_code() -> String`, `Auth::exchange(code: &str) -> Option<String>`, and `Auth::authorized(headers: &axum::http::HeaderMap) -> bool`. The HTTP router configures a port-specific cookie name. MCP explicitly accepts bearer credentials only. Launch codes expire in 60 seconds and are single-use. In-memory browser sessions expire in 12 hours. The cookie is `lain_session_<port>`, HttpOnly, SameSite=Strict, Path=/, Max-Age=43200. Cookies are host-scoped, so local services on the same hostname must be trusted. No credentials go in query strings or logs.

`http` exports `pub fn router(service: AppService, auth: Auth, port: u16) -> axum::Router`. It embeds `frontend/dist` using rust-embed. `mcp` exports `pub fn router(service: AppService) -> axum::Router`, unauthenticated internally and mounted only under the guarded MCP route. The outer HTTP router checks bearer authentication for `/mcp`.

`runtime` exports:

```rust
pub struct Runtime {
    pub home: std::path::PathBuf,
    pub port: u16,
    pub token: String,
}
impl Runtime {
    pub fn load(home: Option<std::path::PathBuf>, port: Option<u16>)
        -> anyhow::Result<Self>;
    pub fn database_path(&self) -> std::path::PathBuf;
    pub fn base_url(&self) -> String;
    pub fn setup(&self, dry_run: bool) -> anyhow::Result<()>;
}
```

## SQLite and publication

Store `id TEXT PRIMARY KEY`, `revision INTEGER`, `document_json TEXT`, `updated_at_ms INTEGER`, and `deleted INTEGER NOT NULL DEFAULT 0`. Storage schema 2 migrates schema 1 by adding the deletion flag. Keep the database on local disk. Enable WAL, a bounded busy timeout, and schema versioning via `PRAGMA user_version`.

Validate before persistence. `expectedRevision = 0` creates only. Positive revisions replace only the matching current revision. Implement compare-and-swap in SQLite, never read-then-unconditional-write. A successful publish commits the entire document and incremented revision atomically, then broadcasts `{id, revision}`. Conflicts are explicit. A disconnected client never rolls back a committed write.

Deletion requires the current positive revision. It atomically increments the revision, marks the row deleted, and replaces the captured document with JSON `null`. Reads and lists hide deleted rows. The response and notification are `{id, revision, deleted: true}`. Creating a deleted ID with `expectedRevision = 0` continues its revision sequence, so stale writes cannot match a recreated document.

Persistence and its notification run in an owned task so cancelling an HTTP or MCP caller cannot interrupt the commit-to-notification sequence. A caller that disconnects during a mutation must refetch before retrying because the transaction may have completed.

## HTTP and MCP

| Route | Contract |
| --- | --- |
| `GET /api/health` | Public `{status: "ok"}`; no local metadata |
| `POST /api/launch` | Bearer-only; return `{url}` with a one-use fragment code |
| `POST /api/session` | Exchange `{code}` for browser cookie |
| `GET /api/explanations` | Authenticated summary array |
| `GET /api/explanations/{id}` | Authenticated stored explanation |
| `PUT /api/explanations/{id}` | Authenticated `PublishRequest`, return stored explanation |
| `DELETE /api/explanations/{id}` | Authenticated `DeleteRequest`, return deletion event |
| `GET /ws` | Authenticated WebSocket invalidations |
| `/mcp` | Bearer-only Streamable HTTP |
| static frontend | Public shell, no embedded private data |

Return `{error: string}` for application HTTP errors: 400 invalid, 401 unauthenticated, 404 missing, 409 conflict, 500 storage. Never expose internal database errors to clients. Limit request bodies and bound upload time; stalled uploads return 408 without imposing a deadline on SSE responses or WebSockets. Bind only `127.0.0.1`; reject unexpected Host headers and foreign or malformed Origins, including for WebSocket upgrades. Require exact `127.0.0.1:port` or `localhost:port`, with Origin matching the request authority. No permissive CORS. Apply the guard to static routes too. WebSocket lag sends a refetch hint or closes the socket so reconnection resyncs. Subscribe before fetching current state. Handle shutdown on SIGINT and SIGTERM.

MCP tools: `list_explanations`, `get_explanation({id})`, `publish_explanation({id, expectedRevision, document})`, `delete_explanation({id, expectedRevision})`. Include the schema in tool discovery. Domain errors become tool errors. Use rmcp's protocol implementation with stateless HTTP transport rather than a hand-written JSON-RPC dispatcher. Keep credentials out of tool descriptions. Include agent instructions for safe authoring, captured values, redaction, revision conflicts, and occurrence identity.

## Viewer

The library selects an explanation. The header centers its title and a 20px left-arrow icon vertically, with an 8px gap between them. The title uses a 24px line height. The icon and title share one back button that opens the explanation library and has an accessible label and tooltip. The explanation title forms the page heading. Long titles truncate and expose the full title in a tooltip. The library view leaves the title area empty. The connection status reads Connected and has a 6px gap between its icon and text. Header actions use 12px gaps, reduced on narrow screens. The sidebar groups scenarios under their diagram and shows every recorded occurrence. Diagram kind labels keep their full width and center their text. Visited events, the current event, and muted upcoming events remain selectable by occurrence ID. Forward/back selects recorded occurrences. Main view has Event, Diagram, Data, and Domain tabs in that order. Event shows trigger, narration, and the compact current diagram node. Diagram embeds the full selected diagram; Data shows concrete before/after values; Domain embeds the shared ERD. The selected tab persists across scenario navigation. Distinguish unchanged, changed, created, removed, uncaptured, and null values. Preserve cursors per scenario using occurrence IDs.

The desktop header is 66px tall; narrow screens wrap the identity and actions. Main content and tab labels keep their viewport-adjusted insets. The tab bar's bottom border and the bottom controls' top border span the main panel's full width. Each tab panel scrolls within the available height. Sequence revisit badges have equal top and right insets inside their message row.

M toggles focus mode in the viewer, instantly hiding or restoring the sidebar, header, and event footer. A centered quiet breadcrumb shows the explanation, diagram, and scenario titles with slash separators; the scenario carries stronger emphasis. It fades in over 250ms on entering focus mode and disappears instantly on exit. Reduced motion shows it immediately. The breadcrumb has equal space above its text and below it to the recorded-step lens. Long titles truncate and expose their complete text in tooltips and accessible labels. Hidden chrome becomes inert immediately. The main panel fills the remaining viewport while the step navigator and tabs stay visible. Focus mode preserves the selected tab and occurrence, shares the viewer shortcut input guards, and ignores key repeats. Toggle focus mode appears in Quick actions. Focus moves to the selected tab when its control becomes hidden. Returning to the library restores the header.

The main panel begins with a three-slot recorded-step navigator above the tabs. Every step heading shows a smaller, muted monospace number separated from its node label by spacing, beside a visited check, current solid dot, or upcoming hollow dot. Every step shows its trigger underneath as a bolt icon and value with centered vertical alignment. Each heading and trigger form a vertically centered group within its slot. Adjacent steps use muted text; the active occurrence stays centered under a raised blue lens. Missing neighbors reserve an empty slot, including single-occurrence scenarios. Neighbor buttons select occurrence IDs, preserving revisit identity and the selected tab. Headings and their triggers slide together under the stationary lens over 300ms, with separate rows keeping them apart throughout the motion. Rapid navigation retargets the slide; reduced motion swaps immediately. Long labels clamp to two lines with full-text tooltips, and long triggers wrap within a bounded scroll area. Light and dark themes share the layout.

Diagram and Domain use transparent, borderless canvases at 100% zoom by default. Graph views focus the current recorded step; sequence views focus its complete horizontal row; Domain focuses its related entity definitions. Automatic following prefers centering but hugs layout bounds with 20px screen-space padding to maximize visible content. Layouts that fit along an axis remain centered as a whole on that axis. Step changes animate to their target over 250ms with sine ease-in-out at the selected zoom. Animation timing starts at the first rendered frame. Canvas gutters support manual panning. Rapid navigation retargets the animation, manual interaction cancels it, and reduced motion uses immediate scrolling. Bottom-right controls zoom around the viewport center, fit the whole layout, and restore 100% while focusing the current step. Fit is an explicit mode: event navigation preserves its zoom and viewport. Zooming, restoring 100%, or manually scrolling or panning exits fit; following resumes on the next event navigation. In Diagram and Domain, = zooms in, - zooms out, ; fits, and ' restores 100% and focus. These actions appear in Quick actions and share the viewer shortcut input guards. A structured minimap shows the layout and visible bounds; dragging its viewport or the canvas background pans the main view. Minimap arrows pan and Home fits without changing the recorded occurrence. Node and entity selection remains available at every scale. Compact Event diagrams retain their inset scroll views. Sequence sticky headings and occurrence centering use scaled coordinates.

The sidebar scrollbar spans its full height at the right border and occupies the right padding. Sidebar content retains its width and horizontal position when the scrollbar appears. The active diagram and scenario labels pin at their padded resting positions. Natural and pinned labels share text metrics and spacing, including the collapsed margin between the diagram heading and its first scenario. Pinned labels truncate on narrow screens to leave room for navigation; their titles expose complete text.

The first scenario in a diagram pins together with its diagram heading. Other selected scenarios pin when their label reaches the heading. Inactive diagram headings are gray; unselected scenario labels are dimmer. The active diagram and selected scenario retain full emphasis. The recorded-event list is labeled Scenario, with the current position and total aligned at the right as `1/3`.

The current recorded event shares the selected scenario's surface and border treatment. Each sidebar event shows its trigger in a wrapping monospace caption, preserving its case, with `No trigger captured` for a null trigger. Visited event labels, trigger captions, and markers use the theme foreground; future events stay muted.

J/K select a scenario and center its saved recorded event in the sidebar over 250ms only when that event is outside the usable viewport. Fully visible events preserve the scroll position. H/L center the selected recorded event over 250ms. Centering accounts for pinned context and clamps at scroll boundaries. Rapid navigation retargets the animation, manual pointer or scroll input cancels it, and reduced-motion preferences use immediate scrolling.

The URL stores explanation, scenario, and occurrence IDs in query parameters. User navigation pushes browser history; initial defaults and revision normalization replace the current entry. Reload and Back/Forward restore the selected occurrence after authentication. Route restoration cancels superseded document loads. URLs and history state contain no captured values or credentials; the launch fragment is reserved for session exchange.

An accessible sun/moon toggle follows Quick actions in the header. Light mode is the default. Dark mode uses neutral black and gray surfaces, whitish text, and monochrome PrimeVue controls. Blue distinguishes graph traversal and selected recorded events. The browser stores an explicit light/dark preference under `lain-theme`; unavailable storage does not prevent switching. The root `app-dark` class controls both custom viewer colors and PrimeVue's dark theme, including teleported dialogs and structured SVG diagrams.

Ctrl+K opens searchable quick actions and focuses the search input. H/L select the previous/next event across all tabs. J/K select the next/previous scenario in displayed sidebar order across all tabs. [ and ] select the previous/next tab, stopping at tab boundaries. Tab switches preserve the selected occurrence and snapshots. The tablist supports Left/Right, Home, and End with roving focus; arrows in panels navigate recorded events and scenarios. Escape dismisses Quick actions and permits navigation during its closing animation. Navigation stops at list boundaries and preserves each scenario's cursor. Viewer shortcuts are inactive in editable controls, quick actions, selection overlays, and unrelated modals. The palette supports arrows, Enter, Escape, and mouse selection, shows each shortcut, and disables unavailable actions.

Left/Right arrows select the previous/next event; Down/Up arrows select the next/previous scenario. Arrow shortcuts share H/J/K/L's input guards, boundary checks, and centered scrolling. Quick actions displays both shortcut forms. Arrows retain their native editing and selection behavior in inputs, palettes, and selection overlays.

In the explanation viewer, Escape and Ctrl+[ blur the focused HTML or SVG element when no dialog or selection overlay owns the key. If focus is on the page body, either shortcut opens the explanation library. Blurring clears its focus outline while preserving the selected occurrence and tab. In the library, either shortcut returns focus to the selected card from search, header controls, cards, or the page body. Pressing either shortcut on a card also clears search and keeps that card focused in the full list. Dismissing Quick actions in the library returns focus to the selected card. With no matching cards, the shortcut blurs the current control. Ctrl+C in the library search clears it while preserving input focus; modified or composing input retains native behavior. Repeated keydown events do not dismiss additional layers. Keyboard navigation retains visible focus indicators.

The explanation library keeps a compact introduction, search, and count fixed above a full-width card scroll region. Its scrollbar sits at the viewport's right edge; content is centered and capped at 1250px. The browser session retains the search text, selected card ID, and card scroll position across explanation visits, failed document loads, and browser history navigation. Returning restores the selected card's focus without scrolling it into view; missing cards fall back to the first result and scroll positions clamp to the available content. The first visit focuses the first card when no other control owns focus. Cards and search indicate focus with a single blue border. H/L and Left/Right move in list order, wrapping between rows and stopping at the first and last cards. J/K and Down/Up move between rendered rows; Down selects the last available card if the next row is incomplete. Vertical navigation stops at the first and last rows. Enter opens the focused card. The introduction uses the available content width. Search sits between the introduction and cards, filtering titles and descriptions by a case-insensitive literal substring and highlighting every match as text. The count shows the total when search is empty and the number found while searching. / focuses search outside editable controls and overlays. Down or Enter in search focuses the first result. Filtering preserves search focus. The no-match message has a borderless background at 20% of the theme's soft surface color.

Capital G selects the last recorded event in the active scenario. Two lowercase g presses within one second select its first event. Unrelated keys, modifiers, composition, and repeats reset the pending sequence. Endpoint shortcuts share H/L's input guards and centered scrolling. First event and Last event appear in Quick actions with their shortcuts and boundary-aware availability.

In Diagram and Domain, a Shift+H/J/K/L tap pans the viewport left/down/up/right by 187.5 screen pixels over 150ms with cubic ease-out. Holding a key continues scrolling on animation frames independently of keyboard-repeat timing, then eases to a stop on release. Releasing Shift also stops the hold; losing focus, opening Quick actions, and focusing an editable control cancel it. Reduced motion uses an immediate tap and steady scrolling while held. Panning preserves the selected occurrence and zoom, cancels step-following motion, and shares the viewer shortcut input guards. Pan actions appear in Quick actions.

In Event and Data, Shift+H resets every scenario cursor in the current explanation to its first occurrence, selects the first scenario in displayed sidebar order, and opens the Event tab. Reset explanation appears in Quick actions across all tabs; its shortcut is shown only where it resets. Reset shares the viewer shortcut input guards, ignores key repeats, centers the selected event, and records the resulting selection as one browser history entry.

Y then S copies the explanation path through the current scenario; Y then D copies it through the diagram; Y then P copies it through the current event, including occurrence position. Paths include the explanation title and use ` → ` separators. These actions appear in the palette's Clipboard group and work across tabs while a scenario is selected. Yank sequences expire after one second and reset on unrelated keys. Editable controls, modified keys, composition, and repeats preserve normal input. PrimeVue toasts at the top right confirm successful clipboard writes or report clipboard failures.

The full diagram distinguishes muted off-scenario elements, upcoming scenario elements, and blue visited elements. Recorded incoming edge IDs determine scenario membership. Nodes recorded more than once in the selected scenario show a badge from their first visit, counted only through the current occurrence. Graph edge labels wrap at roughly 20 characters into at most two centered lines; overflow ends with an ellipsis, and tooltips expose the complete label. Layout reserves the displayed label's width and height. Edge labels show traversal counts above one on their final line. Sidebar occurrences of repeated nodes show their per-node visit number, including upcoming visits. Single-visit nodes remain unbadged. Badge numerals are centered, with the circle inset from the node's top-right corner. Diagram node clicks navigate to recorded occurrences; repeated visits display an occurrence picker. Off-path nodes stay inspectable but cannot mutate a scenario. Structured SVG uses text rendering and controlled attributes. No agent-authored HTML, URLs, SVG, or scripts enter the DOM.

The domain ERD shows entity tables with a type heading and separate property rows; property IDs occupy the right column. Orthogonal connectors use endpoint bars for one and crow's feet for many. The contract specifies maximum multiplicities; minimum cardinalities and property data types are unspecified. The full shared domain determines layout, so changing scenarios preserves entity positions. Relevance spans the entire selected scenario: visited node entity references and all before/after instances identify used types, while captured links identify recorded relationships. Unused types and unrecorded relationships are muted. Every type remains keyboard-inspectable in both themes.

Domain headings begin with a plain shortcut number and a thin vertical divider. Numbers start at 1 in left-to-right layout order, with top-to-bottom ordering within each column. Digit shortcuts select, keyboard-focus, and center the entity at the current zoom, exiting fit mode. A prefix that also matches longer numbers underlines its matched digits across every matching heading for 500ms. Enter confirms the exact number immediately; another digit extends the prefix; timeout confirms the exact number. Unique complete numbers select immediately. Invalid prefixes and unrelated input cancel without selection. Viewer shortcut guards apply, and pending prefixes cancel on scenario or event changes, tab departure, editable or overlay focus, Quick actions, and window blur.

Full sequence views render one diagram-owned layout with participant headers, lifelines, directed messages, and nested alt/opt/loop frames. Switching scenarios preserves geometry; operand shading identifies the recorded branch. Current and visited messages are blue, upcoming messages remain distinct, and other paths are muted but inspectable. Revisited messages occupy one shared row with prefix visit counts and an occurrence picker for separate snapshots. Compact views show the previous and current recorded messages. Sequence and graph views share the same tab controls and keyboard navigation.

Sequence participant headers stay pinned during vertical scrolling and aligned with their lifelines during horizontal scrolling. Fragment and operand headings stick within their declared parent containers. At a container's bottom edge, the heading slides beneath its parent's heading and remains clipped until its final visible pixel leaves the parent. Root fragments use the participant bar as their sticky boundary. Sibling headings stick only when their own frame reaches that boundary. Pinned originals are hidden in the scrolling layer.

The bounded context stack retains outer headings and the innermost heading on narrow viewports; tooltips expose its complete nesting path. Pinned headings retain their typography, colors, fragment tabs, and horizontal frame boundaries. Nested heading surfaces leave ancestor borders visible. Fragment titles and guards share a centered vertical alignment.

Sequence occurrence navigation focuses the complete selected row in the usable scroll area below sticky participant and fragment headings over 250ms. Horizontal focus uses the row's midpoint. Automatic targets hug layout bounds while keeping the selected row visible. Fit mode preserves the viewport during occurrence navigation. Rapid navigation retargets the animation; manual scrolling cancels it. Reduced-motion preferences use immediate scrolling. Compact sequence views keep their containing panels stationary.

WebSocket messages invalidate data. Connect the socket before loading documents; reconnect with bounded backoff and refetch. Keep the displayed revision stable when an update arrives. Show an update banner and explicitly reload, preserving IDs that still exist. Deletion returns an affected view to the library and cancels outstanding loads for that ID. Display connection, loading, empty, and failure states.

## Installation and commands

`lain serve` runs foreground. `lain` requests a launch code from the existing service and opens its URL with `xdg-open`; if unavailable, print an actionable setup/serve instruction. `lain open --print-url` supports manual browser use. `lain setup` creates an idempotent systemd user service with an absolute executable path and explicit home/port, enables/starts it, and checks authenticated readiness and service state. Successful setup saves the selected port for later client commands. `lain setup --dry-run` prints the unit and client settings without installing a unit. `lain status` checks authenticated daemon readiness. `lain demo` publishes the bundled example through the authenticated HTTP API.

Global `--home` or `LAIN_HOME` selects isolated runtime state; default `$XDG_DATA_HOME/lain` (or `~/.local/share/lain`). `--port` overrides the saved port; default 38475. Home mode 0700 and credential/config files mode 0600. Database lives at `home/lain.sqlite`. Preserve credentials during repeat setup. Do not overwrite unrelated files or silently repair unsafe symlinks. A service unit uses `Restart=on-failure`, `WantedBy=default.target`, and runs unprivileged. Start at login; explain `loginctl enable-linger` for pre-login boot without invoking sudo. Do not alter agent client configs automatically.

The daemon holds an exclusive OS file lock under its runtime home for its lifetime. A second daemon using the same home fails even when it selects another port. This keeps publication notifications and browser sessions under one process owner. Do not delete or replace the lock file while a daemon runs; the OS releases the lock when the process exits.

`scripts/build.sh` builds frontend then release executable. `scripts/install.sh` installs the built executable to a user bin directory and prints the setup command. No service installation happens during a build or test. No commits or external configuration changes are part of implementation.

`npm start` is a development supervisor, not an application server. It installs frontend dependencies, builds frontend assets, compiles Rust, and starts the Rust daemon alongside Vite. It uses `.lain-dev` for local state, backend/MCP port 38475, and browser port 5173. It checks port ownership, waits for authenticated readiness, seeds an empty development library, and opens an authenticated Vite URL. Shutdown stops its owned child processes. Vue hot-reloads; Rust changes require restarting the command. The installed runtime remains one Rust executable.

## Verification

Integration tests cover valid publication, failed reference validation, branch continuity, revisits, durable reopen, conflicting concurrent publications, auth/Host/Origin isolation, real MCP initialize/list/call, and WebSocket notifications. Frontend checks cover cursor selection and snapshot semantics where risk warrants a test. Typecheck, frontend production build, cargo test, formatting, and clippy must pass. Smoke-test the embedded frontend; use isolated runtime directories.
