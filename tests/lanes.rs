use lain::{
    model::{DiagramLane, Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::{Value, json};

fn document() -> Value {
    json!({
        "schemaVersion": 1, "title": "Lane recording", "description": "Cross-band revisits",
        "domain": {"entities": [], "relationships": []},
        "diagrams": [{
            "id": "flow", "title": "Flow", "kind": "flow",
            "nodes": [
                {"id": "a", "label": "A", "entityIds": []},
                {"id": "b", "label": "B", "entityIds": []},
                {"id": "c", "label": "C", "entityIds": []}
            ],
            "edges": [
                {"id": "ab", "sourceNodeId": "a", "targetNodeId": "b", "label": "Send"},
                {"id": "ba", "sourceNodeId": "b", "targetNodeId": "a", "label": "Return"}
            ],
            "lanes": [
                {"id": "z-team", "label": "<script>Team Z</script>", "nodeIds": ["b"]},
                {"id": "a-team", "label": "Team A", "nodeIds": ["c", "a"]}
            ]
        }],
        "scenarios": [{
            "id": "run", "title": "Run", "diagramId": "flow",
            "occurrences": [
                {"id": "first", "nodeId": "a", "incomingEdgeId": null, "trigger": null,
                 "narration": "Start", "before": {"instances": [], "links": []},
                 "after": {"instances": [], "links": []}},
                {"id": "second", "nodeId": "b", "incomingEdgeId": "ab", "trigger": "Send",
                 "narration": "Send", "before": {"instances": [], "links": []},
                 "after": {"instances": [], "links": []}},
                {"id": "revisit", "nodeId": "a", "incomingEdgeId": "ba", "trigger": "Return",
                 "narration": "Return", "before": {"instances": [], "links": []},
                 "after": {"instances": [], "links": []}}
            ]
        }]
    })
}

fn validate(value: Value) -> Result<(), String> {
    serde_json::from_value::<Explanation>(value)
        .unwrap()
        .validate()
}

#[tokio::test]
async fn publication_preserves_lane_and_member_order_with_cross_lane_revisits() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("lanes.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let expected = document();
    let mut aliased = expected.clone();
    aliased["diagrams"][0]["kind"] = json!("process");
    let published = service
        .publish(
            "lanes",
            PublishRequest {
                document: serde_json::from_value(aliased).unwrap(),
            },
        )
        .await
        .unwrap();
    assert_eq!(published.revision, 1);
    assert_eq!(serde_json::to_value(published.document).unwrap(), expected);
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    let stored = reopened.get("lanes").await.unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(serde_json::to_value(stored.document).unwrap(), expected);
}

#[tokio::test]
async fn invalid_lanes_preserve_committed_state_and_emit_no_notification() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("lanes.sqlite"))
        .await
        .unwrap();
    let original = document();
    service
        .publish(
            "lanes",
            PublishRequest {
                document: serde_json::from_value(original.clone()).unwrap(),
            },
        )
        .await
        .unwrap();
    let mut events = service.subscribe();
    for (pointer, replacement, error) in [
        ("/diagrams/0/lanes/0/id", json!(""), "invalid ID"),
        (
            "/diagrams/0/lanes/0/id",
            json!("x".repeat(65)),
            "invalid ID",
        ),
        ("/diagrams/0/lanes/0/id", json!("é"), "invalid ID"),
        ("/diagrams/0/lanes/0/id", json!("bad/id"), "invalid ID"),
        ("/diagrams/0/lanes/0/id", json!("team\n"), "invalid ID"),
        (
            "/diagrams/0/lanes/1/id",
            json!("z-team"),
            "duplicate lane ID",
        ),
        (
            "/diagrams/0/lanes/0/id",
            json!("a"),
            "ID conflicts with a node or group",
        ),
        (
            "/diagrams/0/lanes/0/label",
            json!(" \n\t"),
            "label must not be blank",
        ),
        (
            "/diagrams/0/lanes/0/label",
            json!("é".repeat(16_385)),
            "text bytes exceeds limit of 32768",
        ),
        (
            "/diagrams/0/lanes/0/nodeIds",
            json!([]),
            "requires 1–200 member nodes",
        ),
        (
            "/diagrams/0/lanes/0/nodeIds",
            json!(vec!["b"; 201]),
            "requires 1–200 member nodes",
        ),
        (
            "/diagrams/0/lanes/0/nodeIds",
            json!(["missing"]),
            "unknown lane node reference",
        ),
        (
            "/diagrams/0/lanes/0/nodeIds",
            json!(["b", "b"]),
            "more than one lane membership",
        ),
        (
            "/diagrams/0/lanes/0/nodeIds",
            json!(["b", "a"]),
            "more than one lane membership",
        ),
        (
            "/diagrams/0/kind",
            json!("state"),
            "lanes require kind flow",
        ),
        (
            "/diagrams/0/kind",
            json!("sequence"),
            "lanes require kind flow",
        ),
        (
            "/diagrams/0/lanes",
            json!(vec![
                json!({"id": "team", "label": "Team", "nodeIds": ["a"]});
                51
            ]),
            "diagram lanes exceeds limit of 50",
        ),
    ] {
        let mut invalid = original.clone();
        *invalid.pointer_mut(pointer).unwrap() = replacement;
        let result = service
            .publish(
                "lanes",
                PublishRequest {
                    document: serde_json::from_value(invalid).unwrap(),
                },
            )
            .await;
        assert!(
            matches!(result, Err(ServiceError::Invalid(ref message)) if message.contains(error)),
            "{pointer}: {result:?}"
        );
        assert!(matches!(
            events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        let stored = service.get("lanes").await.unwrap();
        assert_eq!(stored.revision, 1);
        assert_eq!(serde_json::to_value(stored.document).unwrap(), original);
    }
    let mut invalid = original.clone();
    invalid["diagrams"][0]["lanes"][0]["nodeIds"] = json!(["missing"]);
    let result = service
        .publish(
            "new-id",
            PublishRequest {
                document: serde_json::from_value(invalid).unwrap(),
            },
        )
        .await;
    assert!(matches!(result, Err(ServiceError::Invalid(_))));
    assert!(matches!(
        service.get("new-id").await,
        Err(ServiceError::NotFound)
    ));
    assert_eq!(service.list().await.unwrap().len(), 1);
}

#[test]
fn lanes_accept_collection_id_and_utf8_text_boundaries() {
    let mut value = document();
    let nodes: Vec<_> = (0..200)
        .map(|index| json!({"id": format!("n-{index}"), "label": "Node", "entityIds": []}))
        .collect();
    value["diagrams"][0]["nodes"] = json!(nodes);
    value["diagrams"][0]["edges"] = json!([]);
    let mut first = value["scenarios"][0]["occurrences"][0].clone();
    first["nodeId"] = json!("n-0");
    value["scenarios"][0]["occurrences"] = json!([first]);
    value["diagrams"][0]["lanes"] = json!([{
        "id": "A_9-".repeat(16), "label": "é".repeat(16_384),
        "nodeIds": (0..200).map(|index| format!("n-{index}")).collect::<Vec<_>>()
    }]);
    validate(value.clone()).unwrap();
    value["diagrams"][0]["lanes"] = json!((0..50)
        .map(|index| json!({"id": format!("lane-{index}"), "label": "Team", "nodeIds": [format!("n-{index}")]}))
        .collect::<Vec<_>>());
    validate(value).unwrap();
}

fn grouped_document() -> Value {
    let mut value = document();
    value["diagrams"][0]["lanes"] = json!([{
        "id": "team", "label": "Team", "nodeIds": ["b", "a"]
    }]);
    value["diagrams"][0]["groups"] = json!([
        {"id": "grandchild", "label": "Grandchild", "nodeIds": ["b"], "parentGroupId": "child"},
        {"id": "root", "label": "Root", "nodeIds": []},
        {"id": "child", "label": "Child", "nodeIds": ["a"], "parentGroupId": "root"},
        {"id": "outside", "label": "Outside", "nodeIds": ["c"]}
    ]);
    value
}

#[test]
fn groups_keep_all_direct_and_descendant_nodes_in_one_band() {
    validate(grouped_document()).unwrap();
    let mut all_unassigned = grouped_document();
    all_unassigned["diagrams"][0]["lanes"][0]["nodeIds"] = json!(["c"]);
    validate(all_unassigned).unwrap();

    let mut mixed = grouped_document();
    mixed["diagrams"][0]["lanes"][0]["nodeIds"] = json!(["a"]);
    let error = validate(mixed).unwrap_err();
    assert!(error.contains("group \"child\""), "{error}");
    assert!(
        error.contains("team") && error.contains("<unassigned>"),
        "{error}"
    );

    let mut siblings = grouped_document();
    siblings["diagrams"][0]["groups"][0]["parentGroupId"] = json!("root");
    siblings["diagrams"][0]["lanes"] = json!([
        {"id": "a-team", "label": "A", "nodeIds": ["a"]},
        {"id": "b-team", "label": "B", "nodeIds": ["b"]}
    ]);
    let error = validate(siblings).unwrap_err();
    assert!(error.contains("group \"root\""), "{error}");
    assert!(
        error.contains("a-team") && error.contains("b-team"),
        "{error}"
    );

    let mut direct = grouped_document();
    direct["diagrams"][0]["groups"] = json!([
        {"id": "root", "label": "Root", "nodeIds": ["a", "c"]}
    ]);
    assert!(validate(direct).unwrap_err().contains("group \"root\""));
}

#[test]
fn group_tree_validation_precedes_lane_validation_and_ids_share_a_namespace() {
    let mut invalid = grouped_document();
    invalid["diagrams"][0]["groups"][1]["parentGroupId"] = json!("grandchild");
    invalid["diagrams"][0]["lanes"][0]["id"] = json!("root");
    assert!(
        validate(invalid)
            .unwrap_err()
            .contains("cyclic parentGroupId")
    );
    let mut conflict = grouped_document();
    conflict["diagrams"][0]["lanes"][0]["id"] = json!("root");
    assert!(
        validate(conflict)
            .unwrap_err()
            .contains("ID conflicts with a node or group")
    );
    let mut missing_parent = grouped_document();
    missing_parent["diagrams"][0]["groups"][0]["parentGroupId"] = json!("missing");
    assert!(
        validate(missing_parent)
            .unwrap_err()
            .contains("unknown parent group")
    );
}

#[test]
fn empty_lanes_round_trip_as_omitted_for_each_diagram_kind() {
    let mut legacy = document();
    legacy["diagrams"][0]
        .as_object_mut()
        .unwrap()
        .remove("lanes");
    let authored: Explanation = serde_json::from_value(legacy.clone()).unwrap();
    authored.validate().unwrap();
    assert_eq!(serde_json::to_value(authored).unwrap(), legacy);
    for kind in ["flow", "state", "sequence"] {
        let mut value = legacy.clone();
        value["diagrams"][0]["kind"] = json!(kind);
        value["diagrams"][0]["lanes"] = json!([]);
        if kind == "sequence" {
            value["diagrams"][0]["sequence"] = json!({
                "participants": [{"id": "actor", "label": "Actor"}],
                "messages": (["a", "b", "c"].map(|node| json!({
                    "nodeId": node, "fromParticipantId": "actor", "toParticipantId": "actor"
                }))),
                "body": [{"kind": "loop", "id": "repeat", "guard": "repeat", "body": [
                    {"kind": "message", "nodeId": "a"}, {"kind": "message", "nodeId": "b"}
                ]}, {"kind": "message", "nodeId": "c"}]
            });
        }
        let authored: Explanation = serde_json::from_value(value).unwrap();
        authored.validate().unwrap();
        let serialized = serde_json::to_value(authored).unwrap();
        assert_eq!(serialized["schemaVersion"], 1);
        assert!(serialized["diagrams"][0].get("lanes").is_none());
    }
    let mut unknown = document();
    unknown["diagrams"][0]["lanes"][0]["unknown"] = json!(true);
    assert!(serde_json::from_value::<Explanation>(unknown).is_err());
    let lane: DiagramLane =
        serde_json::from_value(document()["diagrams"][0]["lanes"][0].clone()).unwrap();
    assert_eq!(lane.node_ids, ["b"]);
}
