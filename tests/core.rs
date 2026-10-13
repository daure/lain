use lain::{
    model::{Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::json;
use tempfile::TempDir;
use tokio::sync::broadcast::error::TryRecvError;

fn document() -> Explanation {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "title": "Recorded order",
        "description": "An order traverses a branch and revisits a node.",
        "domain": {
            "entities": [
                {"id": "order", "label": "Order", "attributes": [
                    {"id": "status", "label": "Status"},
                    {"id": "details", "label": "Details"}
                ]},
                {"id": "customer", "label": "Customer", "attributes": []}
            ],
            "relationships": [{
                "id": "placed-by", "label": "Placed by",
                "sourceEntityId": "order", "targetEntityId": "customer",
                "sourceCardinality": "zeroOrMore", "targetCardinality": "zeroOrOne"
            }]
        },
        "diagrams": [{
            "id": "flow", "title": "Order flow", "kind": "flow",
            "nodes": [
                {"id": "start", "label": "Start", "entityIds": ["order"]},
                {"id": "accepted", "label": "Accepted", "entityIds": ["order"]},
                {"id": "rejected", "label": "Rejected", "entityIds": []}
            ],
            "edges": [
                {"id": "accept", "sourceNodeId": "start", "targetNodeId": "accepted", "label": "Accept"},
                {"id": "reject", "sourceNodeId": "start", "targetNodeId": "rejected", "label": "Reject"},
                {"id": "retry", "sourceNodeId": "accepted", "targetNodeId": "start", "label": "Retry"},
                {"id": "wait", "sourceNodeId": "start", "targetNodeId": "start", "label": "Wait"}
            ]
        }],
        "scenarios": [{
            "id": "happy", "title": "Accept order", "diagramId": "flow",
            "occurrences": [{
                "id": "visit-1", "nodeId": "start", "incomingEdgeId": null,
                "trigger": null, "narration": "Capture an order.",
                "before": {"instances": [], "links": []},
                "after": {
                    "instances": [
                        {"id": "o1", "entityId": "order", "values": {
                            "status": null,
                            "details": {"items": [1, true, null, {"text": "<script>alert(1)</script>"}], "total": 12.5}
                        }},
                        {"id": "c1", "entityId": "customer", "values": {}}
                    ],
                    "links": [{"relationshipId": "placed-by", "sourceInstanceId": "o1", "targetInstanceId": "c1"}]
                }
            }]
        }]
    })).unwrap()
}

fn request(document: Explanation) -> PublishRequest {
    PublishRequest { document }
}

fn sequence_document() -> Explanation {
    let mut value = serde_json::to_value(document()).unwrap();
    value["diagrams"][0]["kind"] = json!("sequence");
    value["diagrams"][0]["sequence"] = json!({
        "participants": [{"id": "client", "label": "<script>client</script>"}, {"id": "server", "label": "Server"}],
        "messages": [
            {"nodeId": "start", "fromParticipantId": "client", "toParticipantId": "server"},
            {"nodeId": "accepted", "fromParticipantId": "server", "toParticipantId": "server"},
            {"nodeId": "rejected", "fromParticipantId": "server", "toParticipantId": "client"}
        ],
        "body": [{"kind": "loop", "id": "attempts", "guard": "Retry the order", "body": [
            {"kind": "message", "nodeId": "start"},
            {"kind": "opt", "id": "decision", "guard": "A decision is recorded", "body": [
                {"kind": "alt", "id": "outcome", "operands": [
                    {"id": "accept-branch", "guard": "Accepted", "body": [{"kind": "message", "nodeId": "accepted"}]},
                    {"id": "reject-branch", "guard": "Rejected", "body": [{"kind": "message", "nodeId": "rejected"}]}
                ]}
            ]}
        ]}]
    });
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn sequences_preserve_messages_self_calls_and_recorded_revisits() {
    let (_directory, service) = service().await;
    let mut authored = sequence_document();
    let sequence = authored.diagrams[0].sequence.as_mut().unwrap();
    assert!(
        sequence
            .participants
            .iter()
            .all(|participant| participant.kind == lain::model::SequenceParticipantKind::System)
    );
    assert!(
        sequence
            .messages
            .iter()
            .all(|message| message.kind == lain::model::SequenceMessageKind::Call)
    );
    sequence.participants[0].kind = lain::model::SequenceParticipantKind::Human;
    sequence.messages[1].kind = lain::model::SequenceMessageKind::Async;
    sequence.messages[2].kind = lain::model::SequenceMessageKind::Reply;
    for (id, node, edge) in [
        ("second", "accepted", "accept"),
        ("revisit", "start", "retry"),
    ] {
        let mut occurrence = authored.scenarios[0].occurrences[0].clone();
        occurrence.id = id.into();
        occurrence.node_id = node.into();
        occurrence.incoming_edge_id = Some(edge.into());
        authored.scenarios[0].occurrences.push(occurrence);
    }
    let expected = serde_json::to_value(&authored).unwrap();
    service
        .publish("sequence", request(authored.clone()))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(service.get("sequence").await.unwrap().document).unwrap(),
        expected
    );
    authored.scenarios[0].occurrences[1].incoming_edge_id = Some("reject".into());
    assert_invalid(&service, authored, "does not connect").await;
}

