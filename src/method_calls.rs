use std::collections::{HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::model::{Explanation, validate_id};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MethodCall {
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub entity_id: String,
    #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_-]+(?![\s\S])"))]
    pub method_id: String,
    /// Optional receiver present in this occurrence's before or after snapshot with the matching entity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "crate::model::NullableId")]
    pub instance_id: Option<String>,
}

impl Explanation {
    pub(crate) fn validate_method_calls(&self) -> Result<(), String> {
        let methods: HashMap<_, HashSet<_>> = self
            .domain
            .iter()
            .flat_map(|domain| &domain.entities)
            .map(|entity| {
                (
                    entity.id.as_str(),
                    entity
                        .methods
                        .iter()
                        .map(|method| method.id.as_str())
                        .collect(),
                )
            })
            .collect();
        for scenario in &self.scenarios {
            for occurrence in &scenario.occurrences {
                let validate = || -> Result<(), String> {
                    if occurrence.method_calls.len() > 500 {
                        return Err("method calls exceeds limit of 500".into());
                    }
                    let instances: HashMap<_, _> = occurrence
                        .before
                        .instances
                        .iter()
                        .chain(&occurrence.after.instances)
                        .map(|instance| (instance.id.as_str(), instance.entity_id.as_str()))
                        .collect();
                    for call in &occurrence.method_calls {
                        validate_id(&call.entity_id)?;
                        validate_id(&call.method_id)?;
                        let entity_methods =
                            methods.get(call.entity_id.as_str()).ok_or_else(|| {
                                format!("unknown method call entity reference {:?}", call.entity_id)
                            })?;
                        if !entity_methods.contains(call.method_id.as_str()) {
                            return Err(format!(
                                "unknown method call method reference {:?} on entity {:?}",
                                call.method_id, call.entity_id
                            ));
                        }
                        if let Some(id) = &call.instance_id {
                            validate_id(id)?;
                            match instances.get(id.as_str()) {
                                Some(entity_id) if *entity_id == call.entity_id => (),
                                Some(_) => {
                                    return Err(format!(
                                        "method call instance {id:?} has a different entity"
                                    ));
                                }
                                None => {
                                    return Err(format!(
                                        "unknown method call instance reference {id:?}"
                                    ));
                                }
                            }
                        }
                    }
                    Ok(())
                };
                validate().map_err(|error| {
                    format!(
                        "scenario {:?}, occurrence {:?}: {error}",
                        scenario.id, occurrence.id
                    )
                })?;
            }
        }
        Ok(())
    }
}
