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
| `runtime.rs`, `runtime/` | Local paths, private-state permissions, configuration, native per-user startup |
| `main.rs` | CLI and daemon lifetime |
| `frontend/src/` | Vue, PrimeVue, navigation, safe structured SVG |

Use Axum 0.8, Tokio, SQLx 0.9 SQLite, rmcp 0.12, serde/schemars, Vue 3, TypeScript, Vite, and MIT PrimeVue 4. SQLx isolates SQLite work from async handlers. Rust embeds `frontend/dist`; the installed executable needs neither Node nor a database daemon. A frontend build must precede a Rust build. Use Dagre for Diagram/Domain layout and locally bundled ELK Layered for Wiring; authored labels render as text, never HTML or executable diagram syntax.

## Document contract

All JSON field names are camelCase. Arrays preserve authored order. Unknown fields are rejected. Definitions use stable string IDs. Server metadata is outside the authored document.

```ts
type Explanation = {
  schemaVersion: 1;
  title: string;
  description: string;
  overview?: string;
  topics?: { id: string; title: string; description?: string; scenarioIds: string[] }[];
  comparisons?: {
    id: string; title: string; description?: string;
    leftScenarioId: string; rightScenarioId: string;
  }[];
  links?: { label: string; url: string }[];
  wiring?: Wiring;
  domain?: {
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
    labels?: string[];
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
      wiringRefs?: WiringRelevance;
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

Domain is optional in schema version 1 independently of Wiring. Omission hides the Domain tab and preserves the omitted field through storage. A present domain requires `entities` and `relationships`; empty collections still expose Domain. Node entity IDs, snapshot instances/links, and method calls resolve against domain definitions, so domain-free documents use empty snapshots and no domain references. Domain export requires a present domain and otherwise returns 404. Live domain removal falls back to Diagram only when Domain is selected; the recorded cursor and Wiring state remain intact.

Scenario `description` is an agent-authored plain-text overview of the actor, setup, goal, and recorded outcome or stopping point. Occurrence `narration` explains that visit's action, cause, and consequence as paragraphs separated by blank lines. Optional occurrence `changeSummary` describes meaningful captured before/after changes, distinguishing state changes from capture differences. Description and changeSummary default to empty strings and are omitted on serialization when empty; schema-version-1 documents remain valid. Both share the 32 KiB text limit. Prose is rendered as inert text, never generated from snapshots. Authors label assumptions and synthetic examples explicitly.

Optional explanation `overview` provides a plain-text purpose, scope, and reading map. Ordered `topics` group scenarios by reader question independently of diagram ownership: each has a stable ID, nonblank title, optional description, and 1–100 ordered existing `scenarioIds`. Topic IDs are unique; a scenario has at most one membership, including within one topic. Allow at most 50 topics. Ungrouped scenarios follow under Other scenarios; omitted topics retain diagram grouping. Scenario `labels` holds at most eight unique nonblank plain-text IDs or short terms of 1–64 Unicode characters. Authors use 1–20 characters per label. The sidebar renders them as small outlined chips beneath the title inside each scenario row, with a subtle blue outline and text on selection. Labels are authored descriptions, not inferred outcomes.

Ordered explanation `comparisons` holds at most 100 pairs with unique stable IDs, nonblank titles, optional descriptions, and distinct existing `leftScenarioId`/`rightScenarioId` references. Pairs may cross diagrams or topics. Comparisons show authored contrasts and scenario summaries; they imply no aligned steps, execution, or automatic state comparison. Overview, topic titles/descriptions, and comparison titles/descriptions share the 32 KiB text limit. Omitted/empty overview, topics, comparisons, and labels serialize without those fields and preserve schema-version-1 compatibility. `AppService` validates all references and bounds before publication.

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

## Wiring model and participation

`src/wiring.rs` owns shared interface definitions and validation. `frontend/src/wiring.ts` resolves recorded relevance; `wiring-layout.ts` sizes and routes the complete map independently of scenario selection. Wiring describes owned interfaces and their individual connections; Diagram describes behavior; Domain describes business data.

```ts
type WiringStatus = 'existing' | 'missing' | 'changed';
type WiringOperationKind = 'http' | 'rpc' | 'query' | 'command' | 'publish' | 'consume'
  | 'upload' | 'read' | 'write' | 'webhook' | 'telemetry' | 'other';
