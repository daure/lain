use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Minimum and maximum number of related instances at a relationship endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Cardinality {
    ZeroOrOne,
    ExactlyOne,
    ZeroOrMore,
    OneOrMore,
    // Stored maximum-only endpoints normalize to a zero minimum on reads.
    #[schemars(skip)]
    One,
    #[schemars(skip)]
    Many,
}

impl Cardinality {
    pub(crate) fn explicit(self) -> Self {
        match self {
            Self::One => Self::ZeroOrOne,
            Self::Many => Self::ZeroOrMore,
            explicit => explicit,
        }
    }

    pub(crate) fn is_explicit(self) -> bool {
        !matches!(self, Self::One | Self::Many)
    }

    pub(crate) fn is_single(self) -> bool {
        matches!(self, Self::ZeroOrOne | Self::ExactlyOne | Self::One)
    }

    pub(crate) fn is_required(self) -> bool {
        matches!(self, Self::ExactlyOne | Self::OneOrMore)
    }
}