#[tokio::test]
async fn sequence_payloads_require_bounded_participants_and_exact_node_message_mapping() {
    let (_directory, service) = service().await;
    let original = serde_json::to_value(sequence_document()).unwrap();
    for (pointer, invalid) in [
        ("/diagrams/0/sequence/participants/0", json!("actor")),
        ("/diagrams/0/sequence/messages/0", json!("signal")),
        ("/diagrams/0/sequence/participants/0", json!(null)),
        ("/diagrams/0/sequence/messages/0", json!(null)),
    ] {
        let mut value = original.clone();
        value.pointer_mut(pointer).unwrap()["kind"] = invalid;
        assert!(serde_json::from_value::<Explanation>(value).is_err());
    }
    for (pointer, replacement, error) in [
        ("/diagrams/0/sequence", json!(null), "require sequence data"),
        ("/diagrams/0/kind", json!("flow"), "requires kind sequence"),
        (
            "/diagrams/0/sequence/participants",
            json!([]),
            "at least one",
        ),
        ("/diagrams/0/nodes", json!([]), "at least one"),
        (
            "/diagrams/0/sequence/participants/1/id",
            json!("client"),
            "duplicate",
        ),
        (
            "/diagrams/0/sequence/participants/0/id",
            json!("bad/id"),
            "invalid ID",
        ),
        (
            "/diagrams/0/sequence/messages/1/nodeId",
            json!("start"),
            "duplicate",
        ),
        (
            "/diagrams/0/sequence/messages/0/nodeId",
            json!("missing"),
            "unknown message node",
        ),
        (
            "/diagrams/0/sequence/messages/0/fromParticipantId",
            json!("missing"),
            "sender participant",
        ),
        (
            "/diagrams/0/sequence/messages/0/toParticipantId",
            json!("missing"),
            "receiver participant",
        ),
        (
            "/diagrams/0/sequence/messages",
            json!([]),
            "every diagram node exactly once",
        ),
        (
            "/diagrams/0/sequence/participants/0/label",
            json!("x".repeat(32 * 1024 + 1)),
            "text bytes",
        ),
    ] {
        let mut value = original.clone();
        *value.pointer_mut(pointer).unwrap() = replacement;
        assert_invalid(&service, serde_json::from_value(value).unwrap(), error).await;
    }
    let mut authored = sequence_document();
    authored.diagrams[0]
        .sequence
        .as_mut()
        .unwrap()
        .messages
        .pop();
    assert_invalid(&service, authored, "every diagram node exactly once").await;
    let mut authored = sequence_document();
    let participants = &mut authored.diagrams[0].sequence.as_mut().unwrap().participants;
    for number in 2..50 {
        participants.push(lain::model::SequenceParticipant {
            id: format!("p-{number}"),
            label: "Participant".into(),
            kind: Default::default(),
        });
    }
    service
        .publish("participant-limit", request(authored.clone()))
        .await
        .unwrap();
    authored.diagrams[0]
        .sequence
        .as_mut()
        .unwrap()
        .participants
        .push(lain::model::SequenceParticipant {
            id: "excess".into(),
            label: "Excess".into(),
            kind: Default::default(),
        });
    assert_invalid(
        &service,
        authored,
        "sequence participants exceeds limit of 50",
    )
    .await;
    let mut absent = original.clone();
    absent["diagrams"][0]
        .as_object_mut()
        .unwrap()
        .remove("sequence");
    assert_invalid(
        &service,
        serde_json::from_value(absent).unwrap(),
        "require sequence data",
    )
    .await;
    for pointer in [
        "/diagrams/0/sequence",
        "/diagrams/0/sequence/participants/0",
        "/diagrams/0/sequence/messages/0",
    ] {
        let mut value = original.clone();
        value.pointer_mut(pointer).unwrap()["unknown"] = json!(true);
        assert!(serde_json::from_value::<Explanation>(value).is_err());
    }
    let mut graph = serde_json::to_value(document()).unwrap();
    assert!(graph["diagrams"][0].get("sequence").is_none());
    graph["diagrams"][0]["kind"] = json!("flow");
    graph["diagrams"][0]["sequence"] = json!(null);
    let graph: Explanation = serde_json::from_value(graph).unwrap();
    graph.validate().unwrap();
    assert!(
        serde_json::to_value(graph).unwrap()["diagrams"][0]
            .get("sequence")
            .is_none()
    );
}