type WiringField = {
  id: string; path: string; type: string;
  section: 'path' | 'query' | 'header' | 'request' | 'response' | 'error'
    | 'message' | 'record' | 'resource' | 'telemetry';
  required?: boolean; nullable?: boolean; status?: WiringStatus;
  example?: unknown; description?: string;
};
type WiringReturn = { status?: number; type: string; fields?: WiringField[] };
type WiringOperation = {
  id: string; label: string; description?: string;
  http?: { method: string; path: string };
  kind?: WiringOperationKind; status?: WiringStatus;
  statement?: string; requestType?: string; fields?: WiringField[]; returns?: WiringReturn[]; responses?: string; decisions?: string[];
};
type WiringConnectionEnd = { componentId: string; operationId?: string; screenId?: string };
type Wiring = {
  components: {
    id: string; label: string;
    kind: 'uiApp' | 'uiComponent' | 'service' | 'database' | 'queue' | 'topic' | 'stream'
      | 'eventBus' | 'bucket' | 'cache' | 'gateway' | 'identity' | 'observability'
      | 'function' | 'worker' | 'externalSystem' | 'other';
    description?: string; status?: WiringStatus;
    technology?: { name: string; provider?: string; icon?: string };
    operations?: WiringOperation[];
    screens?: { id: string; label: string; description?: string; route?: string }[];
    referenceIds?: string[];
  }[];
  connections: {
    id: string; label: string; description?: string;
    source: WiringConnectionEnd; target: WiringConnectionEnd;
    kind?: WiringOperationKind; status?: WiringStatus; requestType?: string; fields?: WiringField[]; returns?: WiringReturn[];
    protocol?: string; referenceIds?: string[];
  }[];
  groups?: { id: string; label: string; componentIds: string[]; parentGroupId?: string }[];
  references?: { id: string; key: string; url?: string; description: string }[];
};
type WiringRelevance = {
  componentIds?: string[]; connectionIds?: string[];
  operationRefs?: { componentId: string; operationId: string }[];
  screenRefs?: { componentId: string; screenId: string }[];
};
```

Wiring is optional independently of Domain. A present wiring requires `components` and `connections`; both may be empty to expose an empty Wiring tab. Connections and groups require components. Allow 200 components, 500 connections, 100 groups, 100 reference definitions, 200 operations and 200 screens per component, 50 reference attachments per element, and 500 explicit relevance entries per occurrence. Stable IDs are collection-unique; operation/screen IDs are owner-local. Group IDs differ from component IDs because layout keys share a namespace. Work keys are unique inert labels. Resolve references and reject duplicate entries. Labels, work keys, and present protocol/technology names are nonblank. HTTP methods are nonblank tokens; paths begin with `/`. Screens belong to `uiApp` or `uiComponent` owners. Routes, statements, and endpoint text remain descriptive, never destinations or executable requests.

Each labelled, directed connection describes one endpoint, query, write, publish, consume, or telemetry operation. Parallel connections and self-connections have distinct IDs. Owner cards collect a controller's or interface owner's operations. Rows display HTTP method/paths; wire captions display authored call labels. Row and caption text blocks center vertically with their metadata, including wrapped lines. Current-step caption boxes highlight blue with their edges. Hovering rows and edge captions highlights their text and backgrounds blue; leaving restores playback styling. Hovered connections retain full contrast with matching blue lines and arrowheads. An endpoint may name an owner-local operation or screen, but never both. Render all operations and screens as inspectable rows; show port circles only on sides with attached wires. Current-step ports fill blue; other ports have opaque surface-colored interiors. Circle interiors mask underlying card borders and wires in every playback state. Wire endpoints and arrow tips meet the circles' outer rims. Screen wires use the right side. A qualified endpoint attaches to its exact row; a component-only endpoint attaches to its owner card without a port circle. Groups use the existing one-direct-membership, acyclic-parent, eight-level, nonempty-descendant rules. Work URLs follow explanation-link validation and safe-anchor rules.

Wiring layout runs in a local worker with a fixed seed. ELK places owners, measured captions, and orthogonal wire routes together using fixed row-center ports and earliest left-to-right layers. Distinct calls use independent layout ports at their shared row dot. Self-calls use one continuous outside route. Groups reserve their own heading and padding space. The view waits for the first layout before fitting and discards results from superseded definitions; exports await the same layout. Scenario selection and playback supply emphasis only.

Operation and connection contracts allow 200 fields each; operation decisions allow 30 plain-text entries. Field IDs are unique within each contract. Each `(section, path)` pair is unique within that contract; request and response may share a path. Paths and type text are nonblank. `required` and `nullable` independently default to false. Types are descriptive text, not executable schemas or Domain references. Examples preserve captured JSON null and obey the document's byte, depth, text, and number limits; they are inert contract examples, not runtime snapshots. Component, operation, and field status defaults to `existing` and serializes absent at that default; `missing` and `changed` mark authored work or contract gaps. Operation kind defaults to `other`. A wire inherits the named target operation's fields, status, and kind, falling back to the source operation only when no target operation is named. Explicit wire values override inheritance and survive serialization, including `fields: []`, `status: existing`, and `kind: other`. Other empty optional strings and collections serialize absent. Status never proves runtime availability or computes a scenario difference.

Technology/provider names are free text, including unknown providers. Optional `technology.icon` selects an inert identifier from bundled assets; an unknown identifier uses the component-kind fallback. The viewer infers a bundled icon from known technology/provider names when no explicit icon is supplied. Authored URLs, SVG, HTML, or image content never load as icons. Queue, topic, stream, and event bus describe different channel roles; vendor metadata and groups imply neither delivery guarantees nor IAM/network boundaries.

Occurrence `wiringRefs` is the sole authored mapping. A connection includes its endpoint owners and named operation/screen ports. Direct operation/screen references include their owners. Components emphasize ancestor groups. Closure never activates adjacent connections, sibling interfaces, domain entities, or detail diagrams. Scenario scope is the union of resolved occurrence scopes. Omitted mapping means participation is unrecorded; present `{}` means the step maps no Wiring elements. A present empty mapping survives serialization. Revisited diagram nodes keep independent mappings on their occurrence IDs. Schema version remains 1; publication accepts canonical `wiring` and `wiringRefs` only. Storage reads normalize prototype field names in memory before deserialization while preserving SQLite values and unrelated fields.

Wiring appears after Diagram and the optional Domain tab and starts fitted to the complete shared map. Its single camera identity is explanation-wide. Playback and scenario changes retain geometry while panning and zooming to the selected step's mapped cards and complete connection paths with 20px screen-space padding. Empty or unrecorded mappings retain the last framing. Scenario members render at normal contrast; current-step cards, rows, and wires highlight blue; elements outside the scenario's mapped scope are dimmed. Connection kind colors identify caption metadata independently of playback. Current-step emphasis takes precedence over earlier, then later recorded positions; rewinding recomputes it. Unmapped steps clear current emphasis. A target icon labeled **Fit current step** beside Fit frames the selected step and is disabled for empty scopes. The semicolon shortcut toggles whole-map fit and current-step fit. Inspection preserves the recorded cursor. Explicit occurrence links open Diagram. Wiring details stay separate from snapshot inspection. A sitemap-icon **Show wiring** / **Hide wiring** toggle sits to the right of **Show data** while Wiring is selected. W toggles the panel, ignores repeats, and shares the viewer shortcut guards; narrow screens allow one details/data sheet at a time and retain hidden selections. Closing restores focus to the inspected item or toggle. Live updates reconcile stable IDs and discard Wiring-only state when wiring disappears. Wiring exports include interface definitions and optional scenario relevance while excluding snapshots, occurrence prose, playback markers, and inspection. Diagram/Domain projections omit Wiring mappings while stored documents retain them. Each work item is a scenario identified by a work-key label such as `CART-DEMO-101`. The schema retains reference metadata for stored documents; the viewer presents work identity through scenario labels. Current/Proposed labels describe authored scenarios; Wiring presents one shared inventory without side-by-side versions or lineage.

**Only current step** is an off-by-default Wiring toggle beside Fit. It filters cards, connections, ancestor groups, and the minimap to the selected occurrence's explicit mapping. Visible cards retain every row and port circle. Toggling preserves layout coordinates, zoom, and pan; playback and scenario changes follow the current step. Omitted mappings show the full map; explicit empty mappings show no map elements. The toggle persists across tabs and scenarios within the explanation.

Operations and connections allow up to 20 ordered `returns`. Each return has a nonblank descriptive `type`, an optional HTTP `status` from 100–599, and up to 200 fields scoped to that response. Statuses are unique within a return collection; statusless types are unique within that collection. HTTP statuses require HTTP metadata or kind on the operation or connection. Each response validates its own field IDs and section/path pairs. Omitted return fields mean an unknown schema; `fields: []` declares an empty field list; `type: void` explicitly declares a bodyless response and permits no fields. Return examples follow all document limits. Connection `returns` replaces the inherited collection, including `[]`. An explicit connection `fields` contract without `returns` leaves response definitions unrecorded for that connection.

Operation and connection `requestType` names the request DTO, command, or incoming message as nonblank descriptive text within the 32 KiB text limit. Omission means the request type is unknown independently of field coverage. A connection inherits the operation's request type only when it inherits its fields; an explicit `requestType` overrides the name independently. The field remains optional in schema version 1. Authoring guidance requires known request/return types and fields within scope, while retaining genuinely unknown contracts and labeling synthetic assumptions.

The Wiring sidepanel provides searchable Components and Connections lists plus Groups. Component details list owned operations/screens, attached connections, and recorded Visits. Connections and operations provide Overview, Schema, and Visits tabs. Overview links owners and exact connected interfaces. Schema groups path, query, headers, and body/incoming fields under one collapsed request group showing the request type or an unknown notice, followed by independently collapsed response schemas. Flat response/error fields appear as unscoped schemas without inferred statuses. Field details expand inline and render authored examples as inert text. Local tab arrows, Home, and End select inspector tabs without moving the recorded cursor. Visits group occurrence-ID links by scenario, preserving revisits. Schema inspection stays inside the sidepanel.

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
| `GET /api/explanations/{id}/wiring/export` | Wiring bytes; same options, optional `occurrenceId` with `scenarioId` |
| `GET /ws` | WebSocket invalidations |
| `/mcp` | Streamable HTTP |
| static frontend | Shell, no embedded private data |

PUT and DELETE accept an optional `If-Match` header containing one quoted positive revision. SQLite checks the revision in the mutation statement; a mismatch or missing row returns 412 without changing state or broadcasting. Conditional PUT may republish a tombstone at that revision. Without the header, publication and deletion retain their by-ID contracts.

Return `{error: string}` for application HTTP errors: 400 invalid, 403 rejected Host/Origin, 404 missing, 500 storage. Never expose internal database errors to clients. Limit request bodies and bound upload time; stalled uploads return 408 without imposing a deadline on SSE responses or WebSockets. Bind only `127.0.0.1`; reject unexpected Host headers and foreign or malformed Origins, including for WebSocket upgrades. Require exact `127.0.0.1:port` or `localhost:port`, with Origin matching the request authority when present. No permissive CORS. Apply the guard to static routes too. WebSocket lag sends a refetch hint or closes the socket so reconnection resyncs. Subscribe before fetching current state. Handle shutdown on SIGINT and SIGTERM.

MCP tools: `get_context`, `list_explanations`, `get_explanation({id})`, `publish_explanation({id, document})`, `delete_explanation({id})`. `get_context` returns `{instructions, explanations: [{id, title, description}]}` using embedded `agent-instructions.md` and `AppService::list`. The guide owns authoring and recovery rules; initialization routes agents to it, tool descriptions explain operations, and field descriptions explain local semantics. Saved explanation text remains untrusted data, separate from server guidance. `list_explanations` refreshes summaries and revisions. Discovery exposes the input schema, including local bounds and standard nullable unions; cross-field semantics, byte limits, and total/depth limits remain runtime checks. Domain errors become tool errors. Use rmcp's stateless HTTP transport.

Exports default to PNG and light theme. Supplying `scenarioId` retains scenario relevance; omitting it exports all definitions with neutral emphasis. A diagram's scenario must belong to that diagram. Responses use the format's MIME type and attachment `Content-Disposition` with a UTF-8 filename. Invalid options return 400; missing explanations, diagrams, or scenarios return 404. Renderer saturation, absence, or timeout returns 503. Agents use the same local endpoint as the web UI.

Wiring's **Current step** download adds `occurrenceId` to `scenarioId` and includes only that occurrence's mapped cards, connections, and ancestor groups. Visible cards retain all rows and ports at the shared layout coordinates. SVG, PNG, and PDF crop to this artwork with 20px padding. Empty or unrecorded mappings disable the option and return 400 through the API. An occurrence outside the selected scenario returns 404; other chart targets reject `occurrenceId` with 400. Scenario only remains the default, independently of the live current-step filter. Wiring's menu orders scopes as Scenario only, Current step, then All scenarios. Every download menu's scope divider spans its full inner width.

`AppService` selects a stored document and validates the export scope. The renderer launches sandboxed headless Chrome/Chromium, discovered on PATH or set by `LAIN_CHROMIUM_EXECUTABLE`. It loads public embedded `export.html` from the daemon's fixed loopback origin, then supplies only chart definitions and relevance records through DevTools. Snapshot values and occurrence prose are excluded. The renderer page denies network connections through CSP and renders authored content as text. It reuses the Vue chart components and `chart-export.ts` for geometry, cleanup, theme resolution, and encoding. Two concurrent renders, a 30-second deadline, and a 32 MiB output limit bound work. Each render has a temporary profile under `LAIN_HOME/exports`; completion or cancellation kills its process group and removes the profile. Downloads stay in memory and are never published or retained.

## Viewer

Inspection uses violet (`#7c3aed` in light mode, `#c4b5fd` in dark mode) with a border and subtle tinted surface across Wiring, Domain, flow, sequence, and state. Selection remains visible outside the scenario and after keyboard focus moves. Inspection preserves border dash patterns. Blue denotes recorded playback independently of inspection; an inspected current item retains its blue fill, ports, arrows, or activity markers alongside the violet border. Inspected Wiring connections use violet for their entire line, arrowhead, and caption, overriding playback and hover blue. Domain selection uses violet for its outer and entity borders, including hover and keyboard focus; data-status colors remain visible. Exports omit inspection styling.

