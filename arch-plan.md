# Architecture view implementation plan

## Outcome

Add an optional **Architecture** tab after **Diagram** and **Domain**. An explanation owns one shared architecture model. Every scenario in that explanation can refer to its components and connections. The view answers three questions:

1. What UI, APIs, data stores, workers, queues, and external services participate in this feature?
2. Which parts participate in the selected scenario and its current recorded step?
3. Which pieces of work relate to each component or connection?

Use `examples/order-lifecycle.json` as the first complete example. API endpoints must be discoverable in the architecture view. UI screens must have explicit mentions associated with their owning UI application. These details must remain usable without turning every endpoint or screen into a top-level box.

## Scope and boundaries

1. Keep architecture definitions at explanation scope, like the domain model. Scenario recordings refer to those shared definitions.
2. Keep the three views distinct: Diagram describes behavior, Domain describes business data, and Architecture describes the participating software and infrastructure.
3. Record architecture participation explicitly. Domain entities, snapshot presence, narration, trigger strings, and sequence participant labels do not establish runtime component usage.
4. Keep mappings attached to recorded occurrences so repeated visits can identify different architectural activity. Architecture has no separate before/after snapshots.
5. Support generic work references with a key, an optional HTTP/HTTPS link, and a description. A reference may cover several components or connections, and one element may have several references.
6. Treat runtime relationships and delivery dependencies as separate concepts. A service call does not establish ticket ordering.
7. Use one legible feature-level map first. Automatic repository discovery, Jira synchronization, deployment topology, screenshots, and timeline scheduling are outside the first delivery.

## Repository constraints

1. Read `AGENTS.md` and `architecture.md` before implementation. Load the coding-standards skill before source or test edits.
2. `AppService` owns validation, persistence, and publication. REST and MCP use that service and the same document contract.
3. Author labels, descriptions, endpoints, and screen mentions as inert text. Validate external URLs and use the existing safe-link behavior.
4. Preserve existing schema-version-1 documents through optional fields and omitted empty collections. Keep existing scenario traversal and snapshot requirements intact.
5. Keep tests and temporary daemons isolated under test-owned state. Do not change installed services or external configuration.
6. Build the frontend before Rust checks that embed its production assets.
7. The user owns the development stack launched with `npm start`. Do not start, stop, or restart it without explicit permission. If manual verification needs an unavailable stack, ask the user to start it.
8. Do not publish over a saved explanation or commit changes without permission. Updating the bundled example and isolated fixtures is sufficient for automated verification.

## Proposed document contract

The contract below is the implementation target. Use component-owned operations for API endpoints and other named capabilities. Keep screen mentions inside their owning UI component. Both have qualified IDs so different services can use the same local operation name.

```ts
type ArchitectureReference = {
  id: string;
  key: string;
  url?: string;
  description: string;
};

type ArchitectureOperation = {
  id: string;
  label: string;
  description?: string;
  http?: { method: string; path: string };
};

type ArchitectureScreen = {
  id: string;
  label: string;
  description?: string;
  route?: string;
};

type ArchitectureComponent = {
  id: string;
  label: string;
  kind: 'uiApp' | 'service' | 'database' | 'queue'
    | 'worker' | 'externalSystem' | 'other';
  description?: string;
  technology?: { name: string; provider?: string };
  operations?: ArchitectureOperation[];
  screens?: ArchitectureScreen[];
  referenceIds?: string[];
};

type ArchitectureConnectionEnd = {
  componentId: string;
  operationId?: string;
};

type ArchitectureConnection = {
  id: string;
  label: string;
  description?: string;
  source: ArchitectureConnectionEnd;
  target: ArchitectureConnectionEnd;
  protocol?: string;
  referenceIds?: string[];
};

type ArchitectureGroup = {
  id: string;
  label: string;
  componentIds: string[];
  parentGroupId?: string;
};

type Architecture = {
  components: ArchitectureComponent[];
  connections: ArchitectureConnection[];
  groups?: ArchitectureGroup[];
  references?: ArchitectureReference[];
};

type ArchitectureRelevance = {
  componentIds?: string[];
  connectionIds?: string[];
  operationRefs?: { componentId: string; operationId: string }[];
  screenRefs?: { componentId: string; screenId: string }[];
};

// Optional additions to the existing authored document types:
// Explanation.architecture?: Architecture
// Occurrence.architectureRefs?: ArchitectureRelevance
```

