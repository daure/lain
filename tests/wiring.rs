use lain::{
    model::{Explanation, PublishRequest},
    service::{AppService, ServiceError},
};
use serde_json::{Value, json};

fn document() -> Value {
    json!({
        "schemaVersion": 1, "title": "Warehouse dispatch", "description": "Synthetic software participation.",
        "domain": {"entities": [], "relationships": []},
        "diagrams": [{"id": "flow", "title": "Dispatch", "kind": "flow", "nodes": [
            {"id": "submit", "label": "Submit", "entityIds": []}
        ], "edges": [{"id": "retry", "sourceNodeId": "submit", "targetNodeId": "submit", "label": "Retry"}]}],
        "scenarios": [{"id": "dispatch", "title": "Dispatch", "diagramId": "flow", "occurrences": [
            {"id": "first", "nodeId": "submit", "incomingEdgeId": null, "trigger": null,
             "narration": "Submit work.", "before": {"instances": [], "links": []},
             "after": {"instances": [], "links": []}, "wiringRefs": {
                 "componentIds": ["ui"], "connectionIds": ["request"],
                 "operationRefs": [{"componentId": "api", "operationId": "submit"}],
                 "screenRefs": [{"componentId": "ui", "screenId": "queue"}]
             }},
            {"id": "second", "nodeId": "submit", "incomingEdgeId": "retry", "trigger": null,
             "narration": "An explicit empty mapping.", "before": {"instances": [], "links": []},
             "after": {"instances": [], "links": []}, "wiringRefs": {}},
            {"id": "third", "nodeId": "submit", "incomingEdgeId": "retry", "trigger": null,
             "narration": "An unrecorded mapping.", "before": {"instances": [], "links": []},
             "after": {"instances": [], "links": []}}
        ]}],
        "wiring": {
            "components": [
                {"id": "ui", "label": "<script>Warehouse</script>", "kind": "uiApp",
                 "operations": [{"id": "submit", "label": "Submit form"}],
                 "screens": [{"id": "queue", "label": "Dispatch queue", "route": "javascript:inert-text"}],
                 "referenceIds": ["delivery"]},
                {"id": "api", "label": "Dispatch API", "kind": "service",
                 "technology": {"name": "Rust", "provider": "Illustrative"},
                 "operations": [{"id": "submit", "label": "Submit order", "http": {"method": "POST", "path": "/orders/{orderId}/dispatch"}}],
                 "referenceIds": ["delivery"]}
            ],
            "connections": [{"id": "request", "label": "Submits dispatch", "source": {"componentId": "ui"},
                "target": {"componentId": "api", "operationId": "submit"}, "protocol": "HTTP", "referenceIds": ["delivery"]}],
            "groups": [{"id": "commerce", "label": "Commerce", "componentIds": [], "parentGroupId": "feature"},
                {"id": "services", "label": "Services", "componentIds": ["ui", "api"], "parentGroupId": "commerce"},
                {"id": "feature", "label": "Feature", "componentIds": []}],
            "references": [{"id": "delivery", "key": "DEMO-102", "url": "https://example.com/work?q=one%20two", "description": "Illustrative work scope."}]
        }
    })
}

fn validate(value: Value) -> Result<(), String> {
    serde_json::from_value::<Explanation>(value)
        .unwrap()
        .validate()
}

#[tokio::test]
async fn wiring_preserves_authored_order_and_visit_mapping_states_across_reopen() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("wiring.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let expected = document();
    let published = service
        .publish(
            "warehouse",
            PublishRequest {
                document: serde_json::from_value(expected.clone()).unwrap(),
            },
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(published.document).unwrap(), expected);
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    let stored = reopened.get("warehouse").await.unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(serde_json::to_value(&stored.document).unwrap(), expected);
    let visits = &stored.document.scenarios[0].occurrences;
    assert!(visits[0].wiring_refs.is_some());
    assert!(visits[1].wiring_refs.is_some());
    assert!(visits[2].wiring_refs.is_none());
}

