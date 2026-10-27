use lain::{
    model::{Explanation, PublishRequest},
    service::AppService,
};
use serde_json::{Value, json};

fn document() -> Value {
    json!({
        "schemaVersion": 1, "title": "Checkout wiring", "description": "Synthetic interface contracts.",
        "wiring": {
            "components": [
                {"id": "ui", "label": "Checkout form", "kind": "uiComponent",
                 "screens": [{"id": "checkout", "label": "Checkout", "route": "/checkout"}],
                 "operations": [{"id": "submit", "label": "Submit"}]},
                {"id": "api", "label": "Checkout API", "kind": "service",
                 "operations": [{"id": "submit", "label": "Create checkout"}]}
            ],
            "connections": [{"id": "submit", "label": "Create checkout",
                "source": {"componentId": "ui", "screenId": "checkout"},
                "target": {"componentId": "api", "operationId": "submit"}}]
        },
        "diagrams": [{"id": "flow", "title": "Checkout", "kind": "flow",
            "nodes": [{"id": "submit", "label": "Submit", "entityIds": []}], "edges": []}],
        "scenarios": [{"id": "checkout", "title": "Checkout", "diagramId": "flow", "occurrences": [{
            "id": "submitted", "nodeId": "submit", "incomingEdgeId": null, "trigger": null,
            "narration": "Create checkout.", "before": {"instances": [], "links": []},
            "after": {"instances": [], "links": []}, "wiringRefs": {"connectionIds": ["submit"]}
        }]}]
    })
}

fn field() -> Value {
    json!({"id": "cart", "path": "cartId", "type": "string", "section": "request",
        "required": true, "nullable": false, "status": "missing", "example": "cart-84",
        "description": "The cart selected for checkout."})
}

fn validate(value: Value) -> Result<(), String> {
    serde_json::from_value::<Explanation>(value)
        .unwrap()
        .validate()
}

#[tokio::test]
async fn typed_interface_contracts_survive_publication_and_reopen_without_domain() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("wiring.sqlite");
    let service = AppService::open(&path).await.unwrap();
    let mut value = document();
    value["wiring"]["components"][0]["status"] = json!("changed");
    value["wiring"]["components"][0]["technology"] = json!({
        "name": "Web Components", "provider": "Unknown vendor", "icon": "<unknown-icon>"
    });
    value["wiring"]["components"][1]["operations"][0] = json!({
        "id": "submit", "label": "Create checkout", "kind": "http", "status": "missing",
        "http": {"method": "POST", "path": "/checkouts"}, "statement": "Create one checkout.",
        "requestType": "CreateCheckoutRequest", "fields": [field()], "responses": "201 Checkout; 409 CART_CHANGED",
        "returns": [{"status": 201, "type": "Checkout", "fields": [field()]},
            {"status": 204, "type": "void"}, {"status": 409, "type": "Conflict", "fields": []}],
        "decisions": ["Who owns checkout idempotency?"]
    });
    value["wiring"]["connections"][0]["kind"] = json!("http");
    value["wiring"]["connections"][0]["status"] = json!("changed");
    value["wiring"]["connections"][0]["fields"] = json!([field()]);
    value["wiring"]["connections"][0]["requestType"] = json!("MobileCheckoutRequest");
    value["wiring"]["connections"][0]["returns"] = json!([]);
    let stored = service
        .publish(
            "checkout",
            PublishRequest {
                document: serde_json::from_value(value.clone()).unwrap(),
            },
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(stored.document).unwrap(), value);
    drop(service);
    let reopened = AppService::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_value(reopened.get("checkout").await.unwrap().document).unwrap(),
        value
    );
}