Reference definitions live once in `architecture.references`; components and connections attach them through `referenceIds`. The same work item can cover several elements without duplicating its description or URL. Keep explanation-wide `links` independent. Reference keys are inert labels, not validated Jira keys. The first delivery attaches references to components and connections; endpoint-specific, screen-specific, and scenario-specific ticket assignments can follow if needed.

`technology` carries optional descriptive product/provider names such as PostgreSQL, Amazon SQS, or AWS Lambda. A generic component kind determines its basic presentation. Technology names do not imply deployment topology or select arbitrary external icon assets.

### Validation and compatibility

1. Use existing stable ID rules. IDs are unique within each architecture collection. Group IDs must also be distinct from component IDs because the layout uses a shared key space for both. Operation and screen IDs are unique within their owning component. Reference keys are unique within `architecture.references`.
2. Require at least one component when architecture is present. Resolve every endpoint, group membership, operation, screen, work reference, and occurrence reference before persistence. Reject occurrence architecture references when the explanation has no architecture.
3. Operations belong to the component implementing or exposing them. An HTTP operation has a nonblank method token and a path beginning with `/`. Display method/path as inert text; a path may be an authored template such as `/orders/{orderId}/dispatch`.
4. Screens are allowed on `uiApp` components. Screen routes are descriptive text, not browser destinations. A screen reference establishes relevance of its UI owner, not evidence of a particular API call.
5. Connections are directed, labelled architectural relationships. Support self-connections and parallel connections with distinct IDs. Optional operation IDs resolve on their respective endpoint component. Groups and screens are not connection endpoints.
6. Reuse the existing group constraints: at most one direct group membership per component, resolved parents, no cycles, at most eight nesting levels, and at least one descendant component per group. Groups describe containment; they establish no security or deployment policy.
7. Reject duplicate IDs and duplicate entries within relevance or attachment arrays. Keep authored collection order. Require nonblank labels, work-reference keys, and present protocol/technology names. Apply existing text, document-byte, and depth limits.
8. Suggested collection bounds: 200 components, 500 connections, 100 groups, 200 operations and 200 screens per component, 100 reference definitions, 50 reference attachments per component/connection, and 500 explicit relevance entries per occurrence. Express local limits in MCP schema as well as runtime checks.
9. Validate each present reference URL with the existing absolute HTTP/HTTPS link rules. Open only through safe anchors with `noopener noreferrer`. Never load diagram assets or perform requests from authored endpoint/screen text.
10. Keep `schemaVersion: 1`. Omitted architecture and relevance fields preserve existing documents. Serialize empty optional collections absent, but preserve a present empty `architectureRefs: {}` because it has a distinct meaning. New readers accept existing documents; older binaries reject enriched documents because unknown fields are denied.

### Relevance semantics

`Occurrence.architectureRefs` is the sole authored source. Do not add diagram-node defaults, a second scenario-level mapping, or inferred mappings in the first delivery.

Resolve each occurrence with this bounded closure:

1. A referenced connection includes its endpoint components and any operations named on those endpoints.
2. A referenced operation or screen includes its owning component.
3. A relevant component emphasizes its ancestor groups.

Closure does not activate adjacent connections, sibling operations/screens, linked detail diagrams, or domain entities. A scenario's relevance is the union of its resolved occurrences. References identify participation, not invocation order, invocation counts, or verified runtime execution.

Omitted `architectureRefs` means **Mapping not recorded**. A present empty object means **No architecture elements mapped for this step**. Display scenario coverage as **Mapped steps X/Y**, counting present mappings including explicit empty ones. Elements outside the union are **Outside this scenario's mapped scope**; that is not proof of physical non-involvement.

## Architecture tab experience

### Canvas and inspection

