use std::collections::{BTreeSet, HashMap, HashSet};

use lain::{
    model::{Explanation, PublishRequest},
    service::AppService,
};
use serde_json::json;

const DEMOS: [(&str, &str); 5] = [
    (
        "order-lifecycle",
        include_str!("../examples/order-lifecycle.json"),
    ),
    (
        "release-promotion",
        include_str!("../examples/release-promotion.json"),
    ),
    (
        "incident-recovery",
        include_str!("../examples/incident-recovery.json"),
    ),
    (
        "pr-comment-review",
        include_str!("../examples/pr-comment-review.json"),
    ),
    (
        "shopping-cart",
        include_str!("../examples/shopping-cart.json"),
    ),
];

fn document(index: usize) -> Explanation {
    serde_json::from_str(DEMOS[index].1).unwrap()
}

#[test]
fn shopping_cart_records_explicit_scopes_and_independent_payment_retry_visits() {
    let authored = document(4);
    authored.validate().unwrap();
    let wiring = authored.wiring.as_ref().unwrap();
    let storefront = wiring
        .components
        .iter()
        .find(|item| item.id == "storefront")
        .unwrap();
    assert_eq!(storefront.technology.as_ref().unwrap().name, "Angular");
    let retry = authored
        .scenarios
        .iter()
        .find(|item| item.id == "cart-payment-retry")
        .unwrap();
    let mapped: Vec<_> = retry
        .occurrences
        .iter()
        .filter(|item| item.wiring_refs.is_some())
        .map(|item| item.id.as_str())
        .collect();
    assert_eq!(mapped.len(), 11);
    assert!(!mapped.contains(&"retry-second-review"));
    let payment_visits: Vec<_> = retry
        .occurrences
        .iter()
        .filter(|item| item.node_id == "pay")
        .map(|item| item.id.as_str())
        .collect();
    assert_eq!(
        payment_visits,
        ["retry-first-payment", "retry-second-payment"]
    );
    let success = authored
        .scenarios
        .iter()
        .find(|item| item.id == "cart-checkout-success")
        .unwrap();
    let empty = success
        .occurrences
        .iter()
        .find(|item| item.id == "success-local-review")
        .unwrap();
    assert_eq!(
        serde_json::to_value(empty.wiring_refs.as_ref().unwrap()).unwrap(),
        json!({})
    );
    let rejected = authored
        .scenarios
        .iter()
        .find(|item| item.id == "cart-stock-rejected")
        .unwrap();
    assert!(rejected.occurrences.iter().all(|item| {
        !item
            .wiring_refs
            .as_ref()
            .unwrap()
            .connection_ids
            .iter()
            .any(|id| {
                ["authorize-payment", "publish-order", "consume-order"].contains(&id.as_str())
            })
    }));
}

#[test]
fn order_lifecycle_maps_every_visit_without_snapshot_inferred_queue_activity() {
    let authored = document(0);
    authored.validate().unwrap();
    assert!(
        authored
            .scenarios
            .iter()
            .flat_map(|item| &item.occurrences)
            .all(|item| item.wiring_refs.is_some())
    );
    for id in [
        "duplicate-callback",
        "sequence-duplicate-callback",
        "declined-payment",
        "sequence-declined-payment",
    ] {
        let scenario = authored
            .scenarios
            .iter()
            .find(|item| item.id == id)
            .unwrap();
        assert!(scenario.occurrences.iter().all(|item| {
            !item
                .wiring_refs
                .as_ref()
                .unwrap()
                .connection_ids
                .contains(&"fulfillment-publication".into())
        }));
    }
}

