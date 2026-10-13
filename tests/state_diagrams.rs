use lain::{
    model::{Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::{Value, json};

fn document() -> Value {
    json!({
        "schemaVersion": 1, "title": "Order lifecycle", "description": "Synthetic lifecycle recording",
        "domain": {"entities": [], "relationships": []},
        "diagrams": [{"id": "states", "title": "Order states", "kind": "state", "nodes": [
            {"id": "initial", "label": "Lifecycle begins", "entityIds": [], "stateRole": "initial"},
            {"id": "pending", "label": "Pending", "entityIds": []},
            {"id": "paid", "label": "Paid", "entityIds": []},
            {"id": "final", "label": "Lifecycle complete", "entityIds": [], "stateRole": "final"}
        ], "edges": [
            {"id": "begin", "sourceNodeId": "initial", "targetNodeId": "pending", "label": ""},
            {"id": "pay", "sourceNodeId": "pending", "targetNodeId": "paid", "label": "Fallback", "transition": {
                "event": "Payment received", "guard": "Full amount", "effect": "Issue receipt"
            }},
            {"id": "finish", "sourceNodeId": "paid", "targetNodeId": "final", "label": ""}
        ]}],
        "scenarios": [{"id": "recording", "title": "Payment observed", "diagramId": "states", "occurrences": [{
            "id": "pending-visit", "nodeId": "pending", "incomingEdgeId": null, "trigger": null,
            "narration": "Pending order observed", "before": {"instances": [], "links": []},
            "after": {"instances": [], "links": []}
        }]}]
    })
}

#[tokio::test]
async fn state_boundaries_and_descriptive_transitions_survive_publication_and_reopening() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("states.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let authored: Explanation = serde_json::from_value(document()).unwrap();
    service
        .publish("states", PublishRequest { document: authored })
        .await
        .unwrap();
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    let saved = reopened.get("states").await.unwrap();
    assert_eq!(serde_json::to_value(saved.document).unwrap(), document());
}

#[tokio::test]
async fn invalid_state_definitions_leave_the_saved_document_unchanged() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("states.sqlite"))
        .await
        .unwrap();
    service
        .publish(
            "states",
            PublishRequest {
                document: serde_json::from_value(document()).unwrap(),
            },
        )
        .await
        .unwrap();
    for (pointer, replacement, expected) in [
        (
            "/diagrams/0/kind",
            json!("flow"),
            "stateRole requires kind state",
        ),
        (
            "/diagrams/0/edges/1/targetNodeId",
            json!("initial"),
            "initial markers cannot have incoming edges",
        ),
        (
            "/diagrams/0/edges/0/sourceNodeId",
            json!("pending"),
            "initial markers require exactly one outgoing edge",
        ),
        (
            "/diagrams/0/edges/1/sourceNodeId",
            json!("initial"),
            "initial markers require exactly one outgoing edge",
        ),
        (
            "/diagrams/0/edges/1/sourceNodeId",
            json!("final"),
            "final markers cannot have outgoing edges",
        ),
        (
            "/diagrams/0/edges/1/transition",
            json!({}),
            "transition requires an event, guard, or effect",
        ),
        (
            "/diagrams/0/edges/1/transition",
            json!({"event": null, "guard": null, "effect": null}),
            "transition requires an event, guard, or effect",
        ),
        (
            "/diagrams/0/edges/1/transition/event",
            json!(" \n\t"),
            "transition event must not be blank",
        ),
        (
            "/diagrams/0/edges/1/transition/guard",
            json!(" "),
            "transition guard must not be blank",
        ),
        (
            "/diagrams/0/edges/1/transition/effect",
            json!(" "),
            "transition effect must not be blank",
        ),
        (
            "/diagrams/0/edges/1/transition/effect",
            json!("x".repeat(32769)),
            "text bytes",
        ),
    ] {
        let mut invalid = document();
        *invalid.pointer_mut(pointer).unwrap() = replacement;
        let result = service
            .publish(
                "states",
                PublishRequest {
                    document: serde_json::from_value(invalid).unwrap(),
                },
            )
            .await;
        assert!(
            matches!(result, Err(ServiceError::Invalid(error)) if error.contains(expected)),
            "expected {expected}"
        );
    }
    assert_eq!(service.get("states").await.unwrap().revision, 1);
    assert_eq!(
        serde_json::to_value(service.get("states").await.unwrap().document).unwrap(),
        document()
    );
}

#[test]
fn state_transition_components_are_optional_and_plain_text_with_strict_field_names() {
    for transition in [
        json!({"event": "<script>payment</script>"}),
        json!({"guard": "false"}),
        json!({"effect": "<img src=x onerror=alert(1)>"}),
        json!({"event": null, "guard": "Amount received", "effect": null}),
    ] {
        let mut value = document();
        value["diagrams"][0]["edges"][1]["transition"] = transition;
        serde_json::from_value::<Explanation>(value)
            .unwrap()
            .validate()
            .unwrap();
    }
    for (pointer, replacement) in [
        ("/diagrams/0/nodes/0/stateRole", json!("choice")),
        (
            "/diagrams/0/edges/1/transition",
            json!({"event": "Pay", "execute": true}),
        ),
        ("/diagrams/0/edges/1/transition", json!({"guard": true})),
    ] {
        let mut invalid = document();
        *invalid.pointer_mut(pointer).unwrap() = replacement;
        assert!(serde_json::from_value::<Explanation>(invalid).is_err());
    }
    let schema = serde_json::to_value(schemars::schema_for!(PublishRequest)).unwrap();
    assert!(
        schema["$defs"]["StateNodeRole"]["enum"]
            .as_array()
            .unwrap()
            .contains(&json!("initial"))
    );
    assert!(
        schema["$defs"]["StateTransition"]["properties"]
            .get("guard")
            .is_some()
    );
}

#[test]
fn ordinary_state_diagrams_retain_labels_and_omit_null_optional_fields() {
    let mut value = document();
    value["diagrams"][0]["nodes"][0]["stateRole"] = Value::Null;
    value["diagrams"][0]["nodes"][3]["stateRole"] = Value::Null;
    value["diagrams"][0]["edges"][1]["transition"] = Value::Null;
    for kind in ["state", "flow"] {
        value["diagrams"][0]["kind"] = json!(kind);
        let authored: Explanation = serde_json::from_value(value.clone()).unwrap();
        authored.validate().unwrap();
        let encoded = serde_json::to_value(authored).unwrap();
        assert!(
            encoded["diagrams"][0]["nodes"][0]
                .get("stateRole")
                .is_none()
        );
        assert!(
            encoded["diagrams"][0]["edges"][1]
                .get("transition")
                .is_none()
        );
        assert_eq!(encoded["diagrams"][0]["edges"][1]["label"], "Fallback");
    }
    value["diagrams"][0]["edges"][1]["transition"] = json!({"event": "Pay"});
    let invalid: Explanation = serde_json::from_value(value).unwrap();
    assert!(
        invalid
            .validate()
            .unwrap_err()
            .contains("transition requires kind state")
    );
}
