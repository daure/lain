use std::collections::{HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::model::{Diagram, DiagramKind, Domain, Entity, Node, validate_id};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagramGroup {
    /// Stable container ID, distinct from node IDs within this diagram.
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    /// Plain-text heading for a flow subgraph or state composite container.
    pub label: String,
    /// Direct member nodes. A node belongs to at most one group; ancestors include it through nesting.
    #[schemars(
        length(max = 200),
        inner(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))
    )]
    pub node_ids: Vec<String>,
    /// Optional parent container in this diagram. Nesting is acyclic and at most eight levels deep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "crate::model::NullableId")]
    pub parent_group_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainGroup {
    /// Stable container ID, distinct from entity IDs in the shared domain.
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    /// Plain-text heading for a domain area, external system, API DTOs, or technology boundary.
    pub label: String,
    /// Direct member entities. Each entity has at most one direct membership.
    #[schemars(
        length(max = 200),
        inner(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))
    )]
    pub entity_ids: Vec<String>,
    /// Optional parent in domain.groups. Nesting is acyclic and at most eight levels deep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "crate::model::NullableId")]
    pub parent_group_id: Option<String>,
}

struct GroupDefinition<'a> {
    id: &'a str,
    label: &'a str,
    members: &'a [String],
    parent: Option<&'a str>,
}

impl Diagram {
    pub(crate) fn validate_groups(&self, nodes: &HashMap<&str, &Node>) -> Result<(), String> {
        if self.groups.is_empty() {
            return Ok(());
        }
        if self.kind == DiagramKind::Sequence {
            return Err("groups require kind flow or state".into());
        }
        let groups: Vec<_> = self
            .groups
            .iter()
            .map(|group| GroupDefinition {
                id: &group.id,
                label: &group.label,
                members: &group.node_ids,
                parent: group.parent_group_id.as_deref(),
            })
            .collect();
        validate_containment(&groups, nodes, "diagram", "node", "nodes", "a node")
    }
}

impl Domain {
    pub(crate) fn validate_groups(&self, entities: &HashMap<&str, &Entity>) -> Result<(), String> {
        let groups: Vec<_> = self
            .groups
            .iter()
            .map(|group| GroupDefinition {
                id: &group.id,
                label: &group.label,
                members: &group.entity_ids,
                parent: group.parent_group_id.as_deref(),
            })
            .collect();
        validate_containment(
            &groups,
            entities,
            "domain",
            "entity",
            "entities",
            "an entity",
        )
    }
}

fn validate_containment<T>(
    definitions: &[GroupDefinition<'_>],
    items: &HashMap<&str, &T>,
    scope: &str,
    member: &str,
    plural: &str,
    conflict: &str,
) -> Result<(), String> {
    if definitions.len() > 100 {
        return Err(format!("{scope} groups exceeds limit of 100"));
    }
    let mut groups = HashMap::new();
    for group in definitions {
        validate_id(group.id).map_err(|error| format!("group: {error}"))?;
        if groups.insert(group.id, group).is_some() {
            return Err(format!("duplicate group ID {:?}", group.id));
        }
        if items.contains_key(group.id) {
            return Err(format!(
                "group {:?}: ID conflicts with {conflict}",
                group.id
            ));
        }
        if group.label.trim().is_empty() {
            return Err(format!("group {:?}: label must not be blank", group.id));
        }
        if group.members.len() > 200 {
            return Err(format!("group {plural} exceeds limit of 200"));
        }
    }
    let mut members = HashSet::new();
    let mut populated = HashSet::new();
    for group in definitions {
        for node_id in group.members {
            if !items.contains_key(node_id.as_str()) {
                return Err(format!("unknown group {member} reference {node_id:?}"));
            }
            if !members.insert(node_id) {
                return Err(format!(
                    "{member} {node_id:?} belongs to more than one group membership"
                ));
            }
        }
        let mut ancestors = HashSet::new();
        let mut current = Some(group);
        while let Some(ancestor) = current {
            if !ancestors.insert(ancestor.id) {
                return Err(format!("group {:?}: cyclic parentGroupId", group.id));
            }
            if ancestors.len() > 8 {
                return Err("group nesting exceeds limit of 8".into());
            }
            if !group.members.is_empty() {
                populated.insert(ancestor.id);
            }
            current = ancestor
                .parent
                .map(|id| {
                    groups
                        .get(id)
                        .copied()
                        .ok_or_else(|| format!("unknown parent group reference {id:?}"))
                })
                .transpose()?;
        }
    }
    for group in definitions {
        if !populated.contains(group.id) {
            return Err(format!(
                "group {:?} requires at least one descendant {member}",
                group.id
            ));
        }
    }
    Ok(())
}