#[test]
fn shopping_cart_records_individual_sql_operations_and_distinct_inventory_reads_and_writes() {
    use lain::wiring::WiringOperationKind::{Query, Write};
    let authored = document(4);
    let wiring = authored.wiring.as_ref().unwrap();
    for (wire_id, component_id, operation_id, kind, verb) in [
        (
            "persist-cart",
            "commerce-store",
            "read-cart",
            Query,
            "SELECT",
        ),
        (
            "write-cart",
            "commerce-store",
            "update-cart",
            Write,
            "UPDATE",
        ),
        (
            "write-cart-total",
            "commerce-store",
            "update-total",
            Write,
            "UPDATE",
        ),
        (
            "record-order",
            "commerce-store",
            "insert-order",
            Write,
            "INSERT",
        ),
        (
            "read-stock",
            "inventory-store",
            "read-balance",
            Query,
            "SELECT",
        ),
        (
            "increment-reserved-stock",
            "inventory-store",
            "increment-reserved",
            Write,
            "UPDATE",
        ),
        (
            "insert-stock-hold",
            "inventory-store",
            "insert-hold",
            Write,
            "INSERT",
        ),
        (
            "read-stock-hold",
            "inventory-store",
            "read-hold",
            Query,
            "SELECT",
        ),
    ] {
        let wire = wiring
            .connections
            .iter()
            .find(|item| item.id == wire_id)
            .unwrap();
        assert_eq!(wire.kind, Some(kind), "{wire_id}");
        assert_eq!(wire.target.component_id, component_id, "{wire_id}");
        assert_eq!(
            wire.target.operation_id.as_deref(),
            Some(operation_id),
            "{wire_id}"
        );
        let owner = wiring
            .components
            .iter()
            .find(|item| item.id == component_id)
            .unwrap();
        let operation = owner
            .operations
            .iter()
            .find(|item| item.id == operation_id)
            .unwrap();
        assert_eq!(operation.kind, kind, "{wire_id}");
        assert_eq!(
            operation.statement.split_whitespace().next(),
            Some(verb),
            "{wire_id}"
        );
    }
    let retry = authored
        .scenarios
        .iter()
        .find(|item| item.id == "cart-payment-retry")
        .unwrap();
    let check = retry
        .occurrences
        .iter()
        .find(|item| item.id == "retry-check-existing-hold")
        .unwrap();
    assert_eq!(
        check.wiring_refs.as_ref().unwrap().connection_ids,
        [
            "submit-retry",
            "check-reservation",
            "read-stock-hold",
            "trace-retry"
        ]
    );
    let rejected = authored
        .scenarios
        .iter()
        .find(|item| item.id == "cart-stock-rejected")
        .unwrap();
    let rejected_calls: BTreeSet<_> = rejected
        .occurrences
        .iter()
        .flat_map(|item| &item.wiring_refs.as_ref().unwrap().connection_ids)
        .map(String::as_str)
        .collect();
    assert!(rejected_calls.contains("read-stock"));
    for write in [
        "increment-reserved-stock",
        "insert-stock-hold",
        "consume-reservation",
    ] {
        assert!(!rejected_calls.contains(write), "{write}");
    }
}

#[test]
fn shopping_cart_separates_topic_publication_queue_delivery_and_worker_consumption() {
    use lain::wiring::{
        WiringComponentKind,
        WiringOperationKind::{Consume, Publish, Telemetry},
    };
    let authored = document(4);
    let wiring = authored.wiring.as_ref().unwrap();
    for (id, kind) in [
        ("order-topic", WiringComponentKind::Topic),
        ("checkout-events", WiringComponentKind::Queue),
    ] {
        assert_eq!(
            wiring
                .components
                .iter()
                .find(|item| item.id == id)
                .unwrap()
                .kind,
            kind
        );
    }
    for (id, source, target, kind) in [
        ("publish-order", "checkout-api", "order-topic", Publish),
        ("fanout-order", "order-topic", "checkout-events", Publish),
        (
            "consume-order",
            "checkout-events",
            "receipt-worker",
            Consume,
        ),
        ("trace-receipt", "receipt-worker", "datadog", Telemetry),
    ] {
        let wire = wiring
            .connections
            .iter()
            .find(|item| item.id == id)
            .unwrap();
        assert_eq!(
            (
                wire.source.component_id.as_str(),
                wire.target.component_id.as_str(),
                wire.kind
            ),
            (source, target, Some(kind))
        );
    }
    for (scenario_id, publish_id, receipt_id) in [
        (
            "cart-checkout-success",
            "success-publish",
            "success-receipt",
        ),
        ("cart-payment-retry", "retry-publish", "retry-receipt"),
    ] {
        let scenario = authored
            .scenarios
            .iter()
            .find(|item| item.id == scenario_id)
            .unwrap();
        let publish = scenario
            .occurrences
            .iter()
            .find(|item| item.id == publish_id)
            .unwrap();
        assert_eq!(
            publish.wiring_refs.as_ref().unwrap().connection_ids,
            ["publish-order", "fanout-order"]
        );
        let receipt = scenario
            .occurrences
            .iter()
            .find(|item| item.id == receipt_id)
            .unwrap();
        assert_eq!(
            receipt.wiring_refs.as_ref().unwrap().connection_ids,
            [
                "consume-order",
                "send-receipt",
                "record-receipt",
                "trace-receipt"
            ]
        );
    }
}

