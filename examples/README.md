# Examples

## Order lifecycle

`order-lifecycle.json` is a schema-version-1 authored explanation. Publish with `lain demo` against a running daemon, or send the document through `publish_explanation` with a stable ID and the expected revision. The browser loads committed explanations from the API; it does not publish examples on startup.

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