#[test]
fn wiring_free_documents_and_empty_optional_collections_keep_schema_version_one() {
    let mut legacy = document();
    legacy.as_object_mut().unwrap().remove("wiring");
    for visit in legacy["scenarios"][0]["occurrences"]
        .as_array_mut()
        .unwrap()
    {
        visit.as_object_mut().unwrap().remove("wiringRefs");
    }
    let parsed: Explanation = serde_json::from_value(legacy.clone()).unwrap();
    parsed.validate().unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);

    let mut value = document();
    value["wiring"]["components"][0]["screens"][0]["description"] = json!("");
    value["wiring"]["components"][1]["screens"] = json!([]);
    value["scenarios"][0]["occurrences"][1]["wiringRefs"] = json!({
        "componentIds": [], "connectionIds": [], "operationRefs": [], "screenRefs": []
    });
    let parsed: Explanation = serde_json::from_value(value).unwrap();
    parsed.validate().unwrap();
    let output = serde_json::to_value(parsed).unwrap();
    assert_eq!(
        output["scenarios"][0]["occurrences"][1]["wiringRefs"],
        json!({})
    );
    assert!(output["wiring"]["components"][1].get("screens").is_none());
    assert!(
        output["wiring"]["components"][0]["screens"][0]
            .get("description")
            .is_none()
    );
}

#[test]
fn wiring_accepts_qualified_local_ids_self_connections_and_parallel_connections() {
    let mut value = document();
    let mut parallel = value["wiring"]["connections"][0].clone();
    parallel["id"] = json!("parallel");
    let mut self_connection = parallel.clone();
    self_connection["id"] = json!("self");
    self_connection["source"] = json!({"componentId": "api", "operationId": "submit"});
    value["wiring"]["connections"]
        .as_array_mut()
        .unwrap()
        .extend([parallel, self_connection]);
    validate(value).unwrap();
}

#[test]
fn wiring_rejects_unresolved_or_unqualified_references() {
    for (pointer, replacement, expected) in [
        ("/wiring/components/0/id", json!("bad/id"), "invalid ID"),
        (
            "/wiring/components/1/id",
            json!("ui"),
            "duplicate wiring component",
        ),
        (
            "/wiring/components/0/operations/0/id",
            json!("bad/id"),
            "invalid ID",
        ),
        (
            "/wiring/connections/0/source/componentId",
            json!("commerce"),
            "unknown wiring component",
        ),
        (
            "/wiring/connections/0/target/operationId",
            json!("queue"),
            "unknown wiring endpoint operation",
        ),
        (
            "/wiring/components/0/referenceIds",
            json!(["missing"]),
            "unknown wiring work reference",
        ),
        (
            "/wiring/connections/0/referenceIds",
            json!(["missing"]),
            "unknown wiring work reference",
        ),
        (
            "/scenarios/0/occurrences/0/wiringRefs/componentIds",
            json!(["missing"]),
            "unknown wiring component",
        ),
        (
            "/scenarios/0/occurrences/0/wiringRefs/connectionIds",
            json!(["missing"]),
            "unknown wiring connection",
        ),
        (
            "/scenarios/0/occurrences/0/wiringRefs/operationRefs",
            json!([{"componentId": "missing", "operationId": "submit"}]),
            "unknown wiring component",
        ),
        (
            "/scenarios/0/occurrences/0/wiringRefs/operationRefs",
            json!([{"componentId": "api", "operationId": "missing"}]),
            "unknown wiring operation",
        ),
        (
            "/scenarios/0/occurrences/0/wiringRefs/screenRefs",
            json!([{"componentId": "api", "screenId": "queue"}]),
            "unknown wiring screen",
        ),
        (
            "/scenarios/0/occurrences/0/wiringRefs/screenRefs",
            json!([{"componentId": "missing", "screenId": "queue"}]),
            "unknown wiring component",
        ),
    ] {
        let mut value = document();
        *value.pointer_mut(pointer).unwrap() = replacement;
        let error = validate(value).unwrap_err();
        assert!(error.contains(expected), "{pointer}: {error}");
        if pointer.starts_with("/scenarios") {
            assert!(
                error.starts_with("scenario \"dispatch\", occurrence \"first\":"),
                "{error}"
            );
        }
    }
    for mapping in [json!({}), json!({"componentIds": ["ui"]})] {
        let mut value = document();
        value.as_object_mut().unwrap().remove("wiring");
        value["scenarios"][0]["occurrences"][0]["wiringRefs"] = mapping;
        assert_eq!(
            validate(value).unwrap_err(),
            "scenario \"dispatch\", occurrence \"first\": wiringRefs requires explanation wiring"
        );
    }
}