#[test]
fn shopping_cart_contrasts_authored_versions_and_exposes_unexplored_contract_gaps() {
    use lain::wiring::{WiringFieldSection, WiringStatus};
    let authored = document(4);
    let current = authored
        .scenarios
        .iter()
        .find(|item| item.id == "cart-current-no-hold")
        .unwrap();
    assert!(current.labels.contains(&"Current".into()));
    assert_eq!(
        current
            .occurrences
            .iter()
            .map(|item| item.node_id.as_str())
            .collect::<Vec<_>>(),
        ["review", "update", "consider", "pay"]
    );
    assert_eq!(
        current.occurrences.last().unwrap().after.instances[0].values["reservation"],
        json!(null)
    );
    let proposed = authored
        .scenarios
        .iter()
        .find(|item| item.id == "cart-checkout-success")
        .unwrap();
    assert!(proposed.labels.contains(&"Proposed".into()));
    let reserve = proposed
        .occurrences
        .iter()
        .find(|item| item.id == "success-reserve")
        .unwrap();
    for id in [
        "reserve-stock",
        "read-stock",
        "increment-reserved-stock",
        "insert-stock-hold",
    ] {
        assert!(
            reserve
                .wiring_refs
                .as_ref()
                .unwrap()
                .connection_ids
                .contains(&id.into())
        );
        assert!(!current.occurrences.iter().any(|item| {
            item.wiring_refs
                .as_ref()
                .unwrap()
                .connection_ids
                .contains(&id.into())
        }));
    }
    let wiring = authored.wiring.as_ref().unwrap();
    let inventory = wiring
        .components
        .iter()
        .find(|item| item.id == "inventory-api")
        .unwrap();
    let release = inventory
        .operations
        .iter()
        .find(|item| item.id == "release")
        .unwrap();
    assert_eq!(release.status, WiringStatus::Missing);
    assert_eq!(release.http.as_ref().unwrap().method, "DELETE");
    assert!(
        !authored
            .scenarios
            .iter()
            .flat_map(|item| &item.occurrences)
            .filter_map(|item| item.wiring_refs.as_ref())
            .any(|item| item.connection_ids.contains(&"release-stock".into()))
    );
    let checkout = wiring
        .components
        .iter()
        .find(|item| item.id == "checkout-api")
        .unwrap();
    let submit = checkout
        .operations
        .iter()
        .find(|item| item.id == "submit")
        .unwrap();
    for (section, path) in [
        (WiringFieldSection::Header, "Idempotency-Key"),
        (WiringFieldSection::Error, "code"),
    ] {
        let field = submit
            .fields
            .iter()
            .chain(
                submit
                    .returns
                    .iter()
                    .flat_map(|result| result.fields.iter().flatten()),
            )
            .find(|field| field.section == section && field.path == path)
            .unwrap();
        assert_eq!(field.status, WiringStatus::Missing);
    }
    let hold = inventory
        .operations
        .iter()
        .find(|item| item.id == "reserve")
        .unwrap();
    let expiry = hold
        .returns
        .iter()
        .flat_map(|result| result.fields.iter().flatten())
        .find(|field| field.section == WiringFieldSection::Response && field.path == "expiresAt")
        .unwrap();
    assert_eq!(expiry.status, WiringStatus::Missing);
    let complete = checkout
        .operations
        .iter()
        .find(|item| item.id == "complete")
        .unwrap();
    assert_eq!(
        complete.request_type.as_deref(),
        Some("CompleteCheckoutCommand")
    );
    assert_eq!(
        complete
            .fields
            .iter()
            .map(|field| field.path.as_str())
            .collect::<Vec<_>>(),
        ["cartId", "reservationId", "authorizedPaymentAttemptId"]
    );
    assert_eq!(complete.returns[0].return_type, "PaidOrder");
    assert_eq!(
        complete.returns[0]
            .fields
            .as_ref()
            .unwrap()
            .iter()
            .map(|field| field.path.as_str())
            .collect::<Vec<_>>(),
        ["orderId", "status"]
    );
}

