# Examples

## Publish the three demos

Against a running daemon:

```sh
lain demo
```

The command publishes these complete schema-version-1 documents in order:

| Explanation ID | Document |
| --- | --- |
| `order-lifecycle` | `order-lifecycle.json` |
| `release-promotion` | `release-promotion.json` |
| `incident-recovery` | `incident-recovery.json` |

For an individual MCP publication, call `get_context` first, then `publish_explanation({id, document})` with the matching ID and the file's complete parsed JSON object as `document`. A filename or partial document is not a publication payload. Publication atomically creates, replaces, or recreates that ID; the last commit wins. The browser loads committed explanations from the API; it does not publish examples on startup.

## Order lifecycle

`order-lifecycle.json` records payment handling, shipment state, and payment messages with shared domain relationships.

Payment handling demonstrates five flow-node roles: Callback received is the start, Receipt checked is a decision diamond, Capture the payment is a double-bordered subprocess, Event already handled is an action box, and the success, duplicate, and decline endpoints are end terminators. Select Diagram to see the full left-to-right flow. Details keeps the agent-authored scenario description above the current step's narration and recorded method calls.

**Dispatch preparation** (`dispatch-preparation-flow`) demonstrates the other nine roles in **Priority order packed and dispatched**. Scan packing request uses `inputOutput`; Prepare workstation uses `preparation`; Save dispatch work uses `database`; Expedite priority order uses `priorityAction`; Pack parcel by hand uses `manualOperation`; Create invoice uses `document`; Print dispatch documents uses `multiDocument`; Wait for carrier uses `delay`; Send dispatch notice uses `outputInput`. Pills mark entry and completion. The two recorded visits to Wait for carrier have distinct occurrence IDs and snapshots. Grouped intake, packing, and dispatch steps exercise containment, curved connectors, traversal colors, and the delay revisit badge. The synthetic recording captures one fulfillment work item throughout its processing stages.

Drill icons use `detailDiagramId`. Flow icons center below their node labels. Step navigator icons align with trigger text; sequence icons align with message labels. Click the icon or focus its parent and press Enter to open the target's first scenario at its saved occurrence. Enter on the Diagram canvas or selected Diagram tab opens the current linked step. Browser Back restores the source cursor. Clicking elsewhere on the node or message selects a recorded step.

The capture examples cover all four link combinations:

1. Payment handling → Payment capture details: flow to flow.
2. Payment capture details → Payment capture exchange: flow to sequence.
3. Payment callback sequence → Payment capture exchange: sequence to sequence.
4. Payment capture exchange → Payment capture details: sequence to flow.

Authorized payment marks order paid and Captured payment marks the order paid record payment capture followed by marking the order paid. Their intermediate snapshots keep the order pending until the second action. These synthetic detail recordings capture order and payment only. Shipment lifecycle remains self-contained.

**Payment capture exchange** (`payment-capture-sequence`), under **Captured payment marks the order paid**, records Capture the authorized payment followed by Mark the order paid. Order payment application service wraps into two header lines. Authorized customer payment awaiting settlement and capture wraps and ends with an ellipsis; hover to read its complete label.

Payment handling groups Receipt verification and Payment resolution inside Callback processing. Shipment lifecycle uses Carrier handling as a composite-state container, with Delivery in progress and Delivery outcome nested inside it. Redelivery revisits In transit within Delivery in progress; delivery and return paths cross into Delivery outcome before leaving Carrier handling for Fulfillment work closed.

Agents declare containers through `diagrams[].groups` in `publish_explanation`:

```json
"groups": [
  { "id": "carrier-handling", "label": "Carrier handling", "nodeIds": [] },
  { "id": "delivery-in-progress", "label": "Delivery in progress", "nodeIds": ["transit", "delivery-failed"], "parentGroupId": "carrier-handling" }
]
```

The same fields describe flow groups/subgraphs. `nodeIds` lists direct members; `parentGroupId` nests containers. Each node has at most one direct membership. Containers organize recorded behavior; edges and occurrences reference concrete node IDs. Entry, exit, and revisits follow explicit edges. State containers do not infer initial substates, entry/exit actions, or inherited transitions.