#[test]
fn wiring_rejects_duplicate_definitions_attachments_and_qualified_relevance() {
    for pointer in [
        "/wiring/components/0/operations",
        "/wiring/components/0/screens",
        "/wiring/connections",
        "/wiring/references",
        "/wiring/groups",
        "/wiring/components/0/referenceIds",
        "/wiring/connections/0/referenceIds",
        "/scenarios/0/occurrences/0/wiringRefs/componentIds",
        "/scenarios/0/occurrences/0/wiringRefs/connectionIds",
        "/scenarios/0/occurrences/0/wiringRefs/operationRefs",
        "/scenarios/0/occurrences/0/wiringRefs/screenRefs",
    ] {
        let mut value = document();
        let array = value.pointer_mut(pointer).unwrap().as_array_mut().unwrap();
        array.push(array[0].clone());
        let error = validate(value).unwrap_err();
        assert!(error.contains("duplicate"), "{pointer}: {error}");
    }
    let mut value = document();
    let mut reference = value["wiring"]["references"][0].clone();
    reference["id"] = json!("another");
    value["wiring"]["references"]
        .as_array_mut()
        .unwrap()
        .push(reference);
    assert_eq!(
        validate(value).unwrap_err(),
        "duplicate wiring reference key \"DEMO-102\""
    );
}

#[test]
fn wiring_enforces_labels_component_kinds_and_inert_http_metadata() {
    for (pointer, replacement, expected) in [
        (
            "/wiring/components",
            json!([]),
            "connections and groups require components",
        ),
        (
            "/wiring/components/0/label",
            json!(" \n"),
            "component label must not be blank",
        ),
        (
            "/wiring/components/0/kind",
            json!("service"),
            "screens require kind uiApp",
        ),
        (
            "/wiring/components/0/screens/0/label",
            json!(" "),
            "screen label must not be blank",
        ),
        (
            "/wiring/components/0/operations/0/label",
            json!(" "),
            "operation label must not be blank",
        ),
        (
            "/wiring/components/1/technology/name",
            json!(" "),
            "technology name must not be blank",
        ),
        (
            "/wiring/components/1/technology/provider",
            json!(" "),
            "technology provider must not be blank",
        ),
        (
            "/wiring/components/1/operations/0/http/method",
            json!("POST GET"),
            "method must be a nonblank token",
        ),
        (
            "/wiring/components/1/operations/0/http/method",
            json!(""),
            "method must be a nonblank token",
        ),
        (
            "/wiring/components/1/operations/0/http/path",
            json!("orders"),
            "path must begin with /",
        ),
        (
            "/wiring/connections/0/label",
            json!(" "),
            "connection label must not be blank",
        ),
        (
            "/wiring/connections/0/protocol",
            json!(" \t"),
            "connection protocol must not be blank",
        ),
        (
            "/wiring/references/0/key",
            json!(" "),
            "reference key must not be blank",
        ),
        (
            "/wiring/components/0/label",
            json!("x".repeat(32769)),
            "text bytes exceeds limit of 32768",
        ),
    ] {
        let mut value = document();
        *value.pointer_mut(pointer).unwrap() = replacement;
        let error = validate(value).unwrap_err();
        assert!(error.contains(expected), "{pointer}: {error}");
    }
}

#[test]
fn wiring_groups_use_shared_containment_rules() {
    for (pointer, replacement, expected) in [
        ("/wiring/groups/0/id", json!("ui"), "ID conflicts"),
        (
            "/wiring/groups/0/label",
            json!(" "),
            "label must not be blank",
        ),
        (
            "/wiring/groups/0/componentIds",
            json!(["missing"]),
            "unknown group entity",
        ),
        (
            "/wiring/groups/0/componentIds",
            json!(["ui"]),
            "more than one group membership",
        ),
        (
            "/wiring/groups/1/componentIds",
            json!(["ui", "ui"]),
            "more than one group membership",
        ),
        (
            "/wiring/groups/0/parentGroupId",
            json!("missing"),
            "unknown parent group",
        ),
        (
            "/wiring/groups/0/parentGroupId",
            json!("services"),
            "cyclic parentGroupId",
        ),
        (
            "/wiring/groups/1/componentIds",
            json!([]),
            "requires at least one descendant entity",
        ),
    ] {
        let mut value = document();
        *value.pointer_mut(pointer).unwrap() = replacement;
        let error = validate(value).unwrap_err();
        assert!(error.contains(expected), "{pointer}: {error}");
    }
    for depth in [8, 9] {
        let mut value = document();
        value["wiring"]["groups"] = Value::Array((0..depth).map(|index| {
            let mut group = json!({"id": format!("group-{index}"), "label": "Boundary", "componentIds": []});
            if index == 0 { group["componentIds"] = json!(["ui", "api"]); }
            if index + 1 < depth { group["parentGroupId"] = json!(format!("group-{}", index + 1)); }
            group
        }).collect());
        if depth == 8 {
            validate(value).unwrap();
        } else {
            assert!(
                validate(value)
                    .unwrap_err()
                    .contains("group nesting exceeds limit of 8")
            );
        }
    }
}