#[tokio::test]
async fn demo_documents_publish_and_survive_reopening_with_complete_recordings() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("demos.sqlite");
    let service = AppService::open(&path).await.unwrap();
    for (id, source) in DEMOS {
        let authored: Explanation = serde_json::from_str(source).unwrap();
        authored.validate().unwrap();
        let expected = serde_json::to_value(&authored).unwrap();
        let published = service
            .publish(id, PublishRequest { document: authored })
            .await
            .unwrap();
        assert_eq!(published.id, id);
        assert_eq!(published.revision, 1);
        assert_eq!(serde_json::to_value(published.document).unwrap(), expected);
    }
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    let ids: BTreeSet<_> = reopened
        .list()
        .await
        .unwrap()
        .into_iter()
        .map(|summary| summary.id)
        .collect();
    assert_eq!(
        ids,
        DEMOS.map(|(id, _)| id.to_owned()).into_iter().collect()
    );
    for (id, source) in DEMOS {
        let expected: Explanation = serde_json::from_str(source).unwrap();
        let stored = reopened.get(id).await.unwrap();
        assert_eq!(stored.revision, 1);
        assert_eq!(
            serde_json::to_value(stored.document).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }
}

#[test]
fn standalone_demos_record_three_responsibilities_and_identity_preserving_retries() {
    for (index, labels, instance_ids, handoffs) in [
        (
            1,
            ["Developer", "Build pipeline", "Release reviewer"],
            ["rel-42", "rel-43"],
            [4, 6],
        ),
        (
            2,
            ["Customer", "Support", "Engineering"],
            ["inc-81", "inc-82"],
            [6, 6],
        ),
    ] {
        let authored = document(index);
        authored.validate().unwrap();
        assert_eq!(authored.schema_version, 1);
        assert!(authored.description.split_whitespace().count() <= 75);
        assert_eq!(authored.domain.as_ref().unwrap().entities.len(), 1);
        assert!(authored.domain.as_ref().unwrap().relationships.is_empty());
        assert_eq!(authored.diagrams.len(), 1);
        assert_eq!(authored.scenarios.len(), 2);
        let diagram = &authored.diagrams[0];
        assert_eq!(
            diagram
                .lanes
                .iter()
                .map(|lane| lane.label.as_str())
                .collect::<Vec<_>>(),
            labels
        );
        let lane_by_node: HashMap<_, _> = diagram
            .lanes
            .iter()
            .flat_map(|lane| {
                lane.node_ids
                    .iter()
                    .map(|node| (node.as_str(), lane.id.as_str()))
            })
            .collect();
        assert_eq!(lane_by_node.len(), diagram.nodes.len());
        let entity = &authored.domain.as_ref().unwrap().entities[0];
        let fields: BTreeSet<_> = entity.attributes.iter().map(|field| &field.id).collect();
        for (scenario_index, scenario) in authored.scenarios.iter().enumerate() {
            assert!(
                scenario
                    .description
                    .starts_with("Synthetic recording. Assume")
            );
            assert_eq!(scenario.diagram_id, diagram.id);
            assert!(scenario.occurrences[0].before.instances.is_empty());
            let occurrence_ids: HashSet<_> =
                scenario.occurrences.iter().map(|visit| &visit.id).collect();
            assert_eq!(occurrence_ids.len(), scenario.occurrences.len());
            let node_ids: HashSet<_> = scenario
                .occurrences
                .iter()
                .map(|visit| &visit.node_id)
                .collect();
            assert_eq!(
                node_ids.len() < scenario.occurrences.len(),
                scenario_index == 1,
                "only the retry recording revisits nodes"
            );
            let recorded_handoffs = scenario
                .occurrences
                .windows(2)
                .filter(|pair| {
                    lane_by_node[pair[0].node_id.as_str()] != lane_by_node[pair[1].node_id.as_str()]
                })
                .count();
            assert_eq!(recorded_handoffs, handoffs[scenario_index]);
            for (position, visit) in scenario.occurrences.iter().enumerate() {
                assert!(!visit.narration.is_empty());
                assert_eq!(visit.after.instances.len(), 1);
                assert_eq!(visit.before.instances.len(), usize::from(position != 0));
                for snapshot in [&visit.before, &visit.after] {
                    assert!(snapshot.links.is_empty());
                    for instance in &snapshot.instances {
                        assert_eq!(instance.id, instance_ids[scenario_index]);
                        assert_eq!(instance.entity_id, entity.id);
                        assert_eq!(instance.values.keys().collect::<BTreeSet<_>>(), fields);
                    }
                }
                if position > 0 {
                    assert_eq!(
                        serde_json::to_value(&visit.before).unwrap(),
                        serde_json::to_value(&scenario.occurrences[position - 1].after).unwrap()
                    );
                }
            }
        }
    }
}

