use lain::{
    model::{EntityMethod, Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::json;

fn document() -> Explanation {
    serde_json::from_str(include_str!("../examples/order-lifecycle.json")).unwrap()
}

fn method() -> EntityMethod {
    EntityMethod {
        id: "capture".into(),
        signature: "capturePayment(paymentId: string): void".into(),
        description: "Capture the authorized payment.".into(),
    }
}

fn request(expected_revision: u64, document: Explanation) -> PublishRequest {
    PublishRequest {
        expected_revision,
        document,
    }
}

#[tokio::test]
async fn legacy_entities_publish_and_reload_with_optional_methods_omitted() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("test.sqlite"))
        .await
        .unwrap();
    let mut authored = document();
    for entity in &mut authored.domain.entities {
        entity.methods.clear();
    }
    let legacy = serde_json::to_value(&authored).unwrap();
    assert!(
        legacy["domain"]["entities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entity| entity.get("methods").is_none())
    );
    let decoded: Explanation = serde_json::from_value(legacy.clone()).unwrap();
    service
        .publish("legacy", request(0, decoded))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(service.get("legacy").await.unwrap().document).unwrap(),
        legacy
    );
}

#[tokio::test]
async fn methods_preserve_authored_order_and_plain_text_across_database_reopen() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("test.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let mut authored = document();
    let mut untrusted = method();
    untrusted.id = "untrusted".into();
    untrusted.signature = "<script>alert(1)</script>(value: string): void".into();
    untrusted.description = "<img src=x onerror=alert(1)>".into();
    authored.domain.entities[0].methods = vec![method(), untrusted];
    let expected = serde_json::to_value(&authored).unwrap();
    service
        .publish("methods", request(0, authored))
        .await
        .unwrap();
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    let stored = reopened.get("methods").await.unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(serde_json::to_value(stored.document).unwrap(), expected);
}

#[tokio::test]
async fn invalid_method_definitions_preserve_the_committed_revision() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("test.sqlite"))
        .await
        .unwrap();
    let mut authored = document();
    authored.domain.entities[0].methods = vec![method()];
    service
        .publish("methods", request(0, authored.clone()))
        .await
        .unwrap();
    let original = serde_json::to_value(authored).unwrap();
    for (replacement, message) in [
        (json!([method(), method()]), "duplicate entity method"),
        (
            json!([{ "id": "bad/id", "signature": "capture()", "description": "Capture" }]),
            "invalid ID",
        ),
        (
            json!([{ "id": "capture", "signature": " \n\t", "description": "Capture" }]),
            "signature must not be blank",
        ),
        (
            json!([{ "id": "capture", "signature": "x".repeat(32 * 1024 + 1), "description": "Capture" }]),
            "text bytes",
        ),
        (
            json!([{ "id": "capture", "signature": "capture()", "description": "x".repeat(32 * 1024 + 1) }]),
            "text bytes",
        ),
        (
            json!(
                (0..201)
                    .map(|index| EntityMethod {
                        id: format!("method-{index}"),
                        ..method()
                    })
                    .collect::<Vec<_>>()
            ),
            "entity methods exceeds limit",
        ),
    ] {
        let mut invalid = original.clone();
        invalid["domain"]["entities"][0]["methods"] = replacement;
        let result = service
            .publish(
                "methods",
                request(1, serde_json::from_value(invalid).unwrap()),
            )
            .await;
        assert!(
            matches!(result, Err(ServiceError::Invalid(error)) if error.contains(message)),
            "expected {message}"
        );
    }
    assert_eq!(service.get("methods").await.unwrap().revision, 1);
    for replacement in [
        json!(null),
        json!([{ "id": "capture", "signature": "capture()" }]),
        json!([{ "id": "capture", "signature": "capture()", "description": "Capture", "execute": true }]),
    ] {
        let mut invalid = original.clone();
        invalid["domain"]["entities"][0]["methods"] = replacement;
        assert!(serde_json::from_value::<Explanation>(invalid).is_err());
    }
}

#[tokio::test]
async fn method_ids_are_not_snapshot_attribute_keys() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("test.sqlite"))
        .await
        .unwrap();
    let mut authored = document();
    authored.domain.entities[0].methods = vec![method()];
    let order = authored.scenarios[0].occurrences[0]
        .after
        .instances
        .iter_mut()
        .find(|instance| instance.entity_id == "order")
        .unwrap();
    order.values.insert("capture".into(), json!("called"));
    let result = service.publish("methods", request(0, authored)).await;
    assert!(
        matches!(result, Err(ServiceError::Invalid(error)) if error.contains("unknown attribute"))
    );
}
