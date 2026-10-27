use std::collections::{HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::model::{Domain, DomainGroup, Entity, Explanation, ExplanationLink, validate_id};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wiring {
    #[schemars(length(max = 200))]
    pub components: Vec<WiringComponent>,
    #[schemars(length(max = 500))]
    pub connections: Vec<WiringConnection>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 100))]
    pub groups: Vec<WiringGroup>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 100))]
    pub references: Vec<WiringReference>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringReference {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    #[schemars(length(min = 1, max = 32768))]
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 4096))]
    pub url: Option<String>,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringComponent {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    #[schemars(length(min = 1, max = 32768))]
    pub label: String,
    pub kind: WiringComponentKind,
    #[serde(default, skip_serializing_if = "WiringStatus::is_existing")]
    pub status: WiringStatus,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub technology: Option<WiringTechnology>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 200))]
    pub operations: Vec<WiringOperation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 200))]
    pub screens: Vec<WiringScreen>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(
        length(max = 50),
        inner(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))
    )]
    pub reference_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WiringComponentKind {
    UiApp,
    UiComponent,
    Service,
    Database,
    Queue,
    Topic,
    Stream,
    EventBus,
    Bucket,
    Cache,
    Gateway,
    Identity,
    Observability,
    Function,
    Worker,
    ExternalSystem,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringTechnology {
    #[schemars(length(min = 1, max = 32768))]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 32768))]
    pub provider: Option<String>,
    /// Inert icon identifier; unknown identifiers use the viewer's fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringOperation {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    #[schemars(length(min = 1, max = 32768))]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http: Option<WiringHttpOperation>,
    #[serde(default, skip_serializing_if = "WiringOperationKind::is_other")]
    pub kind: WiringOperationKind,
    #[serde(default, skip_serializing_if = "WiringStatus::is_existing")]
    pub status: WiringStatus,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub statement: String,
    /// Descriptive request or incoming payload type. Omission means the type is unrecorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 32768))]
    pub request_type: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 200))]
    pub fields: Vec<WiringField>,
    /// Each return owns its field schema; omission leaves return definitions unrecorded.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 20))]
    pub returns: Vec<WiringReturn>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub responses: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 30))]
    pub decisions: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WiringStatus {
    #[default]
    Existing,
    Missing,
    Changed,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringReturn {
    /// HTTP response status when known; omitted for non-HTTP results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 100, max = 599))]
    pub status: Option<u16>,
    /// Descriptive return type, independent of Domain. Use void for an explicitly bodyless result.
    #[serde(rename = "type")]
    #[schemars(length(min = 1, max = 32768))]
    pub return_type: String,
    /// Fields belong only to this return. Omission means the schema is unrecorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 200))]
    pub fields: Option<Vec<WiringField>>,
}

impl WiringStatus {
    fn is_existing(&self) -> bool {
        *self == Self::Existing
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WiringOperationKind {
    Http,
    Rpc,
    Query,
    Command,
    Publish,
    Consume,
    Upload,
    Read,
    Write,
    Webhook,
    Telemetry,
    #[default]
    Other,
}

impl WiringOperationKind {
    fn is_other(&self) -> bool {
        *self == Self::Other
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringField {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    #[schemars(length(min = 1, max = 32768))]
    pub path: String,
    #[serde(rename = "type")]
    #[schemars(length(min = 1, max = 32768))]
    pub field_type: String,
    pub section: WiringFieldSection,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default, skip_serializing_if = "WiringStatus::is_existing")]
    pub status: WiringStatus,
    #[serde(
        default,
        deserialize_with = "deserialize_example",
        skip_serializing_if = "Option::is_none"
    )]
    pub example: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WiringFieldSection {
    Path,
    Query,
    Header,
    Request,
    Response,
    Error,
    Message,
    Record,
    Resource,
    Telemetry,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringHttpOperation {
    /// Descriptive HTTP method token; never executed.
    #[schemars(length(min = 1, max = 32768))]
    pub method: String,
    /// Inert path or route template beginning with a slash.
    #[schemars(length(min = 1, max = 32768), pattern(r"^/"))]
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringScreen {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    #[schemars(length(min = 1, max = 32768))]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Descriptive text, never a browser destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringConnectionEnd {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub component_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "crate::model::NullableId")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "crate::model::NullableId")]
    pub screen_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringConnection {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    #[schemars(length(min = 1, max = 32768))]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub source: WiringConnectionEnd,
    pub target: WiringConnectionEnd,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<WiringOperationKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<WiringStatus>,
    /// Explicit request type; inherited only when the connection also inherits its fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 32768))]
    pub request_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 200))]
    pub fields: Option<Vec<WiringField>>,
    /// Explicit returns replace the inherited return collection, including an empty collection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 20))]
    pub returns: Option<Vec<WiringReturn>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 32768))]
    pub protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(
        length(max = 50),
        inner(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))
    )]
    pub reference_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringGroup {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    #[schemars(length(min = 1, max = 32768))]
    pub label: String,
    #[schemars(
        length(max = 200),
        inner(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))
    )]
    pub component_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "crate::model::NullableId")]
    pub parent_group_id: Option<String>,
}

