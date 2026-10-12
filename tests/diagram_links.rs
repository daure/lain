use lain::{
    model::{DiagramKind, Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::json;
use std::collections::HashSet;

fn document() -> Explanation {
    serde_json::from_str(include_str!("../examples/order-lifecycle.json")).unwrap()
}

#[tokio::test]
async fn flow_and_sequence_detail_links_preserve_recordings_across_publication() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("links.sqlite"))
        .await
        .unwrap();
    let document = document();
    let mut combinations = HashSet::new();
    for source in &document.diagrams {
        for node in &source.nodes {
            if let Some(id) = &node.detail_diagram_id {
                let target = document
                    .diagrams
                    .iter()
                    .find(|diagram| &diagram.id == id)
                    .unwrap();
                assert!(
                    document
                        .scenarios
                        .iter()
                        .any(|scenario| &scenario.diagram_id == id)
                );
                combinations.insert((format!("{:?}", source.kind), format!("{:?}", target.kind)));
            }
        }
    }
    assert_eq!(
        combinations,
        HashSet::from([
            ("Flow".into(), "Flow".into()),
            ("Flow".into(), "Sequence".into()),
            ("Sequence".into(), "Flow".into()),
            ("Sequence".into(), "Sequence".into()),
        ])
    );
    let expected = serde_json::to_value(&document).unwrap();
    service
        .publish("order", PublishRequest { document })
        .await
        .unwrap();
    let saved = service.get("order").await.unwrap();
    assert_eq!(serde_json::to_value(saved.document).unwrap(), expected);
}

#[tokio::test]
async fn invalid_detail_links_fail_before_replacing_the_saved_recording() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("links.sqlite"))
        .await
        .unwrap();
    service
        .publish(
            "order",
            PublishRequest {
                document: document(),
            },
        )
        .await
        .unwrap();
    for (kind, target, error) in [
        (
            DiagramKind::State,
            "payment-flow",
            "state diagrams cannot link",
        ),
        (DiagramKind::Flow, "shipment-state", "kind flow or sequence"),
        (
            DiagramKind::Sequence,
            "shipment-state",
            "kind flow or sequence",
        ),
        (DiagramKind::Flow, "payment-flow", "another diagram"),
        (DiagramKind::Sequence, "payment-sequence", "another diagram"),
        (DiagramKind::Sequence, "missing", "unknown detail diagram"),
    ] {
        let mut invalid = document();
        let source = invalid
            .diagrams
            .iter_mut()
            .find(|diagram| diagram.kind == kind)
            .unwrap();
        let node = source
            .nodes
            .iter_mut()
            .find(|node| {
                kind != DiagramKind::Flow
                    || node.role == Some(lain::model::FlowNodeRole::Subprocess)
            })
            .unwrap();
        node.detail_diagram_id = Some(target.into());
        let result = service
            .publish("order", PublishRequest { document: invalid })
            .await;
        assert!(matches!(result, Err(ServiceError::Invalid(message)) if message.contains(error)));
        assert_eq!(service.get("order").await.unwrap().revision, 1);
    }
    let mut duplicate = serde_json::to_value(document()).unwrap();
    duplicate["diagrams"][0]["nodes"][2]["subprocessDiagramId"] = json!("payment-sequence");
    assert!(serde_json::from_value::<Explanation>(duplicate).is_err());
}