Selecting a Wiring connection dims the surrounding map while retaining full contrast for visible endpoint owners and the selected caption. An owner gets a matching card preview only when its entire card and connection port are outside the viewport. A partially visible card or visible connector retains the original owner. Previews sit directly on the visible portion of that connection's existing route. The preview port meets the wire at the connected interface row. Preview cards have a fixed width of 280 screen pixels and appear only where their full size fits inside the viewport without overlapping the caption or endpoint owners. The overlay uses chart coordinates within the scrollable viewport so selection preserves the wire's route and rounded bends. Helpers trim only the route beyond their ports, with a violet arrowhead terminating at the target preview's port. The caption keeps its original position and appears once. Previews show the owner's bundled icon, kind, technology, and exact connected interface rows as inert text. Self-connections share one owner preview with their connected rows. Two visible owners retain the original line and caption without extra cards. Activating a preview smoothly pans to and focuses the owner at the current zoom while preserving the inspected connection and recorded cursor. Reduced-motion preferences use an immediate pan. Panning, zooming, resizing, and current-step filtering reconcile the previews with the visible map. Exports contain the complete original connections and omit navigation previews and dimming.

Clicking a chart's background clears node, entity, interface, or connection inspection without changing the recorded cursor. Panning, pinching, zoom controls, and clicks inside nodes preserve selection.