1. **New payment queues fulfillment** records receipt creation, payment capture, and one fulfillment work item.
2. **Repeated callback keeps one fulfillment** follows the already-handled branch and revisits `check`. `duplicate-first-check` and `duplicate-verification` have distinct snapshots and lookup counts.
3. **Declined payment stops fulfillment** captures an issuer failure without queuing fulfillment.
4. **First delivery closes fulfillment** creates a shipment, records its tracking number and delivery timestamp, then removes the completed fulfillment queue item. The order-to-shipment link retains the delivery record.
5. **New payment exchange queues fulfillment** records the successful callback as messages between the gateway, payment service, receipt store, and fulfillment queue. Participant lifelines show message order, including a self-message for payment capture.
6. **Retry delivers the parcel** records an unavailable recipient, a second transit visit, and delivery on the second attempt. Occurrence-specific snapshots retain each attempt's state.
7. **Declined redelivery returns the parcel** records a failed delivery and declined redelivery. The returned parcel keeps its reason and timestamp; closing fulfillment work retains the order-to-shipment record.
8. **Repeated payment exchange keeps one fulfillment** records receipt verification and acknowledgement of a retry. The receipt-check message exposes both captured lookups through its occurrence picker.
9. **Declined payment exchange stops fulfillment** records the issuer-failure branch as messages. The payment captures its failure reason and creates no fulfillment work.

Shipment snapshots include carrier, destination city, delivery attempts, delivery issue, return reason, and return timestamp. Select a scenario under Shipment lifecycle or Payment callback sequence to compare the recorded alternatives.

The shared payment sequence defines a receipt-verification loop, an optional handled-receipt response, and an `alt` frame for success, duplicate, and decline. All three scenarios use that layout and select different recorded paths through it.

Snapshots contain complete captured state for each occurrence. An omitted attribute is uncaptured; `null` is captured; an omitted instance is absent. The shipment traversal captures order, fulfillment, and shipment state. Payment and receipt instances are outside that traversal’s captured state.

## Release approval and deployment

`release-promotion.json` records `release-promotion-flow` with Developer, Build pipeline, and Release reviewer lanes. The passing scenario follows submission, build, checks, approval, deployment, and announcement. The retry scenario returns failed checks to the developer, then revisits build and checks with distinct occurrence IDs for the same release instance.

These actors make the approval boundary visible: the pipeline cannot reach the recorded deployment until the reviewer approves. A failure returns responsibility to the developer rather than proceeding to review. Lanes alone express those handoffs; the short process needs no phase groups.

The synthetic assumptions are explicit in each scenario. Fictional releases `rel-42` (1.4.0) and `rel-43` (1.4.1) capture version, status, check result, approval, and build attempt in every nonempty snapshot.

## Incident response and prevention

`incident-recovery.json` records `incident-recovery-flow` with Customer, Support, and Engineering lanes. Support reproduces a customer's failed Invoice downloads; Engineering diagnoses an assumed stale cache key and repairs it. A failed health check revisits repair and health on the same incident. Support verifies recovery, the customer confirms it, and Support closes the incident. Engineering then queues a prevention task; the preventive work remains pending.

Initial assessment groups Support's triage and reproduction. Service restoration groups Engineering's diagnosis, repair, and health check. These phases are strict subsets of their lanes: Support's later verification and closure stay outside Initial assessment, and Engineering's follow-up stays outside Service restoration. Responsibility and phase therefore communicate different boundaries without redundant root groups or nesting.

Both synthetic scenarios capture all seven Incident fields for fictional instances `inc-81` and `inc-82`. Each document has its own minimal domain entity, no relationships, and explicit empty snapshot links. Snapshots are complete captured states, including null values; they are never patches.

## Responsibility lanes

Declare optional flow-only `diagrams[].lanes` as `{id, label, nodeIds}` entries: ≤50 lanes, each with 1–200 existing member nodes. IDs are unique within the diagram and distinct from node/group IDs; labels are nonblank plain text. Each node has at most one explicit lane. Every group's direct and nested descendant nodes share one lane, or all are unassigned. Lanes describe responsibility; concrete edges and occurrences define traversal, with no execution or automatic handoff inferred. Omitted or empty lanes serialize without the field; lane-free schema-version-1 documents remain readable.

The viewer stacks horizontal lanes in authored top-to-bottom order with shared width and a left heading compartment. Nodes without lanes occupy an implicit final Unassigned band when needed. Compact views retain bands containing visible nodes in authored order. Lane frames and headings stay neutral in both themes; nested groups retain containment and traversal emphasis.

IDs, references, edge continuity, relationship endpoints, and cardinalities follow `architecture.md`. These examples contain fictional identifiers and no credentials. Labels and prose are inert text. Redact sensitive captured values before publication.
