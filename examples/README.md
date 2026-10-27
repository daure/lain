# Examples

## Publish the demos

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
| `pr-comment-review` | `pr-comment-review.json` |
| `shopping-cart` | `shopping-cart.json` |

For an individual MCP publication, call `get_context` first, then `publish_explanation({id, document})` with the matching ID and the file's complete parsed JSON object as `document`. A filename or partial document is not a publication payload. Publication atomically creates, replaces, or recreates that ID; the last commit wins. The browser loads committed explanations from the API; it does not publish examples on startup.

## Order lifecycle

`order-lifecycle.json` records payment handling, shipment state, and payment messages with shared domain relationships.

Overview organizes these recordings under Payment handling, Packing and dispatch, Delivery outcomes, and Payment internals. Payment handling combines flow and message scenarios under one reader question. Scenario tags pair recorded IDs with short terms, such as `evt_481` and Duplicate or `ship-88` and Retry. Each tag uses 1–20 characters. Explicit comparisons contrast payment outcomes, action/message perspectives, and redelivery/return outcomes. Comparisons present authored summaries; they do not align steps automatically.

Payment handling demonstrates five flow-node roles: Callback received is the start, Receipt checked is a decision diamond, Capture the payment is a double-bordered subprocess, Event already handled is an action box, and the success, duplicate, and decline endpoints are end terminators. Diagram shows the full left-to-right flow. Hover a scenario or press D to read its description; the data inspector's Calls tab shows recorded method calls.

**Dispatch preparation** (`dispatch-preparation-flow`) demonstrates the other nine roles in **Priority order packed and dispatched**. Scan packing request uses `inputOutput`; Prepare workstation uses `preparation`; Save dispatch work uses `database`; Expedite priority order uses `priorityAction`; Pack parcel by hand uses `manualOperation`; Create invoice uses `document`; Print dispatch documents uses `multiDocument`; Wait for carrier uses `delay`; Send dispatch notice uses `outputInput`. Pills mark entry and completion. The two recorded visits to Wait for carrier have distinct occurrence IDs and snapshots. Grouped intake, packing, and dispatch steps exercise containment, curved connectors, traversal colors, and the delay revisit badge. The synthetic recording captures one fulfillment work item throughout its processing stages.

Drill icons use `detailDiagramId`. Flow icons center below their node labels. Step navigator icons align with trigger text; sequence icons align with message labels. Click the icon or focus its parent and press Enter to open the target's first scenario at its saved occurrence. Enter on the Diagram canvas or selected Diagram tab opens the current linked step. Browser Back restores the source cursor. Clicking elsewhere on the node or message selects a recorded step.

The capture examples cover all four link combinations:

1. Payment handling → Payment capture details: flow to flow.
2. Payment capture details → Payment capture exchange: flow to sequence.
3. Payment callback sequence → Payment capture exchange: sequence to sequence.
4. Payment capture exchange → Payment capture details: sequence to flow.

Authorized payment marks order paid and Captured payment marks the order paid record payment capture followed by marking the order paid. Their intermediate snapshots keep the order pending until the second action. These synthetic detail recordings capture order and payment only. Shipment lifecycle remains self-contained.

**Payment capture exchange** (`payment-capture-sequence`), under **Captured payment marks the order paid**, records Capture the authorized payment followed by Mark the order paid. Order payment application service wraps into two header lines. Authorized customer payment awaiting settlement and capture wraps and ends with an ellipsis; hover to read its complete label.

**Dispatch request exchange** (`dispatch-request-sequence`), under **Operator queues paid order dispatch**, shows all three message kinds. The warehouse operator's synchronous request has a solid filled arrow; queuing dispatch work has a solid open arrow; HTTP 202 acceptance returns on a dashed open arrow. Participant boxes prepend person and monitor icons for `human` and `system`. Dashed lifelines remain consistent. The snapshots capture paid order ORD-1042 and creation of queued work; acceptance does not mean packing or delivery has finished.

Payment handling groups Receipt verification and Payment resolution inside Callback processing. Shipment lifecycle uses Carrier handling as a composite-state container, with Delivery in progress and Delivery outcome nested inside it. Redelivery revisits In transit within Delivery in progress; delivery and return paths cross into Delivery outcome before leaving Carrier handling for Fulfillment work closed.

