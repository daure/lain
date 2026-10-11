# Publishing explanations to Lain

Lain accepts recorded software explanations through MCP. Use `list_explanations`, `get_explanation`, `publish_explanation`, and `delete_explanation`. Tool discovery provides the JSON schema. The server validates the complete document before replacing a saved revision.

## Authoring

Specify `sourceCardinality` and `targetCardinality` on every relationship as `zeroOrOne` (0..1), `exactlyOne` (1..1), `zeroOrMore` (0..*), or `oneOrMore` (1..*). Source cardinality counts sources per target; target cardinality counts targets per source. Every present instance in each snapshot satisfies the declared link bounds. Choose minimums from verified domain rules; label assumptions in the explanation.

1. Name the explanation and describe its scope. Separate verified behavior from assumptions in the narration.
2. Define domain entities, attributes, and relationships with stable IDs. Use those attribute IDs as snapshot value keys.
3. Define behavioral diagrams as structured nodes and edges. A diagram describes possible behavior, not a scenario's history.
4. Attach concrete scenarios to shared diagrams. Give every scenario a `description` explaining its actor, setup, goal, and recorded outcome or stopping point. Each scenario traverses the definitions owned by its diagram; an explanation may contain multiple diagrams.
5. Record each scenario as ordered occurrences. Give each occurrence a distinct ID, even when a node is visited repeatedly.
6. Record each occurrence's trigger, narration, complete before snapshot, and complete after snapshot. Write narration as readable paragraphs explaining this visit's action, cause, and observed consequence. Do not place mutable snapshots on diagram nodes.

## Details prose

The Details tab displays agent-authored text. Its fixed scenario overview uses `scenarios[].description`; the section below uses the selected occurrence's `narration`. Separate paragraphs with blank lines. Keep the overview meaningful at every step, including revisits. State assumptions and synthetic examples explicitly. A recording that ends early needs a stopping point, not a claimed successful outcome.

Use optional `occurrences[].changeSummary` for a concise explanation of meaningful changes in that visit's before/after snapshots. Distinguish state changes from differences in capture. Missing attributes are unknown, not unchanged; null is a captured value. Keep raw values in snapshots, and avoid repeating the narration. Omit the summary when it adds no useful context. Description and changeSummary are optional schema-version-1 fields; omitted or empty descriptions show a missing-description notice. Author descriptions for every new scenario. Each text field is bounded to 32 KiB.

```json
{
  "description": "A gateway sends a new authorized-payment callback for a pending order. The service checks its receipt, captures the payment, and queues one fulfillment item.",
  "occurrences": [{
    "narration": "The receipt is unhandled and the issuer authorized the payment, so the service captures it and marks the order paid.\n\nThe order can now proceed to fulfillment.",
    "changeSummary": "The payment becomes captured and the order becomes paid. The failure reason is captured as null; it was uncaptured before this visit."
  }]
}
```

This excerpt shows prose fields; publication requires the complete scenario and occurrence objects from tool discovery. Recorded `methodCalls` appear in authored order in Details and link to their shared definitions through Domain. Lain never generates prose or infers calls.

## Detail diagrams

Set `diagrams[].nodes[].detailDiagramId` to another flow or sequence diagram in the same explanation. Flow sources use `role: "subprocess"`; sequence sources are message nodes with no flow role. State diagrams are self-contained and cannot be link sources or targets. A node cannot link to its own diagram.

Give each detail diagram a recorded scenario with its own stable occurrence IDs and complete before/after snapshots. Click its drill icon or press Enter on the focused node, message, or step to open the target's first scenario at its saved occurrence. Browser Back restores the source recording. A target with no recorded scenario has an inactive icon. Links are navigation, never execution or automatic expansion. Cross-diagram cycles are valid because each jump is an explicit user action.

For example, a flow capture node may use `{"id": "capture", "label": "Capture payment", "entityIds": ["payment"], "role": "subprocess", "detailDiagramId": "capture-exchange"}` to open a sequence detail. A sequence message node uses the same `detailDiagramId` field and omits `role`. The input alias `subprocessDiagramId` is accepted for stored documents; publication serializes the canonical `detailDiagramId` field. Specify one spelling per node.

## Recorded structure

Domain entities may include an ordered `methods` array. Each method is `{id, signature, description}`: use a stable ID, a nonblank signature with parameters and return type when known, and a plain-text description of its domain behavior. Descriptions may be empty. For example: `{ "id": "mark-paid", "signature": "markPaid(paymentId: string): void", "description": "Mark the order paid after payment capture." }`. Method IDs are unique within an entity's methods collection. Omit methods when behavior is unknown. Keep at most 200 methods per entity; each text field is bounded to 32 KiB. Methods are descriptive definitions, never executable actions or snapshot value keys. The Domain view places them below attributes in a separate compartment and exposes their details in the entity inspector.

Record verified method calls on an occurrence with optional `methodCalls: [{entityId, methodId, instanceId?}]`. Entity and method references must resolve to a domain method. An optional receiver instance must appear in that occurrence’s before or after snapshot with the matching entity. Preserve call order and repeated calls; keep at most 500 calls per occurrence. Omission means no calls recorded, not proof that none occurred. Calls belong to individual visits and may exist without property changes. The Domain view highlights calls and compares only the selected occurrence’s snapshots; it does not infer calls from triggers, labels, or narration.

The first occurrence has `incomingEdgeId: null`. Every later occurrence references an edge from the previous node to its node. Use a self-loop for consecutive visits to the same node. All referenced nodes, entities, attributes, instances, and relationships must exist.

For flow/state containers, define `diagrams[].groups` as `{id, label, nodeIds, parentGroupId?}` objects. State groups are composite-state containers; flow groups are subgraphs. `nodeIds` lists direct member nodes in the same diagram. A node has at most one direct membership. Optional `parentGroupId` nests a group inside another group in that diagram. Use unique group IDs distinct from node IDs and nonblank text labels. Keep at most 100 groups, 200 direct members per group, and eight acyclic nesting levels. Every group needs a node directly or through descendants; a parent containing only child groups uses `nodeIds: []`.

Groups organize recorded behavior. Edges and occurrences reference concrete nodes, including entry/exit across frames and revisits inside them. State groups do not infer initial substates, entry/exit actions, or inherited transitions. Sequence diagrams use sequence fragments for containment. See `examples/README.md` for a nested group payload.

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