#[test]
fn wiring_reference_urls_follow_the_explanation_link_policy() {
    for url in [
        "javascript:alert(1)",
        "data:text/html,test",
        "file:///etc/passwd",
        "/work",
        "//example.com",
        "https:example.com",
        "https:///example.com",
        "https://",
        "https://user@example.com",
        "https://:secret@example.com",
        "https://example.com/a b",
        "https://example.com/\n",
        "https://example.com/\u{7f}",
        "https://example.com\\path",
    ] {
        let mut value = document();
        value["wiring"]["references"][0]["url"] = json!(url);
        let error = validate(value).unwrap_err();
        assert!(
            error.contains("URL must be absolute HTTP/HTTPS"),
            "{url}: {error}"
        );
    }
    let mut value = document();
    value["wiring"]["references"][0]["url"] =
        json!(format!("https://example.com/{}", "x".repeat(4096)));
    assert!(
        validate(value)
            .unwrap_err()
            .contains("URL exceeds 4096 bytes")
    );
    let mut value = document();
    value["wiring"]["references"][0]["url"] = json!("HTTP://localhost:8080/work#details");
    validate(value).unwrap();
}

#[test]
fn wiring_collection_limits_apply_before_reference_resolution() {
    for (pointer, maximum, expected) in [
        (
            "/wiring/components",
            200,
            "wiring component exceeds limit of 200",
        ),
        (
            "/wiring/connections",
            500,
            "wiring connection exceeds limit of 500",
        ),
        ("/wiring/groups", 100, "domain groups exceeds limit of 100"),
        (
            "/wiring/references",
            100,
            "wiring reference exceeds limit of 100",
        ),
        (
            "/wiring/components/0/operations",
            200,
            "wiring operation exceeds limit of 200",
        ),
        (
            "/wiring/components/0/screens",
            200,
            "wiring screen exceeds limit of 200",
        ),
        (
            "/wiring/components/0/referenceIds",
            50,
            "reference attachments exceeds limit of 50",
        ),
        (
            "/wiring/connections/0/referenceIds",
            50,
            "reference attachments exceeds limit of 50",
        ),
        (
            "/wiring/groups/1/componentIds",
            200,
            "group entities exceeds limit of 200",
        ),
        (
            "/scenarios/0/occurrences/0/wiringRefs/componentIds",
            500,
            "relevance entries exceeds limit of 500",
        ),
    ] {
        let mut value = document();
        let array = value.pointer_mut(pointer).unwrap().as_array_mut().unwrap();
        let item = array[0].clone();
        *array = vec![item; maximum + 1];
        assert!(validate(value).unwrap_err().contains(expected), "{pointer}");
    }
}

#[test]
fn wiring_accepts_collection_boundaries_and_counts_relevance_across_all_arrays() {
    let mut value = document();
    let wiring = &mut value["wiring"];
    wiring["components"] = Value::Array(
        (0..200)
            .map(|index| {
                json!({
                    "id": format!("component-{index}"), "label": "Component", "kind": "uiApp"
                })
            })
            .collect(),
    );
    wiring["components"][0]["operations"] = Value::Array(
        (0..200)
            .map(|index| {
                json!({
                    "id": format!("operation-{index}"), "label": "Operation"
                })
            })
            .collect(),
    );
    wiring["components"][0]["screens"] = Value::Array(
        (0..200)
            .map(|index| {
                json!({
                    "id": format!("screen-{index}"), "label": "Screen"
                })
            })
            .collect(),
    );
    wiring["connections"] = Value::Array((0..500).map(|index| json!({
        "id": format!("connection-{index}"), "label": "Connection",
        "source": {"componentId": "component-0"}, "target": {"componentId": "component-1"}
    })).collect());
    wiring["groups"] = Value::Array((0..100).map(|index| json!({
        "id": format!("group-{index}"), "label": "Group", "componentIds": [format!("component-{index}")]
    })).collect());
    wiring["references"] = Value::Array((0..100).map(|index| json!({
        "id": format!("reference-{index}"), "key": format!("DEMO-{index}"), "description": "Illustrative"
    })).collect());
    let attachments = json!(
        (0..50)
            .map(|index| format!("reference-{index}"))
            .collect::<Vec<_>>()
    );
    wiring["components"][0]["referenceIds"] = attachments.clone();
    wiring["connections"][0]["referenceIds"] = attachments;
    value["scenarios"][0]["occurrences"][0]["wiringRefs"] = json!({
        "connectionIds": (0..500).map(|index| format!("connection-{index}")).collect::<Vec<_>>()
    });
    validate(value.clone()).unwrap();
    value["scenarios"][0]["occurrences"][0]["wiringRefs"]["componentIds"] = json!(["component-0"]);
    assert_eq!(
        validate(value).unwrap_err(),
        "scenario \"dispatch\", occurrence \"first\": wiring relevance entries exceeds limit of 500"
    );
}