**Shipment lifecycle** (`shipment-state`) shows an initial filled circle before Parcel packed and a final ring with a filled center after Fulfillment work closed. Select any shipment scenario, then Diagram. Hover either marker for its lifecycle-boundary label. The recordings begin at Parcel packed and stop at Fulfillment work closed; the declared boundaries remain visible without synthetic marker visits or snapshots.

Its transitions show separate event, bracketed guard, and slash-prefixed effect components. Carrier pickup `[Parcel packed] / Assign tracking` describes dispatch. Delivery attempted `[Recipient unavailable] / Record failed attempt` describes the failure branch, while Redelivery scheduled `[Recipient agrees] / Dispatch again` explains the revisit. All fields are descriptive; guards do not run against snapshots. Hover a caption for its complete text. Chart exports retain markers and structured captions.

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

Payment callback messages use calls for receipt lookup and payment operations, asynchronous sends for fulfillment, and replies for handled receipts and duplicate acknowledgements. Select the successful scenario to see off-scenario replies retain their dashes while dimmed; off-scenario calls and fragment borders stay solid. Omitted participant and message kinds in Payment capture exchange use system icons and call arrows.

Snapshots contain complete captured state for each occurrence. An omitted attribute is uncaptured; `null` is captured; an omitted instance is absent. The shipment traversal captures order, fulfillment, and shipment state. Payment and receipt instances are outside that traversal’s captured state.

The optional Wiring tab shares one feature-level inventory across these scenarios. Callback/dispatch endpoints and warehouse screens belong to their software owners. Each recorded visit has an explicit mapping, including an empty mapping for manual packing. Synthetic software responsibilities are labelled assumptions. Duplicate and declined callbacks leave fulfillment publication outside their mapped scope even when a snapshot contains queued work. `warehouse-ui-dispatch` demonstrates a synthetic UI submission that stops at accepted queue work. Fictional `DEMO-101` and `DEMO-102` work references demonstrate shared attachments without claiming ticket ordering.

## Shopping cart Wiring

`shopping-cart.json` is a self-contained synthetic checkout explanation. Wiring shows Angular screens and child components, Spring REST endpoints, individual SELECT/UPDATE/INSERT operations owned by PostgreSQL stores, a payment provider, SNS topic fan-out to SQS, Lambda receipt consumption, and Datadog trace export. Products, contracts, transactions, transport settings, telemetry, and work references are labelled assumptions. Nested groups describe responsibility, not IAM, network access, or deployment topology.

`cart-current-no-hold` has Current and No stock hold badges and stops after authorizing a two-bottle basket without calling Inventory. `cart-checkout-success` has Proposed and Happy path badges and records a hold before payment, then order commitment, publication, and receipt processing. Their Overview comparison contrasts authored recordings; it does not align steps or compute diffs. `cart-stock-rejected` records the stock SELECT without a hold INSERT, stock UPDATE, payment, or receipt publication. `cart-payment-retry` reads the existing hold without creating another one. Revisited payment/review nodes keep distinct occurrence IDs and mappings. Local review uses explicit empty mappings; `retry-second-review` intentionally omits its mapping so **Mapping not recorded** remains visible.

Open Wiring to inspect every owner-local operation/screen port and its individual wires. `persist-cart` is the basket SELECT; `write-cart` and `write-cart-total` are separate UPDATE wires. `publish-order` reaches SNS, `fanout-order` reaches SQS, and `consume-order` reaches Lambda only at the recorded receipt step. Trace wires are mapped only on recorded synthetic export steps. The missing `release-stock` DELETE remains off-scenario.

Contracts show typed fields separated into request, response, error, record, message, and telemetry sections. Missing expiry, idempotency, and error DTO fields name contract work; they do not claim a production endpoint was measured. Required and nullable are independent. `technology.icon` selects bundled identifiers such as `angular`, `spring`, `postgresql`, and `datadog`; unknown identifiers use a kind fallback rather than loading an asset.