Every explanation opens at Explanation overview unless a direct scenario route selects a recorded visit. The overview presents the authored purpose, comparison pairs as adjacent scenario summary cards, and ordered topic sections with scenario counts, labels, descriptions, diagram titles, and step counts. Cards open the scenario at its saved cursor. Comparisons stack on narrow screens. Authored text remains inert in both themes.

Overview search matches scenario titles, descriptions, labels, diagram titles, topic titles/descriptions, and comparison titles/descriptions as case-insensitive literal substrings. Matching comparisons retain both partners for context. The count below search shows topic or diagram-group totals, scenario totals, and comparison totals when search is empty; active search shows the number of matching scenarios. Scenario counts count unique matches rather than repeated cards. Highlights render as inert text; empty results show a notice without filtering the sidebar. The browser session retains the query per explanation across scenario visits. Slash focuses search outside editable controls and overlays; Down or Enter in search focuses the first result, and Ctrl+C clears search while preserving focus.

The Overview sidebar item uses the sidebar surface without an outlined dark box and has 10px vertical padding. Hovering or keyboard-focusing a scenario shows its title, description, badges, diagram kind/title, and step count in a popover to the right. D toggles the selected scenario's preview and shares the viewer shortcut input guards. A D-opened preview stays open through J/K and Down/Up scenario navigation, updating its content and anchor. Sidebar scrolling repositions it; hover-only previews dismiss on navigation or scrolling. In focus mode, D centers the preview in the viewport. Narrow screens place anchored previews below their scenario and keep them inside the viewport. A preview never selects a scenario or advances its cursor. Moving onto it preserves it; leaving closes after a short delay. Clicking outside or pressing Escape dismisses it while retaining navigation. Viewport resizing, explicit scenario opening, Overview entry, toggling focus mode, and opening another dialog dismiss it. Preview text is inert.

The sidebar provides Overview followed by topic groups and scenario badges; documents without topics use diagram groups. Overview comparison cards open their recorded scenarios while preserving each scenario's cursor and the selected chart tab. J/K scenario navigation follows the displayed topic order, then ungrouped scenarios. Overview hides and makes recorded-step content inert while retaining the selected view, inspector visibility/tab, and canvas session state. Recorded-step shortcuts are inactive there. Opening Overview exits focus mode. Overview's heading receives focus on entry; selecting a scenario focuses the selected chart tab. Live publications update topics, labels, and comparisons while retaining valid recorded selections.

Flow and state connectors preserve at least 16 layout pixels of straight line between each node outline and the nearest turn. The same terminal spacing applies to swimlanes and chart exports; zoom scales these distances with the chart.

Flow lanes render as open horizontal bands of shared width with alternating neutral fills. Authored order runs top-to-bottom. Each band has a narrow left heading compartment with a centered, bottom-to-top label and an inset vertical separator. Heading compartments pin over chart content during horizontal panning with a 20px screen-space left inset, remain within their bands, and scroll vertically with them. Wrapped headings reserve sufficient band height and share a heading width. Unassigned appears last only when needed. Nested group frames remain inside their single lane; declared connectors may cross lane boundaries. Full and compact views retain lane membership and ordering; compact views show bands containing visible nodes. Bands and headings stay neutral in both themes while nodes, edges, and groups retain traversal emphasis. Headings render as inert text; lanes neither select recorded steps nor acquire occurrence IDs.

Swimlane tracks align nodes with the median member centerline of adjacent groups, reserving the group's asymmetric heading and body space. Extra band height required by rotated headings is split equally above and below the packed contents; routing corridors retain their reserved space. Horizontally separated members of acyclic leaf groups share a centerline; cyclic and stacked members retain their internal offsets. Continuing branches take the primary track ahead of terminating branches at the same column. Frames reserve space for the orthogonal routes and captions. Connectors between different rows consider facing vertical ports as well as side ports, favor distinct departures for divergent branches, and retain obstacle clearance and terminal spacing.

Diagram and Domain each provide an export icon beside the bottom-right zoom controls. Its menu opens upward. When a scenario filter applies, Scenario only and All scenarios appear above SVG, PNG, and PDF. Scenario only retains muted off-path definitions; All scenarios gives every definition neutral emphasis within the current chart. Each export captures the full layout independently of zoom, panning, and sticky headings. Exports omit playback highlights, visit counts, inspection markers, shortcuts, drill controls, and snapshot-bearing tooltips. Diagram and Domain remain separate files. SVG embeds resolved presentation styles and an opaque background in the active light/dark theme. PNG and single-page PDF use the same themed artwork at up to 2× resolution, bounded to 8,192 pixels per dimension and 16 million pixels total. PDF embeds the raster image; SVG retains vector geometry. The web UI downloads through the local export endpoints in the active theme.

Flow/state layouts keep direct members and nested containers inside labeled frames with a heading divider. Divider and outline share the frame's traversal color. Heading lines center vertically within the heading compartment, with equal space above and below. State composites use rounded outlines; flow subgraphs use rectangular outlines. Both kinds use solid outlines when any descendant node belongs to the selected scenario, including upcoming occurrences. Frames with no descendant node on the scenario use dashed outlines. With no scenario filter, outlines are solid. Frames size around direct members, nested frames, and internal connector routes and labels with a 24px body inset on all sides. The heading sits above that inset; wide headings may expand a frame symmetrically. Vertically stacked nested siblings have 56px between their outlines; root siblings have 42px. Normalize gaps from the innermost frames outward while moving nodes, connector points, and labels together. The canvas keeps 32px outer margins. Layout reserves space for wrapped headings and routes declared edges between nodes across container boundaries. Ancestor frames reflect current, visited, upcoming, and off-scenario membership without acquiring occurrence IDs. Full and compact views share containment; compact views show only visible nodes and their ancestor frames. The minimap includes container outlines. Headings render as inert text in both themes. Containers do not select or execute recorded steps.

