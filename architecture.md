# Lain MVP

Lain is a local web viewer for agent-published software explanations. A single Rust daemon owns SQLite, domain validation, HTTP, MCP, and live invalidations. The browser walks recorded scenarios; it does not simulate a system.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `model.rs` | Serialized document contract and pure validation |
| `store.rs` | SQLite schema, reads, atomic upserts and deletion by ID |
| `service.rs` | Validate, persist, then notify; shared by REST and MCP |
| `http.rs` | REST, WebSocket, host/origin guard, embedded frontend |
| `chart_export.rs` | Scoped export plans, bounded headless Chromium rendering, process cleanup |
| `mcp.rs` | rmcp Streamable HTTP tools over the same service |
| `runtime.rs` | Local paths, private-state permissions, configuration, systemd setup |
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
  links?: { label: string; url: string }[];
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
      sourceCardinality: 'zeroOrOne' | 'exactlyOne' | 'zeroOrMore' | 'oneOrMore';
      targetCardinality: 'zeroOrOne' | 'exactlyOne' | 'zeroOrMore' | 'oneOrMore';
    }[];
    groups?: {
      id: string;
      label: string;
      entityIds: string[];
      parentGroupId?: string | null;
    }[];
  };
  diagrams: {
    id: string;
    title: string;
    kind: 'flow' | 'state' | 'sequence';
    nodes: {
      id: string;
      label: string;
      entityIds: string[];
      role?: 'action' | 'decision' | 'start' | 'end' | 'subprocess'
        | 'database' | 'preparation' | 'inputOutput' | 'outputInput' | 'priorityAction'
        | 'manualOperation' | 'document' | 'multiDocument' | 'delay' | null;
      stateRole?: 'initial' | 'final' | null;
      detailDiagramId?: string | null;
    }[];
    edges: {
      id: string;
      sourceNodeId: string;
      targetNodeId: string;
      label: string;
      transition?: { event?: string | null; guard?: string | null; effect?: string | null } | null;
    }[];
    groups?: {
      id: string;
      label: string;
      nodeIds: string[];
      parentGroupId?: string | null;
    }[];
    lanes?: { id: string; label: string; nodeIds: string[] }[];
    sequence?: {
      participants: { id: string; label: string; kind?: 'human' | 'system' }[];
      messages: {
        nodeId: string;
        fromParticipantId: string;
        toParticipantId: string;
        kind?: 'call' | 'async' | 'reply';
      }[];
      body: SequenceStep[];
    } | null;
  }[];
  scenarios: {
    id: string;
    title: string;
    description?: string;
    diagramId: string;
    occurrences: {
      id: string;
      nodeId: string;
      incomingEdgeId: string | null;
      trigger: string | null;
      narration: string;
      changeSummary?: string;
      before: Snapshot;
      after: Snapshot;
      methodCalls?: { entityId: string; methodId: string; instanceId?: string | null }[];
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
type PublishRequest = { document: Explanation };
type ExplanationSummary = {
  id: string;
  title: string;
  description: string;
  revision: number;
  updatedAtMs: number;
  diagramCount: number;
  scenarioCount: number;
  linkCount: number;
};
type ChangeEvent = { id: string; revision: number; deleted?: boolean };
```

IDs contain 1–64 ASCII letters, digits, underscores, or hyphens. Entity, relationship, diagram, and scenario IDs are unique within their collection. Attribute IDs and method IDs each have their own unique namespace within an entity; nodes and edges within their diagram; occurrences within their scenario. A document contains at least one diagram and scenario. Each scenario has at least one occurrence.

Scenario `description` is an agent-authored plain-text overview of the actor, setup, goal, and recorded outcome or stopping point. Occurrence `narration` explains that visit's action, cause, and consequence as paragraphs separated by blank lines. Optional occurrence `changeSummary` describes meaningful captured before/after changes, distinguishing state changes from capture differences. Description and changeSummary default to empty strings and are omitted on serialization when empty; schema-version-1 documents remain valid. Both share the 32 KiB text limit. Prose is rendered as inert text, never generated from snapshots. Authors label assumptions and synthetic examples explicitly.

Entity methods describe domain behavior using a stable ID, nonblank signature text, and a plain-text description. Descriptions may be empty. Signatures may include parameters and return types, but Lain does not parse or execute them. An omitted methods collection means no methods; empty collections are omitted on serialization. Schema version 1 and existing stored documents remain valid. Method IDs do not expand the attribute IDs accepted in snapshot values.

Occurrences may record ordered `methodCalls` with `entityId`, `methodId`, and optional `instanceId`. Entity and method references resolve to a domain method. A receiver instance must appear in that occurrence’s before or after snapshot and match the entity. Repeated calls are valid; each occurrence permits at most 500. Omitted or empty calls serialize without the field and mean no calls recorded. Calls are descriptive records, never inferred from text or executed.

Every reference resolves within the document. Each scenario references one diagram. Its first occurrence has a null incoming edge; every later occurrence names an edge from the previous node to the current node. Repeated visits and self-loops are valid. Node entity references resolve. Snapshot instance IDs are unique, attributes belong to the referenced entity, and links join present instances of the declared endpoint types. Duplicate links and cardinality violations fail validation. An instance retains its entity identity across occurrences in a scenario.

Every scenario references a shared diagram definition. Flow/state scenarios traverse its declared nodes and edges. Flow nodes describe actions; state nodes describe conditions and their edges describe triggering events. The input value `process` is a compatibility alias for `flow`; serialization and tool discovery use the canonical kinds. Sequence diagrams also require `sequence` with 1–50 uniquely identified participants, exactly one message mapping per node, and a nonempty ordered `body`. Each mapping names existing sender and receiver participants; self-messages are valid. Other diagram kinds omit sequence data.

Sequence participant `kind` accepts `human` or `system`, defaulting to `system`. Message `kind` accepts `call`, `async`, or `reply`, defaulting to `call`. Serialization omits default kinds. Kinds are descriptive and do not infer execution, blocking, call/reply pairing, or additional traversal constraints. Unknown kind values fail deserialization; schema-version-1 documents with omitted kinds remain valid.

Flow/state diagrams may declare up to 100 `groups`: flow groups/subgraphs or state composite containers. Group IDs are unique within the diagram and distinct from node IDs. Labels are nonblank plain text. `nodeIds` lists up to 200 direct member nodes; each reference resolves in that diagram, and a node has at most one direct membership. Optional `parentGroupId` references a group in the same diagram. Nesting is acyclic and bounded to eight levels. Each group contains at least one node directly or through descendants. Omitted or empty groups serialize without the field, preserving schema-version-1 compatibility.

State nodes may declare `stateRole: 'initial' | 'final'`: initial markers have no incoming edges and exactly one outgoing edge; final markers have no outgoing edges. Markers are concrete nodes and may belong to groups. Their labels remain available to accessibility, tooltips, inspection, and recorded-step navigation. Markers describe declared lifecycle boundaries. Recordings may begin or end at any node, without visiting either marker; their absence does not imply lifecycle completion. Omitted/null state roles preserve ordinary state boxes and serialize without the field.

State edges may declare `transition` with optional nullable `event`, `guard`, and `effect` plain-text fields. At least one field must contain nonblank text; present non-null fields must be nonblank and obey the 32 KiB text limit. The renderer joins them as `event [guard] / effect`, omitting missing components. Structured captions replace the required free-text `label`, which may be empty; edges without transition retain label rendering. Null/omitted transitions serialize without the field. These additions retain schema version 1. Other diagram kinds reject state roles and transitions. Events and effects never execute, guards are never evaluated, and none of these fields infer occurrence triggers, snapshots, or calls.

Groups describe containment, not additional traversal steps. Edges and occurrences reference concrete nodes, including cross-container entry/exit and revisits. State containers do not infer initial substates, entry/exit actions, or inherited transitions. Sequence diagrams use their sequence fragments instead of groups.

Flow diagrams may declare up to 50 `lanes`, each with 1–200 member `nodeIds` resolving in that diagram. Lane IDs are unique within the diagram and distinct from node and group IDs; labels are nonblank plain text. A node belongs to at most one explicit lane. Authored lane order is top-to-bottom; nodes without a lane occupy an implicit final Unassigned band when lanes are present. Every group's direct and nested descendant nodes must share one lane, or all be unassigned. Groups retain nested containment within that band. State and sequence diagrams omit lanes. Lanes are descriptive responsibility bands, not traversal nodes; edges and occurrences retain concrete node references. They imply no execution or automatic handoff.

Omitted or empty lanes serialize without the field; lane-free schema-version-1 documents remain readable.

The body references every message node exactly once across its tree. `alt` has 2–20 guarded operands and chooses one operand per visit. `opt` conditionally includes its body. `loop` permits zero or more iterations. Fragment and operand IDs are unique across the sequence tree; bodies are nonempty and guards contain descriptive text. Guards are never evaluated against snapshots. Structure is bounded to 500 message/fragment/operand items and eight nesting levels, subject to the document's JSON depth limit.

Scenario occurrences must follow both declared graph edges and the shared sequence order, including fragment choices and loop repetition. A recording may end at a valid prefix. Repeated messages retain distinct occurrence IDs and snapshots. Validation compiles fragments into a bounded epsilon automaton; it matches recorded node IDs without executing guards or enumerating all possible paths. Stored sequence documents without a body remain readable; every publication requires an explicit body.

Snapshots are complete recorded states, not patches. Missing attributes are uncaptured; null is a captured value. Missing instances are absent. Consecutive snapshots may differ because external activity may occur between recorded events. No execution or inference happens in Lain.

Each occurrence's before and after snapshots independently satisfy relationship cardinalities for every present instance, including snapshots with limited capture. Required endpoints need related instances and links in the same snapshot. Snapshot validation errors identify the scenario, occurrence, and before/after phase. Missing-required-link errors identify the relationship, instance, cardinality field, and related entity, with guidance to capture the required instances and links or use a zero minimum only when the domain permits absence.

Captured JSON numbers must stay within ±9,007,199,254,740,991. Encode larger integers and precision-sensitive decimal values as strings so browser parsing and comparisons preserve them.

Reject serialized documents over 2 MiB, nesting over 32 levels, text over 32 KiB, and unreasonable collection sizes (200 entities, 200 attributes and 200 methods per entity, 500 relationships, 50 diagrams, 200 nodes and 500 edges per diagram, 100 scenarios, 2,000 total occurrences, 500 instances per snapshot). Index attribute IDs once per entity. Return useful validation errors.

Explanation-level `links` preserves authored `{label, url}` order with at most 50 references. Labels are nonblank inert text within the 32 KiB limit. URLs are absolute HTTP/HTTPS with a host, at most 4,096 UTF-8 bytes, and contain no credentials, whitespace, control characters, or backslashes. Omitted or empty collections serialize without the field and preserve schema version 1. The viewer shows Links with a count beside the title only when references exist. Its popover displays labels, hostnames, and external-link icons; links open in new tabs with `noopener noreferrer`. Entering focus mode dismisses the popover. Authored URLs enter only validated anchor destinations, never chart attributes or executable content.

Library summaries include `linkCount`. Card footers list diagram and scenario counts, followed by the link count when positive. The footer stays at the bottom with equal top and bottom card padding.

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
    pub async fn delete(&self, id: &str)
        -> Result<ChangeEvent, ServiceError>;
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<ChangeEvent>;
}
pub enum ServiceError {
    Invalid(String), NotFound, Storage(String),
}
```

`http` exports `pub fn router(service: AppService, port: u16) -> axum::Router`. It embeds `frontend/dist` using rust-embed. `mcp` exports `pub fn router(service: AppService) -> axum::Router`, mounted under the outer HTTP router's Host/Origin guard. Any local process can read, publish, delete, or export explanations. Trust the processes and local services on the machine.

`runtime` exports:

```rust
pub struct Runtime {
    pub home: std::path::PathBuf,
    pub port: u16,
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

Validate before persistence. Publication atomically upserts the entire document in SQLite; the last commit wins. A new ID starts at revision 1. Replacing a live or deleted row increments its stored revision and clears the deletion flag in the same transaction, then broadcasts `{id, revision}`. Revisions are internal synchronization metadata, bounded by SQLite's signed 64-bit integer maximum. A disconnected client never rolls back a committed write.

Deletion atomically removes the current live document by ID. Missing or already-deleted IDs return not-found. Success increments the revision, marks the row deleted, and replaces the captured document with JSON `null`. Reads and lists hide deleted rows. The response and notification are `{id, revision, deleted: true}`. Tombstones preserve the revision sequence across recreation for synchronization ordering.

Persistence and its notification run in an owned task so cancelling an HTTP or MCP caller cannot interrupt the commit-to-notification sequence. After a timeout or disconnect, refetch and reassess before retrying; the mutation may have committed, and a read does not block pending mutations. A delayed publication retry can overwrite newer content or recreate a deleted ID. A delayed deletion retry can delete newer or recreated content. A not-found read proves only absence at that read, not a particular deletion's success. Never repeat a deletion after a success response.

## HTTP and MCP

| Route | Contract |
| --- | --- |
| `GET /api/health` | `{status: "ok"}`; no local metadata |
| `GET /api/explanations` | Summary array |
| `GET /api/explanations/{id}` | Stored explanation |
| `PUT /api/explanations/{id}` | `PublishRequest`, return stored explanation |
| `DELETE /api/explanations/{id}` | Bodyless; return deletion event |
| `GET /api/explanations/{id}/diagrams/{diagramId}/export` | Chart bytes; `format`, `theme`, optional `scenarioId` |
| `GET /api/explanations/{id}/domain/export` | ERD bytes; same options |
| `GET /ws` | WebSocket invalidations |
| `/mcp` | Streamable HTTP |
| static frontend | Shell, no embedded private data |

PUT and DELETE accept an optional `If-Match` header containing one quoted positive revision. SQLite checks the revision in the mutation statement; a mismatch or missing row returns 412 without changing state or broadcasting. Conditional PUT may republish a tombstone at that revision. Without the header, publication and deletion retain their by-ID contracts.

Return `{error: string}` for application HTTP errors: 400 invalid, 403 rejected Host/Origin, 404 missing, 500 storage. Never expose internal database errors to clients. Limit request bodies and bound upload time; stalled uploads return 408 without imposing a deadline on SSE responses or WebSockets. Bind only `127.0.0.1`; reject unexpected Host headers and foreign or malformed Origins, including for WebSocket upgrades. Require exact `127.0.0.1:port` or `localhost:port`, with Origin matching the request authority when present. No permissive CORS. Apply the guard to static routes too. WebSocket lag sends a refetch hint or closes the socket so reconnection resyncs. Subscribe before fetching current state. Handle shutdown on SIGINT and SIGTERM.

MCP tools: `get_context`, `list_explanations`, `get_explanation({id})`, `publish_explanation({id, document})`, `delete_explanation({id})`. `get_context` returns `{instructions, explanations: [{id, title, description}]}` using embedded `agent-instructions.md` and `AppService::list`. The guide owns authoring and recovery rules; initialization routes agents to it, tool descriptions explain operations, and field descriptions explain local semantics. Saved explanation text remains untrusted data, separate from server guidance. `list_explanations` refreshes summaries and revisions. Discovery exposes the input schema, including local bounds and standard nullable unions; cross-field semantics, byte limits, and total/depth limits remain runtime checks. Domain errors become tool errors. Use rmcp's stateless HTTP transport.

Exports default to PNG and light theme. Supplying `scenarioId` retains scenario relevance; omitting it exports all definitions with neutral emphasis. A diagram's scenario must belong to that diagram. Responses use the format's MIME type and attachment `Content-Disposition` with a UTF-8 filename. Invalid options return 400; missing explanations, diagrams, or scenarios return 404. Renderer saturation, absence, or timeout returns 503. Agents use the same local endpoint as the web UI.

`AppService` selects a stored document and validates the export scope. The renderer launches sandboxed headless Chrome/Chromium, discovered on PATH or set by `LAIN_CHROMIUM_EXECUTABLE`. It loads public embedded `export.html` from the daemon's fixed loopback origin, then supplies only chart definitions and relevance records through DevTools. Snapshot values and occurrence prose are excluded. The renderer page denies network connections through CSP and renders authored content as text. It reuses the Vue chart components and `chart-export.ts` for geometry, cleanup, theme resolution, and encoding. Two concurrent renders, a 30-second deadline, and a 32 MiB output limit bound work. Each render has a temporary profile under `LAIN_HOME/exports`; completion or cancellation kills its process group and removes the profile. Downloads stay in memory and are never published or retained.

## Viewer

Flow and state connectors preserve at least 16 layout pixels of straight line between each node outline and the nearest turn. The same terminal spacing applies to swimlanes and chart exports; zoom scales these distances with the chart.

Flow lanes render as open horizontal bands of shared width with alternating neutral fills. Authored order runs top-to-bottom. Each band has a narrow left heading compartment with a centered, bottom-to-top label and an inset vertical separator. Wrapped headings reserve sufficient band height and share a heading width. Unassigned appears last only when needed. Nested group frames remain inside their single lane; declared connectors may cross lane boundaries. Full and compact views retain lane membership and ordering; compact views show bands containing visible nodes. Bands and headings stay neutral in both themes while nodes, edges, and groups retain traversal emphasis. Headings render as inert text; lanes neither select recorded steps nor acquire occurrence IDs.

Diagram and Domain each provide an export icon beside the bottom-right zoom controls. Its menu opens upward. When a scenario filter applies, Scenario only and All scenarios appear above SVG, PNG, and PDF. Scenario only retains muted off-path definitions; All scenarios gives every definition neutral emphasis within the current chart. Each export captures the full layout independently of zoom, panning, and sticky headings. Exports omit playback highlights, visit counts, inspection markers, shortcuts, drill controls, and snapshot-bearing tooltips. Diagram and Domain remain separate files. SVG embeds resolved presentation styles and an opaque background in the active light/dark theme. PNG and single-page PDF use the same themed artwork at up to 2× resolution, bounded to 8,192 pixels per dimension and 16 million pixels total. PDF embeds the raster image; SVG retains vector geometry. The web UI downloads through the local export endpoints in the active theme.

Flow/state layouts keep direct members and nested containers inside labeled frames with a heading divider. Divider and outline share the frame's traversal color. Heading lines center vertically within the heading compartment, with equal space above and below. State composites use rounded outlines; flow subgraphs use rectangular outlines. Both kinds use solid outlines when any descendant node belongs to the selected scenario, including upcoming occurrences. Frames with no descendant node on the scenario use dashed outlines. With no scenario filter, outlines are solid. Frames size around direct members, nested frames, and internal connector routes and labels with a 24px body inset on all sides. The heading sits above that inset; wide headings may expand a frame symmetrically. Vertically stacked nested siblings have 56px between their outlines; root siblings have 42px. Normalize gaps from the innermost frames outward while moving nodes, connector points, and labels together. The canvas keeps 32px outer margins. Layout reserves space for wrapped headings and routes declared edges between nodes across container boundaries. Ancestor frames reflect current, visited, upcoming, and off-scenario membership without acquiring occurrence IDs. Full and compact views share containment; compact views show only visible nodes and their ancestor frames. The minimap includes container outlines. Headings render as inert text in both themes. Containers do not select or execute recorded steps.

Flow and state use left-to-right layouts with the same action/state boxes and filled arrowheads. Flow nodes may declare a role: action uses the standard box, decision uses a content-sized diamond, start/end use pill-shaped terminators, and subprocess uses a box with inset vertical borders. Database uses a cylinder; preparation uses a hexagon; inputOutput and outputInput use opposing parallelograms; priorityAction uses a bottom-wide trapezoid; manualOperation uses a top-wide trapezoid; document uses a wavy-bottom sheet; multiDocument uses stacked sheets; delay uses a D-shaped box. Omitted roles use the standard box. Roles are accepted only on flow nodes and remain descriptive; branches follow declared edges rather than executing decisions. Graph views and chart exports share shapes, traversal colors, and revisit badges. Connectors meet each shape's visible outer boundary, including curves and stacked sheets; labels and revisit badges stay inside their node with space reserved for sloped sides, cylinder rims, and document waves.

State initial markers render as filled circles; final markers render as a filled circle inside an outlined ring. Both occupy 32px square bounds with captions available through tooltips rather than text inside the symbols. Connectors meet the outer circular boundary. The minimap, selection, traversal emphasis, both themes, and chart exports share their geometry. Structured transition captions display each present event, bracketed guard, and slash-prefixed effect as a separate component, each wrapped into at most two lines. Layout reserves the entire caption height; tooltips expose the complete joined caption as inert text.

Flow subprocess nodes and sequence message nodes may reference another flow or sequence diagram through `detailDiagramId`. State diagrams cannot be link sources or targets. References resolve inside the same explanation and direct self-links fail validation. The input alias `subprocessDiagramId` reads as `detailDiagramId`; serialization and MCP schema use the canonical field. Specifying both spellings fails deserialization. Cross-diagram cycles are permitted because links are explicit navigation, never execution or automatic expansion.

Drill icons occupy a 20px box. Flow icons center horizontally below the node label, with vertical space reserved inside the node. Recorded-step navigator icons align vertically with their trigger text and stay anchored to the right. They follow the trigger's text color and overlay their surface without shifting headings or enlarging nodes. Sequence glyphs sit 8px after the rendered message text, with reserved horizontal space. They are muted until their message is selected or visited, then blue. The icon is a plain glyph with a target-title tooltip. Its parent owns keyboard focus and announces the target. Clicking the icon or pressing Enter on its focused node, message, or step opens the target's first scenario at its saved cursor in Diagram. Enter on the Diagram canvas, event region, or selected Diagram tab also opens the current linked step. Other controls retain their native Enter behavior. Clicking elsewhere or pressing Space retains step selection. Modified, composing, and repeated Enter events do not drill. A target with no recorded scenario has a muted, inactive icon. Navigation preserves the source cursor and pushes one browser history entry; Back restores the source occurrence. Details displays prose and recorded method calls.

The library selects an explanation. The header centers its title and a 20px left-arrow icon vertically, with an 8px gap between them. The title uses a 24px line height. The icon and title share one back button that opens the explanation library and has an accessible label and tooltip. The explanation title forms the page heading. Long titles truncate and expose the full title in a tooltip. The library view leaves the title area empty. The connection status reads Connected and has a 6px gap between its icon and text. Header actions use 12px gaps, reduced on narrow screens. The sidebar groups scenarios under their diagram. Diagram kind labels keep their full width and center their text. The carousel selects adjacent recorded occurrences by ID. Forward/back selects recorded occurrences. Main view has Details, Diagram, and Domain tabs in that order. Details pins a SCENARIO heading and agent-authored description above an independently scrolling step section on the same panel background. The overview occupies at most 40% of the panel and scrolls when long. A STEP heading introduces the narration with paragraph breaks. Scenario and step prose fill the available panel width within its padding. Recorded methodCalls appear in authored order with entity labels, signatures, and receiver IDs. Missing descriptions and blank narration show explicit notices. Live announcements apply only to the step prose. Diagram embeds the full selected diagram; Domain embeds the shared ERD. The selected tab persists across scenario navigation. Distinguish unchanged, changed, created, removed, uncaptured, and null values. Preserve cursors per scenario using occurrence IDs.

The data inspector sits beside every main view and starts open. Its visibility and selected Changes, Before, After, or Calls tab persist across main views and scenarios for the viewer session. N toggles it with a 150ms right-edge slide; reduced motion switches immediately. Comma and period select the previous and next inspector tab while open, stopping at boundaries. Apostrophe pages up and slash pages down by the active inspector tab's visible height, clamped to its scroll bounds. Paging preserves focus, the selected occurrence, and both tab selections. Data shortcuts share the viewer input guards; paging is inactive while the inspector is closed. Slash focuses search in the explanation library. The toolbar toggle stays available in focus mode. Closed content becomes inert immediately; closing from inside returns focus to the toggle. Desktop inspection reserves up to 420px or 45vw; viewports at most 1000px use a right-edge overlay capped at the workspace width.

Inspector data comes only from the selected occurrence. Changes lists affected instances and links; Show unchanged values includes the complete comparison. Before and After show the corresponding captured snapshot; Calls retains authored order and receiver IDs even without property differences. Entity heading chips count visible instances. Expandable array and object headings count items and fields, with nested values rendered as inert text. Activity chips count property differences, link changes, and recorded calls. ERD heading chips show previous · current · next object counts from each occurrence’s After snapshot within the selected scenario. The first step’s left count uses its Before snapshot; the last step’s right count uses its After snapshot. The chip’s left end is fully rounded at scenario start and its right end at scenario end; a single-step scenario rounds both ends. Tooltips name the initial and final snapshots. Empty snapshots show 0. Counts stay gray, with the current count bold. Changed counts roll upward over 220ms when moving forward and downward when moving backward, clipped inside the chip. Unchanged counts stay still; initial rendering, scenario switches, data refreshes at the same step, and reduced motion use immediate updates. Selecting an ERD property opens and focuses its inspector value without advancing the scenario or switching the main view.

The desktop header is 66px tall; narrow screens wrap the identity and actions. Main content and tab labels keep their viewport-adjusted insets. The tab bar's bottom border and the bottom controls' top border span the main panel's full width. Each tab panel scrolls within the available height. Sequence revisit badges have equal top and right insets inside their message row.

M toggles focus mode in the viewer, instantly hiding or restoring the sidebar, header, and event footer. A centered quiet breadcrumb shows the explanation, diagram, and scenario titles with slash separators; the scenario carries stronger emphasis. It fades in over 250ms on entering focus mode and disappears instantly on exit. Reduced motion shows it immediately. The breadcrumb has equal space above its text and below it to the recorded-step lens. Long titles truncate and expose their complete text in tooltips and accessible labels. Hidden chrome becomes inert immediately. The main panel fills the remaining viewport while the step navigator and tabs stay visible. Focus mode preserves the selected tab and occurrence, shares the viewer shortcut input guards, and ignores key repeats. Toggle focus mode appears in Quick actions. Focus moves to the selected tab when its control becomes hidden. Returning to the library restores the header.

The main panel begins with a responsive recorded-step navigator above the tabs. Rails at least 900px wide show three slots with the active occurrence centered. Rails below 900px show two slots following the latest travel direction: previous and current when moving backward, current and next when moving forward. Initial direction is forward. At scenario boundaries, the available neighbor fills the second slot. Resizing preserves direction. Rails below 480px show only the current occurrence. Every step heading shows a smaller, muted monospace position/total counter such as `1/4`, separated from its node label by spacing, beside a visited check, current solid dot, or upcoming hollow dot. Every step shows its trigger underneath as a bolt icon and value with centered vertical alignment. Each heading and trigger form a vertically centered group within its slot. Adjacent steps use muted text; a raised blue lens marks the active slot. Missing neighbors reserve an empty slot in the three-slot layout, including single-occurrence scenarios. Hidden neighbors stay outside keyboard navigation and the accessibility tree. Neighbor buttons select occurrence IDs, preserving revisit identity and the selected tab. Headings and their triggers slide together over 300ms, with separate rows keeping them apart throughout the motion. The lens stays stationary while the active slot is unchanged. Rapid navigation retargets the slide; reduced motion swaps immediately. Long labels clamp to two lines with full-text tooltips, and long triggers wrap within a bounded scroll area. Light and dark themes share the layout.

Diagram and Domain use transparent, borderless canvases at 1:1 with current-step focus on first use. Each fitting axis centers the scaled layout within the viewport without scroll overflow. Each overflowing axis reserves 20px screen-space gutters around the scaled layout. The viewer session remembers zoom, fit mode, and pan position independently for each explanation, diagram, scenario, and chart tab. Returning to a scenario or chart tab restores its saved framing without following the current step; fit mode refits the available viewport and other positions clamp to the current layout. Reload starts fresh canvas state.

Outside fit mode, graph views focus the current recorded step; sequence views focus its complete horizontal row; Domain focuses its related entity definitions. Automatic following prefers centering but hugs layout bounds with 20px screen-space padding to maximize visible content. Layouts that fit along an axis remain centered as a whole on that axis. Step changes animate to their target over 250ms with sine ease-in-out at the selected zoom. Animation timing starts at the first rendered frame. Canvas gutters support manual panning. Rapid navigation retargets the animation, manual interaction cancels it, and reduced motion uses immediate scrolling. Bottom-right controls zoom around the viewport center, fit the whole layout, and restore 100% while focusing the current step. Fit is an explicit mode: event navigation preserves its zoom and viewport. Its control is blue and pressed while fitted. The 1:1 control is blue and pressed at 100% outside fit mode. Zooming, restoring 100%, or manually scrolling or panning exits fit; following resumes on the next event navigation. In Diagram and Domain, = zooms in, - zooms out, and ; toggles between fit-to-screen and 100% with current-step focus. The toggle uses fit mode even when fitting produces 100% zoom and ignores key repeats. These actions appear in Quick actions and share the viewer shortcut input guards. A structured minimap shows the layout and visible bounds; dragging its viewport or the canvas background pans the main view. Minimap arrows pan and Home fits without changing the recorded occurrence. Node and entity selection remains available at every scale. Sequence sticky headings and occurrence centering use scaled coordinates.

Scenarios fill the sidebar's available height and scroll within it. The scrollbar sits at the right border and occupies the right padding. Content retains its width and horizontal position when a scrollbar appears. The Scenarios heading, diagram headings, and scenario labels scroll together in normal document flow. The sidebar begins with a muted uppercase monospace Scenarios heading. The active diagram and selected scenario retain full emphasis.

J/K select a scenario and reveal its label in Scenarios. Endpoint scenarios reveal the corresponding scroll boundary. H/L select recorded occurrences in the carousel while preserving the scenario list's scroll position.

The URL stores explanation, scenario, and occurrence IDs in query parameters. User navigation pushes browser history; initial defaults and revision normalization replace the current entry. Reload and Back/Forward restore the selected occurrence. Route restoration cancels superseded document loads. URLs and history state contain no captured values.

An accessible sun/moon toggle follows Quick actions in the header. Light mode is the default. Dark mode uses neutral black and gray surfaces, whitish text, and monochrome PrimeVue controls. Blue distinguishes graph traversal and selected recorded events. The browser stores an explicit light/dark preference under `lain-theme`; unavailable storage does not prevent switching. The root `app-dark` class controls both custom viewer colors and PrimeVue's dark theme, including teleported dialogs and structured SVG diagrams.

Ctrl+K opens searchable quick actions and focuses the search input. H/L select the previous/next event across all tabs. J/K select the next/previous scenario in displayed sidebar order across all tabs. [ and ] select the previous/next tab, stopping at tab boundaries. Tab switches preserve the selected occurrence and snapshots. The tablist supports Left/Right, Home, and End with roving focus; arrows in panels navigate recorded events and scenarios. Escape dismisses Quick actions and permits navigation during its closing animation. Navigation stops at list boundaries and preserves each scenario's cursor. Viewer shortcuts are inactive in editable controls, quick actions, selection overlays, and unrelated modals. The palette supports arrows, Enter, Escape, and mouse selection, shows each shortcut, and disables unavailable actions.

I/O traverse a dedicated drill-down history backward/forward. Only opening a linked chart records a visit, with source and destination scenario/occurrence IDs. Step changes, sidebar scenario selection, and browser Back/Forward do not add drill visits. Traversal restores the saved occurrence, opens Diagram, and focuses its tab. Each visit retains separate cursors when links cycle through the same chart. Leaving a visit saves its latest step when that scenario is still active. A new drill after going back discards forward visits. History is bounded at either end and clears on leaving the explanation, switching explanations, resetting cursors, or reloading the viewer. Live updates reconcile removed occurrences to surviving neighbors and discard visits whose scenarios were removed. Shortcuts share viewer input guards. Each fresh press acts immediately; holding either key acts on every second repeat event until the history boundary, at half the keyboard's repeat rate. Quick actions lists both with boundary-aware availability. Each traversal writes one browser history entry without invoking browser Back/Forward.

Left/Right arrows select the previous/next event; Down/Up arrows select the next/previous scenario. Arrow shortcuts share H/J/K/L's input guards, boundary checks, and centered scrolling. Quick actions displays both shortcut forms. Arrows retain their native editing and selection behavior in inputs, palettes, and selection overlays.

In the explanation viewer, Escape and Ctrl+[ blur the focused HTML or SVG element when no dialog or selection overlay owns the key. If focus is on the page body, either shortcut opens the explanation library. Blurring clears its focus outline while preserving the selected occurrence and tab. In the library, either shortcut returns focus to the selected card from search, header controls, cards, or the page body. Pressing either shortcut on a card also clears search and keeps that card focused in the full list. Dismissing Quick actions in the library returns focus to the selected card. With no matching cards, the shortcut blurs the current control. Ctrl+C in the library search clears it while preserving input focus; modified or composing input retains native behavior. Repeated keydown events do not dismiss additional layers. Keyboard navigation retains visible focus indicators.

The explanation library keeps a compact introduction, search, and count fixed above a full-width card scroll region. Its scrollbar sits at the viewport's right edge; content is centered and capped at 1250px. The browser session retains the search text, selected card ID, and card scroll position across explanation visits, failed document loads, and browser history navigation. Returning restores the selected card's focus without scrolling it into view; missing cards fall back to the first result and scroll positions clamp to the available content. The first visit focuses the first card when no other control owns focus. Cards and search indicate focus with a single blue border. H/L and Left/Right move in list order, wrapping between rows and stopping at the first and last cards. J/K and Down/Up move between rendered rows; Down selects the last available card if the next row is incomplete. Vertical navigation stops at the first and last rows. Enter opens the focused card. The introduction uses the available content width. Search sits between the introduction and cards, filtering titles and descriptions by a case-insensitive literal substring and highlighting every match as text. The count shows the total when search is empty and the number found while searching. / focuses search outside editable controls and overlays. Down or Enter in search focuses the first result. Filtering preserves search focus. The no-match message has a borderless background at 20% of the theme's soft surface color.

Each library card has a separate, keyboard-accessible delete action. Delete all beside the count covers the whole library, including search-hidden cards, captured when confirmation opens. A modal names the target and explains the eight-second notification Undo window; Cancel receives initial focus. Confirmation reads each complete document, then sends a bodyless deletion once with its revision in If-Match. Pending deletion disables dismissal. Success removes the card without waiting for WebSocket delivery and restores focus to a surviving card. Failures refresh the library, show an error, and require closing the dialog and reviewing the current card before a fresh confirmation. Delayed deletion responses cannot hide newer publications of the same ID.

Deletion notifications retain successful deletions' documents in browser memory for eight seconds. Undo republishes each document under its original ID with the deletion revision in If-Match, so newer publications or deletion cycles cannot be overwritten. Bulk Undo covers only successfully deleted targets. Undo accepts one click, reports partial restoration on failure, refreshes the library, and never automatically retries publication. Notification expiry or dismissal releases its backups; reload discards them. Notifications persist across explanation navigation.

Capital G selects the last recorded event in the active scenario. Two lowercase g presses within one second select its first event. Unrelated keys, modifiers, composition, and repeats reset the pending sequence. Endpoint shortcuts share H/L's input guards and centered scrolling. First event and Last event appear in Quick actions with their shortcuts and boundary-aware availability.

In Diagram and Domain, a Shift+H/J/K/L tap pans the viewport left/down/up/right by 187.5 screen pixels over 150ms with cubic ease-out. Holding a key continues scrolling on animation frames independently of keyboard-repeat timing, then eases to a stop on release. Releasing Shift also stops the hold; losing focus, opening Quick actions, and focusing an editable control cancel it. Reduced motion uses an immediate tap and steady scrolling while held. Panning preserves the selected occurrence and zoom, cancels step-following motion, and shares the viewer shortcut input guards. Pan actions appear in Quick actions.

In Details, Shift+H resets every scenario cursor in the current explanation to its first occurrence, selects the first scenario in displayed sidebar order, and opens the Details tab. Reset explanation appears in Quick actions across all tabs; its shortcut is shown only where it resets. Reset shares the viewer shortcut input guards, ignores key repeats, centers the selected event, and records the resulting selection as one browser history entry.

Y then S copies the explanation path through the current scenario; Y then D copies it through the diagram; Y then P copies it through the current event, including occurrence position. Paths include the explanation title and use ` → ` separators. These actions appear in the palette's Clipboard group and work across tabs while a scenario is selected. Yank sequences expire after one second and reset on unrelated keys. Editable controls, modified keys, composition, and repeats preserve normal input. PrimeVue toasts at the top right confirm successful clipboard writes or report clipboard failures.

The full diagram distinguishes muted off-scenario elements, upcoming scenario elements, and blue visited elements. Recorded incoming edge IDs determine scenario membership. Nodes recorded more than once in the selected scenario show a badge from their first visit, counted only through the current occurrence. Graph edge labels wrap at roughly 20 characters into at most two centered lines; overflow ends with an ellipsis, and tooltips expose the complete label. Layout reserves the displayed label's width and height. Edge labels show traversal counts above one on their final line. Single-visit nodes remain unbadged. Badge numerals are centered. Graph badges follow the rendered label's upper-right corner for every shape: the circle's left edge sits four pixels after the text, and its center sits two pixels above the text's top. Wrapped labels use their complete text bounds. Self-loops leave and return beneath their node with smooth turns and separate captions. Swimlane connectors follow short, obstacle-clear orthogonal routes with captions beside chosen segments. Diagram node clicks navigate to recorded occurrences; repeated visits display an occurrence picker. Off-path nodes stay inspectable but cannot mutate a scenario. Structured SVG uses text rendering and controlled attributes. No agent-authored HTML, URLs, SVG, or scripts enter the chart DOM.

The domain ERD shows entity tables with a type heading and separate property rows; property IDs occupy the right column. Each orthogonal connector endpoint specifies both bounds: `zeroOrOne` (0..1), `exactlyOne` (1..1), `zeroOrMore` (0..*), or `oneOrMore` (1..*). A circle or bar indicates the minimum; a separate bar or crow's foot indicates the maximum. Optional circles mask the connector beneath them in both themes. Stored maximum-only `one` and `many` endpoints read as `zeroOrOne` and `zeroOrMore`, preserving their constraints. Publications require explicit bounds and snapshots satisfy both minimum and maximum link counts for present instances. Property data types are unspecified. The full shared domain determines layout, so changing scenarios preserves entity positions. Relevance spans the entire selected scenario: visited node entity references and all before/after instances identify used types, while captured links identify recorded relationships. Unused types and unrecorded relationships are muted. Every type remains keyboard-inspectable in both themes.

The Domain view correlates its shared definitions with the selected occurrence. Property differences use only that visit’s before and after snapshots, including created/removed instances and uncaptured/null distinctions. Rows aggregate all affected instances; tooltips expose each receiver’s values. Recorded methods have a call marker and call count in their tooltip, including calls with unchanged snapshots. The shared data inspector lists values and receivers and can focus an affected entity. Active entities receive a blue outline and automatic following centers affected definitions. Full-domain layout remains stable across steps. Blue marks property differences and calls; green marks creation; red marks removal. Calls contribute to scenario-wide relevance even without snapshots or node references.

Domain headings begin with a plain shortcut number and a thin vertical divider. Numbers start at 1 and follow containment: finish every entity and nested block in one group before moving to the next group. At each level, order blocks and direct entities left to right, then top to bottom. Ungrouped entities follow the same spatial ordering. ERD containers reserve 24px body insets and wrap headings to their available width. Vertically stacked root frames have 42px between their outlines; nested sibling frames have 56px. Normalize finished-frame gaps from the innermost groups outward, moving entities and connector routes together. Horizontal coordinates and entity dimensions stay fixed. Digit shortcuts select, keyboard-focus, and center the entity at the current zoom, exiting fit mode. A prefix that also matches longer numbers underlines its matched digits across every matching heading for 500ms. Enter confirms the exact number immediately; another digit extends the prefix; timeout confirms the exact number. Unique complete numbers select immediately. Invalid prefixes and unrelated input cancel without selection. Viewer shortcut guards apply, and pending prefixes cancel on scenario or event changes, tab departure, editable or overlay focus, Quick actions, and window blur.

Full sequence views render one diagram-owned layout with participant headers, lifelines, directed messages, and nested alt/opt/loop frames. Participant and message labels wrap into at most two lines; overflow ends with an ellipsis on the second line, and tooltips expose the complete text. Message rows reserve space for both lines in full and compact views. Switching scenarios preserves geometry; operand shading identifies the recorded branch. Current and visited messages are blue, upcoming messages remain distinct, and other paths are muted but inspectable. Revisited messages occupy one shared row with prefix visit counts and an occurrence picker for separate snapshots. Sequence and graph views share the same tab controls and keyboard navigation.

Participant boxes prepend a controlled decorative person or monitor icon for their human/system kind. Labels reserve space for the icon; accessible names and tooltips expose the kind. Lifelines use consistent dashes. Calls use solid lines and filled arrowheads; asynchronous sends use solid lines and open arrowheads; replies use dashed lines and open arrowheads, including self-messages. Scenario relevance changes color and opacity only, preserving semantic line styles on messages and fragment borders. Operand separators retain their dashes. Full/compact views and chart exports share this notation in both themes.

Sequence participant headers stay pinned during vertical scrolling and aligned with their lifelines during horizontal scrolling. Fragment and operand headings stick within their declared parent containers. At a container's bottom edge, the heading slides beneath its parent's heading and remains clipped until its final visible pixel leaves the parent. Root fragments use the participant bar as their sticky boundary. Sibling headings stick only when their own frame reaches that boundary. Pinned originals are hidden in the scrolling layer.

The bounded context stack retains outer headings and the innermost heading on narrow viewports; tooltips expose its complete nesting path. Pinned headings retain their typography, colors, fragment tabs, and horizontal frame boundaries. Nested heading surfaces leave ancestor borders visible. Fragment titles and guards share a centered vertical alignment.

Sequence occurrence navigation focuses the complete selected row in the usable scroll area below sticky participant and fragment headings over 250ms. Horizontal focus uses the row's midpoint. Automatic targets hug layout bounds while keeping the selected row visible. Fit mode preserves the viewport during occurrence navigation. Rapid navigation retargets the animation; manual scrolling cancels it. Reduced-motion preferences use immediate scrolling. Compact sequence views keep their containing panels stationary.

WebSocket messages invalidate data. Connect the socket before loading documents; reconnect with bounded backoff and refetch. Automatically fetch newer active explanations and apply the document with reconciled selection in one render. Keep revision counters internal; show update status and retry actions in the GUI. Preserve scenario and occurrence IDs, the active tab, and surviving inspectors. A removed occurrence selects the nearest surviving neighbor in the old recording, preferring the preceding neighbor on a tie; if none survive, select the first new occurrence. A removed scenario selects the first available scenario. Close inspectors for removed entities or nodes and discard invalid occurrence-picker selections. Normalize the URL with replacement rather than adding history entries. Show an Explanation updated toast, with an explanation when the selected scenario or step was removed. Failed updates retain the current view and expose a retry. Coalesce invalidations during fetches, reject stale responses, and cancel reads when navigating away or disconnecting. Layout changes preserve zoom and clamp the viewport; fit mode refits the new bounds. Deletion returns an affected view to the library and cancels outstanding loads for that ID. Display connection, loading, empty, and failure states.

## Installation and commands

`lain serve` runs foreground. `lain` checks the existing service and opens its local URL with `xdg-open`; if unavailable, print an actionable setup/serve instruction. `lain open --print-url` prints the configured local URL for manual browser use. `lain setup` creates an idempotent systemd user service with an absolute executable path and explicit home/port, enables/starts it, and checks readiness and service state. Successful setup saves the selected port for later client commands. `lain setup --dry-run` prints the unit and client settings without installing a unit. `lain status` checks daemon readiness. `lain demo` publishes the bundled example through the local HTTP API.

Global `--home` or `LAIN_HOME` selects isolated runtime state; default `$XDG_DATA_HOME/lain` (or `~/.local/share/lain`). `--port` overrides the saved port; default 38475. Home mode 0700 and config file mode 0600. Database lives at `home/lain.sqlite`. Do not overwrite unrelated files or silently repair unsafe symlinks. A service unit uses `Restart=on-failure`, `WantedBy=default.target`, and runs unprivileged. Start at login; explain `loginctl enable-linger` for pre-login boot without invoking sudo. Do not alter agent client configs automatically.

The daemon holds an exclusive OS file lock under its runtime home for its lifetime. A second daemon using the same home fails even when it selects another port. This keeps publication notifications under one process owner. Do not delete or replace the lock file while a daemon runs; the OS releases the lock when the process exits.

`scripts/build.sh` builds frontend then release executable. `scripts/install.sh` installs the built executable to a user bin directory and prints the setup command. No service installation happens during a build or test. No commits or external configuration changes are part of implementation.

The release workflow checks `main` and publishes stable `vX.Y.Z` tags matching the package version. cargo-dist 0.32.0 packages `x86_64-unknown-linux-gnu` on Ubuntu 24.04 with the embedded frontend, a SHA-256 checksum, and a shell installer targeting `~/.local/bin`. The packaged executable is smoke-tested with isolated state before publication. `scripts/prepare_installer.py` adds automatic first-install setup and restarts an existing managed user service whose executable matches the installation. Upgrades preserve its home, port, and unit settings. Unsafe or mismatched units and failed setup/restarts fail installation. An unavailable user service manager warns and leaves manual instructions. `LAIN_NO_SETUP=1` skips service management. Installer tests use fake commands and isolated paths; they never change a real user service.

`npm start` runs Watchexec around a persistent Node development supervisor. Watchexec watches Rust sources, Cargo manifests/lockfile, and embedded authoring guidance; it sends `SIGUSR2` on changes. The supervisor installs frontend dependencies, builds frontend assets, compiles Rust, and starts the daemon alongside Vite. It uses `.lain-dev` for local state, backend/MCP port 38475, and browser port 5173. It checks port ownership, waits for readiness, seeds an empty library, and opens the local Vite URL.

Rebuilds are serialized and coalesce pending changes. Build frontend assets before Rust; retain the running backend if either the frontend build or Rust compilation fails. After success, stop only the owned backend group, recheck its port, start the replacement, and verify readiness. Vite stays live. Restarted backends preserve SQLite state. Browsers reconnect with bounded backoff, resynchronize the library, and restore the current route. Unexpected server exits or replacement failures stop the owned stack. Shutdown cleans up owned process groups, never existing listeners or installed services. Generated output and development state do not trigger rebuilds. The installed runtime remains one Rust executable.

## Verification

Integration tests cover valid publication, failed reference validation, branch continuity, revisits, durable reopen, concurrent last-write-wins publications, recreation with monotonic revisions, deletion by ID, Host/Origin isolation, real MCP initialize/list/call, and WebSocket notifications. Frontend checks cover cursor selection and snapshot semantics where risk warrants a test. Typecheck, frontend production build, cargo test, formatting, and clippy must pass. Smoke-test the embedded frontend; use isolated runtime directories.