#[test]
fn wiring_and_domain_presence_are_independent_including_empty_wiring() {
    for wiring in [None, Some(json!({"components": [], "connections": []}))] {
        for domain in [None, Some(json!({"entities": [], "relationships": []}))] {
            let mut value = document();
            value.as_object_mut().unwrap().remove("wiring");
            value["scenarios"][0]["occurrences"][0]
                .as_object_mut()
                .unwrap()
                .remove("wiringRefs");
            if let Some(wiring) = &wiring {
                value["wiring"] = wiring.clone();
            }
            if let Some(domain) = &domain {
                value["domain"] = domain.clone();
            }
            validate(value.clone()).unwrap();
            let parsed: Explanation = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        }
    }
    for dependent in ["connections", "groups"] {
        let mut value = document();
        value["wiring"]["components"] = json!([]);
        value["wiring"]["groups"] = json!([]);
        if dependent == "groups" {
            value["wiring"]["connections"] = json!([]);
            value["wiring"]["groups"] =
                json!([{"id": "group", "label": "Group", "componentIds": []}]);
        }
        assert_eq!(
            validate(value).unwrap_err(),
            "wiring connections and groups require components"
        );
    }
}

#[test]
fn component_and_operation_kinds_use_the_public_camel_case_vocabulary() {
    for kind in [
        "uiApp",
        "uiComponent",
        "service",
        "database",
        "queue",
        "worker",
        "externalSystem",
        "other",
        "topic",
        "stream",
        "eventBus",
        "bucket",
        "cache",
        "gateway",
        "identity",
        "observability",
        "function",
    ] {
        let mut value = document();
        value["wiring"]["components"][1]["kind"] = json!(kind);
        validate(value.clone()).unwrap();
        let parsed: Explanation = serde_json::from_value(value).unwrap();
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["wiring"]["components"][1]["kind"],
            kind
        );
    }
    for kind in [
        "http",
        "rpc",
        "query",
        "command",
        "publish",
        "consume",
        "upload",
        "read",
        "write",
        "webhook",
        "telemetry",
        "other",
    ] {
        let mut value = document();
        value["wiring"]["components"][1]["operations"][0]["kind"] = json!(kind);
        value["wiring"]["connections"][0]["kind"] = json!(kind);
        validate(value.clone()).unwrap();
        let parsed: Explanation = serde_json::from_value(value).unwrap();
        let output = serde_json::to_value(parsed).unwrap();
        assert_eq!(
            output["wiring"]["components"][1]["operations"][0]
                .get("kind")
                .and_then(Value::as_str),
            if kind == "other" { None } else { Some(kind) }
        );
        assert_eq!(output["wiring"]["connections"][0]["kind"], kind);
    }
}

#[test]
fn wire_overrides_preserve_explicit_empty_fields_existing_status_and_other_kind() {
    let mut value = document();
    value["wiring"]["components"][0]["status"] = json!("existing");
    value["wiring"]["components"][1]["operations"][0] = json!({
        "id": "submit", "label": "Create checkout", "kind": "other", "status": "existing",
        "statement": "", "fields": [], "responses": "", "decisions": []
    });
    value["wiring"]["connections"][0]["kind"] = json!("other");
    value["wiring"]["connections"][0]["status"] = json!("existing");
    value["wiring"]["connections"][0]["fields"] = json!([]);
    value["wiring"]["components"][1]["operations"][0]["status"] = json!("missing");
    let parsed: Explanation = serde_json::from_value(value).unwrap();
    parsed.validate().unwrap();
    let serialized = serde_json::to_value(parsed).unwrap();
    assert_eq!(serialized["wiring"]["connections"][0]["fields"], json!([]));
    assert_eq!(serialized["wiring"]["connections"][0]["status"], "existing");
    assert_eq!(serialized["wiring"]["connections"][0]["kind"], "other");
    assert_eq!(
        serialized["wiring"]["components"][1]["operations"][0]["status"],
        "missing"
    );
    let reparsed: Explanation = serde_json::from_value(serialized.clone()).unwrap();
    assert_eq!(serde_json::to_value(reparsed).unwrap(), serialized);
}