#[tokio::test]
async fn invalid_wiring_publications_preserve_revision_document_and_notifications() {
    let home = tempfile::tempdir().unwrap();
    let service = AppService::open(&home.path().join("validation.sqlite"))
        .await
        .unwrap();
    let original = document();
    service
        .publish(
            "warehouse",
            PublishRequest {
                document: serde_json::from_value(original.clone()).unwrap(),
            },
        )
        .await
        .unwrap();
    let mut changes = service.subscribe();
    let mut invalid = original.clone();
    invalid["wiring"]["groups"][0]["id"] = json!("ui");
    let result = service
        .publish(
            "warehouse",
            PublishRequest {
                document: serde_json::from_value(invalid).unwrap(),
            },
        )
        .await;
    assert!(
        matches!(result, Err(ServiceError::Invalid(message)) if message.contains("ID conflicts"))
    );
    let stored = service.get("warehouse").await.unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(serde_json::to_value(stored.document).unwrap(), original);
    assert!(matches!(
        changes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}

#[test]
fn wiring_rejects_unknown_fields_and_unknown_component_kinds() {
    for (pointer, replacement) in [
        ("/wiring/components/0/kind", json!("deployment")),
        (
            "/wiring/components/1/technology",
            json!({"name": "Rust", "iconUrl": "https://example.com/icon"}),
        ),
        (
            "/wiring/components/0/operations/0",
            json!({"id": "submit", "label": "Submit", "execute": true}),
        ),
        (
            "/scenarios/0/occurrences/0/wiringRefs",
            json!({"inferred": true}),
        ),
    ] {
        let mut value = document();
        *value.pointer_mut(pointer).unwrap() = replacement;
        assert!(
            serde_json::from_value::<Explanation>(value).is_err(),
            "{pointer}"
        );
    }
}

#[test]
fn publication_schema_exposes_optional_wiring_fields_and_collection_limits() {
    let schema = serde_json::to_value(schemars::schema_for!(PublishRequest)).unwrap();
    let definitions = &schema["$defs"];
    for (definition, field, minimum, maximum) in [
        ("Wiring", "components", None, 200),
        ("Wiring", "connections", None, 500),
        ("Wiring", "groups", None, 100),
        ("Wiring", "references", None, 100),
        ("WiringComponent", "operations", None, 200),
        ("WiringComponent", "screens", None, 200),
        ("WiringComponent", "referenceIds", None, 50),
        ("WiringConnection", "referenceIds", None, 50),
        ("WiringGroup", "componentIds", None, 200),
        ("WiringRelevance", "componentIds", None, 500),
        ("WiringRelevance", "connectionIds", None, 500),
        ("WiringRelevance", "operationRefs", None, 500),
        ("WiringRelevance", "screenRefs", None, 500),
    ] {
        let field_schema = &definitions[definition]["properties"][field];
        assert_eq!(field_schema["maxItems"], maximum, "{definition}.{field}");
        assert_eq!(
            field_schema.get("minItems").and_then(Value::as_u64),
            minimum,
            "{definition}.{field}"
        );
    }
    for (definition, field) in [("Explanation", "wiring"), ("Occurrence", "wiringRefs")] {
        assert!(definitions[definition]["properties"][field].is_object());
        assert!(
            !definitions[definition]["required"]
                .as_array()
                .unwrap()
                .contains(&json!(field))
        );
    }
    assert_eq!(
        definitions["WiringReference"]["properties"]["url"]["maxLength"],
        4096
    );
    assert_eq!(
        definitions["WiringOperationRef"]["properties"]["operationId"]["maxLength"],
        64
    );
    assert_eq!(
        definitions["WiringScreenRef"]["properties"]["screenId"]["pattern"],
        r"^[A-Za-z0-9_-]+(?![\s\S])"
    );
}
