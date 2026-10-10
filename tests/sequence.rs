use lain::{
    model::{Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::{Value, json};

fn message(id: &str) -> Value {
    json!({"kind": "message", "nodeId": id})
}

fn interaction(body: Value, trace: &[&str]) -> Explanation {
    let nodes = ["start", "a", "b", "c", "end"];
    let edges: Vec<_> = nodes.iter().flat_map(|from| nodes.iter().map(move |to|
        json!({"id": format!("{from}-{to}"), "sourceNodeId": from, "targetNodeId": to, "label": "Observed transition"})
    )).collect();
    serde_json::from_value(json!({
        "schemaVersion": 1, "title": "Shared interaction", "description": "Recorded alternatives",
        "domain": {"entities": [], "relationships": []},
        "diagrams": [{"id": "interaction", "title": "Interaction", "kind": "sequence",
            "nodes": nodes.iter().map(|id| json!({"id": id, "label": id, "entityIds": []})).collect::<Vec<_>>(),
            "edges": edges,
            "sequence": {
                "participants": [{"id": "service", "label": "Service"}],
                "messages": nodes.iter().map(|id| json!({"nodeId": id, "fromParticipantId": "service", "toParticipantId": "service"})).collect::<Vec<_>>(),
                "body": body
            }
        }],
        "scenarios": [{"id": "run", "title": "Run", "diagramId": "interaction",
            "occurrences": trace.iter().enumerate().map(|(index, node)| json!({
                "id": format!("visit-{index}"), "nodeId": node,
                "incomingEdgeId": if index == 0 { None } else { Some(format!("{}-{node}", trace[index - 1])) },
                "trigger": null, "narration": "Observed message",
                "before": {"instances": [], "links": []}, "after": {"instances": [], "links": []}
            })).collect::<Vec<_>>()
        }]
    })).unwrap()
}

fn body() -> Value {
    json!([
        message("start"),
        {"kind": "alt", "id": "outcome", "operands": [
            {"id": "accepted", "guard": "Accepted <script>not executable</script>", "body": [message("a")]},
            {"id": "declined", "guard": "Declined", "body": [message("b")]}
        ]},
        {"kind": "loop", "id": "verification", "guard": "Verification repeats", "body": [message("c")]},
        message("end")
    ])
}

#[tokio::test]
async fn publication_enforces_shared_order_branches_and_loop_revisits_atomically() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("state.sqlite"))
        .await
        .unwrap();
    for trace in [
        vec!["start", "a", "c", "c", "end"],
        vec!["start", "b", "end"],
        vec!["start", "a"],
    ] {
        interaction(body(), &trace).validate().unwrap();
    }
    let authored = interaction(body(), &["start", "a", "c", "c", "end"]);
    let expected = serde_json::to_value(&authored).unwrap();
    service
        .publish(
            "interaction",
            PublishRequest {
                expected_revision: 0,
                document: authored,
            },
        )
        .await
        .unwrap();
    for trace in [
        vec!["a"],
        vec!["start", "end"],
        vec!["start", "a", "b"],
        vec!["start", "a", "a"],
        vec!["start", "a", "end", "c"],
    ] {
        let rejected = service
            .publish(
                "interaction",
                PublishRequest {
                    expected_revision: 1,
                    document: interaction(body(), &trace),
                },
            )
            .await;
        assert!(
            matches!(rejected, Err(ServiceError::Invalid(ref error)) if error.contains("shared sequence ordering")),
            "{rejected:?}"
        );
    }
    let saved = service.get("interaction").await.unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(serde_json::to_value(saved.document).unwrap(), expected);
}

#[test]
fn nested_fragments_allow_per_iteration_choices_optional_steps_and_nullable_loops() {
    let nested = json!([
        message("start"),
        {"kind": "loop", "id": "attempt", "guard": "Another attempt", "body": [
            {"kind": "alt", "id": "outcome", "operands": [
                {"id": "accepted", "guard": "Accepted", "body": [message("a")]},
                {"id": "declined", "guard": "Declined", "body": [message("b")]}
            ]},
            {"kind": "loop", "id": "checks", "guard": "More checks", "body": [message("c")]}
        ]},
        message("end")
    ]);
    interaction(nested.clone(), &["start", "a", "c", "c", "b", "a", "end"])
        .validate()
        .unwrap();
    interaction(nested, &["start", "end"]).validate().unwrap();
    let nullable = json!([
        message("start"),
        {"kind": "loop", "id": "attempt", "guard": "More observations", "body": [
            {"kind": "opt", "id": "decision", "guard": "Decision observed", "body": [
                {"kind": "alt", "id": "outcome", "operands": [
                    {"id": "accepted", "guard": "Accepted", "body": [message("a")]},
                    {"id": "declined", "guard": "Declined", "body": [message("b")]}
                ]}
            ]},
            {"kind": "opt", "id": "check", "guard": "Check observed", "body": [message("c")]}
        ]},
        message("end")
    ]);
    interaction(nullable.clone(), &["start", "a", "c", "b", "end"])
        .validate()
        .unwrap();
    interaction(nullable, &["start", "end"]).validate().unwrap();
}

#[test]
fn shared_structure_requires_complete_unique_references_guards_and_bounded_nesting() {
    let original = serde_json::to_value(interaction(body(), &["start", "a"])).unwrap();
    for (pointer, replacement, expected) in [
        ("/diagrams/0/sequence/body", json!([]), "nonempty"),
        (
            "/diagrams/0/sequence/body/3/nodeId",
            json!("unknown"),
            "every message node",
        ),
        (
            "/diagrams/0/sequence/body/3/nodeId",
            json!("start"),
            "duplicate sequence body message",
        ),
        (
            "/diagrams/0/sequence/body/1/operands/0/body",
            json!([]),
            "nonempty",
        ),
        (
            "/diagrams/0/sequence/body/1/operands/0/guard",
            json!("  "),
            "guards must contain text",
        ),
        (
            "/diagrams/0/sequence/body/1/id",
            json!("bad/id"),
            "invalid ID",
        ),
        (
            "/diagrams/0/sequence/body/1/operands/0/id",
            json!("outcome"),
            "duplicate sequence fragment",
        ),
        ("/diagrams/0/sequence/body/1/operands", json!([]), "2–20"),
    ] {
        let mut value = original.clone();
        *value.pointer_mut(pointer).unwrap() = replacement;
        let error = serde_json::from_value::<Explanation>(value)
            .unwrap()
            .validate()
            .unwrap_err();
        assert!(error.contains(expected), "{error}");
    }
    let mut missing = original.clone();
    missing["diagrams"][0]["sequence"]
        .as_object_mut()
        .unwrap()
        .remove("body");
    let stored: Explanation = serde_json::from_value(missing).unwrap();
    assert!(stored.validate().unwrap_err().contains("nonempty"));
    let mut nested = body();
    for depth in 0..9 {
        nested = json!([{"kind": "opt", "id": format!("nested-{depth}"), "guard": "Observed", "body": nested}]);
    }
    assert!(
        interaction(nested, &["start"])
            .validate()
            .unwrap_err()
            .contains("nesting exceeds")
    );
    for pointer in [
        "/diagrams/0/sequence/body/0",
        "/diagrams/0/sequence/body/1",
        "/diagrams/0/sequence/body/1/operands/0",
    ] {
        let mut value = original.clone();
        value.pointer_mut(pointer).unwrap()["unknown"] = json!(true);
        assert!(serde_json::from_value::<Explanation>(value).is_err());
    }
}