/// Authored participation, with qualified operation and screen ownership. Total explicit entries are limited to 500.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringRelevance {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(
        length(max = 500),
        inner(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))
    )]
    pub component_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(
        length(max = 500),
        inner(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))
    )]
    pub connection_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 500))]
    pub operation_refs: Vec<WiringOperationRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 500))]
    pub screen_refs: Vec<WiringScreenRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringOperationRef {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub component_id: String,
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub operation_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WiringScreenRef {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub component_id: String,
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub screen_id: String,
}

impl Explanation {
    pub(crate) fn validate_wiring(&self) -> Result<(), String> {
        if let Some(wiring) = &self.wiring {
            wiring.validate()?;
        }
        for scenario in &self.scenarios {
            for occurrence in &scenario.occurrences {
                if let Some(relevance) = &occurrence.wiring_refs {
                    let result = self
                        .wiring
                        .as_ref()
                        .ok_or_else(|| "wiringRefs requires explanation wiring".to_string())
                        .and_then(|wiring| wiring.validate_relevance(relevance));
                    result.map_err(|error| {
                        format!(
                            "scenario {:?}, occurrence {:?}: {error}",
                            scenario.id, occurrence.id
                        )
                    })?;
                }
            }
        }
        Ok(())
    }
}

impl Wiring {
    fn validate(&self) -> Result<(), String> {
        if self.components.is_empty() && (!self.connections.is_empty() || !self.groups.is_empty()) {
            return Err("wiring connections and groups require components".into());
        }
        collection(&self.components, 200, |item| &item.id, "component")?;
        collection(&self.connections, 500, |item| &item.id, "connection")?;
        collection(&self.references, 100, |item| &item.id, "reference")?;
        let mut keys = HashSet::new();
        for reference in &self.references {
            nonblank(&reference.key, "reference key")?;
            if !keys.insert(&reference.key) {
                return Err(format!(
                    "duplicate wiring reference key {:?}",
                    reference.key
                ));
            }
            if let Some(url) = &reference.url {
                self.validate_url(reference, url)?;
            }
        }
        for component in &self.components {
            nonblank(&component.label, "component label")?;
            collection(&component.operations, 200, |item| &item.id, "operation")?;
            collection(&component.screens, 200, |item| &item.id, "screen")?;
            if !component.screens.is_empty()
                && !matches!(
                    component.kind,
                    WiringComponentKind::UiApp | WiringComponentKind::UiComponent
                )
            {
                return Err(format!(
                    "component {:?}: screens require kind uiApp or uiComponent",
                    component.id
                ));
            }
            if let Some(technology) = &component.technology {
                nonblank(&technology.name, "technology name")?;
                if let Some(provider) = &technology.provider {
                    nonblank(provider, "technology provider")?;
                }
            }
            for operation in &component.operations {
                nonblank(&operation.label, "operation label")?;
                if let Some(request_type) = &operation.request_type {
                    nonblank(request_type, "request type")?;
                }
                validate_fields(&operation.fields)?;
                validate_returns(
                    &operation.returns,
                    operation.http.is_some() || operation.kind == WiringOperationKind::Http,
                )?;
                check_count(operation.decisions.len(), 30, "operation decisions")?;
                if let Some(http) = &operation.http {
                    if http.method.is_empty()
                        || !http.method.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
                        })
                    {
                        return Err("wiring HTTP method must be a nonblank token".into());
                    }
                    if !http.path.starts_with('/') {
                        return Err("wiring HTTP path must begin with /".into());
                    }
                }
            }
            for screen in &component.screens {
                nonblank(&screen.label, "screen label")?;
            }
            self.validate_attachments(&component.reference_ids)?;
        }
        for connection in &self.connections {
            nonblank(&connection.label, "connection label")?;
            if let Some(request_type) = &connection.request_type {
                nonblank(request_type, "request type")?;
            }
            validate_fields(connection.fields.as_deref().unwrap_or(&[]))?;
            if let Some(protocol) = &connection.protocol {
                nonblank(protocol, "connection protocol")?;
            }
            for endpoint in [&connection.source, &connection.target] {
                let component = self.component(&endpoint.component_id)?;
                if endpoint.operation_id.is_some() && endpoint.screen_id.is_some() {
                    return Err(
                        "wiring endpoint permits either operationId or screenId, not both".into(),
                    );
                }
                if let Some(operation) = &endpoint.operation_id {
                    require_id(
                        operation,
                        component.operations.iter().map(|item| item.id.as_str()),
                        "endpoint operation",
                    )?;
                }
                if let Some(screen) = &endpoint.screen_id {
                    require_id(
                        screen,
                        component.screens.iter().map(|item| item.id.as_str()),
                        "endpoint screen",
                    )?;
                }
            }
            let operation = [&connection.target, &connection.source]
                .into_iter()
                .find(|end| end.operation_id.is_some())
                .and_then(|end| {
                    self.components
                        .iter()
                        .find(|component| component.id == end.component_id)?
                        .operations
                        .iter()
                        .find(|operation| Some(&operation.id) == end.operation_id.as_ref())
                });
            validate_returns(
                connection.returns.as_deref().unwrap_or(&[]),
                connection.kind == Some(WiringOperationKind::Http)
                    || operation.is_some_and(|operation| {
                        operation.http.is_some() || operation.kind == WiringOperationKind::Http
                    }),
            )?;
            self.validate_attachments(&connection.reference_ids)?;
        }
        self.validate_groups()
    }

    fn component(&self, id: &str) -> Result<&WiringComponent, String> {
        self.components
            .iter()
            .find(|component| component.id == id)
            .ok_or_else(|| format!("unknown wiring component reference {id:?}"))
    }

    fn validate_attachments(&self, ids: &[String]) -> Result<(), String> {
        check_count(ids.len(), 50, "reference attachments")?;
        unique(ids.iter().map(String::as_str), "reference attachment")?;
        for id in ids {
            require_id(
                id,
                self.references.iter().map(|item| item.id.as_str()),
                "work reference",
            )?;
        }
        Ok(())
    }

    fn validate_relevance(&self, relevance: &WiringRelevance) -> Result<(), String> {
        check_count(
            relevance.component_ids.len()
                + relevance.connection_ids.len()
                + relevance.operation_refs.len()
                + relevance.screen_refs.len(),
            500,
            "relevance entries",
        )?;
        unique(
            relevance.component_ids.iter().map(String::as_str),
            "component relevance",
        )?;
        unique(
            relevance.connection_ids.iter().map(String::as_str),
            "connection relevance",
        )?;
        unique(
            relevance
                .operation_refs
                .iter()
                .map(|item| (&item.component_id, &item.operation_id)),
            "operation relevance",
        )?;
        unique(
            relevance
                .screen_refs
                .iter()
                .map(|item| (&item.component_id, &item.screen_id)),
            "screen relevance",
        )?;
        for id in &relevance.component_ids {
            self.component(id)?;
        }
        for id in &relevance.connection_ids {
            require_id(
                id,
                self.connections.iter().map(|item| item.id.as_str()),
                "connection",
            )?;
        }
        for reference in &relevance.operation_refs {
            let component = self.component(&reference.component_id)?;
            require_id(
                &reference.operation_id,
                component.operations.iter().map(|item| item.id.as_str()),
                "operation",
            )?;
        }
        for reference in &relevance.screen_refs {
            let component = self.component(&reference.component_id)?;
            require_id(
                &reference.screen_id,
                component.screens.iter().map(|item| item.id.as_str()),
                "screen",
            )?;
        }
        Ok(())
    }

    fn validate_groups(&self) -> Result<(), String> {
        // Adapt the shared containment contract without creating another nesting validator.
        let domain = Domain {
            entities: self
                .components
                .iter()
                .map(|component| Entity {
                    id: component.id.clone(),
                    label: component.label.clone(),
                    attributes: vec![],
                    methods: vec![],
                })
                .collect(),
            relationships: vec![],
            groups: self
                .groups
                .iter()
                .map(|group| DomainGroup {
                    id: group.id.clone(),
                    label: group.label.clone(),
                    entity_ids: group.component_ids.clone(),
                    parent_group_id: group.parent_group_id.clone(),
                })
                .collect(),
        };
        let entities: HashMap<_, _> = domain
            .entities
            .iter()
            .map(|entity| (entity.id.as_str(), entity))
            .collect();
        domain
            .validate_groups(&entities)
            .map_err(|error| format!("wiring groups: {error}"))
    }

    fn validate_url(&self, reference: &WiringReference, url: &str) -> Result<(), String> {
        // Share the explanation link policy; only the link collection is validated here.
        let document = Explanation {
            schema_version: 1,
            title: String::new(),
            description: String::new(),
            overview: String::new(),
            topics: vec![],
            comparisons: vec![],
            wiring: None,
            links: vec![ExplanationLink {
                label: reference.key.clone(),
                url: url.into(),
            }],
            domain: None,
            diagrams: vec![],
            scenarios: vec![],
        };
        document
            .validate_links()
            .map_err(|error| format!("wiring reference {:?}: {error}", reference.id))
    }
}