Flow and state use left-to-right layouts with the same action/state boxes and filled arrowheads. Flow nodes may declare a role: action uses the standard box, decision uses a content-sized diamond, start/end use pill-shaped terminators, and subprocess uses a box with inset vertical borders. Database uses a cylinder; preparation uses a hexagon; inputOutput and outputInput use opposing parallelograms; priorityAction uses a bottom-wide trapezoid; manualOperation uses a top-wide trapezoid; document uses a wavy-bottom sheet; multiDocument uses stacked sheets; delay uses a D-shaped box. Omitted roles use the standard box. Roles are accepted only on flow nodes and remain descriptive; branches follow declared edges rather than executing decisions. Graph views and chart exports share shapes, traversal colors, and revisit badges. Connectors meet each shape's visible outer boundary, including curves and stacked sheets; labels and revisit badges stay inside their node with space reserved for sloped sides, cylinder rims, and document waves.

State initial markers render as filled circles; final markers render as a filled circle inside an outlined ring. Both occupy 32px square bounds with captions available through tooltips rather than text inside the symbols. Connectors meet the outer circular boundary. The minimap, selection, traversal emphasis, both themes, and chart exports share their geometry. Structured transition captions display each present event, bracketed guard, and slash-prefixed effect as a separate component, each wrapped into at most two lines. Layout reserves the entire caption height; tooltips expose the complete joined caption as inert text.

Flow subprocess nodes and sequence message nodes may reference another flow or sequence diagram through `detailDiagramId`. State diagrams cannot be link sources or targets. References resolve inside the same explanation and direct self-links fail validation. The input alias `subprocessDiagramId` reads as `detailDiagramId`; serialization and MCP schema use the canonical field. Specifying both spellings fails deserialization. Cross-diagram cycles are permitted because links are explicit navigation, never execution or automatic expansion.

Drill icons occupy a 20px box. Flow icons center horizontally below the node label, with vertical space reserved inside the node. Recorded-step navigator icons align vertically with their trigger text and stay anchored to the right. They follow the trigger's text color and overlay their surface without shifting headings or enlarging nodes. Sequence glyphs sit 8px after the rendered message text, with reserved horizontal space. They are muted until their message is selected or visited, then blue. The icon is a plain glyph with a target-title tooltip. Its parent owns keyboard focus and announces the target. Clicking the icon or pressing Enter on its focused node, message, or step opens the target's first scenario at its saved cursor in Diagram. Enter on the Diagram canvas, event region, or selected Diagram tab also opens the current linked step. Other controls retain their native Enter behavior. Clicking elsewhere or pressing Space retains step selection. Modified, composing, and repeated Enter events do not drill. A target with no recorded scenario has a muted, inactive icon. Navigation preserves the source cursor and pushes one browser history entry; Back restores the source occurrence.

The library selects an explanation. The header centers its title and a 20px left-arrow icon vertically, with an 8px gap between them. The title uses a 24px line height. The icon and title share one back button that opens the explanation library and has an accessible label and tooltip. The explanation title forms the page heading. Long titles truncate and expose the full title in a tooltip. The library view leaves the title area empty. The connection status reads Connected and has a 6px gap between its icon and text. Header actions use 12px gaps, reduced on narrow screens. Diagram kind labels in legacy navigation keep their full width and center their text. The carousel selects adjacent recorded occurrences by ID. Forward/back selects recorded occurrences. Main view starts with Diagram, followed by optional Domain and Wiring tabs, with Diagram selected initially. Diagram embeds the full selected diagram; Domain embeds the shared ERD. Scenario cards and sidebar previews show the authored description. The data inspector's Calls tab shows recorded method calls. The selected tab persists across scenario navigation. Distinguish unchanged, changed, created, removed, uncaptured, and null values. Preserve cursors per scenario using occurrence IDs.

The data inspector sits beside every main view and starts closed. Its visibility and selected Changes, Before, After, or Calls tab persist across main views and scenarios for the viewer session. N toggles it with a 150ms right-edge slide; reduced motion switches immediately. Comma and period select the previous and next inspector tab while open, stopping at boundaries. Apostrophe pages up and slash pages down by the active inspector tab's visible height, clamped to its scroll bounds. Paging preserves focus, the selected occurrence, and both tab selections. Data shortcuts share the viewer input guards; paging is inactive while the inspector is closed. Slash focuses search in the explanation library. The toolbar toggle stays available in focus mode. Closed content becomes inert immediately; closing from inside returns focus to the toggle. Desktop inspection reserves up to 420px or 45vw; viewports at most 1000px use a right-edge overlay capped at the workspace width.

Inspector data comes only from the selected occurrence. Changes lists affected instances and links; Show unchanged values includes the complete comparison. Before and After show the corresponding captured snapshot; Calls retains authored order and receiver IDs even without property differences. Entity heading chips count visible instances. Expandable array and object headings count items and fields, with nested values rendered as inert text. Activity chips count property differences, link changes, and recorded calls. ERD heading chips show previous · current · next object counts from each occurrence’s After snapshot within the selected scenario. The first step’s left count uses its Before snapshot; the last step’s right count uses its After snapshot. The chip’s left end is fully rounded at scenario start and its right end at scenario end; a single-step scenario rounds both ends. Tooltips name the initial and final snapshots. Empty snapshots show 0. Counts stay gray, with the current count bold. Changed counts roll upward over 220ms when moving forward and downward when moving backward, clipped inside the chip. Unchanged counts stay still; initial rendering, scenario switches, data refreshes at the same step, and reduced motion use immediate updates. Selecting an ERD property opens and focuses its inspector value without advancing the scenario or switching the main view.

The header is 66px tall; narrow screens align the hamburger, identity, and actions in one row, truncating long titles. Main content and tab labels keep their viewport-adjusted insets. Diagram and Domain stay centered on the same row as the right-aligned data toggle; widths up to 360px show the toggle's icon with its accessible label. The tab bar's bottom border and the bottom controls' top border span the main panel's full width. Each tab panel scrolls within the available height. Graph and sequence revisit badges follow the rendered label's upper-right text bounds, including wrapped labels. Their circle's left edge sits four pixels after the text, and its center sits two pixels above the text's top.

M toggles focus mode in the viewer, instantly hiding or restoring the sidebar, header, and event footer. A centered quiet breadcrumb shows the explanation, diagram, and scenario titles with slash separators; the scenario carries stronger emphasis. It fades in over 250ms on entering focus mode and disappears instantly on exit. Reduced motion shows it immediately. The breadcrumb has equal space above its text and below it to the recorded-step lens. Long titles truncate and expose their complete text in tooltips and accessible labels. Hidden chrome becomes inert immediately. The main panel fills the remaining viewport while the step navigator and tabs stay visible. Focus mode preserves the selected tab and occurrence, shares the viewer shortcut input guards, and ignores key repeats. Toggle focus mode appears in Quick actions. Focus moves to the selected tab when its control becomes hidden. Returning to the library restores the header.