#[tokio::test]
async fn deletion_purges_body_and_preserves_revision_history_across_restart_and_recreation() {
    use sqlx::Connection;
    let (directory, service) = service().await;
    service.publish("demo", request(document())).await.unwrap();
    let mut events = service.subscribe();
    assert!(matches!(
        service.delete("bad/id").await,
        Err(ServiceError::Invalid(_))
    ));
    assert!(matches!(
        service.delete("missing").await,
        Err(ServiceError::NotFound)
    ));
    assert_eq!(service.get("demo").await.unwrap().revision, 1);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    let deleted = service.delete("demo").await.unwrap();
    assert_eq!(
        serde_json::to_value(&deleted).unwrap(),
        json!({"id": "demo", "revision": 2, "deleted": true})
    );
    assert_eq!(
        serde_json::to_value(events.try_recv().unwrap()).unwrap(),
        serde_json::to_value(deleted).unwrap()
    );
    assert!(matches!(
        service.get("demo").await,
        Err(ServiceError::NotFound)
    ));
    assert!(service.list().await.unwrap().is_empty());
    assert!(matches!(
        service.delete("demo").await,
        Err(ServiceError::NotFound)
    ));
    let path = directory.path().join("lain.sqlite");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path);
    let mut connection = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    let tombstone: (i64, String, i64) = sqlx::query_as(
        "SELECT revision, document_json, deleted FROM explanations WHERE id = 'demo'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(tombstone, (2, "null".into(), 1));
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    drop(events);
    drop(service);
    let service = AppService::open(&path).await.unwrap();
    assert!(service.list().await.unwrap().is_empty());
    assert!(matches!(
        service.get("demo").await,
        Err(ServiceError::NotFound)
    ));
    let mut events = service.subscribe();
    let recreated = service.publish("demo", request(document())).await.unwrap();
    assert_eq!(recreated.revision, 3);
    assert_eq!(
        serde_json::to_value(events.try_recv().unwrap()).unwrap(),
        json!({"id": "demo", "revision": 3})
    );
    assert_eq!(service.delete("demo").await.unwrap().revision, 4);
    assert_eq!(events.try_recv().unwrap().revision, 4);
    assert!(matches!(
        service.get("demo").await,
        Err(ServiceError::NotFound)
    ));
    assert_eq!(
        service
            .publish("demo", request(document()))
            .await
            .unwrap()
            .revision,
        5
    );
    assert_eq!(events.try_recv().unwrap().revision, 5);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    sqlx::query("UPDATE explanations SET revision = 9223372036854775807 WHERE id = 'demo'")
        .execute(&mut connection)
        .await
        .unwrap();
    let exhausted = serde_json::to_value(service.get("demo").await.unwrap()).unwrap();
    let mut replacement = document();
    replacement.title = "Publication at the revision limit".into();
    assert!(matches!(
        service.publish("demo", request(replacement)).await,
        Err(ServiceError::Invalid(message)) if message == "explanation update limit reached"
    ));
    assert!(matches!(
        service.delete("demo").await,
        Err(ServiceError::Invalid(message)) if message == "explanation update limit reached"
    ));
    assert_eq!(
        serde_json::to_value(service.get("demo").await.unwrap()).unwrap(),
        exhausted
    );
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    sqlx::query("UPDATE explanations SET revision = 9223372036854775806 WHERE id = 'demo'")
        .execute(&mut connection)
        .await
        .unwrap();
    assert_eq!(
        service.delete("demo").await.unwrap().revision,
        i64::MAX as u64
    );
    let tombstone: (i64, String, i64, i64) = sqlx::query_as(
        "SELECT revision, document_json, updated_at_ms, deleted FROM explanations WHERE id = 'demo'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    let mut events = service.subscribe();
    assert!(matches!(
        service.publish("demo", request(document())).await,
        Err(ServiceError::Invalid(message)) if message == "explanation update limit reached"
    ));
    assert!(matches!(
        service.delete("demo").await,
        Err(ServiceError::NotFound)
    ));
    let unchanged: (i64, String, i64, i64) = sqlx::query_as(
        "SELECT revision, document_json, updated_at_ms, deleted FROM explanations WHERE id = 'demo'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(unchanged, tombstone);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test]
async fn concurrent_undo_republishes_once_and_broadcasts_only_the_committed_revision() {
    let (_directory, service) = service().await;
    service.publish("demo", request(document())).await.unwrap();
    let deleted = service.delete_with_revision("demo", Some(1)).await.unwrap();
    let mut events = service.subscribe();
    let (first, second) = tokio::join!(
        service.publish_with_revision("demo", request(document()), Some(deleted.revision)),
        service.publish_with_revision("demo", request(document()), Some(deleted.revision))
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    let failure = if first.is_err() { first } else { second };
    assert!(matches!(failure, Err(ServiceError::Conflict)));
    let restored = service.get("demo").await.unwrap();
    assert_eq!(restored.revision, 3);
    assert_eq!(
        serde_json::to_value(restored.document).unwrap(),
        serde_json::to_value(document()).unwrap()
    );
    let event = events.try_recv().unwrap();
    assert_eq!(event.id, "demo");
    assert_eq!(event.revision, 3);
    assert!(!event.deleted);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    assert!(matches!(
        service.delete_with_revision("demo", Some(1)).await,
        Err(ServiceError::Conflict)
    ));
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test]
async fn concurrent_publication_and_deletion_follow_commit_order() {
    let (directory, first) = service().await;
    let second = AppService::open(&directory.path().join("lain.sqlite"))
        .await
        .unwrap();
    first.publish("demo", request(document())).await.unwrap();
    let mut events = first.subscribe();
    let mut other_events = second.subscribe();
    let (deleted, published) = tokio::join!(
        first.delete("demo"),
        second.publish("demo", request(document()))
    );
    let stored = published.unwrap();
    let deleted = deleted.unwrap();
    assert!(deleted.deleted);
    let mut revisions = [deleted.revision, stored.revision];
    revisions.sort();
    assert_eq!(revisions, [2, 3]);
    if deleted.revision > stored.revision {
        assert!(matches!(
            first.get("demo").await,
            Err(ServiceError::NotFound)
        ));
    } else {
        assert_eq!(
            serde_json::to_value(first.get("demo").await.unwrap()).unwrap(),
            serde_json::to_value(&stored).unwrap()
        );
    }
    let event = events.try_recv().unwrap();
    assert_eq!(event.revision, deleted.revision);
    assert!(event.deleted);
    let event = other_events.try_recv().unwrap();
    assert_eq!(event.revision, stored.revision);
    assert!(!event.deleted);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    assert!(matches!(other_events.try_recv(), Err(TryRecvError::Empty)));
}

async fn service() -> (TempDir, AppService) {
    let directory = tempfile::tempdir().unwrap();
    let service = AppService::open(&directory.path().join("lain.sqlite"))
        .await
        .unwrap();
    (directory, service)
}

async fn assert_invalid(service: &AppService, document: Explanation, message: &str) {
    match service.publish("invalid", request(document)).await {
        Err(ServiceError::Invalid(error)) => assert!(
            error.contains(message),
            "{error:?} should contain {message:?}"
        ),
        result => panic!("expected invalid document, got {result:?}"),
    }
    assert!(matches!(
        service.get("invalid").await,
        Err(ServiceError::NotFound)
    ));
}

#[tokio::test]
async fn flow_roles_round_trip_and_require_a_flow_diagram() {
    let (_directory, service) = service().await;
    for role in [
        "action",
        "decision",
        "start",
        "end",
        "subprocess",
        "database",
        "preparation",
        "inputOutput",
        "outputInput",
        "priorityAction",
        "manualOperation",
        "document",
        "multiDocument",
        "delay",
    ] {
        let mut value = serde_json::to_value(document()).unwrap();
        value["diagrams"][0]["nodes"][0]["role"] = json!(role);
        let authored: Explanation = serde_json::from_value(value.clone()).unwrap();
        service.publish(role, request(authored)).await.unwrap();
        assert_eq!(
            serde_json::to_value(service.get(role).await.unwrap().document).unwrap(),
            value
        );
    }
    for mut value in [
        serde_json::to_value(document()).unwrap(),
        serde_json::to_value(sequence_document()).unwrap(),
    ] {
        if value["diagrams"][0]["kind"] == "flow" {
            value["diagrams"][0]["kind"] = json!("state");
        }
        for role in [
            "decision",
            "database",
            "preparation",
            "inputOutput",
            "outputInput",
            "priorityAction",
            "manualOperation",
            "document",
            "multiDocument",
            "delay",
        ] {
            value["diagrams"][0]["nodes"][0]["role"] = json!(role);
            assert_invalid(
                &service,
                serde_json::from_value(value.clone()).unwrap(),
                "role requires kind flow",
            )
            .await;
        }
    }
    let mut invalid = serde_json::to_value(document()).unwrap();
    invalid["diagrams"][0]["nodes"][0]["role"] = json!("triangle");
    assert!(serde_json::from_value::<Explanation>(invalid).is_err());
}

#[tokio::test]
async fn detail_links_resolve_diagrams_and_require_subprocess_roles_on_flows() {
    let (_directory, service) = service().await;
    let mut value = serde_json::to_value(document()).unwrap();
    let mut detail = serde_json::to_value(sequence_document()).unwrap()["diagrams"][0].clone();
    detail["id"] = json!("detail");
    value["diagrams"].as_array_mut().unwrap().push(detail);
    value["diagrams"][0]["nodes"][0]["role"] = json!("subprocess");
    value["diagrams"][0]["nodes"][0]["detailDiagramId"] = json!("detail");
    service
        .publish(
            "subprocess",
            request(serde_json::from_value(value.clone()).unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(service.get("subprocess").await.unwrap().document).unwrap(),
        value
    );
    for (field, replacement, error) in [
        (
            "detailDiagramId",
            json!("missing"),
            "unknown detail diagram",
        ),
        (
            "role",
            json!("action"),
            "detailDiagramId on a flow node requires role subprocess",
        ),
        (
            "role",
            json!(null),
            "detailDiagramId on a flow node requires role subprocess",
        ),
    ] {
        let mut invalid = value.clone();
        invalid["diagrams"][0]["nodes"][0][field] = replacement;
        assert_invalid(&service, serde_json::from_value(invalid).unwrap(), error).await;
    }
    let mut compatible = value.clone();
    let node = compatible["diagrams"][0]["nodes"][0]
        .as_object_mut()
        .unwrap();
    node.remove("detailDiagramId");
    node.insert("subprocessDiagramId".into(), json!("detail"));
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<Explanation>(compatible).unwrap()).unwrap(),
        value
    );
}

#[tokio::test]
async fn process_documents_load_and_publish_as_flow_with_recorded_data_intact() {
    use sqlx::Connection;
    let (directory, service) = service().await;
    let expected = serde_json::to_value(document()).unwrap();
    let mut compatible = expected.clone();
    compatible["diagrams"][0]["kind"] = json!("process");
    let options =
        sqlx::sqlite::SqliteConnectOptions::new().filename(directory.path().join("lain.sqlite"));
    let mut connection = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    sqlx::query("INSERT INTO explanations (id, revision, document_json, updated_at_ms) VALUES ('compatible', 7, ?, 123)")
        .bind(compatible.to_string())
        .execute(&mut connection)
        .await
        .unwrap();
    let loaded = service.get("compatible").await.unwrap();
    assert_eq!(loaded.revision, 7);
    assert_eq!(loaded.updated_at_ms, 123);
    assert_eq!(serde_json::to_value(loaded.document).unwrap(), expected);
    assert_eq!(service.list().await.unwrap()[0].diagram_count, 1);
    let published = service
        .publish(
            "compatible",
            request(serde_json::from_value(compatible).unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(published.revision, 8);
    assert_eq!(serde_json::to_value(published.document).unwrap(), expected);
    let persisted: String =
        sqlx::query_scalar("SELECT document_json FROM explanations WHERE id = 'compatible'")
            .fetch_one(&mut connection)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&persisted).unwrap(),
        expected
    );
}

#[tokio::test]
async fn publication_notifies_after_commit_and_reopens_exact_recorded_states() {
    let (directory, service) = service().await;
    let original = document();
    let expected = serde_json::to_value(&original).unwrap();
    let mut events = service.subscribe();
    let stored = service
        .publish("order-demo", request(original))
        .await
        .unwrap();
    assert_eq!(stored.id, "order-demo");
    assert_eq!(stored.revision, 1);
    assert!(stored.updated_at_ms > 0);
    let event = events.try_recv().unwrap();
    assert_eq!(event.id, "order-demo");
    assert_eq!(event.revision, 1);
    let loaded = service.get(&event.id).await.unwrap();
    assert_eq!(serde_json::to_value(&loaded.document).unwrap(), expected);
    let summaries = service.list().await.unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].id, "order-demo");
    assert_eq!(summaries[0].title, "Recorded order");
    assert_eq!(summaries[0].description, loaded.document.description);
    assert_eq!(summaries[0].revision, 1);
    assert_eq!(summaries[0].updated_at_ms, stored.updated_at_ms);
    assert_eq!(summaries[0].diagram_count, 1);
    assert_eq!(summaries[0].scenario_count, 1);
    drop(events);
    drop(service);
    let reopened = AppService::open(&directory.path().join("lain.sqlite"))
        .await
        .unwrap();
    let loaded = reopened.get("order-demo").await.unwrap();
    assert_eq!(
        serde_json::to_value(&loaded).unwrap(),
        serde_json::to_value(&stored).unwrap()
    );
    let mut replacement = document();
    replacement.title = "Second recorded revision".into();
    assert_eq!(
        reopened
            .publish("order-demo", request(replacement))
            .await
            .unwrap()
            .revision,
        2
    );
    assert_eq!(
        reopened.get("order-demo").await.unwrap().document.title,
        "Second recorded revision"
    );
}

#[tokio::test]
async fn concurrent_publications_commit_distinct_revisions_and_the_latest_complete_document() {
    let (directory, first) = service().await;
    let second = AppService::open(&directory.path().join("lain.sqlite"))
        .await
        .unwrap();
    let mut events = first.subscribe();
    let mut other_events = second.subscribe();
    for expected_revisions in [[1, 2], [3, 4]] {
        let mut left_document = document();
        left_document.title = "Left publication".into();
        left_document.description = "Left recorded state".into();
        let mut right_document = document();
        right_document.title = "Right publication".into();
        right_document.scenarios[0].occurrences[0].narration = "Right recorded state".into();
        let (left, right) = tokio::join!(
            first.publish("demo", request(left_document)),
            second.publish("demo", request(right_document))
        );
        let left = left.unwrap();
        let right = right.unwrap();
        let mut revisions = [left.revision, right.revision];
        revisions.sort_unstable();
        assert_eq!(revisions, expected_revisions);
        let latest = if left.revision > right.revision {
            left
        } else {
            right
        };
        assert_eq!(
            serde_json::to_value(first.get("demo").await.unwrap()).unwrap(),
            serde_json::to_value(latest).unwrap()
        );
        let mut revisions = [
            events.try_recv().unwrap().revision,
            other_events.try_recv().unwrap().revision,
        ];
        revisions.sort_unstable();
        assert_eq!(revisions, expected_revisions);
        assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
        assert!(matches!(other_events.try_recv(), Err(TryRecvError::Empty)));
    }
}

#[tokio::test]
async fn cancelled_mutations_finish_persistence_and_notify_after_sqlite_unblocks() {
    use sqlx::Connection;
    use std::{
        future::{Future, poll_fn},
        task::Poll,
        time::Duration,
    };

    for delete in [false, true] {
        let (directory, service) = service().await;
        service.publish("demo", request(document())).await.unwrap();
        let mut events = service.subscribe();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(directory.path().join("lain.sqlite"));
        let mut connection = sqlx::SqliteConnection::connect_with(&options)
            .await
            .unwrap();
        let transaction = connection.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let mut replacement = document();
        replacement.title = "Cancelled caller's committed revision".into();
        let expected = serde_json::to_value(&replacement).unwrap();
        let mut publication = Box::pin(async {
            if delete {
                service.delete("demo").await.map(|_| ())
            } else {
                service
                    .publish("demo", request(replacement))
                    .await
                    .map(|_| ())
            }
        });
        poll_fn(|context| {
            assert!(publication.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        tokio::task::yield_now().await;
        assert_eq!(service.get("demo").await.unwrap().revision, 1);
        assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
        drop(publication);
        transaction.commit().await.unwrap();
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("cancelled mutation must still notify")
            .unwrap();
        assert_eq!(event.id, "demo");
        assert_eq!(event.revision, 2);
        assert_eq!(event.deleted, delete);
        if delete {
            assert!(matches!(
                service.get("demo").await,
                Err(ServiceError::NotFound)
            ));
        } else {
            let stored = service.get("demo").await.unwrap();
            assert_eq!(stored.revision, 2);
            assert_eq!(serde_json::to_value(stored.document).unwrap(), expected);
        }
        assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    }
}

#[tokio::test]
async fn entities_allow_200_attributes_and_reject_excess_definitions_before_storage() {
    let (_directory, service) = service().await;
    let mut authored = document();
    for number in 2..200 {
        authored.domain.entities[0]
            .attributes
            .push(lain::model::Attribute {
                id: format!("attribute-{number}"),
                label: format!("Attribute {number}"),
            });
    }
    let values = &mut authored.scenarios[0].occurrences[0].after.instances[0].values;
    for number in 2..200 {
        values.insert(format!("attribute-{number}"), json!(number));
    }
    let stored = service
        .publish("attribute-limit", request(authored.clone()))
        .await
        .unwrap();
    assert_eq!(stored.document.domain.entities[0].attributes.len(), 200);
    assert_eq!(
        stored.document.scenarios[0].occurrences[0].after.instances[0]
            .values
            .len(),
        200
    );
    authored.domain.entities[0]
        .attributes
        .push(lain::model::Attribute {
            id: "excess".into(),
            label: "Excess attribute".into(),
        });
    assert_invalid(&service, authored, "entity attributes exceeds limit of 200").await;
}

#[tokio::test]
async fn failed_publications_leave_revision_and_notifications_unchanged() {
    let (_directory, service) = service().await;
    service.publish("demo", request(document())).await.unwrap();
    let mut events = service.subscribe();
    let mut invalid = document();
    invalid.diagrams[0].nodes[0]
        .entity_ids
        .push("missing".into());
    assert!(matches!(
        service.publish("demo", request(invalid)).await,
        Err(ServiceError::Invalid(_))
    ));
    assert!(matches!(
        service.publish("../escape", request(document())).await,
        Err(ServiceError::Invalid(_))
    ));
    assert!(matches!(
        service.get("bad/id").await,
        Err(ServiceError::Invalid(_))
    ));
    assert_eq!(service.get("demo").await.unwrap().revision, 1);
    assert_eq!(service.list().await.unwrap().len(), 1);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test]
async fn all_reference_boundaries_reject_unresolved_ids() {
    let (_directory, service) = service().await;
    let cases: &[(&str, &str)] = &[
        ("/domain/relationships/0/sourceEntityId", "source entity"),
        ("/domain/relationships/0/targetEntityId", "target entity"),
        ("/diagrams/0/nodes/0/entityIds/0", "node entity"),
        ("/diagrams/0/edges/0/sourceNodeId", "edge source node"),
        ("/diagrams/0/edges/0/targetNodeId", "edge target node"),
        ("/scenarios/0/diagramId", "scenario diagram"),
        ("/scenarios/0/occurrences/0/nodeId", "occurrence node"),
        (
            "/scenarios/0/occurrences/0/after/instances/0/entityId",
            "instance entity",
        ),
        (
            "/scenarios/0/occurrences/0/after/links/0/relationshipId",
            "link relationship",
        ),
        (
            "/scenarios/0/occurrences/0/after/links/0/sourceInstanceId",
            "link source instance",
        ),
        (
            "/scenarios/0/occurrences/0/after/links/0/targetInstanceId",
            "link target instance",
        ),
    ];
    for (pointer, error) in cases {
        let mut value = serde_json::to_value(document()).unwrap();
        *value.pointer_mut(pointer).unwrap() = json!("missing");
        assert_invalid(&service, serde_json::from_value(value).unwrap(), error).await;
    }
    let mut invalid = document();
    invalid.scenarios[0].occurrences[0].after.instances[0]
        .values
        .insert("other".into(), json!(1));
    assert_invalid(&service, invalid, "unknown attribute").await;
}

#[tokio::test]
async fn authored_branch_revisits_and_self_loops_preserve_occurrence_identity() {
    let (_directory, service) = service().await;
    let mut authored = document();
    for (id, node, edge) in [
        ("visit-2", "accepted", "accept"),
        ("visit-3", "start", "retry"),
        ("visit-4", "start", "wait"),
    ] {
        let mut occurrence = authored.scenarios[0].occurrences[0].clone();
        occurrence.id = id.into();
        occurrence.node_id = node.into();
        occurrence.incoming_edge_id = Some(edge.into());
        occurrence.narration = id.into();
        occurrence.after.instances[0]
            .values
            .insert("status".into(), json!(id));
        authored.scenarios[0].occurrences.push(occurrence);
    }
    let stored = service
        .publish("visits", request(authored.clone()))
        .await
        .unwrap();
    let visits = &stored.document.scenarios[0].occurrences;
    assert_eq!(
        visits
            .iter()
            .map(|visit| visit.id.as_str())
            .collect::<Vec<_>>(),
        ["visit-1", "visit-2", "visit-3", "visit-4"]
    );
    assert_eq!(
        visits[2].after.instances[0].values["status"],
        json!("visit-3")
    );
    assert_eq!(
        visits[3].after.instances[0].values["status"],
        json!("visit-4")
    );
    authored.scenarios[0].occurrences[1].incoming_edge_id = Some("reject".into());
    assert_invalid(&service, authored.clone(), "does not connect").await;
    authored.scenarios[0].occurrences[1].incoming_edge_id = None;
    assert_invalid(&service, authored.clone(), "require an incomingEdgeId").await;
    authored.scenarios[0].occurrences[0].incoming_edge_id = Some("wait".into());
    assert_invalid(&service, authored, "first occurrence").await;
}

#[tokio::test]
async fn snapshot_links_enforce_duplicate_endpoint_and_both_cardinality_rules() {
    let (_directory, service) = service().await;
    let mut authored = document();
    let snapshot = &mut authored.scenarios[0].occurrences[0].after;
    snapshot.links.push(snapshot.links[0].clone());
    assert_invalid(&service, authored, "duplicate link").await;
    let mut authored = document();
    authored.scenarios[0].occurrences[0].after.links[0].target_instance_id = "o1".into();
    assert_invalid(&service, authored, "endpoint entity types").await;
    let mut authored = document();
    let snapshot = &mut authored.scenarios[0].occurrences[0].after;
    let mut customer = snapshot.instances[1].clone();
    customer.id = "c2".into();
    snapshot.instances.push(customer);
    let mut link = snapshot.links[0].clone();
    link.target_instance_id = "c2".into();
    snapshot.links.push(link);
    assert_invalid(&service, authored.clone(), "target cardinality one").await;
    authored.domain.relationships[0].target_cardinality = lain::model::Cardinality::ExactlyOne;
    assert_invalid(&service, authored.clone(), "target cardinality one").await;
    authored.domain.relationships[0].target_cardinality = lain::model::Cardinality::ZeroOrMore;
    service
        .publish("many-targets", request(authored))
        .await
        .unwrap();
    let mut authored = document();
    let snapshot = &mut authored.scenarios[0].occurrences[0].after;
    let mut order = snapshot.instances[0].clone();
    order.id = "o2".into();
    snapshot.instances.push(order);
    let mut link = snapshot.links[0].clone();
    link.source_instance_id = "o2".into();
    snapshot.links.push(link);
    service
        .publish("many-sources", request(authored.clone()))
        .await
        .unwrap();
    authored.domain.relationships[0].source_cardinality = lain::model::Cardinality::ZeroOrOne;
    assert_invalid(&service, authored.clone(), "source cardinality one").await;
    authored.domain.relationships[0].source_cardinality = lain::model::Cardinality::ExactlyOne;
    assert_invalid(&service, authored, "source cardinality one").await;
}

#[tokio::test]
async fn required_endpoints_enforce_minimum_links_in_both_snapshots() {
    use lain::model::Cardinality;
    let (_directory, service) = service().await;
    for cardinality in [Cardinality::ExactlyOne, Cardinality::OneOrMore] {
        for source in [false, true] {
            let mut authored = document();
            if source {
                authored.domain.relationships[0].source_cardinality = cardinality;
            } else {
                authored.domain.relationships[0].target_cardinality = cardinality;
            }
            service
                .publish(
                    &format!("required-{cardinality:?}-{source}"),
                    request(authored.clone()),
                )
                .await
                .unwrap();
            for before in [false, true] {
                for missing_instance in [false, true] {
                    let mut invalid = authored.clone();
                    let occurrence = &mut invalid.scenarios[0].occurrences[0];
                    let (phase, snapshot) = if before {
                        occurrence.before = occurrence.after.clone();
                        ("before", &mut occurrence.before)
                    } else {
                        ("after", &mut occurrence.after)
                    };
                    snapshot.links.clear();
                    let (endpoint, instance_id, related_entity) = if source {
                        ("source", "c1", "order")
                    } else {
                        ("target", "o1", "customer")
                    };
                    if missing_instance {
                        snapshot
                            .instances
                            .retain(|instance| instance.entity_id != related_entity);
                    }
                    let (required, optional) = match cardinality {
                        Cardinality::ExactlyOne => ("exactlyOne", "zeroOrOne"),
                        Cardinality::OneOrMore => ("oneOrMore", "zeroOrMore"),
                        _ => unreachable!(),
                    };
                    let expected = format!(
                        "scenario \"happy\", occurrence \"visit-1\", {phase} snapshot: relationship \"placed-by\": instance {instance_id:?} requires at least one {endpoint} link ({endpoint}Cardinality={required}); include a related instance of entity {related_entity:?} and its link in this same snapshot, or use {endpoint}Cardinality={optional} only if the domain permits no {endpoint}"
                    );
                    assert_invalid(&service, invalid, &expected).await;
                }
            }
        }
    }
}

#[tokio::test]
async fn instance_entity_identity_survives_absence_but_is_scoped_to_scenario() {
    let (_directory, service) = service().await;
    let mut authored = document();
    let mut later = authored.scenarios[0].occurrences[0].clone();
    later.id = "later".into();
    later.incoming_edge_id = Some("wait".into());
    later.after.links.clear();
    later.after.instances[0].entity_id = "customer".into();
    later.after.instances[0].values.clear();
    authored.scenarios[0].occurrences.push(later.clone());
    assert_invalid(&service, authored.clone(), "changes entity identity").await;
    authored.scenarios[0].occurrences.pop();
    later.incoming_edge_id = None;
    let mut separate = authored.scenarios[0].clone();
    separate.id = "separate".into();
    separate.occurrences = vec![later];
    authored.scenarios.push(separate);
    service
        .publish("separate", request(authored))
        .await
        .unwrap();
    let mut authored = document();
    authored.scenarios[0].occurrences[0].before =
        authored.scenarios[0].occurrences[0].after.clone();
    authored.scenarios[0].occurrences[0].before.links.clear();
    authored.scenarios[0].occurrences[0].before.instances[0].entity_id = "customer".into();
    authored.scenarios[0].occurrences[0].before.instances[0]
        .values
        .clear();
    assert_invalid(&service, authored, "changes entity identity").await;
}

#[tokio::test]
async fn collection_ids_and_minimum_counts_are_validated_before_storage() {
    let (_directory, service) = service().await;
    for pointer in [
        "/domain/entities",
        "/domain/relationships",
        "/domain/entities/0/attributes",
        "/diagrams",
        "/diagrams/0/nodes",
        "/diagrams/0/edges",
        "/scenarios",
        "/scenarios/0/occurrences",
        "/scenarios/0/occurrences/0/after/instances",
    ] {
        let mut value = serde_json::to_value(document()).unwrap();
        let array = value.pointer_mut(pointer).unwrap().as_array_mut().unwrap();
        array.push(array[0].clone());
        assert_invalid(
            &service,
            serde_json::from_value(value).unwrap(),
            "duplicate",
        )
        .await;
    }
    for pointer in ["/diagrams", "/scenarios", "/scenarios/0/occurrences"] {
        let mut value = serde_json::to_value(document()).unwrap();
        *value.pointer_mut(pointer).unwrap() = json!([]);
        assert_invalid(
            &service,
            serde_json::from_value(value).unwrap(),
            "at least one",
        )
        .await;
    }
    let mut invalid = document();
    invalid.domain.entities[0].id = "🦀".into();
    assert_invalid(&service, invalid, "invalid ID").await;
}

#[tokio::test]
async fn nested_captured_values_enforce_depth_text_and_document_size_limits() {
    let (_directory, service) = service().await;
    let mut authored = document();
    let mut nested = json!(null);
    for _ in 0..23 {
        nested = json!([nested]);
    }
    authored.scenarios[0].occurrences[0].after.instances[0]
        .values
        .insert("details".into(), nested.clone());
    service
        .publish("depth-limit", request(authored.clone()))
        .await
        .unwrap();
    authored.scenarios[0].occurrences[0].after.instances[0]
        .values
        .insert("details".into(), json!([nested]));
    assert_invalid(&service, authored, "nesting levels").await;
    let mut authored = document();
    authored.title = "x".repeat(32 * 1024);
    service
        .publish("text-limit", request(authored.clone()))
        .await
        .unwrap();
    authored.title.push('x');
    assert_invalid(&service, authored, "text bytes").await;
    let mut authored = document();
    authored.scenarios[0].occurrences[0].after.instances[0]
        .values
        .insert("details".into(), json!(vec!["x".repeat(32 * 1024); 65]));
    assert_invalid(&service, authored, "serialized document bytes").await;
}

#[test]
fn document_json_requires_camel_case_explicit_nullable_fields_and_known_structure() {
    let original = serde_json::to_value(document()).unwrap();
    assert!(original.get("schemaVersion").is_some());
    assert!(original.get("schema_version").is_none());
    let mut invalid = original.clone();
    invalid["surprise"] = json!(true);
    assert!(serde_json::from_value::<Explanation>(invalid).is_err());
    let mut invalid = original.clone();
    invalid["scenarios"][0]["occurrences"][0]["after"]["surprise"] = json!(true);
    assert!(serde_json::from_value::<Explanation>(invalid).is_err());
    for field in ["incomingEdgeId", "trigger", "before", "after"] {
        let mut invalid = original.clone();
        invalid["scenarios"][0]["occurrences"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            serde_json::from_value::<Explanation>(invalid).is_err(),
            "{field} must be present"
        );
    }
}

#[tokio::test]
async fn captured_numbers_require_safe_bounds_and_preserve_exact_large_strings() {
    let (_directory, service) = service().await;
    let mut authored = document();
    let float_boundaries: serde_json::Value = serde_json::from_str(
        "[9007199254740991.0, 9.007199254740991e15, -9007199254740991.0, -9.007199254740991e15]",
    )
    .unwrap();
    let captured = json!({
        "values": [
            -9_007_199_254_740_991_i64,
            9_007_199_254_740_991_u64,
            89.9, null, true, false
        ],
        "exact": "9007199254740993",
        "floatBoundaries": float_boundaries
    });
    authored.scenarios[0].occurrences[0].after.instances[0]
        .values
        .insert("details".into(), captured.clone());
    let mut events = service.subscribe();
    let stored = service
        .publish("numbers", request(authored.clone()))
        .await
        .unwrap();
    assert_eq!(events.try_recv().unwrap().revision, 1);
    let serialized = serde_json::to_string(&stored.document).unwrap();
    let serialized: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(
        serialized["scenarios"][0]["occurrences"][0]["after"]["instances"][0]["values"]["details"],
        captured
    );
    for literal in [
        "9007199254740992",
        "9007199254740993",
        "-9007199254740992",
        "-9007199254740993",
        "9007199254740993.0",
        "-9007199254740993.0",
        "18446744073709551615",
        "-9223372036854775808",
        "9.007199254740992e15",
        "-9.007199254740992e15",
        "9.007199254740993e15",
        "-9.007199254740993e15",
        "1e100",
        "-1e100",
    ] {
        let number: serde_json::Value = serde_json::from_str(literal).unwrap();
        let mut invalid = authored.clone();
        invalid.scenarios[0].occurrences[0].after.instances[0]
            .values
            .insert("details".into(), json!({"nested": [number]}));
        match service.publish("numbers", request(invalid)).await {
            Err(ServiceError::Invalid(error)) => {
                assert!(
                    error.contains("[-9007199254740991, 9007199254740991]"),
                    "{error}"
                );
                assert!(
                    error.contains("encode out-of-range values as strings"),
                    "{error}"
                );
            }
            result => panic!("unsafe number {literal} must fail validation: {result:?}"),
        }
    }
    let loaded = service.get("numbers").await.unwrap();
    assert_eq!(loaded.revision, 1);
    for (index, expected) in [
        9_007_199_254_740_991.0,
        9_007_199_254_740_991.0,
        -9_007_199_254_740_991.0,
        -9_007_199_254_740_991.0,
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            loaded.document.scenarios[0].occurrences[0].after.instances[0].values["details"]
                ["floatBoundaries"][index]
                .as_f64(),
            Some(expected)
        );
    }
    assert_eq!(serde_json::to_value(loaded.document).unwrap(), serialized);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test]
async fn document_collections_enforce_bounded_counts_and_supported_schema_version() {
    let (_directory, service) = service().await;
    for (pointer, count, error) in [
        ("/domain/entities", 201, "entities exceeds"),
        ("/domain/relationships", 501, "relationships exceeds"),
        ("/diagrams", 51, "diagrams exceeds"),
        ("/scenarios", 101, "scenarios exceeds"),
        ("/diagrams/0/nodes", 201, "diagram nodes exceeds"),
        ("/diagrams/0/edges", 501, "diagram edges exceeds"),
        (
            "/scenarios/0/occurrences",
            2_001,
            "total occurrences exceeds",
        ),
        (
            "/scenarios/0/occurrences/0/after/instances",
            501,
            "snapshot instances exceeds",
        ),
    ] {
        let mut value = serde_json::to_value(document()).unwrap();
        let array = value.pointer_mut(pointer).unwrap().as_array_mut().unwrap();
        let prototype = array[0].clone();
        while array.len() < count {
            let mut item = prototype.clone();
            item["id"] = json!(format!("extra-{}", array.len()));
            array.push(item);
        }
        assert_invalid(&service, serde_json::from_value(value).unwrap(), error).await;
    }
    let mut invalid = document();
    invalid.schema_version = 2;
    assert_invalid(&service, invalid, "schemaVersion must be 1").await;
}

#[tokio::test]
async fn concurrent_database_initialization_preserves_schema_and_data() {
    use sqlx::Connection;
    for legacy in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("lain.sqlite");
        if legacy {
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true);
            let mut connection = sqlx::SqliteConnection::connect_with(&options)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE explanations (id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0), document_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0))").execute(&mut connection).await.unwrap();
            sqlx::query("INSERT INTO explanations VALUES ('legacy', 7, ?, 123)")
                .bind({
                    let mut stored = serde_json::to_value(document()).unwrap();
                    stored["domain"]["relationships"][0]["sourceCardinality"] = json!("many");
                    stored["domain"]["relationships"][0]["targetCardinality"] = json!("one");
                    stored.to_string()
                })
                .execute(&mut connection)
                .await
                .unwrap();
            sqlx::query("PRAGMA user_version = 1")
                .execute(&mut connection)
                .await
                .unwrap();
        }
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(8));
        let mut openings = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let path = path.clone();
            let barrier = barrier.clone();
            openings.spawn(async move {
                barrier.wait().await;
                AppService::open(&path).await
            });
        }
        let mut services = Vec::new();
        while let Some(opened) = openings.join_next().await {
            services.push(opened.unwrap().unwrap());
        }
        services[0]
            .publish("shared", request(document()))
            .await
            .unwrap();
        for service in services {
            assert_eq!(service.get("shared").await.unwrap().revision, 1);
            if legacy {
                let stored = service.get("legacy").await.unwrap();
                assert_eq!(stored.revision, 7);
                assert_eq!(stored.updated_at_ms, 123);
                assert_eq!(
                    serde_json::to_value(stored.document).unwrap(),
                    serde_json::to_value(document()).unwrap()
                );
            }
        }
    }
}

#[tokio::test]
async fn sqlite_uses_versioned_wal_and_rejects_unknown_schema_versions() {
    use sqlx::Connection;
    let (directory, service) = service().await;
    service.publish("demo", request(document())).await.unwrap();
    let path = directory.path().join("lain.sqlite");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path);
    let mut connection = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(version, 2);
    assert_eq!(journal, "wal");
    sqlx::query("PRAGMA user_version = 99")
        .execute(&mut connection)
        .await
        .unwrap();
    assert!(matches!(
        AppService::open(&path).await,
        Err(ServiceError::Storage(_))
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn database_files_are_private_and_symlink_targets_are_untouched() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (directory, service) = service().await;
    service.publish("demo", request(document())).await.unwrap();
    for name in ["lain.sqlite", "lain.sqlite-wal", "lain.sqlite-shm"] {
        let mode = std::fs::metadata(directory.path().join(name))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{name}");
    }
    let target = directory.path().join("target");
    std::fs::write(&target, "private sentinel").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
    let link = directory.path().join("linked.sqlite");
    symlink(&target, &link).unwrap();
    assert!(matches!(
        AppService::open(&link).await,
        Err(ServiceError::Storage(_))
    ));
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "private sentinel"
    );
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o644
    );
}