fn deserialize_example<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error> {
    serde_json::Value::deserialize(deserializer).map(Some)
}

fn validate_fields(fields: &[WiringField]) -> Result<(), String> {
    collection(fields, 200, |field| &field.id, "field")?;
    unique(
        fields.iter().map(|field| (field.section, &field.path)),
        "field path and section",
    )?;
    for field in fields {
        nonblank(&field.path, "field path")?;
        nonblank(&field.field_type, "field type")?;
    }
    Ok(())
}

fn validate_returns(returns: &[WiringReturn], http: bool) -> Result<(), String> {
    check_count(returns.len(), 20, "returns")?;
    let mut statuses = HashSet::new();
    let mut types = HashSet::new();
    for result in returns {
        nonblank(&result.return_type, "return type")?;
        if let Some(status) = result.status {
            if !http {
                return Err("wiring return status requires an HTTP operation or connection".into());
            }
            if !(100..=599).contains(&status) {
                return Err("wiring return status must be between 100 and 599".into());
            }
            if !statuses.insert(status) {
                return Err("duplicate wiring return status".into());
            }
        } else if !types.insert(&result.return_type) {
            return Err("duplicate wiring return type without status".into());
        }
        let fields = result.fields.as_deref().unwrap_or(&[]);
        validate_fields(fields)?;
        if result.return_type == "void" && !fields.is_empty() {
            return Err("wiring void return cannot declare fields".into());
        }
    }
    Ok(())
}

