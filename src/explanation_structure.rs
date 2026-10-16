use std::collections::HashSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::model::{Explanation, validate_id};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioTopic {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    /// Nonblank reader question or subject, independent of diagram kind.
    pub title: String,
    /// Plain-text context for this topic.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Ordered scenario IDs. A scenario has at most one topic; ungrouped scenarios remain available.
    #[schemars(
        length(min = 1, max = 100),
        inner(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))
    )]
    pub scenario_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioComparison {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub id: String,
    /// Nonblank question or contrast explained by this pair.
    pub title: String,
    /// Plain-text explanation of the difference, evidence, and assumptions.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub left_scenario_id: String,
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub right_scenario_id: String,
}

impl Explanation {
    pub(crate) fn validate_structure(&self) -> Result<(), String> {
        if self.topics.len() > 50 {
            return Err("explanation topics exceeds limit of 50".into());
        }
        if self.comparisons.len() > 100 {
            return Err("explanation comparisons exceeds limit of 100".into());
        }
        let scenarios: HashSet<_> = self
            .scenarios
            .iter()
            .map(|scenario| scenario.id.as_str())
            .collect();
        let mut topic_ids = HashSet::new();
        let mut memberships = HashSet::new();
        for topic in &self.topics {
            validate_id(&topic.id)?;
            if !topic_ids.insert(&topic.id) {
                return Err(format!("duplicate topic ID {:?}", topic.id));
            }
            if topic.title.trim().is_empty() {
                return Err(format!("topic {:?}: title must not be blank", topic.id));
            }
            if topic.scenario_ids.is_empty() || topic.scenario_ids.len() > 100 {
                return Err(format!("topic {:?}: requires 1–100 scenario IDs", topic.id));
            }
            for id in &topic.scenario_ids {
                if !scenarios.contains(id.as_str()) {
                    return Err(format!(
                        "topic {:?}: unknown scenario reference {id:?}",
                        topic.id
                    ));
                }
                if !memberships.insert(id) {
                    return Err(format!(
                        "scenario {id:?}: belongs to more than one topic or is repeated"
                    ));
                }
            }
        }
        let mut comparison_ids = HashSet::new();
        for comparison in &self.comparisons {
            validate_id(&comparison.id)?;
            if !comparison_ids.insert(&comparison.id) {
                return Err(format!("duplicate comparison ID {:?}", comparison.id));
            }
            if comparison.title.trim().is_empty() {
                return Err(format!(
                    "comparison {:?}: title must not be blank",
                    comparison.id
                ));
            }
            for id in [&comparison.left_scenario_id, &comparison.right_scenario_id] {
                if !scenarios.contains(id.as_str()) {
                    return Err(format!(
                        "comparison {:?}: unknown scenario reference {id:?}",
                        comparison.id
                    ));
                }
            }
            if comparison.left_scenario_id == comparison.right_scenario_id {
                return Err(format!(
                    "comparison {:?}: requires two distinct scenarios",
                    comparison.id
                ));
            }
        }
        for scenario in &self.scenarios {
            if scenario.labels.len() > 8 {
                return Err(format!(
                    "scenario {:?}: labels exceeds limit of 8",
                    scenario.id
                ));
            }
            let mut labels = HashSet::new();
            for label in &scenario.labels {
                if label.trim().is_empty() || label.chars().count() > 64 {
                    return Err(format!(
                        "scenario {:?}: labels require 1–64 characters of nonblank text",
                        scenario.id
                    ));
                }
                if !labels.insert(label) {
                    return Err(format!(
                        "scenario {:?}: duplicate label {label:?}",
                        scenario.id
                    ));
                }
            }
        }
        Ok(())
    }
}
