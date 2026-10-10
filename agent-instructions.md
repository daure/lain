# Publishing explanations to Lain

Lain accepts recorded software explanations through MCP. Use `list_explanations`, `get_explanation`, `publish_explanation`, and `delete_explanation`. Tool discovery provides the JSON schema. The server validates the complete document before replacing a saved revision.

## Authoring

1. Name the explanation and describe its scope. Separate verified behavior from assumptions in the narration.
2. Define domain entities, attributes, and relationships with stable IDs. Use those attribute IDs as snapshot value keys.
3. Define behavioral diagrams as structured nodes and edges. A diagram describes possible behavior, not a scenario's history.
4. Attach concrete scenarios to shared diagrams. Each scenario traverses the definitions owned by its diagram; an explanation may contain multiple diagrams.
5. Record each scenario as ordered occurrences. Give each occurrence a distinct ID, even when a node is visited repeatedly.
6. Record each occurrence's trigger, narration, complete before snapshot, and complete after snapshot. Do not place mutable snapshots on diagram nodes.

The first occurrence has `incomingEdgeId: null`. Every later occurrence references an edge from the previous node to its node. Use a self-loop for consecutive visits to the same node. All referenced nodes, entities, attributes, instances, and relationships must exist.

For `kind: "sequence"`, define `sequence.participants` as `{id, label}` objects and `sequence.messages` as `{nodeId, fromParticipantId, toParticipantId}` objects. Map every diagram node exactly once to a message between declared participants. A sender may also be its receiver. Nodes provide message labels; edges describe valid temporal transitions.

Declare the shared interaction in a required, ordered `sequence.body`:

```json
[
  { "kind": "message", "nodeId": "request" },
  { "kind": "alt", "id": "result", "operands": [
    { "id": "accepted", "guard": "Request accepted", "body": [{ "kind": "message", "nodeId": "success" }] },
    { "id": "rejected", "guard": "Request rejected", "body": [{ "kind": "message", "nodeId": "failure" }] }
  ] }
]
```

Reference each message node exactly once in this tree. An `alt` contains 2–20 guarded operands; each visit chooses one operand. An `opt` is `{kind: "opt", id, guard, body}` and may be skipped. A `loop` uses the same fields with `kind: "loop"` and permits zero or more iterations. Use unique fragment/operand IDs, nonempty bodies, and nonblank guards. Guards describe conditions as text; Lain never evaluates them. Keep structure within 500 items and eight nesting levels, subject to the document's JSON depth limit.

Record scenarios in the order allowed by both the shared body and declared edges. A recording may stop at a valid prefix. Loop iterations reuse message definitions but require distinct occurrence IDs and snapshots. The full diagram keeps alternative branches visible; repeated messages expose their captured visits through an occurrence picker.

Snapshots contain concrete instances and relationship links. Missing instances are absent; missing attributes are uncaptured; null is an explicitly captured value. Keep an instance ID attached to the same entity throughout a scenario. Values may be strings, numbers, booleans, null, arrays, or objects.

Encode integers outside ±9,007,199,254,740,991 as strings. Use strings for exact decimals when rounding would matter, including precise financial values. Browser JSON numbers use IEEE-754 doubles.

Use text, not HTML, SVG, scripts, executable expressions, or externally loaded diagram content. Keep labels short. Narration should explain the cause and observed result of one occurrence. Do not present inferred production values as captured facts.

## Publication

Create with `expectedRevision: 0` and a stable explanation ID. Update by fetching the current document, reconciling changes, and publishing with its revision. Never retry a revision conflict by blindly replacing the latest revision.

Delete only when requested, using `delete_explanation` with the current revision. Deleted IDs retain their revision sequence when recreated with `expectedRevision: 0`.

A successful result means the entire document is committed. Browser notifications are invalidations; a disconnected browser can refetch the saved revision. Navigation position belongs to the viewer and is not part of the authored document.

If a publication request disconnects or times out, fetch the explanation before retrying. The server completes an accepted write independently of the caller's connection.

## Privacy

Redact credentials, tokens, personal data, and private source material before publication. Use synthetic instance values when exact values are unnecessary. Saved explanations retain all captured values. Never include Lain's local bearer credential in document data.

See `examples/order-lifecycle.json` for flow, state, and sequence examples, and `architecture.md` for limits and reference rules.