fn collection<T>(
    items: &[T],
    maximum: usize,
    id: impl Fn(&T) -> &str,
    kind: &str,
) -> Result<(), String> {
    check_count(items.len(), maximum, kind)?;
    unique(items.iter().map(&id), kind)?;
    for item in items {
        validate_id(id(item)).map_err(|error| format!("wiring {kind}: {error}"))?;
    }
    Ok(())
}

fn check_count(count: usize, maximum: usize, kind: &str) -> Result<(), String> {
    if count > maximum {
        return Err(format!("wiring {kind} exceeds limit of {maximum}"));
    }
    Ok(())
}

fn unique<T: Eq + std::hash::Hash>(
    items: impl Iterator<Item = T>,
    kind: &str,
) -> Result<(), String> {
    let mut seen = HashSet::new();
    for item in items {
        if !seen.insert(item) {
            return Err(format!("duplicate wiring {kind}"));
        }
    }
    Ok(())
}

fn nonblank(value: &str, kind: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("wiring {kind} must not be blank"));
    }
    Ok(())
}

fn require_id<'a>(id: &str, ids: impl Iterator<Item = &'a str>, kind: &str) -> Result<(), String> {
    validate_id(id)?;
    if !ids.into_iter().any(|candidate| candidate == id) {
        return Err(format!("unknown wiring {kind} reference {id:?}"));
    }
    Ok(())
}