#[test]
fn contract_fields_have_local_ids_and_distinct_section_paths() {
    for pointer in [
        "/wiring/components/1/operations/0/fields",
        "/wiring/connections/0/fields",
    ] {
        let mut value = document();
        let mut response = field();
        response["id"] = json!("cart-response");
        response["section"] = json!("response");
        value
            .pointer_mut(pointer.rsplit_once('/').unwrap().0)
            .unwrap()["fields"] = json!([field(), response.clone()]);
        validate(value.clone()).unwrap();
        response["section"] = json!("request");
        value.pointer_mut(pointer).unwrap()[1] = response;
        assert_eq!(
            validate(value.clone()).unwrap_err(),
            "duplicate wiring field path and section"
        );
        value.pointer_mut(pointer).unwrap()[1] = field();
        assert_eq!(validate(value).unwrap_err(), "duplicate wiring field");
    }
    let mut value = document();
    value["wiring"]["components"][1]["operations"][0]["fields"] = json!([field()]);
    value["wiring"]["connections"][0]["fields"] = json!([field()]);
    validate(value).unwrap();
}

#[test]
fn contract_sections_and_statuses_are_descriptive_independent_of_domain() {
    for section in [
        "path",
        "query",
        "header",
        "request",
        "response",
        "error",
        "message",
        "record",
        "resource",
        "telemetry",
    ] {
        for status in ["existing", "missing", "changed"] {
            let mut value = document();
            let mut descriptive = field();
            descriptive["section"] = json!(section);
            descriptive["status"] = json!(status);
            descriptive["nullable"] = json!(true);
            value["wiring"]["components"][1]["operations"][0]["status"] = json!(status);
            value["wiring"]["components"][0]["status"] = json!(status);
            value["wiring"]["connections"][0]["status"] = json!(status);
            value["wiring"]["connections"][0]["fields"] = json!([descriptive]);
            let parsed: Explanation = serde_json::from_value(value).unwrap();
            parsed.validate().unwrap();
            let output = serde_json::to_value(parsed).unwrap();
            let field = &output["wiring"]["connections"][0]["fields"][0];
            assert_eq!(field["section"], section);
            assert_eq!(field["nullable"], true);
            assert_eq!(field["required"], true);
            assert_eq!(
                field.get("status").and_then(Value::as_str),
                if status == "existing" {
                    None
                } else {
                    Some(status)
                }
            );
        }
    }
}

#[test]
fn field_definitions_reject_invalid_ids_blank_paths_and_blank_types() {
    for (key, replacement, expected) in [
        ("id", json!("bad/id"), "invalid ID"),
        ("id", json!("x".repeat(65)), "invalid ID"),
        ("path", json!(" \n"), "wiring field path must not be blank"),
        ("type", json!("\t"), "wiring field type must not be blank"),
    ] {
        for owner in ["operation", "connection"] {
            let mut value = document();
            let mut invalid = field();
            invalid[key] = replacement.clone();
            let contract = if owner == "operation" {
                &mut value["wiring"]["components"][1]["operations"][0]
            } else {
                &mut value["wiring"]["connections"][0]
            };
            contract["fields"] = json!([invalid]);
            assert!(
                validate(value).unwrap_err().contains(expected),
                "{key}: {owner}"
            );
        }
    }
}

#[test]
fn screen_endpoints_resolve_on_their_owner_and_exclude_operation_endpoints() {
    for kind in ["uiApp", "uiComponent"] {
        let mut value = document();
        value["wiring"]["components"][0]["kind"] = json!(kind);
        validate(value).unwrap();
    }
    for endpoint in ["source", "target"] {
        for (reference, expected) in [
            (
                json!({"componentId": "ui", "screenId": "unknown"}),
                "unknown wiring endpoint screen reference \"unknown\"",
            ),
            (
                json!({"componentId": "api", "screenId": "checkout"}),
                "unknown wiring endpoint screen reference \"checkout\"",
            ),
            (
                json!({"componentId": "ui", "screenId": "checkout", "operationId": "submit"}),
                "wiring endpoint permits either operationId or screenId, not both",
            ),
        ] {
            let mut value = document();
            value["wiring"]["connections"][0][endpoint] = reference;
            assert_eq!(validate(value).unwrap_err(), expected);
        }
    }
}

