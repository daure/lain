use crate::model::{Diagram, DiagramKind, StateNodeRole};

impl Diagram {
    pub(crate) fn validate_state_diagram(&self) -> Result<(), String> {
        for node in &self.nodes {
            let Some(role) = node.state_role else {
                continue;
            };
            if self.kind != DiagramKind::State {
                return Err(format!("node {:?}: stateRole requires kind state", node.id));
            }
            match role {
                StateNodeRole::Initial => {
                    if self.edges.iter().any(|edge| edge.target_node_id == node.id) {
                        return Err(format!(
                            "node {:?}: initial markers cannot have incoming edges",
                            node.id
                        ));
                    }
                    if self
                        .edges
                        .iter()
                        .filter(|edge| edge.source_node_id == node.id)
                        .count()
                        != 1
                    {
                        return Err(format!(
                            "node {:?}: initial markers require exactly one outgoing edge",
                            node.id
                        ));
                    }
                }
                StateNodeRole::Final => {
                    if self.edges.iter().any(|edge| edge.source_node_id == node.id) {
                        return Err(format!(
                            "node {:?}: final markers cannot have outgoing edges",
                            node.id
                        ));
                    }
                }
            }
        }
        for edge in &self.edges {
            let Some(transition) = &edge.transition else {
                continue;
            };
            if self.kind != DiagramKind::State {
                return Err(format!(
                    "edge {:?}: transition requires kind state",
                    edge.id
                ));
            }
            let fields = [
                ("event", &transition.event),
                ("guard", &transition.guard),
                ("effect", &transition.effect),
            ];
            if fields.iter().all(|(_, value)| value.is_none()) {
                return Err(format!(
                    "edge {:?}: transition requires an event, guard, or effect",
                    edge.id
                ));
            }
            for (name, value) in fields {
                if value.as_ref().is_some_and(|text| text.trim().is_empty()) {
                    return Err(format!(
                        "edge {:?}: transition {name} must not be blank",
                        edge.id
                    ));
                }
            }
        }
        Ok(())
    }
}
