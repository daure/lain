use lain::{
    model::{Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::{Value, json};

fn document() -> Value {
    json!({
        "schemaVersion": 1, "title": "Checkout boundaries", "description": "Synthetic software recording.",
        "wiring": {
            "components": [{"id": "checkout", "label": "Checkout API", "kind": "service"}],
            "connections": []
        },
        "diagrams": [{"id": "flow", "title": "Checkout", "kind": "flow", "nodes": [
            {"id": "submit", "label": "Submit checkout", "entityIds": []}
        ], "edges": []}],
        "scenarios": [{"id": "checkout", "title": "Checkout accepted", "diagramId": "flow", "occurrences": [{
            "id": "submitted", "nodeId": "submit", "incomingEdgeId": null, "trigger": null,
            "narration": "The service accepts checkout.", "wiringRefs": {"componentIds": ["checkout"]},
            "before": {"instances": [], "links": []}, "after": {"instances": [], "links": []}
        }]}]
    })
}

#[tokio::test]
async fn optional_domain_presence_survives_publication_and_database_reopen() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("test.sqlite");
    let service = AppService::open(&path).await.unwrap();
    for (id, domain) in [
        ("without-domain", None),
        (
            "empty-domain",
            Some(json!({"entities": [], "relationships": []})),
        ),
    ] {
        let mut value = document();
        if let Some(domain) = domain {
            value["domain"] = domain;
        }
        let authored: Explanation = serde_json::from_value(value.clone()).unwrap();
        let stored = service
            .publish(id, PublishRequest { document: authored })
            .await
            .unwrap();
        assert_eq!(stored.revision, 1);
        assert_eq!(serde_json::to_value(stored.document).unwrap(), value);
    }
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    assert!(
        reopened
            .get("without-domain")
            .await
            .unwrap()
            .document
            .domain
            .is_none()
    );
    assert!(
        reopened
            .get("empty-domain")
            .await
            .unwrap()
            .document
            .domain
            .is_some()
    );
    let mut flow_only = document();
    flow_only.as_object_mut().unwrap().remove("wiring");
    flow_only["scenarios"][0]["occurrences"][0]
        .as_object_mut()
        .unwrap()
        .remove("wiringRefs");
    let authored: Explanation = serde_json::from_value(flow_only).unwrap();
    authored.validate().unwrap();
}

#[tokio::test]
async fn domain_references_require_definitions_before_replacing_a_saved_document() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("test.sqlite"))
        .await
        .unwrap();
    service
        .publish(
            "checkout",
            PublishRequest {
                document: serde_json::from_value(document()).unwrap(),
            },
        )
        .await
        .unwrap();
    let mut events = service.subscribe();
    for (pointer, replacement, message) in [
        (
            "/diagrams/0/nodes/0/entityIds",
            json!(["order"]),
            "unknown node entity reference \"order\"",
        ),
        (
            "/scenarios/0/occurrences/0/before/instances",
            json!([{"id": "order-1", "entityId": "order", "values": {}}]),
            "scenario \"checkout\", occurrence \"submitted\", before snapshot: unknown instance entity reference \"order\"",
        ),
        (
            "/scenarios/0/occurrences/0/after/instances",
            json!([{"id": "order-1", "entityId": "order", "values": {}}]),
            "scenario \"checkout\", occurrence \"submitted\", after snapshot: unknown instance entity reference \"order\"",
        ),
        (
            "/scenarios/0/occurrences/0/after/links",
            json!([{"relationshipId": "order-payment", "sourceInstanceId": "order-1", "targetInstanceId": "payment-1"}]),
            "scenario \"checkout\", occurrence \"submitted\", after snapshot: unknown link relationship reference \"order-payment\"",
        ),
    ] {
        let mut value = document();
        *value.pointer_mut(pointer).unwrap() = replacement;
        let result = service
            .publish(
                "checkout",
                PublishRequest {
                    document: serde_json::from_value(value).unwrap(),
                },
            )
            .await;
        assert!(matches!(result, Err(ServiceError::Invalid(error)) if error == message));
    }
    let mut value = document();
    value["scenarios"][0]["occurrences"][0]["methodCalls"] =
        json!([{"entityId": "order", "methodId": "submit"}]);
    let result = service
        .publish(
            "checkout",
            PublishRequest {
                document: serde_json::from_value(value).unwrap(),
            },
        )
        .await;
    assert!(
        matches!(result, Err(ServiceError::Invalid(error)) if error == "scenario \"checkout\", occurrence \"submitted\": unknown method call entity reference \"order\"")
    );
    let stored = service.get("checkout").await.unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(serde_json::to_value(stored.document).unwrap(), document());
    assert!(events.try_recv().is_err());
}

#[test]
fn publication_schema_accepts_an_omitted_domain_and_requires_its_collections_when_present() {
    let schema = serde_json::to_value(schemars::schema_for!(PublishRequest)).unwrap();
    let definitions = &schema["$defs"];
    assert!(
        !definitions["Explanation"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("domain"))
    );
    assert_eq!(
        definitions["Domain"]["required"],
        json!(["entities", "relationships"])
    );
    for invalid in [
        json!({}),
        json!({"entities": []}),
        json!({"entities": [], "relationships": [], "unknown": true}),
    ] {
        let mut value = document();
        value["domain"] = invalid;
        assert!(serde_json::from_value::<Explanation>(value).is_err());
    }
}
