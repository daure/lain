use lain::{
    model::{Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::{Value, json};

fn document() -> Value {
    serde_json::from_str(include_str!("../examples/order-lifecycle.json")).unwrap()
}

#[tokio::test]
async fn nested_flow_and_state_groups_preserve_recordings_through_publication_and_reopen() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("groups.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let expected = document();
    let published = service
        .publish(
            "groups",
            PublishRequest {
                document: serde_json::from_value(expected.clone()).unwrap(),
            },
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(published.document).unwrap(), expected);
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_value(reopened.get("groups").await.unwrap().document).unwrap(),
        expected
    );
}

#[tokio::test]
async fn invalid_containment_is_rejected_without_replacing_the_committed_recording() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("groups.sqlite"))
        .await
        .unwrap();
    let original = document();
    service
        .publish(
            "groups",
            PublishRequest {
                document: serde_json::from_value(original.clone()).unwrap(),
            },
        )
        .await
        .unwrap();
    for (pointer, replacement, error) in [
        ("/diagrams/0/groups/0/id", json!("bad/id"), "invalid ID"),
        (
            "/diagrams/0/groups/1/id",
            json!("callback-processing"),
            "duplicate group",
        ),
        (
            "/diagrams/0/groups/1/id",
            json!("callback"),
            "ID conflicts with a node",
        ),
        (
            "/diagrams/0/groups/1/label",
            json!(" \n"),
            "label must not be blank",
        ),
        (
            "/diagrams/0/groups/1/nodeIds",
            json!(["missing"]),
            "unknown group node",
        ),
        (
            "/diagrams/0/groups/1/nodeIds",
            json!(["check", "check"]),
            "more than one group membership",
        ),
        (
            "/diagrams/0/groups/2/nodeIds",
            json!(["check"]),
            "more than one group membership",
        ),
        (
            "/diagrams/0/groups/1/parentGroupId",
            json!("missing"),
            "unknown parent group",
        ),
        (
            "/diagrams/0/groups/1/parentGroupId",
            json!("receipt-verification"),
            "cyclic parentGroupId",
        ),
        (
            "/diagrams/0/groups/0",
            json!({"id": "callback-processing", "label": "Callbacks", "nodeIds": [], "parentGroupId": "receipt-verification"}),
            "cyclic parentGroupId",
        ),
        (
            "/diagrams/0/groups/1/nodeIds",
            json!([]),
            "requires at least one descendant node",
        ),
        (
            "/diagrams/2/groups",
            json!([{"id": "group", "label": "Sequence", "nodeIds": ["callback"]}]),
            "groups require kind flow or state",
        ),
        (
            "/diagrams/0/edges/0/targetNodeId",
            json!("receipt-verification"),
            "unknown edge target node",
        ),
        (
            "/scenarios/0/occurrences/0/nodeId",
            json!("callback-processing"),
            "unknown occurrence node",
        ),
        (
            "/diagrams/0/groups",
            json!(vec![
                json!({"id": "group", "label": "Group", "nodeIds": ["check"]});
                101
            ]),
            "diagram groups exceeds limit of 100",
        ),
        (
            "/diagrams/0/groups/1/nodeIds",
            json!(vec!["check"; 201]),
            "group nodes exceeds limit of 200",
        ),
    ] {
        let mut invalid = original.clone();
        if pointer == "/diagrams/2/groups" {
            invalid["diagrams"][2]["groups"] = replacement;
        } else {
            *invalid.pointer_mut(pointer).unwrap() = replacement;
        }
        let result = service
            .publish(
                "groups",
                PublishRequest {
                    document: serde_json::from_value(invalid).unwrap(),
                },
            )
            .await;
        assert!(
            matches!(result, Err(ServiceError::Invalid(ref message)) if message.contains(error)),
            "{pointer}: {result:?}"
        );
    }
    let stored = service.get("groups").await.unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(serde_json::to_value(stored.document).unwrap(), original);
}

#[test]
fn group_nesting_is_bounded_and_legacy_documents_omit_empty_groups() {
    let mut value = document();
    let groups: Vec<_> = (0..8)
        .map(|level| {
            let mut group =
                json!({"id": format!("group-{level}"), "label": "Group", "nodeIds": []});
            if level > 0 {
                group["parentGroupId"] = json!(format!("group-{}", level - 1));
            }
            if level == 7 {
                group["nodeIds"] = json!(["callback"]);
            }
            group
        })
        .collect();
    value["diagrams"][0]["groups"] = json!(groups);
    serde_json::from_value::<Explanation>(value.clone())
        .unwrap()
        .validate()
        .unwrap();
    value["diagrams"][0]["groups"][7]["nodeIds"] = json!([]);
    value["diagrams"][0]["groups"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "group-8", "label": "Group", "nodeIds": ["callback"], "parentGroupId": "group-7"
        }));
    assert!(
        serde_json::from_value::<Explanation>(value.clone())
            .unwrap()
            .validate()
            .unwrap_err()
            .contains("nesting exceeds limit of 8")
    );
    value = document();
    value["diagrams"][0]["groups"][0]["unknown"] = json!(true);
    assert!(serde_json::from_value::<Explanation>(value).is_err());
    let mut value = document();
    for diagram in value["diagrams"].as_array_mut().unwrap() {
        diagram.as_object_mut().unwrap().remove("groups");
    }
    let authored: Explanation = serde_json::from_value(value.clone()).unwrap();
    authored.validate().unwrap();
    assert_eq!(serde_json::to_value(authored).unwrap(), value);
    value["diagrams"][0]["groups"] = json!([]);
    let serialized =
        serde_json::to_value(serde_json::from_value::<Explanation>(value).unwrap()).unwrap();
    assert!(serialized["diagrams"][0].get("groups").is_none());
}
