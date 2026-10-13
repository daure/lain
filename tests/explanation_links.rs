use lain::{
    model::{Explanation, ExplanationLink, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::json;

fn document() -> Explanation {
    serde_json::from_value(json!({
        "schemaVersion": 1, "title": "Reference example", "description": "A recorded step.",
        "domain": {"entities": [], "relationships": []},
        "diagrams": [{"id": "flow", "title": "Flow", "kind": "flow", "nodes": [
            {"id": "start", "label": "Start", "entityIds": []}
        ], "edges": []}],
        "scenarios": [{"id": "run", "title": "Run", "diagramId": "flow", "occurrences": [{
            "id": "visit", "nodeId": "start", "incomingEdgeId": null, "trigger": null,
            "narration": "A step is recorded.", "before": {"instances": [], "links": []},
            "after": {"instances": [], "links": []}
        }]}]
    }))
    .unwrap()
}

fn link(url: &str) -> ExplanationLink {
    ExplanationLink {
        label: "Documentation".into(),
        url: url.into(),
    }
}

#[tokio::test]
async fn explanation_references_preserve_order_and_plain_text_across_database_reopen() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("test.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let mut authored = document();
    assert!(authored.links.is_empty());
    assert!(
        serde_json::to_value(&authored)
            .unwrap()
            .get("links")
            .is_none()
    );
    service
        .publish(
            "references",
            PublishRequest {
                document: authored.clone(),
            },
        )
        .await
        .unwrap();
    authored.links = vec![
        link("https://example.com/docs?q=one%20two#overview"),
        ExplanationLink {
            label: "<img src=x onerror=alert(1)>".into(),
            url: "HTTP://localhost:8080/help".into(),
        },
    ];
    let expected = serde_json::to_value(&authored).unwrap();
    service
        .publish("references", PublishRequest { document: authored })
        .await
        .unwrap();
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    let stored = reopened.get("references").await.unwrap();
    assert_eq!(stored.revision, 2);
    assert_eq!(serde_json::to_value(stored.document).unwrap(), expected);
    assert_eq!(reopened.list().await.unwrap()[0].link_count, 2);
}

#[tokio::test]
async fn invalid_references_preserve_the_committed_document_and_revision() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("test.sqlite"))
        .await
        .unwrap();
    let mut authored = document();
    authored.links = vec![link("https://example.com/docs")];
    let original = serde_json::to_value(&authored).unwrap();
    service
        .publish(
            "references",
            PublishRequest {
                document: authored.clone(),
            },
        )
        .await
        .unwrap();
    let mut changes = service.subscribe();
    for url in [
        "javascript:alert(1)",
        "data:text/html,test",
        "file:///etc/passwd",
        "mailto:test@example.com",
        "/docs",
        "//example.com/docs",
        "https:",
        "https:example.com",
        "https:///example.com",
        "https://",
        "https://[invalid]",
        "https://user:password@example.com",
        "https://user@example.com",
        "https://:password@example.com",
        " https://example.com",
        "https://example.com/a b",
        "https://example.com/\npath",
        "https://example.com/\u{7f}",
        "https://example.com\\path",
    ] {
        authored.links = vec![link(url)];
        let result = service
            .publish(
                "references",
                PublishRequest {
                    document: authored.clone(),
                },
            )
            .await;
        assert!(
            matches!(result, Err(ServiceError::Invalid(error)) if error.contains("explanation link 0: URL")),
            "{url:?}"
        );
    }
    for (links, message) in [
        (
            vec![ExplanationLink {
                label: " \n\t".into(),
                ..link("https://example.com")
            }],
            "label must not be blank",
        ),
        (
            vec![ExplanationLink {
                label: "x".repeat(32769),
                ..link("https://example.com")
            }],
            "text bytes",
        ),
        (
            vec![link(&format!("https://example.com/{}", "x".repeat(4096)))],
            "4096 bytes",
        ),
        (vec![link("https://example.com"); 51], "limit of 50"),
    ] {
        authored.links = links;
        let result = service
            .publish(
                "references",
                PublishRequest {
                    document: authored.clone(),
                },
            )
            .await;
        assert!(
            matches!(result, Err(ServiceError::Invalid(error)) if error.contains(message)),
            "{message}"
        );
    }
    for links in [
        json!(null),
        json!([{"url": "https://example.com"}]),
        json!([{"label": "Docs", "url": "https://example.com", "html": true}]),
    ] {
        let mut invalid = original.clone();
        invalid["links"] = links;
        assert!(serde_json::from_value::<Explanation>(invalid).is_err());
    }
    let stored = service.get("references").await.unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(serde_json::to_value(stored.document).unwrap(), original);
    assert!(matches!(
        changes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}
