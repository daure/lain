use lain::{
    model::{Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::{Value, json};

fn document() -> Value {
    serde_json::from_str(include_str!("../examples/pr-comment-review.json")).unwrap()
}

#[tokio::test]
async fn topics_labels_and_cross_diagram_comparisons_survive_database_reopen() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("test.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let mut value = document();
    value["overview"] = json!("<script>Plain text</script>\n\nA review overview.");
    value["topics"][0]["title"] = json!("<img src=x> A question");
    value["scenarios"][0]["labels"] = json!(["Current", "<svg>Assumed</svg>"]);
    let authored: Explanation = serde_json::from_value(value).unwrap();
    let expected = serde_json::to_value(&authored).unwrap();
    let pair = &authored.comparisons[0];
    assert_ne!(
        authored
            .scenarios
            .iter()
            .find(|s| s.id == pair.left_scenario_id)
            .unwrap()
            .diagram_id,
        authored
            .scenarios
            .iter()
            .find(|s| s.id == pair.right_scenario_id)
            .unwrap()
            .diagram_id
    );
    service
        .publish("review", PublishRequest { document: authored })
        .await
        .unwrap();
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_value(reopened.get("review").await.unwrap().document).unwrap(),
        expected
    );
}

#[tokio::test]
async fn invalid_reader_structure_preserves_the_committed_document_and_notifications() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("test.sqlite"))
        .await
        .unwrap();
    let original = document();
    service
        .publish(
            "review",
            PublishRequest {
                document: serde_json::from_value(original.clone()).unwrap(),
            },
        )
        .await
        .unwrap();
    let mut changes = service.subscribe();
    let mut invalids = vec![
        ("/topics/0/id", json!("bad id"), "invalid ID"),
        (
            "/topics/1/id",
            original["topics"][0]["id"].clone(),
            "duplicate topic",
        ),
        ("/topics/0/title", json!(" \n"), "title must not be blank"),
        ("/topics/0/scenarioIds", json!([]), "1–100 scenario IDs"),
        (
            "/topics/0/scenarioIds",
            json!(["missing"]),
            "unknown scenario",
        ),
        (
            "/topics/0/scenarioIds",
            json!(["duplicate-current", "duplicate-current"]),
            "more than one topic",
        ),
        (
            "/topics/1/scenarioIds",
            json!(["duplicate-current"]),
            "more than one topic",
        ),
        ("/comparisons/0/id", json!(""), "invalid ID"),
        (
            "/comparisons/1/id",
            original["comparisons"][0]["id"].clone(),
            "duplicate comparison",
        ),
        (
            "/comparisons/0/title",
            json!("\t"),
            "title must not be blank",
        ),
        (
            "/comparisons/0/leftScenarioId",
            json!("missing"),
            "unknown scenario",
        ),
        (
            "/comparisons/0/rightScenarioId",
            json!("missing"),
            "unknown scenario",
        ),
        (
            "/comparisons/0/rightScenarioId",
            json!("duplicate-current"),
            "two distinct scenarios",
        ),
        ("/scenarios/0/labels", json!([""]), "nonblank text"),
        ("/scenarios/0/labels", json!([" \n"]), "nonblank text"),
        (
            "/scenarios/0/labels",
            json!(["Current", "Current"]),
            "duplicate label",
        ),
        (
            "/scenarios/0/labels",
            json!(["x".repeat(65)]),
            "1–64 characters",
        ),
        (
            "/scenarios/0/labels",
            json!(["a", "b", "c", "d", "e", "f", "g", "h", "i"]),
            "limit of 8",
        ),
        ("/overview", json!("x".repeat(32769)), "text bytes"),
        (
            "/topics/0/description",
            json!("x".repeat(32769)),
            "text bytes",
        ),
        (
            "/comparisons/0/description",
            json!("x".repeat(32769)),
            "text bytes",
        ),
    ];
    invalids.push((
        "/topics",
        json!(vec![original["topics"][0].clone(); 51]),
        "limit of 50",
    ));
    invalids.push((
        "/comparisons",
        json!(vec![original["comparisons"][0].clone(); 101]),
        "limit of 100",
    ));
    invalids.push((
        "/topics/0/scenarioIds",
        json!(vec!["duplicate-current"; 101]),
        "1–100 scenario IDs",
    ));
    for (pointer, replacement, message) in invalids {
        let mut invalid = original.clone();
        *invalid.pointer_mut(pointer).unwrap() = replacement;
        let result = service
            .publish(
                "review",
                PublishRequest {
                    document: serde_json::from_value(invalid).unwrap(),
                },
            )
            .await;
        assert!(
            matches!(result, Err(ServiceError::Invalid(ref error)) if error.contains(message)),
            "{pointer}: {result:?}"
        );
        assert!(matches!(
            changes.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }
    let stored = service.get("review").await.unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(serde_json::to_value(stored.document).unwrap(), original);
}

#[test]
fn reader_structure_is_optional_in_schema_version_one_and_rejects_unknown_fields() {
    let mut value = document();
    for field in ["overview", "topics", "comparisons"] {
        value.as_object_mut().unwrap().remove(field);
    }
    for scenario in value["scenarios"].as_array_mut().unwrap() {
        scenario.as_object_mut().unwrap().remove("labels");
    }
    let legacy: Explanation = serde_json::from_value(value.clone()).unwrap();
    legacy.validate().unwrap();
    assert_eq!(serde_json::to_value(legacy).unwrap(), value);
    for pointer in ["/topics/0", "/comparisons/0"] {
        let mut unknown = document();
        unknown.pointer_mut(pointer).unwrap()["extra"] = json!(true);
        assert!(serde_json::from_value::<Explanation>(unknown).is_err());
    }
}

#[test]
fn short_unicode_labels_and_optional_empty_structure_are_valid() {
    let mut authored: Explanation = serde_json::from_value(document()).unwrap();
    authored.scenarios[0].labels = vec!["é".repeat(64)];
    authored.overview.clear();
    authored.topics.clear();
    authored.comparisons.clear();
    authored.validate().unwrap();
    let value = serde_json::to_value(authored).unwrap();
    for field in ["overview", "topics", "comparisons"] {
        assert!(value.get(field).is_none());
    }
}