#[test]
fn contract_field_and_decision_limits_accept_the_boundary_and_reject_the_next_item() {
    for pointer in ["/wiring/components/1/operations/0", "/wiring/connections/0"] {
        for count in [200, 201] {
            let mut value = document();
            value.pointer_mut(pointer).unwrap()["fields"] = json!((0..count).map(|index| {
                json!({"id": format!("field-{index}"), "path": format!("value{index}"), "type": "string", "section": "record"})
            }).collect::<Vec<_>>());
            if count == 200 {
                validate(value).unwrap();
            } else {
                assert_eq!(
                    validate(value).unwrap_err(),
                    "wiring field exceeds limit of 200"
                );
            }
        }
    }
    for count in [30, 31] {
        let mut value = document();
        value["wiring"]["components"][1]["operations"][0]["decisions"] =
            json!(vec!["Who owns retries?"; count]);
        if count == 30 {
            validate(value).unwrap();
        } else {
            assert_eq!(
                validate(value).unwrap_err(),
                "wiring operation decisions exceeds limit of 30"
            );
        }
    }
}

#[test]
fn examples_preserve_null_and_use_document_json_limits() {
    for example in [
        json!(null),
        json!({"nested": [true, 42, "<script>inert</script>"]}),
    ] {
        let mut value = document();
        let mut example_field = field();
        example_field["example"] = example.clone();
        example_field.as_object_mut().unwrap().remove("required");
        example_field.as_object_mut().unwrap().remove("nullable");
        value["wiring"]["connections"][0]["fields"] = json!([example_field]);
        let parsed: Explanation = serde_json::from_value(value).unwrap();
        parsed.validate().unwrap();
        let output = serde_json::to_value(parsed).unwrap();
        assert_eq!(
            output["wiring"]["connections"][0]["fields"][0]["example"],
            example
        );
        assert_eq!(
            output["wiring"]["connections"][0]["fields"][0]["required"],
            false
        );
        assert_eq!(
            output["wiring"]["connections"][0]["fields"][0]["nullable"],
            false
        );
    }
    let mut nested = json!(null);
    for _ in 0..32 {
        nested = json!([nested]);
    }
    for (example, expected) in [
        (json!(9007199254740992_u64), "JSON numbers must be within"),
        (
            json!("x".repeat(32769)),
            "text bytes exceeds limit of 32768",
        ),
        (nested, "JSON nesting levels exceeds limit of 32"),
        (
            json!(vec!["x".repeat(32768); 65]),
            "document bytes exceeds limit",
        ),
    ] {
        let mut value = document();
        let mut example_field = field();
        example_field["example"] = example;
        value["wiring"]["connections"][0]["fields"] = json!([example_field]);
        assert!(
            validate(value).unwrap_err().contains(expected),
            "{expected}"
        );
    }
}

