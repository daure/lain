use reqwest::Url;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::model::Explanation;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplanationLink {
    /// Nonblank plain-text name for an explanation-wide reference.
    #[schemars(length(min = 1, max = 32768))]
    pub label: String,
    /// Absolute HTTP/HTTPS URL with a host, no credentials, whitespace, control characters, or backslashes.
    /// Percent-encode spaces; never include secrets in paths or query parameters.
    #[schemars(length(min = 1, max = 4096))]
    pub url: String,
}

impl Explanation {
    pub(crate) fn validate_links(&self) -> Result<(), String> {
        if self.links.len() > 50 {
            return Err("explanation links exceeds limit of 50".into());
        }
        for (index, link) in self.links.iter().enumerate() {
            if link.label.trim().is_empty() {
                return Err(format!("explanation link {index}: label must not be blank"));
            }
            if link.url.len() > 4096 {
                return Err(format!("explanation link {index}: URL exceeds 4096 bytes"));
            }
            let invalid = || {
                format!(
                    "explanation link {index}: URL must be absolute HTTP/HTTPS with a host and no credentials, whitespace, control characters, or backslashes"
                )
            };
            if link.url.chars().any(|character| {
                character.is_whitespace() || character.is_control() || character == '\\'
            }) {
                return Err(invalid());
            }
            let url = Url::parse(&link.url).map_err(|_| invalid())?;
            let prefix = format!("{}://", url.scheme());
            if !matches!(url.scheme(), "http" | "https")
                || !link.url.to_ascii_lowercase().starts_with(&prefix)
                || link.url[prefix.len()..].starts_with('/')
                || !url.has_host()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
