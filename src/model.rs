use std::collections::{BTreeMap, HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub use crate::cardinality::Cardinality;
pub use crate::groups::{DiagramGroup, DomainGroup};
pub use crate::method_calls::MethodCall;
pub use crate::sequence::{SequenceOperand, SequenceStep};

pub const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_DEPTH: usize = 32;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Explanation {
    pub schema_version: u32,
    pub title: String,
    pub description: String,
    pub domain: Domain,
    pub diagrams: Vec<Diagram>,
    pub scenarios: Vec<Scenario>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Domain {
    pub entities: Vec<Entity>,
    pub relationships: Vec<Relationship>,
    /// Shared ERD containers for domain areas, external systems, API DTOs, or technology boundaries.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<DomainGroup>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entity {
    pub id: String,
    pub label: String,
    pub attributes: Vec<Attribute>,
    /// Descriptive domain operations, rendered separately from captured attributes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<EntityMethod>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityMethod {
    pub id: String,
    /// Nonblank signature text, including parameters and return type when known; never executed.
    pub signature: String,
    /// Plain-text description of the operation's domain behavior.
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attribute {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Relationship {
    pub id: String,
    pub label: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    /// Sources per target: zeroOrOne (0..1), exactlyOne (1..1), zeroOrMore (0..*), or oneOrMore (1..*).
    pub source_cardinality: Cardinality,
    /// Targets per source: zeroOrOne (0..1), exactlyOne (1..1), zeroOrMore (0..*), or oneOrMore (1..*).
    pub target_cardinality: Cardinality,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagram {
    pub id: String,
    pub title: String,
    /// Flow nodes describe actions; state nodes describe conditions and their edges describe triggering events.
    pub kind: DiagramKind,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// Flow subgraphs or state composite containers. Membership is descriptive; traversals use nodes and edges.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<DiagramGroup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<Sequence>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DiagramKind {
    #[serde(alias = "process")]
    Flow,
    State,
    Sequence,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sequence {
    pub participants: Vec<SequenceParticipant>,
    pub messages: Vec<SequenceMessage>,
    /// Ordered shared interaction with message references and alt/opt/loop fragments.
    #[serde(default)]
    #[schemars(!default)]
    pub body: Vec<SequenceStep>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SequenceParticipant {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SequenceMessage {
    pub node_id: String,
    pub from_participant_id: String,
    pub to_participant_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub entity_ids: Vec<String>,
    /// Optional flow-only role. Subprocesses use double-bordered boxes; omitted roles use action boxes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<FlowNodeRole>,
    /// Detail flow or sequence diagram in this explanation. Flow sources require role subprocess;
    /// sequence sources are message nodes. State diagrams cannot be sources or targets. Never executed.
    #[serde(
        default,
        alias = "subprocessDiagramId",
        skip_serializing_if = "Option::is_none"
    )]
    pub detail_diagram_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FlowNodeRole {
    Action,
    Decision,
    Start,
    End,
    Subprocess,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edge {
    pub id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scenario {
    pub id: String,
    pub title: String,
    /// Agent-authored plain-text overview of the setup, goal, and recorded outcome or stopping point.
    /// Remains the same at every step. Label assumptions and synthetic examples explicitly.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub diagram_id: String,
    pub occurrences: Vec<Occurrence>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Occurrence {
    pub id: String,
    pub node_id: String,
    #[serde(deserialize_with = "required_nullable")]
    #[schemars(with = "NullableString")]
    pub incoming_edge_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[schemars(with = "NullableString")]
    pub trigger: Option<String>,
    /// Agent-authored paragraphs explaining this visit's action, cause, and observed consequence.
    /// Distinguish verified facts from assumptions; use blank lines between paragraphs.
    pub narration: String,
    /// Optional agent-authored summary of this visit's captured before-to-after changes.
    /// Distinguish capture differences from state changes; omitted data is unknown, not unchanged.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub change_summary: String,
    pub before: Snapshot,
    pub after: Snapshot,
    /// Recorded calls in authored order, attached to this visit rather than the shared node.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub method_calls: Vec<MethodCall>,
}

#[derive(JsonSchema)]
#[serde(untagged)]
#[allow(dead_code)]
enum NullableString {
    Text(String),
    Null(()),
}

fn required_nullable<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub instances: Vec<Instance>,
    pub links: Vec<Link>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Instance {
    pub id: String,
    pub entity_id: String,
    pub values: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Link {
    pub relationship_id: String,
    pub source_instance_id: String,
    pub target_instance_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredExplanation {
    pub id: String,
    pub revision: u64,
    pub updated_at_ms: u64,
    pub document: Explanation,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishRequest {
    pub expected_revision: u64,
    pub document: Explanation,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteRequest {
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplanationSummary {
    pub id: String,
    pub title: String,
    pub description: String,
    pub revision: u64,
    pub updated_at_ms: u64,
    pub diagram_count: usize,
    pub scenario_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeEvent {
    pub id: String,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(format!(
            "invalid ID {id:?}: use 1–64 ASCII letters, digits, underscores or hyphens"
        ));
    }
    Ok(())
}

fn index<'a, T>(
    items: &'a [T],
    id: impl Fn(&'a T) -> &'a str,
    kind: &str,
) -> Result<HashMap<&'a str, &'a T>, String> {
    let mut result = HashMap::new();
    for item in items {
        let key = id(item);
        validate_id(key).map_err(|error| format!("{kind}: {error}"))?;
        if result.insert(key, item).is_some() {
            return Err(format!("duplicate {kind} ID {key:?}"));
        }
    }
    Ok(result)
}

fn limit(count: usize, maximum: usize, kind: &str) -> Result<(), String> {
    if count > maximum {
        return Err(format!("{kind} exceeds limit of {maximum}"));
    }
    Ok(())
}

fn require<'a, T>(items: &'a HashMap<&str, T>, id: &str, kind: &str) -> Result<&'a T, String> {
    items
        .get(id)
        .ok_or_else(|| format!("unknown {kind} reference {id:?}"))
}

impl Explanation {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("schemaVersion must be 1".into());
        }
        limit(self.domain.entities.len(), 200, "entities")?;
        limit(self.domain.relationships.len(), 500, "relationships")?;
        limit(self.diagrams.len(), 50, "diagrams")?;
        limit(self.scenarios.len(), 100, "scenarios")?;
        if self.diagrams.is_empty() || self.scenarios.is_empty() {
            return Err("at least one diagram and scenario are required".into());
        }
        let entities = index(&self.domain.entities, |entity| &entity.id, "entity")?;
        let relationships = index(
            &self.domain.relationships,
            |relationship| &relationship.id,
            "relationship",
        )?;
        let diagrams = index(&self.diagrams, |diagram| &diagram.id, "diagram")?;
        index(&self.scenarios, |scenario| &scenario.id, "scenario")?;
        let mut entity_attributes = HashMap::new();
        for entity in &self.domain.entities {
            limit(entity.attributes.len(), 200, "entity attributes")?;
            limit(entity.methods.len(), 200, "entity methods")?;
            index(&entity.methods, |method| &method.id, "entity method")?;
            for method in &entity.methods {
                if method.signature.trim().is_empty() {
                    return Err(format!(
                        "entity {:?}, method {:?}: signature must not be blank",
                        entity.id, method.id
                    ));
                }
            }
            let attributes = index(&entity.attributes, |attribute| &attribute.id, "attribute")?;
            entity_attributes.insert(entity.id.as_str(), attributes);
        }
        self.domain.validate_groups(&entities)?;
        for relationship in &self.domain.relationships {
            require(&entities, &relationship.source_entity_id, "source entity")?;
            require(&entities, &relationship.target_entity_id, "target entity")?;
            for (endpoint, cardinality) in [
                ("sourceCardinality", relationship.source_cardinality),
                ("targetCardinality", relationship.target_cardinality),
            ] {
                if !cardinality.is_explicit() {
                    return Err(format!(
                        "relationship {:?}: {endpoint} must specify a minimum and maximum: zeroOrOne, exactlyOne, zeroOrMore, or oneOrMore",
                        relationship.id
                    ));
                }
            }
        }
        for diagram in &self.diagrams {
            limit(diagram.nodes.len(), 200, "diagram nodes")?;
            limit(diagram.edges.len(), 500, "diagram edges")?;
            let nodes = index(&diagram.nodes, |node| &node.id, "node")?;
            index(&diagram.edges, |edge| &edge.id, "edge")?;
            diagram.validate_groups(&nodes)?;
            diagram.validate_sequence(&nodes)?;
            for node in &diagram.nodes {
                if node.role.is_some() && diagram.kind != DiagramKind::Flow {
                    return Err(format!("node {:?}: role requires kind flow", node.id));
                }
                if let Some(target) = &node.detail_diagram_id {
                    if diagram.kind == DiagramKind::State {
                        return Err(format!(
                            "node {:?}: state diagrams cannot link to detail diagrams",
                            node.id
                        ));
                    }
                    if diagram.kind == DiagramKind::Flow
                        && node.role != Some(FlowNodeRole::Subprocess)
                    {
                        return Err(format!(
                            "node {:?}: detailDiagramId on a flow node requires role subprocess",
                            node.id
                        ));
                    }
                    let detail = require(&diagrams, target, "detail diagram")?;
                    if detail.kind == DiagramKind::State {
                        return Err(format!(
                            "node {:?}: detail diagram must have kind flow or sequence",
                            node.id
                        ));
                    }
                    if target == &diagram.id {
                        return Err(format!(
                            "node {:?}: detail diagram must be another diagram",
                            node.id
                        ));
                    }
                }
                for entity_id in &node.entity_ids {
                    require(&entities, entity_id, "node entity")?;
                }
            }
            for edge in &diagram.edges {
                require(&nodes, &edge.source_node_id, "edge source node")?;
                require(&nodes, &edge.target_node_id, "edge target node")?;
            }
        }
        let mut occurrence_count = 0;
        for scenario in &self.scenarios {
            occurrence_count += scenario.occurrences.len();
            limit(occurrence_count, 2_000, "total occurrences")?;
            let diagram = require(&diagrams, &scenario.diagram_id, "scenario diagram")?;
            self.validate_scenario(scenario, diagram, &entity_attributes, &relationships)?;
        }
        self.validate_method_calls()?;
        let value = serde_json::to_value(self).map_err(|error| error.to_string())?;
        validate_json(&value, 0)?;
        let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        limit(bytes.len(), MAX_DOCUMENT_BYTES, "serialized document bytes")
    }

    fn validate_scenario(
        &self,
        scenario: &Scenario,
        diagram: &Diagram,
        entity_attributes: &HashMap<&str, HashMap<&str, &Attribute>>,
        relationships: &HashMap<&str, &Relationship>,
    ) -> Result<(), String> {
        if scenario.occurrences.is_empty() {
            return Err(format!(
                "scenario {:?} requires at least one occurrence",
                scenario.id
            ));
        }
        index(
            &scenario.occurrences,
            |occurrence| &occurrence.id,
            "occurrence",
        )?;
        let nodes = index(&diagram.nodes, |node| &node.id, "node")?;
        let edges = index(&diagram.edges, |edge| &edge.id, "edge")?;
        let mut identities = HashMap::new();
        let mut previous_node = None;
        for occurrence in &scenario.occurrences {
            require(&nodes, &occurrence.node_id, "occurrence node")?;
            match (previous_node, occurrence.incoming_edge_id.as_deref()) {
                (None, None) => (),
                (Some(previous), Some(edge_id)) => {
                    let edge = require(&edges, edge_id, "incoming edge")?;
                    if edge.source_node_id != previous || edge.target_node_id != occurrence.node_id
                    {
                        return Err(format!(
                            "occurrence {:?}: incoming edge does not connect previous node to current node",
                            occurrence.id
                        ));
                    }
                }
                (None, Some(_)) => {
                    return Err("first occurrence must have null incomingEdgeId".into());
                }
                (Some(_), None) => return Err("later occurrences require an incomingEdgeId".into()),
            }
            for snapshot in [&occurrence.before, &occurrence.after] {
                validate_snapshot(snapshot, entity_attributes, relationships, &mut identities)
                    .map_err(|error| {
                        format!(
                            "scenario {:?}, occurrence {:?}: {error}",
                            scenario.id, occurrence.id
                        )
                    })?;
            }
            previous_node = Some(occurrence.node_id.as_str());
        }
        if let Some(sequence) = &diagram.sequence {
            sequence.validate_traversal(scenario)?;
        }
        Ok(())
    }
}

impl Diagram {
    fn validate_sequence(&self, nodes: &HashMap<&str, &Node>) -> Result<(), String> {
        let sequence = match (self.kind, &self.sequence) {
            (DiagramKind::Sequence, Some(sequence)) => sequence,
            (DiagramKind::Sequence, None) => {
                return Err("sequence diagrams require sequence data".into());
            }
            (_, Some(_)) => return Err("sequence data requires kind sequence".into()),
            (_, None) => return Ok(()),
        };
        if nodes.is_empty() || sequence.participants.is_empty() {
            return Err("sequence diagrams require at least one node and participant".into());
        }
        limit(sequence.participants.len(), 50, "sequence participants")?;
        limit(sequence.messages.len(), 200, "sequence messages")?;
        let participants = index(
            &sequence.participants,
            |participant| &participant.id,
            "sequence participant",
        )?;
        let messages = index(
            &sequence.messages,
            |message| &message.node_id,
            "message node",
        )?;
        for message in &sequence.messages {
            require(nodes, &message.node_id, "message node")?;
            require(
                &participants,
                &message.from_participant_id,
                "sender participant",
            )?;
            require(
                &participants,
                &message.to_participant_id,
                "receiver participant",
            )?;
        }
        if messages.len() != nodes.len() {
            return Err("sequence messages must map every diagram node exactly once".into());
        }
        sequence.validate_body()?;
        Ok(())
    }
}

fn validate_snapshot<'a>(
    snapshot: &'a Snapshot,
    entity_attributes: &HashMap<&str, HashMap<&str, &Attribute>>,
    relationships: &HashMap<&str, &Relationship>,
    identities: &mut HashMap<&'a str, &'a str>,
) -> Result<(), String> {
    limit(snapshot.instances.len(), 500, "snapshot instances")?;
    let instances = index(&snapshot.instances, |instance| &instance.id, "instance")?;
    for instance in &snapshot.instances {
        let attributes = require(entity_attributes, &instance.entity_id, "instance entity")?;
        for attribute in instance.values.keys() {
            if !attributes.contains_key(attribute.as_str()) {
                return Err(format!(
                    "instance {:?}: unknown attribute {attribute:?}",
                    instance.id
                ));
            }
        }
        for value in instance.values.values() {
            validate_json(value, 9)?;
        }
        if let Some(previous) = identities.insert(&instance.id, &instance.entity_id)
            && previous != instance.entity_id
        {
            return Err(format!(
                "instance {:?} changes entity identity",
                instance.id
            ));
        }
    }
    let mut links = HashSet::new();
    let mut sources = HashSet::new();
    let mut targets = HashSet::new();
    for link in &snapshot.links {
        let relationship = require(relationships, &link.relationship_id, "link relationship")?;
        let source = require(&instances, &link.source_instance_id, "link source instance")?;
        let target = require(&instances, &link.target_instance_id, "link target instance")?;
        if source.entity_id != relationship.source_entity_id
            || target.entity_id != relationship.target_entity_id
        {
            return Err(format!(
                "link {:?} has incorrect endpoint entity types",
                link.relationship_id
            ));
        }
        if !links.insert((
            &link.relationship_id,
            &link.source_instance_id,
            &link.target_instance_id,
        )) {
            return Err(format!(
                "duplicate link for relationship {:?}",
                link.relationship_id
            ));
        }
        let first_source = sources.insert((&link.relationship_id, &link.source_instance_id));
        let first_target = targets.insert((&link.relationship_id, &link.target_instance_id));
        if relationship.target_cardinality.is_single() && !first_source {
            return Err(format!(
                "relationship {:?} violates target cardinality one",
                link.relationship_id
            ));
        }
        if relationship.source_cardinality.is_single() && !first_target {
            return Err(format!(
                "relationship {:?} violates source cardinality one",
                link.relationship_id
            ));
        }
    }
    for relationship in relationships.values() {
        for instance in &snapshot.instances {
            if relationship.target_cardinality.is_required()
                && instance.entity_id == relationship.source_entity_id
                && !sources.contains(&(&relationship.id, &instance.id))
            {
                return Err(format!(
                    "relationship {:?}: instance {:?} requires at least one target link",
                    relationship.id, instance.id
                ));
            }
            if relationship.source_cardinality.is_required()
                && instance.entity_id == relationship.target_entity_id
                && !targets.contains(&(&relationship.id, &instance.id))
            {
                return Err(format!(
                    "relationship {:?}: instance {:?} requires at least one source link",
                    relationship.id, instance.id
                ));
            }
        }
    }
    Ok(())
}

fn validate_json(value: &Value, depth: usize) -> Result<(), String> {
    match value {
        Value::String(text) => limit(text.len(), MAX_TEXT_BYTES, "text bytes"),
        Value::Number(number) => {
            const MAX_SAFE_NUMBER: f64 = 9_007_199_254_740_991.0;
            if !number
                .as_f64()
                .is_some_and(|value| (-MAX_SAFE_NUMBER..=MAX_SAFE_NUMBER).contains(&value))
            {
                return Err(
                    "JSON numbers must be within [-9007199254740991, 9007199254740991]; encode out-of-range values as strings"
                        .into(),
                );
            }
            Ok(())
        }
        Value::Array(values) => {
            limit(depth + 1, MAX_DEPTH, "JSON nesting levels")?;
            for value in values {
                validate_json(value, depth + 1)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            limit(depth + 1, MAX_DEPTH, "JSON nesting levels")?;
            for (key, value) in values {
                limit(key.len(), MAX_TEXT_BYTES, "text bytes")?;
                validate_json(value, depth + 1)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
