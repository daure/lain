# Examples

## Order lifecycle

`order-lifecycle.json` is a schema-version-1 authored explanation. Publish with `lain demo` against a running daemon, or send the document through `publish_explanation` with a stable ID and the expected revision. The browser loads committed explanations from the API; it does not publish examples on startup.

Payment handling uses all five flow-node roles: Callback received is the start, Receipt checked is a decision diamond, Capture the payment is a double-bordered subprocess, Event already handled is an action box, and the success, duplicate, and decline endpoints are end terminators. Select Diagram to see the full left-to-right flow. Details keeps the agent-authored scenario description above the current step's narration and recorded method calls.

Drill icons use `detailDiagramId`. Flow icons center below their node labels. Sidebar and step navigator icons align with trigger text; sequence icons align with message labels. Click the icon or focus its parent and press Enter to open the target's first scenario at its saved occurrence. Enter on the Diagram canvas or selected Diagram tab opens the current linked step. Browser Back restores the source cursor. Clicking elsewhere on the node or message selects a recorded step.

The capture examples cover all four link combinations:

1. Payment handling → Payment capture details: flow to flow.
2. Payment capture details → Payment capture exchange: flow to sequence.
3. Payment callback sequence → Payment capture exchange: sequence to sequence.
4. Payment capture exchange → Payment capture details: sequence to flow.

Capture and mark paid and Capture interaction record payment capture followed by marking the order paid. Their intermediate snapshots keep the order pending until the second action. These synthetic detail recordings capture order and payment only. Shipment lifecycle remains self-contained.

Payment handling groups Receipt verification and Payment resolution inside Callback processing. Shipment lifecycle uses Carrier handling as a composite-state container, with Delivery in progress and Delivery outcome nested inside it. Redelivery revisits In transit within Delivery in progress; delivery and return paths cross into Delivery outcome before leaving Carrier handling for Fulfillment work closed.

Agents declare containers through `diagrams[].groups` in `publish_explanation`:

```json
"groups": [
  { "id": "carrier-handling", "label": "Carrier handling", "nodeIds": [] },
  { "id": "delivery-in-progress", "label": "Delivery in progress", "nodeIds": ["transit", "delivery-failed"], "parentGroupId": "carrier-handling" }
]
```

The same fields describe flow groups/subgraphs. `nodeIds` lists direct members; `parentGroupId` nests containers. Each node has at most one direct membership. Containers organize recorded behavior; edges and occurrences reference concrete node IDs. Entry, exit, and revisits follow explicit edges. State containers do not infer initial substates, entry/exit actions, or inherited transitions.

1. **Successful callback** records receipt creation, payment capture, and one fulfillment work item.
2. **Duplicate callback** follows the already-handled branch and revisits `check`. `duplicate-first-check` and `duplicate-verification` have distinct snapshots and lookup counts.
3. **Declined payment** captures an issuer failure without queuing fulfillment.
4. **Parcel delivered** creates a shipment, records its tracking number and delivery timestamp, then removes the completed fulfillment queue item. The order-to-shipment link retains the delivery record.
5. **Successful payment exchange** records the successful callback as messages between the gateway, payment service, receipt store, and fulfillment queue. Participant lifelines show message order, including a self-message for payment capture.
6. **Delivery after redelivery** records an unavailable recipient, a second transit visit, and delivery on the second attempt. Occurrence-specific snapshots retain each attempt's state.
7. **Returned to sender** records a failed delivery and declined redelivery. The returned parcel keeps its reason and timestamp; closing fulfillment work retains the order-to-shipment record.
8. **Duplicate payment exchange** records receipt verification and acknowledgement of a retry. The receipt-check message exposes both captured lookups through its occurrence picker.
9. **Declined payment exchange** records the issuer-failure branch as messages. The payment captures its failure reason and creates no fulfillment work.

Shipment snapshots include carrier, destination city, delivery attempts, delivery issue, return reason, and return timestamp. Select a scenario under Shipment lifecycle or Payment callback sequence to compare the recorded alternatives.

The shared payment sequence defines a receipt-verification loop, an optional handled-receipt response, and an `alt` frame for success, duplicate, and decline. All three scenarios use that layout and select different recorded paths through it.

Snapshots contain complete captured state for each occurrence. An omitted attribute is uncaptured; `null` is captured; an omitted instance is absent. The shipment traversal captures order, fulfillment, and shipment state. Payment and receipt instances are outside that traversal’s captured state.

IDs, references, edge continuity, relationship endpoints, and cardinalities follow `architecture.md`. The example contains fictional identifiers and no credentials. Redact sensitive captured values before publication.