#[test]
fn publication_rejects_unknown_contract_fields_kinds_statuses_and_prototype_names() {
    for (pointer, replacement) in [
        ("/wiring/components/1/kind", json!("lambda")),
        ("/wiring/components/0/status", json!("added")),
        (
            "/wiring/components/1/operations/0",
            json!({"id": "submit", "label": "Submit", "kind": "sql"}),
        ),
        (
            "/wiring/components/1/operations/0",
            json!({"id": "submit", "label": "Submit", "status": "added"}),
        ),
        ("/wiring/connections/0/kind", json!("upstream")),
        ("/wiring/connections/0/status", json!("added")),
        (
            "/wiring/connections/0",
            json!({"id": "call", "label": "Call", "source": {"componentId": "ui"}, "target": {"componentId": "api"}, "lineage": []}),
        ),
    ] {
        let mut value = document();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        let parent = value.pointer_mut(parent).unwrap();
        if parent.is_array() {
            parent[key.parse::<usize>().unwrap()] = replacement;
        } else {
            parent[key] = replacement;
        }
        assert!(
            serde_json::from_value::<Explanation>(value).is_err(),
            "{pointer}"
        );
    }
    for (key, replacement) in [
        ("section", json!("body")),
        ("status", json!("added")),
        ("domainEntityId", json!("cart")),
    ] {
        let mut value = document();
        let mut invalid = field();
        invalid[key] = replacement;
        value["wiring"]["connections"][0]["fields"] = json!([invalid]);
        assert!(
            serde_json::from_value::<Explanation>(value).is_err(),
            "{key}"
        );
    }
    let mut value = document();
    let wiring = value.as_object_mut().unwrap().remove("wiring").unwrap();
    value["architecture"] = wiring;
    assert!(serde_json::from_value::<PublishRequest>(json!({"document": value})).is_err());
    let mut value = document();
    value["scenarios"][0]["occurrences"][0]["architectureRefs"] = json!({});
    assert!(serde_json::from_value::<PublishRequest>(json!({"document": value})).is_err());
}

#[test]
fn discovery_exposes_contract_fields_defaults_enum_values_and_bounds() {
    let schema = serde_json::to_value(schemars::schema_for!(PublishRequest)).unwrap();
    let definitions = &schema["$defs"];
    for (definition, field, maximum) in [
        ("WiringOperation", "fields", 200),
        ("WiringOperation", "returns", 20),
        ("WiringOperation", "decisions", 30),
        ("WiringConnection", "fields", 200),
        ("WiringConnection", "returns", 20),
        ("WiringReturn", "fields", 200),
    ] {
        assert_eq!(
            definitions[definition]["properties"][field]["maxItems"],
            maximum
        );
    }
    assert_eq!(definitions["WiringReturn"]["required"], json!(["type"]));
    for definition in ["WiringOperation", "WiringConnection"] {
        assert_eq!(
            definitions[definition]["properties"]["requestType"]["minLength"],
            1
        );
        assert_eq!(
            definitions[definition]["properties"]["requestType"]["maxLength"],
            32768
        );
    }
    assert_eq!(
        definitions["WiringReturn"]["properties"]["status"]["minimum"],
        100
    );
    assert_eq!(
        definitions["WiringReturn"]["properties"]["status"]["maximum"],
        599
    );
    assert_eq!(
        definitions["WiringField"]["required"],
        json!(["id", "path", "type", "section"])
    );
    assert_eq!(
        definitions["WiringField"]["properties"]["required"]["default"],
        false
    );
    assert_eq!(
        definitions["WiringField"]["properties"]["nullable"]["default"],
        false
    );
    assert_eq!(
        definitions["WiringStatus"]["enum"],
        json!(["existing", "missing", "changed"])
    );
    assert_eq!(
        definitions["WiringOperationKind"]["enum"],
        json!([
            "http",
            "rpc",
            "query",
            "command",
            "publish",
            "consume",
            "upload",
            "read",
            "write",
            "webhook",
            "telemetry",
            "other"
        ])
    );
    assert_eq!(
        definitions["WiringFieldSection"]["enum"],
        json!([
            "path",
            "query",
            "header",
            "request",
            "response",
            "error",
            "message",
            "record",
            "resource",
            "telemetry"
        ])
    );
    assert_eq!(
        definitions["WiringConnectionEnd"]["properties"]["screenId"]["$ref"],
        "#/$defs/NullableId"
    );
    for definition in [
        "Wiring",
        "WiringComponent",
        "WiringOperation",
        "WiringConnection",
        "WiringConnectionEnd",
        "WiringField",
        "WiringReturn",
        "WiringTechnology",
    ] {
        assert_eq!(
            definitions[definition]["additionalProperties"], false,
            "{definition}"
        );
    }
}

