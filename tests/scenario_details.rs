use lain::{
    model::{Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::json;

fn document() -> Explanation {
    let occurrences: Vec<_> = (0..2)
        .map(|position| {
            json!({
                "id": format!("read-{position}"), "nodeId": "check",
                "incomingEdgeId": if position == 0 { None } else { Some("verify") },
                "trigger": "receipt.lookup()", "narration": "The receipt is checked.",
                "before": {"instances": [], "links": []},
                "after": {"instances": [], "links": []}
            })
        })
        .collect();
    serde_json::from_value(json!({
        "schemaVersion": 1, "title": "Receipt verification", "description": "A recorded retry.",
        "domain": {"entities": [], "relationships": []},
        "diagrams": [{"id": "receipt", "title": "Receipt reads", "kind": "flow",
            "nodes": [{"id": "check", "label": "Receipt checked", "entityIds": []}],
            "edges": [{"id": "verify", "sourceNodeId": "check", "targetNodeId": "check", "label": "Verify"}]
        }],
        "scenarios": [{"id": "retry", "title": "Verify a retry", "diagramId": "receipt", "occurrences": occurrences}]
    }))
    .unwrap()
}

#[tokio::test]
async fn scenario_prose_and_visit_summaries_persist_across_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("details.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let mut authored = document();
    authored.scenarios[0].description =
        "A gateway retries.\n\n<script>Recorded context.</script>".into();
    authored.scenarios[0].occurrences[0].change_summary =
        "First read: no instances captured.".into();
    authored.scenarios[0].occurrences[1].change_summary =
        "Verification read: no instances captured.".into();
    let expected = serde_json::to_value(&authored).unwrap();
    service
        .publish(
            "details",
            PublishRequest {
                expected_revision: 0,
                document: authored,
            },
        )
        .await
        .unwrap();
    drop(service);
    let service = AppService::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_value(service.get("details").await.unwrap().document).unwrap(),
        expected
    );
}

#[tokio::test]
async fn optional_prose_accepts_omission_and_empty_strings_and_enforces_text_limits() {
    let directory = tempfile::tempdir().unwrap();
    let service = AppService::open(&directory.path().join("details.sqlite"))
        .await
        .unwrap();
    let mut value = serde_json::to_value(document()).unwrap();
    for scenario in value["scenarios"].as_array_mut().unwrap() {
        scenario.as_object_mut().unwrap().remove("description");
        for occurrence in scenario["occurrences"].as_array_mut().unwrap() {
            occurrence.as_object_mut().unwrap().remove("changeSummary");
        }
    }
    let omitted = value.clone();
    value["scenarios"][0]["description"] = json!("");
    value["scenarios"][0]["occurrences"][0]["changeSummary"] = json!("");
    for (id, payload) in [("omitted", omitted.clone()), ("empty", value)] {
        let stored = service
            .publish(
                id,
                PublishRequest {
                    expected_revision: 0,
                    document: serde_json::from_value(payload).unwrap(),
                },
            )
            .await
            .unwrap();
        assert_eq!(serde_json::to_value(stored.document).unwrap(), omitted);
    }
    for field in ["description", "changeSummary"] {
        let mut authored = document();
        let text = if field == "description" {
            &mut authored.scenarios[0].description
        } else {
            &mut authored.scenarios[0].occurrences[0].change_summary
        };
        *text = "x".repeat(32 * 1024 + 1);
        let result = service
            .publish(
                "oversized",
                PublishRequest {
                    expected_revision: 0,
                    document: authored,
                },
            )
            .await;
        assert!(
            matches!(result, Err(ServiceError::Invalid(error)) if error.contains("text bytes"))
        );
    }
}