1. Show tabs in this order: Diagram, Domain, Architecture. Show Architecture only when the explanation supplies architecture data. Diagram remains the initial view. Preserve the selected occurrence and inspector tab when switching views.
2. Use a feature-level component map with named boundaries. Each card shows its name, kind, optional technology, and compact HTTP method/path rows. Use one basic visual language with small kind distinctions, including storage and queue cues. Provider icons are optional decoration, never the only label.
3. Show screen names as compact **Screens** mentions within their UI card. Put full operation/screen descriptions, routes, connection details, and reference descriptions in an Architecture details panel. Keep endpoint/screen summaries fixed during navigation; bound large lists with an authored-order summary and a count.
4. Give every directed connection a short intent label, such as **reads receipts** or **queues fulfillment**. Show an authored protocol where available. A structural connection is not a behavioral-diagram edge or a playback step.
5. Clicking or keyboard-selecting a component, operation, screen, or connection inspects metadata without moving the recorded cursor. Offer explicit links to matching recorded occurrences when navigation is wanted. Keep Architecture details separate from the existing Changes/Before/After/Calls data inspector.
6. Retain the inspected element while stepping or switching scenarios. Clear it when dismissed, removed by a live publication, or leaving the explanation. Its selection outline must differ from current-step emphasis.
7. Lay out the complete shared graph. Scenario switching, playback, inspection, and reference overlays do not move cards or reroute connectors. Preserve architecture framing per explanation across scenarios, rather than using the behavioral diagram's per-scenario viewport identity.
8. Start Architecture fitted to the whole map. Playback changes emphasis without automatic camera movement. Provide an explicit **Focus current step** action alongside normal fit, zoom, pan, and minimap controls. The action adjusts zoom and pan to frame all current components and mapped connection paths with 20px screen-space padding. Use the owning component card for operation and screen references. Disable the action when the current occurrence's resolved scope is empty, including unmapped occurrences. Focusing does not enable automatic following; subsequent playback preserves the resulting framing.

### Playback emphasis

Use current-step emphasis over earlier-recorded emphasis over later-recorded emphasis. Keep off-scenario labels readable. Distinguish states with markers/text as well as color, and include a short legend.

**Earlier** and **later** mean positions around the recorded cursor, not the reader's navigation history or predictions of future execution. An element may participate on both sides of the cursor; inspection can show both counts. Rewinding recomputes emphasis. An unmapped current occurrence clears current emphasis rather than retaining the preceding step's highlight.

Highlight connections independently from their endpoints. Two highlighted components do not establish that the connection between them participates in the scenario. Show occurrence-level operation and screen emphasis inside the owning card.

### Work-reference overlay

Provide a small reference picker listing authored keys and descriptions. Selecting a key outlines its attached components/connections using a distinct **Work-linked** marker while preserving playback colors. Selecting an element lists its references as key chips with optional external links and descriptions. A removable **Work: KEY** filter makes the active overlay visible.

Reference selection does not advance playback. Do not display inferred blockers, implementation status, ownership, completeness, or release readiness. Delivery-dependency arrows and Jira synchronization are outside this feature.

### Keyboard, narrow screens, and live updates

1. Extend tablist arrows, Home/End, and `[`/`]` navigation to the optional third tab. Keep scenario/occurrence shortcuts and existing input guards. Architecture Enter/Space inspect; they do not trigger Diagram's drill-down behavior.
2. Make components, endpoint rows, screen mentions, and connection inspection reachable by keyboard. Connection lists in the details panel provide an accessible alternative to selecting SVG paths. Announce state and work linkage, with visible focus indicators.
3. On narrow screens, use a dismissible details sheet. Opening it closes the Data overlay and vice versa while retaining their selections. Restore focus to the opener. Keep all three tabs reachable at 320px without page-wide overflow.
4. Reconcile live updates by stable IDs. If architecture disappears while Architecture is selected, select Diagram. Preserve Diagram or Domain when either is already selected. Discard architecture-only selection/framing when architecture disappears. If one selected element/reference disappears, clear only that selection. Keep valid scenario and occurrence cursors.
5. Hide architecture export controls in the first delivery. Existing Diagram/Domain export projections omit occurrence `architectureRefs` and retain their existing scope and behavior. Stored explanations retain their mappings.

## Order lifecycle example

### Grounding and synthetic additions

The bundled explanation is already synthetic. Its sequence definitions name a payment gateway, payment service, receipt store, fulfillment queue, and dispatch service. Its occurrences explicitly include `POST /payments/callback` and the concrete request `POST /orders/ORD-1042/dispatch`.

Use the authored template `POST /orders/{orderId}/dispatch` for the dispatch operation and state that it generalizes the example request. UI applications/screens, database products, cloud providers, worker deployment, and carrier APIs are not established by those recordings. Any such additions need a plain-text synthetic-assumption description. Domain records or a carrier name in snapshot values do not prove a service boundary or API contract.

