use std::collections::HashSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::model::{Scenario, Sequence, validate_id};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SequenceStep {
    Message {
        #[serde(rename = "nodeId")]
        node_id: String,
    },
    Alt {
        id: String,
        operands: Vec<SequenceOperand>,
    },
    Opt {
        id: String,
        /// Descriptive condition, rendered as text and never evaluated.
        guard: String,
        body: Vec<SequenceStep>,
    },
    Loop {
        id: String,
        /// Descriptive condition for zero or more recorded iterations.
        guard: String,
        body: Vec<SequenceStep>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SequenceOperand {
    pub id: String,
    /// Descriptive branch condition; a traversal chooses one operand per alt visit.
    pub guard: String,
    pub body: Vec<SequenceStep>,
}

impl Sequence {
    pub(crate) fn validate_body(&self) -> Result<(), String> {
        let mut structure = Structure::default();
        structure.validate(&self.body, 0)?;
        let messages: HashSet<_> = self
            .messages
            .iter()
            .map(|message| message.node_id.as_str())
            .collect();
        if structure.nodes != messages {
            return Err("sequence body must reference every message node exactly once".into());
        }
        Ok(())
    }

    pub(crate) fn validate_traversal(&self, scenario: &Scenario) -> Result<(), String> {
        let mut machine = Machine::default();
        let start = machine.state();
        let end = machine.state();
        machine.body(&self.body, start, end);
        let mut states = machine.closure(vec![start]);
        for occurrence in &scenario.occurrences {
            let next = states
                .iter()
                .flat_map(|&state| &machine.transitions[state])
                .filter_map(|&(node, target)| {
                    (node == Some(occurrence.node_id.as_str())).then_some(target)
                })
                .collect();
            states = machine.closure(next);
            if states.is_empty() {
                return Err(format!(
                    "scenario {:?}, occurrence {:?}: violates shared sequence ordering or fragment branches",
                    scenario.id, occurrence.id
                ));
            }
        }
        // Recorded scenarios may end at a prefix of the declared interaction.
        Ok(())
    }
}

#[derive(Default)]
struct Structure<'a> {
    ids: HashSet<&'a str>,
    nodes: HashSet<&'a str>,
    count: usize,
}

impl<'a> Structure<'a> {
    fn identify(&mut self, id: &'a str) -> Result<(), String> {
        validate_id(id)?;
        if !self.ids.insert(id) {
            return Err(format!("duplicate sequence fragment or operand ID {id:?}"));
        }
        Ok(())
    }

    fn guard(guard: &str) -> Result<(), String> {
        if guard.trim().is_empty() {
            return Err("sequence fragment guards must contain text".into());
        }
        Ok(())
    }

    fn validate(&mut self, body: &'a [SequenceStep], depth: usize) -> Result<(), String> {
        if body.is_empty() {
            return Err("sequence body and fragment bodies must be nonempty".into());
        }
        if depth > 8 {
            return Err("sequence fragment nesting exceeds limit of 8".into());
        }
        for step in body {
            self.count += 1;
            if self.count > 500 {
                return Err("sequence structure exceeds limit of 500 items".into());
            }
            match step {
                SequenceStep::Message { node_id } => {
                    validate_id(node_id)?;
                    if !self.nodes.insert(node_id) {
                        return Err(format!("duplicate sequence body message node {node_id:?}"));
                    }
                }
                SequenceStep::Alt { id, operands } => {
                    self.identify(id)?;
                    if !(2..=20).contains(&operands.len()) {
                        return Err("alt fragments require 2–20 operands".into());
                    }
                    for operand in operands {
                        self.count += 1;
                        self.identify(&operand.id)?;
                        Self::guard(&operand.guard)?;
                        self.validate(&operand.body, depth + 1)?;
                    }
                }
                SequenceStep::Opt { id, guard, body } | SequenceStep::Loop { id, guard, body } => {
                    self.identify(id)?;
                    Self::guard(guard)?;
                    self.validate(body, depth + 1)?;
                }
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct Machine<'a> {
    transitions: Vec<Vec<(Option<&'a str>, usize)>>,
}

impl<'a> Machine<'a> {
    fn state(&mut self) -> usize {
        self.transitions.push(Vec::new());
        self.transitions.len() - 1
    }

    fn edge(&mut self, from: usize, to: usize, node: Option<&'a str>) {
        self.transitions[from].push((node, to));
    }

    fn body(&mut self, body: &'a [SequenceStep], start: usize, end: usize) {
        let mut from = start;
        for (index, step) in body.iter().enumerate() {
            let to = if index + 1 == body.len() {
                end
            } else {
                self.state()
            };
            match step {
                SequenceStep::Message { node_id } => self.edge(from, to, Some(node_id)),
                SequenceStep::Alt { operands, .. } => {
                    for operand in operands {
                        self.body(&operand.body, from, to);
                    }
                }
                SequenceStep::Opt { body, .. } => {
                    self.edge(from, to, None);
                    self.body(body, from, to);
                }
                SequenceStep::Loop { body, .. } => {
                    let entry = self.state();
                    let exit = self.state();
                    self.edge(from, to, None);
                    self.edge(from, entry, None);
                    self.body(body, entry, exit);
                    self.edge(exit, from, None);
                }
            }
            from = to;
        }
    }

    fn closure(&self, mut pending: Vec<usize>) -> Vec<usize> {
        let mut seen = vec![false; self.transitions.len()];
        let mut states = Vec::new();
        while let Some(state) = pending.pop() {
            if seen[state] {
                continue;
            }
            seen[state] = true;
            states.push(state);
            pending.extend(
                self.transitions[state]
                    .iter()
                    .filter_map(|&(node, target)| node.is_none().then_some(target)),
            );
        }
        states
    }
}
