use lain::{
    model::{Explanation, PublishRequest},
    service::AppService,
};
use serde_json::{Value, json};
use sqlx::Connection;

fn canonical_document() -> Value {
    let snapshot = json!({"instances": [{"id": "cart-84", "entityId": "cart", "values": {
        "payload": {"architecture": "captured user data", "architectureRefs": {}}
    }}], "links": []});
    json!({
        "schemaVersion": 1, "title": "Stored wiring", "description": "Synthetic recorded checkout.",
        "overview": "Read the checkout recording.",
        "topics": [{"id": "checkout", "title": "Checkout", "scenarioIds": ["checkout"]}],
        "links": [{"label": "Specification", "url": "https://example.com/checkout"}],
        "domain": {"entities": [{"id": "cart", "label": "Cart", "attributes": [{"id": "payload", "label": "Payload"}]}], "relationships": []},
        "wiring": {"components": [{"id": "api", "label": "Checkout API", "kind": "service"}], "connections": []},
        "diagrams": [{"id": "flow", "title": "Checkout", "kind": "flow",
            "nodes": [{"id": "submit", "label": "Submit", "entityIds": ["cart"]}],
            "edges": [{"id": "retry", "sourceNodeId": "submit", "targetNodeId": "submit", "label": "Retry"}]}],
        "scenarios": [{"id": "checkout", "title": "Checkout", "labels": ["synthetic"], "diagramId": "flow", "occurrences": [
            {"id": "first", "nodeId": "submit", "incomingEdgeId": null, "trigger": null,
             "narration": "Submit checkout.", "changeSummary": "Captured state remains unchanged.",
             "before": snapshot, "after": snapshot, "wiringRefs": {"componentIds": ["api"]}},
            {"id": "second", "nodeId": "submit", "incomingEdgeId": "retry", "trigger": null,
             "narration": "Record an explicit empty mapping.", "before": snapshot, "after": snapshot, "wiringRefs": {}},
            {"id": "third", "nodeId": "submit", "incomingEdgeId": "retry", "trigger": null,
             "narration": "Capture the next visit.", "before": snapshot, "after": snapshot}
        ]}]
    })
}

fn prototype_document() -> Value {
    let mut prototype = canonical_document();
    let wiring = prototype.as_object_mut().unwrap().remove("wiring").unwrap();
    prototype["architecture"] = wiring;
    for occurrence in prototype["scenarios"][0]["occurrences"]
        .as_array_mut()
        .unwrap()
    {
        let occurrence = occurrence.as_object_mut().unwrap();
        if let Some(mapping) = occurrence.remove("wiringRefs") {
            occurrence.insert("architectureRefs".into(), mapping);
        }
    }
    prototype
}

#[tokio::test]
async fn stored_prototype_records_decode_canonically_without_mutating_database_values() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("stored.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path);
    let mut connection = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    let original = prototype_document().to_string();
    sqlx::query("INSERT INTO explanations (id, revision, document_json, updated_at_ms) VALUES ('prototype', 7, ?, 123)")
        .bind(&original).execute(&mut connection).await.unwrap();
    let mut notifications = service.subscribe();
    let loaded = service.get("prototype").await.unwrap();
    assert_eq!(loaded.revision, 7);
    assert_eq!(loaded.updated_at_ms, 123);
    loaded.document.validate().unwrap();
    assert_eq!(
        serde_json::to_value(loaded.document).unwrap(),
        canonical_document()
    );
    let summaries = service.list().await.unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].revision, 7);
    assert_eq!(summaries[0].link_count, 1);
    assert_eq!(summaries[0].scenario_count, 1);
    assert!(matches!(
        notifications.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_value(reopened.get("prototype").await.unwrap().document).unwrap(),
        canonical_document()
    );
    let persisted: (String, i64, i64) = sqlx::query_as(
        "SELECT document_json, revision, updated_at_ms FROM explanations WHERE id = 'prototype'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(persisted, (original, 7, 123));
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(version, 2);
}

#[tokio::test]
async fn canonical_publications_persist_wiring_and_keep_omitted_domain_omitted() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("canonical.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let mut expected = canonical_document();
    expected.as_object_mut().unwrap().remove("domain");
    expected["diagrams"][0]["nodes"][0]["entityIds"] = json!([]);
    for occurrence in expected["scenarios"][0]["occurrences"]
        .as_array_mut()
        .unwrap()
    {
        occurrence["before"] = json!({"instances": [], "links": []});
        occurrence["after"] = json!({"instances": [], "links": []});
    }
    service
        .publish(
            "canonical",
            PublishRequest {
                document: serde_json::from_value::<Explanation>(expected.clone()).unwrap(),
            },
        )
        .await
        .unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path);
    let mut connection = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    let persisted: String =
        sqlx::query_scalar("SELECT document_json FROM explanations WHERE id = 'canonical'")
            .fetch_one(&mut connection)
            .await
            .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&persisted).unwrap(), expected);
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_value(reopened.get("canonical").await.unwrap().document).unwrap(),
        expected
    );
}