Start with these components. Keep technology/provider unspecified unless the example explicitly labels a chosen technology as illustrative.

| ID | Kind | Role and grounding |
| --- | --- | --- |
| `payment-gateway` | `externalSystem` | Gateway named by the payment sequences. |
| `payment-service` | `service` | Callback handling and payment capture named by the sequences. Owns `POST /payments/callback`. |
| `receipt-store` | `database` | Logical persistent receipt store named by the sequence; engine unspecified. |
| `fulfillment-queue` | `queue` | Shared work queue named by payment and dispatch sequences. |
| `dispatch-service` | `service` | Dispatch intake named by its sequence. Owns the authored dispatch route template. |
| `warehouse-ui` | `uiApp` | Synthetic warehouse application with screen mentions **Dispatch queue** and **Packing detail**. |
| `fulfillment-service` | `service` | Synthetic software responsibility for recording packing, shipment, and queue acknowledgement; manual packing remains a human action. |
| `commerce-store` | `database` | Synthetic logical store for order/payment/shipment records; engine unspecified. |
| `carrier-system` | `externalSystem` | Synthetic system boundary for DemoParcel coordination; no carrier HTTP API is asserted. |

Group commerce components inside a named **Commerce system** boundary. Keep gateway and carrier outside it. This is a feature-level architecture, not a claim about independently deployed services or strict C4 conformance.

Define connections only where they clarify the feature: callback delivery, receipt lookup, payment recording, fulfillment publication, dispatch submission, dispatch enqueue, work consumption, warehouse recording, shipment persistence, carrier coordination, and queue acknowledgement. Label the synthetic additions. Do not add reverse response arrows automatically. A connection may be relevant to a recorded acknowledgement without asserting the physical direction of every response byte.

### Mapping the existing scenarios

Map every occurrence in all 13 existing scenarios, including explicit empty mappings for markers with no architectural involvement to describe. Keep existing occurrence IDs and snapshots intact.

| Scenarios | Required emphasis |
| --- | --- |
| `successful-callback`, `sequence-successful-callback` | Callback endpoint/connection, receipt access, payment recording, then fulfillment publication. Keep each recording's granularity. |
| `duplicate-callback`, `sequence-duplicate-callback` | Callback, separate receipt reads, and acknowledgement. The queue remains outside mapped scope even though snapshots contain a fulfillment item. |
| `declined-payment`, `sequence-declined-payment` | Callback, receipt lookup, and decline recording. Fulfillment publication remains outside mapped scope. |
| `capture-authorized-payment`, `capture-payment-exchange` | Shared payment service and authored persistence responsibilities. Domain Payment/Order are not infrastructure nodes. |
| `dispatch-request-accepted` | Dispatch operation and queue publication. Acceptance is not warehouse completion. |
| `priority-order-dispatch` | Explicit warehouse UI/screen mentions and software recording around manual packing and dispatch coordination. Both waits retain their own mappings. |
| `parcel-delivered`, `delivery-retry`, `returned-to-sender` | Authored fulfillment/carrier coordination and durable shipment recording. Each retry/return visit remains distinct. |

To demonstrate UI participation without rewriting the meaning of existing recordings, add one small synthetic UI dispatch scenario with its own flow diagram and occurrence IDs. Describe a warehouse operator opening **Dispatch queue** and submitting a paid order through the dispatch endpoint. Reuse valid example domain state; keep its screen/route assumptions explicit. Stop at accepted queue work. Use the existing `dispatch-request-accepted` scenario as the behavioral contract reference, not an automatically aligned or continued recording.

Add two or three fictional work references, such as `DEMO-101` for callback handling and `DEMO-102` for dispatch submission. Mark them as illustrative. Attach one reference to multiple components and a connection so the overlay demonstrates many-to-many scope. Include a safe example URL only where useful; do not invent a real Jira submission.

## Implementation sequence

### 1. Contract, validation, and persistence

Add focused architecture types and validation in `src/architecture.rs`, register the module in `src/lib.rs`, and extend `src/model.rs::{Explanation, Occurrence}`. Mirror the types in `frontend/src/model.ts`. Follow the existing split validation modules and schema annotations.