#[test]
fn release_recordings_require_passing_checks_and_approval_before_deployment() {
    let authored = document(1);
    assert!(authored.diagrams[0].groups.is_empty());
    for (scenario_index, version, expected) in [
        (
            0,
            "1.4.0",
            vec![
                ("submit", "queued", 0, None, false),
                ("build", "built", 1, None, false),
                ("check", "checked", 1, Some(true), false),
                ("approve", "approved", 1, Some(true), true),
                ("deploy", "deployed", 1, Some(true), true),
                ("announce", "announced", 1, Some(true), true),
            ],
        ),
        (
            1,
            "1.4.1",
            vec![
                ("submit", "queued", 0, None, false),
                ("build", "built", 1, None, false),
                ("check", "checked", 1, Some(false), false),
                ("fix", "queued", 1, None, false),
                ("build", "built", 2, None, false),
                ("check", "checked", 2, Some(true), false),
                ("approve", "approved", 2, Some(true), true),
                ("deploy", "deployed", 2, Some(true), true),
                ("announce", "announced", 2, Some(true), true),
            ],
        ),
    ] {
        let scenario = &authored.scenarios[scenario_index];
        assert_eq!(scenario.occurrences.len(), expected.len());
        for (visit, (node, status, attempt, checks, approved)) in
            scenario.occurrences.iter().zip(expected)
        {
            assert_eq!(visit.node_id, node);
            assert_eq!(
                serde_json::to_value(&visit.after.instances[0].values).unwrap(),
                json!({"version": version, "status": status, "checksPassed": checks,
                    "approved": approved, "attempt": attempt})
            );
        }
    }
}

#[test]
fn incident_recordings_restore_and_confirm_service_before_queuing_prevention() {
    let authored = document(2);
    for (scenario_index, expected) in [
        (
            0,
            vec![
                ("report", "reported", 0),
                ("triage", "triaged", 0),
                ("reproduce", "reproduced", 0),
                ("diagnose", "diagnosed", 0),
                ("repair", "testing", 1),
                ("health", "restored", 1),
                ("verify", "verified", 1),
                ("confirm", "verified", 1),
                ("close", "closed", 1),
                ("follow-up", "closed", 1),
            ],
        ),
        (
            1,
            vec![
                ("report", "reported", 0),
                ("triage", "triaged", 0),
                ("reproduce", "reproduced", 0),
                ("diagnose", "diagnosed", 0),
                ("repair", "testing", 1),
                ("health", "degraded", 1),
                ("repair", "testing", 2),
                ("health", "restored", 2),
                ("verify", "verified", 2),
                ("confirm", "verified", 2),
                ("close", "closed", 2),
                ("follow-up", "closed", 2),
            ],
        ),
    ] {
        let scenario = &authored.scenarios[scenario_index];
        assert_eq!(scenario.occurrences.len(), expected.len());
        let confirm_position = expected
            .iter()
            .position(|(node, _, _)| *node == "confirm")
            .unwrap();
        for (position, (visit, (node, status, attempts))) in
            scenario.occurrences.iter().zip(expected).enumerate()
        {
            assert_eq!(visit.node_id, node);
            assert_eq!(
                serde_json::to_value(&visit.after.instances[0].values).unwrap(),
                json!({"service": "Invoice downloads", "impact": "Downloads fail", "status": status,
                    "restorationAttempts": attempts,
                    "diagnosis": if position >= 3 { Some("stale cache key") } else { None },
                    "customerConfirmed": position >= confirm_position,
                    "followUpStatus": if node == "follow-up" { Some("queued") } else { None }})
            );
        }
    }
}

#[test]
fn incident_phases_are_strict_subsets_of_responsibility_lanes() {
    let authored = document(2);
    let diagram = &authored.diagrams[0];
    assert_eq!(diagram.groups.len(), 2);
    for (group, label, lane_id, members) in [
        (
            &diagram.groups[0],
            "Initial assessment",
            "support",
            vec!["triage", "reproduce"],
        ),
        (
            &diagram.groups[1],
            "Service restoration",
            "engineering",
            vec!["diagnose", "repair", "health"],
        ),
    ] {
        assert_eq!(group.label, label);
        assert!(group.parent_group_id.is_none());
        assert_eq!(group.node_ids, members);
        let lane = diagram
            .lanes
            .iter()
            .find(|lane| lane.id == lane_id)
            .unwrap();
        assert!(group.node_ids.len() < lane.node_ids.len());
        assert!(
            group
                .node_ids
                .iter()
                .all(|node| lane.node_ids.contains(node))
        );
    }
}
