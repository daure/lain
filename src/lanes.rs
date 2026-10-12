use std::collections::{HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::model::{Diagram, DiagramKind, Node, validate_id};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagramLane {
    /// Stable lane ID, distinct from node and group IDs within this diagram.
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    /// Nonblank plain-text heading for this flow swimlane.
    pub label: String,
    /// Explicit member nodes. Each node has at most one lane membership.
    #[schemars(
        length(min = 1, max = 200),
        inner(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))
    )]
    pub node_ids: Vec<String>,
}

impl Diagram {
    pub(crate) fn validate_lanes(&self, nodes: &HashMap<&str, &Node>) -> Result<(), String> {
        if self.lanes.is_empty() {
            return Ok(());
        }
        if self.kind != DiagramKind::Flow {
            return Err(format!("diagram {:?}: lanes require kind flow", self.id));
        }
        if self.lanes.len() > 50 {
            return Err("diagram lanes exceeds limit of 50".into());
        }
        let groups: HashMap<_, _> = self
            .groups
            .iter()
            .map(|group| (group.id.as_str(), group))
            .collect();
        let mut lane_ids = HashSet::new();
        let mut memberships = HashMap::new();
        for lane in &self.lanes {
            validate_id(&lane.id).map_err(|error| format!("lane: {error}"))?;
            if !lane_ids.insert(lane.id.as_str()) {
                return Err(format!("duplicate lane ID {:?}", lane.id));
            }
            if nodes.contains_key(lane.id.as_str()) || groups.contains_key(lane.id.as_str()) {
                return Err(format!(
                    "lane {:?}: ID conflicts with a node or group",
                    lane.id
                ));
            }
            if lane.label.trim().is_empty() {
                return Err(format!("lane {:?}: label must not be blank", lane.id));
            }
            if lane.node_ids.is_empty() || lane.node_ids.len() > 200 {
                return Err(format!("lane {:?}: requires 1–200 member nodes", lane.id));
            }
            for node_id in &lane.node_ids {
                if !nodes.contains_key(node_id.as_str()) {
                    return Err(format!(
                        "lane {:?}: unknown lane node reference {node_id:?}",
                        lane.id
                    ));
                }
                if let Some(previous) = memberships.insert(node_id.as_str(), lane.id.as_str()) {
                    return Err(format!(
                        "node {node_id:?} belongs to more than one lane membership: lanes {previous:?} and {:?}",
                        lane.id
                    ));
                }
            }
        }
        let mut group_bands = HashMap::new();
        for group in &self.groups {
            for node_id in &group.node_ids {
                let band = memberships.get(node_id.as_str()).copied();
                let mut ancestor = Some(group);
                while let Some(current) = ancestor {
                    if let Some(previous) = group_bands.insert(current.id.as_str(), band)
                        && previous != band
                    {
                        return Err(format!(
                            "group {:?}: subtree spans lane bands {:?} and {:?}; all direct and descendant nodes must share one lane or all be unassigned",
                            current.id,
                            previous.unwrap_or("<unassigned>"),
                            band.unwrap_or("<unassigned>")
                        ));
                    }
                    ancestor = current.parent_group_id.as_deref().map(|id| groups[id]);
                }
            }
        }
        Ok(())
    }
}