Call the validator through `Explanation::validate()`. `AppService::publish_with_revision()` already validates before persistence and notification. REST `PublishRequest` and MCP `PublishInput` derive from the same model; no separate architecture publication endpoint is needed. Keep SQLite's complete-document storage and revision semantics. Optional JSON fields need no database-schema migration.

Test absent/present/empty mappings, all reference failures, ownership, groups, URL policy, limits, serialization, and reopening stored documents. Include rejection of group/component ID collisions. Confirm rejected publications leave revision and notifications unchanged. Include schema-discovery assertions for the new optional fields.

In `src/chart_export.rs::relevance_only()`, clear `architectureRefs` from the projected occurrences for both Diagram and Domain exports. Test that serialized export plans omit those mappings while the saved document retains them. Architecture export support remains outside the first delivery.

### 2. Pure relevance and layout helpers

Add `frontend/src/architecture.ts` for qualified-reference resolution, occurrence/scenario relevance, coverage, earlier/current/later classification, work-reference scope, and occurrence lookup. Add an architecture layout adapter, such as `frontend/src/architecture-layout.ts`.

Reuse geometry/routing from `frontend/src/layout.ts` where it fits. Keep component cards and endpoint/screen sizing architecture-specific. Do not add a new `DiagramKind` or create fake behavioral nodes/occurrences to reuse the graph renderer.

`GraphView.vue` assumes a single current node, drill links, and recorded-step badges. Architecture needs multi-component emphasis, so add a thin `ArchitectureView.vue` rather than reusing that component unchanged. Reuse `DiagramViewport.vue` for fit/zoom/pan/minimap. Add the controls needed for initial whole-map fit, explicit current-scope framing, export suppression, and opting out of automatic following. Retain the existing views' defaults.

### 3. Optional-tab integration and inspection

In `frontend/src/App.vue`, use explicit view identities for Diagram, Domain, and Architecture. Update the optional tab list, active-canvas selection, export dispatch, shortcut applicability, panel/ARIA IDs, tab selection, and fallback when architecture disappears. Keep existing drill-down and explicit recorded-step jumps opening Diagram.

Give Architecture a viewport key based on explanation ID and the architecture view, independent of behavioral diagram/scenario IDs. Reconcile selection against live definitions and derive emphasis from navigation's reconciled current occurrence. Retain current Overview hiding/inert behavior and existing data-inspector state.

Add architecture-specific details and the work-reference picker without changing `StepInspector.vue`'s snapshot semantics. Extend `frontend/src/style.css` rules that currently name `.diagram-panel,.domain-panel`. Verify the three-tab header, data toggle, details sheet, and focus mode at narrow widths.

### 4. Example and authoring documentation

Extend `examples/order-lifecycle.json` with the shared definitions, all existing occurrence mappings, synthetic UI scenario, and fictional references. Update `agent-instructions.md`, `architecture.md`, `docs/reference.md`, and relevant example guidance with ownership, mapping, coverage, and synthetic-evidence rules.

Preserve explicit legacy fixtures. `frontend/tests/fixtures/legacy-order-lifecycle.ts` currently strips only reader-structure fields and scenario labels; make its intended architecture-free contract explicit, including removing occurrence mappings. Review browser fixtures that clone the bundled example so each test intentionally exercises architecture-present or architecture-absent behavior.

### 5. Verification and visual acceptance

Extend Rust model/demo/transport tests and frontend helper/app tests. Add browser coverage for shared geometry, independent viewport state, endpoint/screen inspection, reference overlays, and live removal. Update existing two-tab assertions in `frontend/tests/app.test.ts` and `tests/browser-smoke.cjs` according to their fixture, while retaining a genuine two-tab legacy case.

Inspect both themes, focus mode, Overview return, reduced motion, and 320px/360px/390px layouts. Check malicious-looking labels as inert text and external reference anchors against existing policy. Confirm existing Diagram/Domain downloads and keyboard actions still operate on the correct view.

## Acceptance checklist