#[test]
fn return_fields_are_scoped_to_each_response_and_keep_unknown_schemas_distinct() {
    let mut value = document();
    value["wiring"]["components"][1]["operations"][0]["kind"] = json!("http");
    let responses = json!([
        {"status": 200, "type": "Checkout", "fields": [field()]},
        {"status": 409, "type": "Conflict", "fields": [field()]},
        {"status": 202, "type": "Pending"},
        {"status": 204, "type": "void"},
        {"status": 206, "type": "Empty", "fields": []}
    ]);
    for owner in ["/wiring/components/1/operations/0", "/wiring/connections/0"] {
        let mut value = value.clone();
        value.pointer_mut(owner).unwrap()["returns"] = responses.clone();
        validate(value.clone()).unwrap();
        let parsed: Explanation = serde_json::from_value(value).unwrap();
        assert_eq!(
            serde_json::to_value(parsed)
                .unwrap()
                .pointer(owner)
                .unwrap()["returns"],
            responses
        );
    }
}

#[test]
fn request_types_are_optional_descriptive_text_and_reject_blank_or_oversized_names() {
    for owner in ["/wiring/components/1/operations/0", "/wiring/connections/0"] {
        let mut value = document();
        value.pointer_mut(owner).unwrap()["requestType"] = json!("<CheckoutRequest>");
        validate(value.clone()).unwrap();
        let parsed: Explanation = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        value.pointer_mut(owner).unwrap()["requestType"] = json!(" \n");
        assert_eq!(
            validate(value.clone()).unwrap_err(),
            "wiring request type must not be blank"
        );
        value.pointer_mut(owner).unwrap()["requestType"] = json!("x".repeat(32769));
        assert!(
            validate(value)
                .unwrap_err()
                .contains("text bytes exceeds limit of 32768")
        );
    }
}

#[test]
fn return_definitions_validate_statuses_types_bodyless_results_and_field_bounds() {
    for (responses, expected) in [
        (
            json!([{"status": 99, "type": "Result"}]),
            "wiring return status must be between 100 and 599",
        ),
        (
            json!([{"status": 600, "type": "Result"}]),
            "wiring return status must be between 100 and 599",
        ),
        (
            json!([{"type": " \n"}]),
            "wiring return type must not be blank",
        ),
        (
            json!([{"status": 200, "type": "First"}, {"status": 200, "type": "Second"}]),
            "duplicate wiring return status",
        ),
        (
            json!([{"type": "Result"}, {"type": "Result"}]),
            "duplicate wiring return type without status",
        ),
        (
            json!([{"type": "void", "fields": [field()]}]),
            "wiring void return cannot declare fields",
        ),
        (
            json!([{"type": "Result", "fields": [field(), field()]}]),
            "duplicate wiring field",
        ),
        (
            json!([{"type": "Result", "fields": vec![field(); 201]}]),
            "wiring field exceeds limit of 200",
        ),
        (
            json!(
                (200..221)
                    .map(|status| json!({"status": status, "type": "Result"}))
                    .collect::<Vec<_>>()
            ),
            "wiring returns exceeds limit of 20",
        ),
    ] {
        for owner in ["/wiring/components/1/operations/0", "/wiring/connections/0"] {
            let mut value = document();
            value["wiring"]["components"][1]["operations"][0]["kind"] = json!("http");
            value.pointer_mut(owner).unwrap()["returns"] = responses.clone();
            assert_eq!(validate(value).unwrap_err(), expected, "{owner}");
        }
    }
    let mut value = document();
    value["wiring"]["components"][1]["operations"][0]["returns"] =
        json!([{"status": 200, "type": "Result"}]);
    assert_eq!(
        validate(value).unwrap_err(),
        "wiring return status requires an HTTP operation or connection"
    );
    let mut value = document();
    value["wiring"]["connections"][0]["returns"] = json!([{"type": "Result", "unknown": true}]);
    assert!(serde_json::from_value::<Explanation>(value).is_err());
}
