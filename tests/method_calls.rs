use lain::{
    model::{Explanation, MethodCall, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::json;

fn document() -> Explanation {
    serde_json::from_str(include_str!("../examples/order-lifecycle.json")).unwrap()
}

#[tokio::test]
async fn occurrence_calls_preserve_order_receivers_and_repeated_visits_after_reopen() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("test.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let mut authored = document();
    let scenario = &mut authored.scenarios[1];
    let call = MethodCall {
        entity_id: "payment".into(),
        method_id: "capture".into(),
        instance_id: Some("pay-72".into()),
    };
    scenario.occurrences[1].method_calls = vec![
        call.clone(),
        MethodCall {
            instance_id: None,
            ..call.clone()
        },
    ];
    scenario.occurrences[3].method_calls = vec![call];
    let expected = serde_json::to_value(&authored).unwrap();
    service
        .publish(
            "calls",
            PublishRequest {
                expected_revision: 0,
                document: authored,
            },
        )
        .await
        .unwrap();
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_value(reopened.get("calls").await.unwrap().document).unwrap(),
        expected
    );
    assert!(
        expected["scenarios"][1]["occurrences"][2]
            .get("methodCalls")
            .is_none()
    );
}

#[tokio::test]
async fn invalid_call_references_cannot_replace_a_committed_document() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("test.sqlite"))
        .await
        .unwrap();
    let authored = document();
    let original = serde_json::to_value(&authored).unwrap();
    service
        .publish(
            "calls",
            PublishRequest {
                expected_revision: 0,
                document: authored,
            },
        )
        .await
        .unwrap();
    for (call, error) in [
        (
            json!({"entityId": "missing", "methodId": "capture"}),
            "unknown method call entity",
        ),
        (
            json!({"entityId": "payment", "methodId": "missing"}),
            "unknown method call method",
        ),
        (
            json!({"entityId": "payment", "methodId": "capture", "instanceId": "missing"}),
            "unknown method call instance",
        ),
        (
            json!({"entityId": "payment", "methodId": "capture", "instanceId": "ord-1042"}),
            "different entity",
        ),
        (
            json!({"entityId": "payment", "methodId": "bad/id"}),
            "invalid ID",
        ),
    ] {
        let mut invalid = original.clone();
        invalid["scenarios"][0]["occurrences"][0]["methodCalls"] = json!([call]);
        let result = service
            .publish(
                "calls",
                PublishRequest {
                    expected_revision: 1,
                    document: serde_json::from_value(invalid).unwrap(),
                },
            )
            .await;
        assert!(
            matches!(result, Err(ServiceError::Invalid(message)) if message.contains(error)),
            "expected {error}"
        );
    }
    let mut excessive = document();
    excessive.scenarios[0].occurrences[2].method_calls =
        vec![excessive.scenarios[0].occurrences[2].method_calls[0].clone(); 501];
    assert!(
        excessive
            .validate()
            .unwrap_err()
            .contains("method calls exceeds limit")
    );
    let stored = service.get("calls").await.unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(serde_json::to_value(stored.document).unwrap(), original);
}

#[test]
fn calls_can_reference_created_and_removed_receivers_or_omit_the_receiver() {
    let mut authored = document();
    let packed = &mut authored.scenarios[3].occurrences[0];
    packed.method_calls = vec![MethodCall {
        entity_id: "shipment".into(),
        method_id: "record-attempt".into(),
        instance_id: Some("ship-88".into()),
    }];
    let closed = &mut authored.scenarios[3].occurrences[3];
    closed.before.instances.push(lain::model::Instance {
        id: "pay-removed".into(),
        entity_id: "payment".into(),
        values: Default::default(),
    });
    closed.method_calls = vec![
        MethodCall {
            entity_id: "payment".into(),
            method_id: "capture".into(),
            instance_id: Some("pay-removed".into()),
        },
        MethodCall {
            entity_id: "order".into(),
            method_id: "mark-paid".into(),
            instance_id: None,
        },
    ];
    authored.validate().unwrap();
    let mut legacy = serde_json::to_value(authored).unwrap();
    for scenario in legacy["scenarios"].as_array_mut().unwrap() {
        for occurrence in scenario["occurrences"].as_array_mut().unwrap() {
            occurrence.as_object_mut().unwrap().remove("methodCalls");
        }
    }
    serde_json::from_value::<Explanation>(legacy)
        .unwrap()
        .validate()
        .unwrap();
}