1. An architecture-free explanation has its existing Diagram/Domain behavior. An enriched explanation has one optional Architecture tab shared by all its scenarios.
2. `POST /payments/callback`, the authored dispatch route template, and warehouse screen names are visible/discoverable without endpoint-per-node or screen-per-node expansion.
3. Scenario switching and stepping preserve graph geometry and camera position. **Focus current step** frames all current components and mapped connection paths with padding, and is disabled for unmapped or explicitly empty steps. Playback after focusing preserves that framing. Architecture inspection and work-reference selection preserve occurrence IDs and snapshots.
4. Multiple components/connections may be current simultaneously. Connection/operation/screen emphasis follows only explicit mappings plus the documented ownership closure.
5. `duplicate-first-check` and `duplicate-verification` are distinct visits. Both `dispatch-first-wait` and `dispatch-second-wait` remain inspectable. `retry-transit` and `retry-rescheduled` retain their separate involvement.
6. Duplicate and declined payment scenarios leave fulfillment publication unhighlighted. Queue contents in snapshots do not imply queue activity.
7. Missing and explicit-empty mappings have different messages. An unmapped current occurrence clears current emphasis. Coverage counts authored mappings without claiming runtime completeness.
8. One fictional reference highlights several attached elements. The selected work overlay remains distinct from scenario/current-step styling and creates no inferred delivery dependencies.
9. Live publication can remove an element, a reference, or the whole architecture without losing valid scenario cursors or leaving an inaccessible selected tab. Removing architecture selects Diagram only when Architecture was active; existing Diagram/Domain selections survive. Existing documents still round-trip and publish. Validation rejects group/component ID collisions.
10. Keyboard, pointer, touch, and narrow-screen inspection work without relying on color alone. Architecture export controls are absent. Existing chart exports retain their proper targets and omit occurrence architecture mappings from their payloads. Saved mappings remain intact.

### Commands for the implementation session

Run from the repository root. These are planned checks, not results from the planning session.

```sh
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
```

Use the existing browser harnesses with locally installed Playwright/Chromium paths:

```sh
LAIN_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
LAIN_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
node tests/browser-viewport-smoke.cjs

LAIN_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
LAIN_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
node tests/browser-focus-smoke.cjs

LAIN_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
LAIN_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
node tests/browser-overview-smoke.cjs
```

The viewport/focus harnesses use an isolated frontend preview. The overview harness uses a test-owned daemon and defaults to `target/debug/lain`. `tests/browser-smoke.cjs` instead targets `target/release/lain`; build the release binary after the frontend before using that harness. Export regression coverage lives in `tests/chart-export-browser.cjs` and accepts `LAIN_CHROMIUM_EXECUTABLE`.

### Demo publication caveat

`src/main.rs::demo()` embeds examples at compile time. `scripts/watch-dev.mjs` does not watch `examples/`, and `scripts/dev.mjs` seeds demos only when the library is empty. Editing the JSON alone therefore does not refresh a saved development explanation. Rebuild for embedded-demo checks. Use isolated publication in tests; obtain permission before replacing a saved explanation for manual viewing. Do not clear the user's library to force reseeding.

## Research basis

The following sources support the architecture principles. Endpoint compartments, screen mentions, occurrence mapping, and work-reference overlays are Lain-specific design choices.

| Source | Applicable guidance |
| --- | --- |
| [C4 container diagram](https://c4model.com/diagrams/container) | Show applications, stores, responsibilities, technologies, and communication at a coherent level. |
| [C4 notation](https://c4model.com/diagrams/notation) | Make element types explicit and use specific, labelled, directed relationships. |
| [C4 diagram checklist](https://c4model.com/diagrams/checklist) | Explain notation and ensure labels, boundaries, colors, and icons remain understandable. |
| [arc42 building-block view](https://docs.arc42.org/section-5/) | Describe static structure and important interfaces, with selective refinement. |
| [arc42 runtime view](https://docs.arc42.org/section-6/) | Describe concrete interactions through scenarios separately from static structure. |
| [Structurizr dynamic views](https://docs.structurizr.com/dsl/cookbook/dynamic-view/) | Reuse static elements/relationships when describing scenario interactions. |
| [Structurizr groups](https://docs.structurizr.com/dsl/cookbook/groups/) | Use named boundaries with clear descriptive meaning. |
| [Structurizr URL metadata](https://docs.structurizr.com/dsl/language#url) | Attach traceability links to elements and relationships. |

Avoid per-scenario architecture copies, domain records disguised as services, endpoint/screen box explosions, vague **uses** arrows, logo-only meaning, inferred runtime activity, and ticket arrows mixed into system relationships.