Select an illustrative work key to see shared attachments without advancing playback. **Focus current step** frames mapped owners and complete wire paths once; later steps retain the single camera. Details link to matching recorded occurrences and safe optional work URLs. Diagram/Domain exports omit wiring mappings while stored explanations keep them. `tests/browser-wiring-smoke.cjs` checks Wiring against an isolated preview with this fixture.

## Release approval and deployment

Release readiness pairs Happy path and Retry recordings under one topic. Its comparison explains why the failed candidate must return through checks before deployment.

`release-promotion.json` records `release-promotion-flow` with Developer, Build pipeline, and Release reviewer lanes. The passing scenario follows submission, build, checks, approval, deployment, and announcement. The retry scenario returns failed checks to the developer, then revisits build and checks with distinct occurrence IDs for the same release instance.

These actors make the approval boundary visible: the pipeline cannot reach the recorded deployment until the reviewer approves. A failure returns responsibility to the developer rather than proceeding to review. Lanes alone express those handoffs; the short process needs no phase groups.

The synthetic assumptions are explicit in each scenario. Fictional releases `rel-42` (1.4.0) and `rel-43` (1.4.1) capture version, status, check result, approval, and build attempt in every nonempty snapshot.

## Incident response and prevention

Restoring invoice downloads pairs the first repair and retry recordings. Its Overview distinguishes confirmed recovery from the prevention task that remains queued.

`incident-recovery.json` records `incident-recovery-flow` with Customer, Support, and Engineering lanes. Support reproduces a customer's failed Invoice downloads; Engineering diagnoses an assumed stale cache key and repairs it. A failed health check revisits repair and health on the same incident. Support verifies recovery, the customer confirms it, and Support closes the incident. Engineering then queues a prevention task; the preventive work remains pending.

Initial assessment groups Support's triage and reproduction. Service restoration groups Engineering's diagnosis, repair, and health check. These phases are strict subsets of their lanes: Support's later verification and closure stay outside Initial assessment, and Engineering's follow-up stays outside Service restoration. Responsibility and phase therefore communicate different boundaries without redundant root groups or nesting.

Both synthetic scenarios capture all seven Incident fields for fictional instances `inc-81` and `inc-82`. Each document has its own minimal domain entity, no relationships, and explicit empty snapshot links. Snapshots are complete captured states, including null values; they are never patches.

## Responsibility lanes

Prefer containers when grouping clarifies a subprocess or domain boundary. Use responsibility lanes when real handoffs add clear value beyond containment.

Declare optional flow-only `diagrams[].lanes` as `{id, label, nodeIds}` entries: ≤50 lanes, each with 1–200 existing member nodes. IDs are unique within the diagram and distinct from node/group IDs; labels are nonblank plain text. Each node has at most one explicit lane. Every group's direct and nested descendant nodes share one lane, or all are unassigned. Lanes describe responsibility; concrete edges and occurrences define traversal, with no execution or automatic handoff inferred. Omitted or empty lanes serialize without the field; lane-free schema-version-1 documents remain readable.

The viewer stacks horizontal lanes in authored top-to-bottom order with shared width and a left heading compartment. Nodes without lanes occupy an implicit final Unassigned band when needed. Compact views retain bands containing visible nodes in authored order. Lane frames and headings stay neutral in both themes; nested groups retain containment and traversal emphasis.

IDs, references, edge continuity, relationship endpoints, and cardinalities follow `architecture.md`. These examples contain fictional identifiers and no credentials. Labels and prose are inert text. Redact sensitive captured values before publication.

## Payment callback review comments

`pr-comment-review.json` examines two fictional review comments under separate topics: Repeated callback work and Failed queue write. Each topic pairs Current and Proposed scenarios that share a setup but use different diagrams. The synthetic current handler queues duplicate work or acknowledges a failed queue write. The proposals check a handled receipt and retry a failed write before acknowledgement.

Read Compare scenarios in Overview, open either recording, and use its comparison-partner link to switch. Each scenario retains its recorded cursor. The Current and Proposed badges identify the side; descriptions state assumptions and limits. The receipt-check example covers sequential retries, not concurrent delivery guarantees. The queue-recovery example assumes one successful retry and does not establish a production retry policy.