The main panel begins with a responsive recorded-step navigator above the tabs. Rails at least 900px wide show three slots with the active occurrence centered. Rails below 900px show two slots following the latest travel direction: previous and current when moving backward, current and next when moving forward. Initial direction is forward. At scenario boundaries, the available neighbor fills the second slot. Resizing preserves direction. Rails below 480px show only the current occurrence. Every step heading shows a smaller, muted monospace position/total counter such as `1/4`, separated from its node label by spacing, beside a visited check, current solid dot, or upcoming hollow dot. Every step shows its trigger underneath as a bolt icon and value with centered vertical alignment. Each heading and trigger form a vertically centered group within its slot. Adjacent steps use muted text; a raised blue lens marks the active slot. Missing neighbors reserve an empty slot in the three-slot layout, including single-occurrence scenarios. Hidden neighbors stay outside keyboard navigation and the accessibility tree. Neighbor buttons select occurrence IDs, preserving revisit identity and the selected tab. Headings and their triggers slide together over 300ms, with separate rows keeping them apart throughout the motion. The lens stays stationary while the active slot is unchanged. Rapid navigation retargets the slide; reduced motion swaps immediately. Long labels clamp to two lines with full-text tooltips, and long triggers wrap within a bounded scroll area. Light and dark themes share the layout.

Touch swipes across the recorded-step rail select the next occurrence to the left and the previous occurrence to the right, stopping at scenario boundaries and retaining the selected tab. Upward swipes on the rail or anywhere in Explanation overview open the next scenario in displayed sidebar order; downward swipes open the previous scenario. Scenario gestures share J/K's boundaries, Overview entry, and saved cursors. Vertical touch gestures on these surfaces navigate; mouse-wheel scrolling remains available in Overview. A single-finger gesture must travel at least 40px and favor one axis by at least 1.25×. Pinch zoom, cancelled gestures, diagonal movements, and ordinary taps retain their native behavior. Each swipe performs one navigation and consumes its synthetic click.

Diagram and Domain use transparent, borderless canvases at 1:1 with current-step focus on first use. Each fitting axis centers the scaled layout within the viewport without scroll overflow. Each overflowing axis reserves 20px screen-space gutters around the scaled layout. The viewer session remembers zoom, fit mode, and pan position independently for each explanation, diagram, scenario, and chart tab. Returning to a scenario or chart tab restores its saved framing without following the current step; fit mode refits the available viewport and other positions clamp to the current layout. Reload starts fresh canvas state.

Outside fit mode, graph views focus the current recorded step; sequence views focus its complete horizontal row; Domain focuses its related entity definitions. Automatic following prefers centering but hugs layout bounds with 20px screen-space padding to maximize visible content. Layouts that fit along an axis remain centered as a whole on that axis. Step changes animate to their target over 250ms with sine ease-in-out at the selected zoom. Animation timing starts at the first rendered frame. Canvas gutters support manual panning. Rapid navigation retargets the animation, manual interaction cancels it, and reduced motion uses immediate scrolling. Bottom-right controls zoom around the viewport center, fit the whole layout, and restore 100% while focusing the current step. Fit is an explicit mode: event navigation preserves its zoom and viewport. Its control is blue and pressed while fitted. The 1:1 control is blue and pressed at 100% outside fit mode. Zooming, restoring 100%, or manually scrolling or panning exits fit; following resumes on the next event navigation. In Diagram and Domain, = zooms in, - zooms out, and ; toggles between fit-to-screen and 100% with current-step focus. The toggle uses fit mode even when fitting produces 100% zoom and ignores key repeats. These actions appear in Quick actions and share the viewer shortcut input guards. A structured minimap shows the layout and visible bounds; dragging its viewport or the canvas background pans the main view. Minimap Up/Down pan and Home fits without changing the recorded occurrence; Left/Right select recorded occurrences. Node and entity selection remains available at every scale. Sequence sticky headings and occurrence centering use scaled coordinates.

Scenarios fill the sidebar's available height and scroll within it. The scrollbar sits at the right border and occupies the right padding. Content retains its width and horizontal position when a scrollbar appears. The Scenarios heading, diagram headings, and scenario labels scroll together in normal document flow. The sidebar begins with a muted uppercase monospace Scenarios heading. The active diagram and selected scenario retain full emphasis. At widths up to 700px, a header hamburger opens the sidebar as a vertically scrolling left-edge overlay with a backdrop, preserving the main view's size. Selecting a scenario or Overview, tapping the backdrop, or pressing Escape closes it; backdrop and Escape dismissal return focus to the hamburger.

J/K traverse Overview followed by scenarios in displayed sidebar order, stopping at both boundaries. J from Overview opens the first scenario at its saved cursor; K from the first scenario opens Overview and reveals the sidebar's top. Scenario selection reveals its label in Scenarios. Endpoint scenarios reveal the corresponding scroll boundary. H/L select recorded occurrences in the carousel while preserving the scenario list's scroll position.

The URL stores explanation, scenario, and occurrence IDs in query parameters. Overview uses `explanation` and `view=overview` without recorded-step IDs. User navigation pushes browser history; initial defaults and revision normalization replace the current entry. Reload and Back/Forward restore Overview or the selected occurrence. Route restoration cancels superseded document loads. URLs and history state contain no captured values.

An accessible sun/moon toggle follows Quick actions in the header. Light mode is the default. Dark mode uses neutral black and gray surfaces, whitish text, and monochrome PrimeVue controls. Blue distinguishes graph traversal and selected recorded events. The browser stores an explicit light/dark preference under `lain-theme`; unavailable storage does not prevent switching. The root `app-dark` class controls both custom viewer colors and PrimeVue's dark theme, including teleported dialogs and structured SVG diagrams.

Ctrl+K opens searchable quick actions and focuses the search input. H/L select the previous/next event across all tabs. J/K select the next/previous scenario in displayed sidebar order across all tabs. [ and ] select the previous/next tab, stopping at tab boundaries. Tab switches preserve the selected occurrence and snapshots. The tablist supports Home and End with roving focus. Left/Right select recorded events while tabs, inspector tabs, or the minimap have focus, sharing H/L's input guards and boundaries. Escape dismisses Quick actions and permits navigation during its closing animation. Navigation stops at list boundaries and preserves each scenario's cursor. Viewer shortcuts are inactive in editable controls, quick actions, selection overlays, and unrelated modals. The palette supports arrows, Enter, Escape, and mouse selection, shows each shortcut, and disables unavailable actions.

