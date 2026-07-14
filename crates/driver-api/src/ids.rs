//! Opaque identifiers used across the driver boundary.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! id_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            #[allow(clippy::new_without_default)]
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

id_type!(
    /// Identifies a single query execution for status, streaming, and cancellation.
    ExecutionId
);
id_type!(
    /// Identifies an open transaction on a session.
    TransactionId
);
id_type!(
    /// Identifies a stored connection profile.
    ConnectionId
);
id_type!(
    /// Identifies a live database session.
    SessionId
);

/// An opaque reference to a secret stored in the OS keychain.
///
/// The referenced value is only ever resolved inside backend crates.
/// This type deliberately does not implement `Display` for the inner value
/// and its `Debug` output is redacted.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SecretRef(String);

impl SecretRef {
    pub fn new(reference: impl Into<String>) -> Self {
        Self(reference.into())
    }

    /// The opaque reference key (NOT the secret value).
    pub fn key(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretRef(<redacted>)")
    }
}