I/O traverse a dedicated drill-down history backward/forward. Only opening a linked chart records a visit, with source and destination scenario/occurrence IDs. Step changes, sidebar scenario selection, and browser Back/Forward do not add drill visits. Traversal restores the saved occurrence, opens Diagram, and focuses its tab. Each visit retains separate cursors when links cycle through the same chart. Leaving a visit saves its latest step when that scenario is still active. A new drill after going back discards forward visits. History is bounded at either end and clears on leaving the explanation, switching explanations, resetting cursors, or reloading the viewer. Live updates reconcile removed occurrences to surviving neighbors and discard visits whose scenarios were removed. Shortcuts share viewer input guards. Each fresh press acts immediately; holding either key acts on every second repeat event until the history boundary, at half the keyboard's repeat rate. Quick actions lists both with boundary-aware availability. Each traversal writes one browser history entry without invoking browser Back/Forward.

Left/Right arrows select the previous/next event; Down/Up arrows select the next/previous scenario. Arrow shortcuts share H/J/K/L's input guards, boundary checks, and centered scrolling. Quick actions displays both shortcut forms. Arrows retain their native editing and selection behavior in inputs, palettes, and selection overlays.

In the explanation viewer, Escape and Ctrl+[ blur the focused HTML or SVG element when no dialog or selection overlay owns the key. If focus is on the page body, either shortcut opens the explanation library. Blurring preserves the selected occurrence and tab. In the library, either shortcut returns focus to the selected card from search, header controls, cards, or the page body. Pressing either shortcut on a card also clears search and keeps that card focused in the full list. Dismissing Quick actions in the library returns focus to the selected card. With no matching cards, the shortcut blurs the current control. Ctrl+C in the library search clears it while preserving input focus; modified or composing input retains native behavior. Repeated keydown events do not dismiss additional layers. CSS outlines are disabled throughout the app; hover fills, selection colors, and structural borders retain their styling.

The explanation library keeps a compact introduction, search, and count fixed above a full-width card scroll region. Its scrollbar sits at the viewport's right edge; content is centered and capped at 1250px. The browser session retains the search text, selected card ID, and card scroll position across explanation visits, failed document loads, and browser history navigation. Returning restores the selected card's focus without scrolling it into view; missing cards fall back to the first result and scroll positions clamp to the available content. The first visit focuses the first card when no other control owns focus. Cards and search indicate focus with a single blue border. H/L and Left/Right move in list order, wrapping between rows and stopping at the first and last cards. J/K and Down/Up move between rendered rows; Down selects the last available card if the next row is incomplete. Vertical navigation stops at the first and last rows. Enter opens the focused card. The introduction uses the available content width. Search sits between the introduction and cards, filtering titles and descriptions by a case-insensitive literal substring and highlighting every match as text. The count shows the total when search is empty and the number found while searching. / focuses search outside editable controls and overlays. Down or Enter in search focuses the first result. Filtering preserves search focus. The no-match message has a borderless background at 20% of the theme's soft surface color.

Each library card has a separate, keyboard-accessible delete action. Delete all beside the count covers the whole library, including search-hidden cards, captured when confirmation opens. A modal names the target and explains the eight-second notification Undo window; Cancel receives initial focus. Confirmation reads each complete document, then sends a bodyless deletion once with its revision in If-Match. Pending deletion disables dismissal. Success removes the card without waiting for WebSocket delivery and restores focus to a surviving card. Failures refresh the library, show an error, and require closing the dialog and reviewing the current card before a fresh confirmation. Delayed deletion responses cannot hide newer publications of the same ID.

Deletion notifications retain successful deletions' documents in browser memory for eight seconds. Undo republishes each document under its original ID with the deletion revision in If-Match, so newer publications or deletion cycles cannot be overwritten. Bulk Undo covers only successfully deleted targets. Undo accepts one click, reports partial restoration on failure, refreshes the library, and never automatically retries publication. Notification expiry or dismissal releases its backups; reload discards them. Notifications persist across explanation navigation.

Capital G selects the last recorded event in the active scenario. Two lowercase g presses within one second select its first event. Unrelated keys, modifiers, composition, and repeats reset the pending sequence. Endpoint shortcuts share H/L's input guards and centered scrolling. First event and Last event appear in Quick actions with their shortcuts and boundary-aware availability.

In Diagram and Domain, a Shift+H/J/K/L tap pans the viewport left/down/up/right by 187.5 screen pixels over 150ms with cubic ease-out. Holding a key continues scrolling on animation frames independently of keyboard-repeat timing, then eases to a stop on release. Releasing Shift also stops the hold; losing focus, opening Quick actions, and focusing an editable control cancel it. Reduced motion uses an immediate tap and steady scrolling while held. Panning preserves the selected occurrence and zoom, cancels step-following motion, and shares the viewer shortcut input guards. Pan actions appear in Quick actions.

Reset explanation in Quick actions resets every scenario cursor in the current explanation to its first occurrence, selects the first scenario in displayed sidebar order, and opens Diagram. Reset centers the selected event and records the resulting selection as one browser history entry.

Y then S copies the explanation path through the current scenario; Y then D copies it through the diagram; Y then P copies it through the current event, including occurrence position. Paths include the explanation title and use ` → ` separators. These actions appear in the palette's Clipboard group and work across tabs while a scenario is selected. Yank sequences expire after one second and reset on unrelated keys. Editable controls, modified keys, composition, and repeats preserve normal input. PrimeVue toasts at the top right confirm successful clipboard writes or report clipboard failures.

The full diagram distinguishes muted off-scenario elements, upcoming scenario elements, and blue visited elements. Recorded incoming edge IDs determine scenario membership. Nodes recorded more than once in the selected scenario show a badge from their first visit, counted only through the current occurrence. Graph edge labels wrap at roughly 20 characters into at most two centered lines; overflow ends with an ellipsis, and tooltips expose the complete label. Layout reserves the displayed label's width and height. Edge labels show traversal counts above one on their final line. Single-visit nodes remain unbadged. Badge numerals are centered. Graph badges follow the rendered label's upper-right corner for every shape: the circle's left edge sits four pixels after the text, and its center sits two pixels above the text's top. Wrapped labels use their complete text bounds. Self-loops leave and return beneath their node with smooth turns and separate captions. Swimlane connectors follow short, obstacle-clear orthogonal routes with captions beside chosen segments. Diagram node clicks navigate to recorded occurrences; repeated visits display an occurrence picker. Off-path nodes stay inspectable but cannot mutate a scenario. Structured SVG uses text rendering and controlled attributes. No agent-authored HTML, URLs, SVG, or scripts enter the chart DOM.

Flow, state, and full sequence nodes with recordings in another scenario reveal a centered edge pill on hover or focus. Graph pills sit on the node's top boundary, including a decision diamond's top vertex; sequence pills sit on the message row's top-center edge. Pills show the alternative scenario count as “1 scenario” or “3 scenarios” and have a 36px-tall pointer target. Touch devices keep pills visible. Clicking a pill opens an anchored, numbered picker without advancing the source recording. Choices retain authored scenario order, stay within the same diagram, exclude the current scenario, and count each scenario once despite revisits. Selection opens that node's first occurrence in the chosen scenario, preserves the source cursor, focuses Diagram, and pushes one browser history entry. In Diagram, ? activates dimmed-chart hints for jump pills whose centers lie inside the visible canvas, below sequence sticky headings. Hints show a letter beside the scenario count, such as “a · 3 scenarios”. Letters start at a, continue through z then aa, ab, and follow screen order, top to bottom then left to right. Panning and resizing relabel visible targets and clear pending prefixes when their mapping changes. Typing a node's letters opens its scenario picker; typing a scenario number selects it. Unique complete hints act immediately. Ambiguous prefixes highlight matches and wait one second after the last character; Enter confirms the exact hint immediately. Invalid prefixes clear pending input. Escape or Ctrl+[ dismisses the picker and node hints together, cancels pending input, and restores the originating focus while preserving the recorded occurrence. Picker arrows, Home, and End move focus. Outside interaction, tab departure, recording or document changes, editable or overlay focus, Quick actions, and window blur cancel pending jumps. Viewer input guards apply. Quick actions exposes the hint command when alternatives exist. Chart exports omit jump pills and hint dimming.

Dismissing a scenario picker with Escape, Ctrl+[, ?, its close button, or an outside click pans back to the current recorded node at the selected zoom without changing the occurrence.

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

`lain serve` runs foreground. `lain` checks the existing daemon and opens its local URL with `xdg-open` on Linux, `open` on macOS, or the Windows URL handler; failures print an actionable setup/serve instruction. `lain open --print-url` prints the configured local URL for manual browser use. `lain setup` creates idempotent per-user startup with an absolute executable path and explicit home/port: a systemd user service on Linux, a launchd LaunchAgent on macOS, or a limited interactive scheduled task named `Lain-<user SID>` on Windows. Setup starts the viewer and checks readiness. Successful setup saves the selected port for later client commands. `lain setup --dry-run` prints native startup configuration and client settings without installing startup. `lain status` checks daemon readiness. `lain demo` publishes the bundled example through the local HTTP API.

Global `--home` or `LAIN_HOME` selects isolated runtime state. Defaults are `$XDG_DATA_HOME/lain` (or `~/.local/share/lain`) on Linux, `~/Library/Application Support/lain` on macOS, and `%LOCALAPPDATA%\lain` on Windows. `--port` overrides the saved port; default 38475. Unix homes use mode 0700 and settings mode 0600. Windows creates state with owner/SYSTEM-only ACLs and validates existing ACLs and reparse points. Database lives at `home/lain.sqlite`. Do not overwrite unrelated files or silently repair unsafe links. Startup runs unprivileged at login and restarts after failure. The Linux service uses `Restart=on-failure` and `WantedBy=default.target`; macOS uses `KeepAlive.SuccessfulExit=false`; Windows retries three times at one-minute intervals. Explain `loginctl enable-linger` for Linux pre-login boot without invoking sudo. Do not alter agent client configs automatically.

The daemon holds an exclusive OS file lock under its runtime home for its lifetime. A second daemon using the same home fails even when it selects another port. This keeps publication notifications under one process owner. Do not delete or replace the lock file while a daemon runs; the OS releases the lock when the process exits.

`scripts/build.sh` builds frontend then release executable on Linux/macOS. Windows source builds run the same npm and Cargo commands from PowerShell. `scripts/install.sh` and `scripts/install.ps1` install the built executable to a user bin directory and print the setup command. No startup installation happens during a build or test. No commits or external configuration changes are part of implementation.

The release workflow checks `main` and publishes stable `vX.Y.Z` tags matching the package version. cargo-dist 0.32.0 packages Linux x64, macOS Apple Silicon/Intel, and Windows x64 on native runners with the embedded frontend and SHA-256 checksums. Global packaging merges native manifests into shell and PowerShell installers targeting `~/.local/bin`. Native checks exercise packaged installation, chart rendering, persistence, and generated installers with isolated state before publication. `scripts/prepare_installer.py` adds automatic first-install setup and upgrade hooks. Upgrades ask before stopping outdated processes from the target installation and restart associated managed startup jobs with their existing home, port, and settings. Declining aborts before executable replacement. Unsafe or mismatched startup configuration and failed setup/restarts fail installation. An unavailable Linux/macOS login service manager warns and leaves manual instructions. `LAIN_NO_SETUP=1` skips startup creation; approved upgrades still restart associated jobs. Installer tests use fake commands and isolated paths; they never change real startup configuration.

`npm start` runs Watchexec around a persistent Node development supervisor. Watchexec watches Rust sources, Cargo manifests/lockfile, and embedded authoring guidance; it sends `SIGUSR2` on changes. The supervisor installs frontend dependencies, builds frontend assets, compiles Rust, and starts the daemon alongside Vite. It uses `.lain-dev` for local state, backend/MCP port 38475, and browser port 5173. It checks port ownership, waits for readiness, seeds an empty library, and opens the local Vite URL.

Rebuilds are serialized and coalesce pending changes. Build frontend assets before Rust; retain the running backend if either the frontend build or Rust compilation fails. After success, stop only the owned backend group, recheck its port, start the replacement, and verify readiness. Vite stays live. Restarted backends preserve SQLite state. Browsers reconnect with bounded backoff, resynchronize the library, and restore the current route. Unexpected server exits or replacement failures stop the owned stack. Shutdown cleans up owned process groups, never existing listeners or installed services. Generated output and development state do not trigger rebuilds. The installed runtime remains one Rust executable.

## Verification

Integration tests cover valid publication, failed reference validation, branch continuity, revisits, durable reopen, concurrent last-write-wins publications, recreation with monotonic revisions, deletion by ID, Host/Origin isolation, real MCP initialize/list/call, and WebSocket notifications. Frontend checks cover cursor selection and snapshot semantics where risk warrants a test. Typecheck, frontend production build, cargo test, formatting, and clippy must pass. Smoke-test the embedded frontend; use isolated runtime directories.
