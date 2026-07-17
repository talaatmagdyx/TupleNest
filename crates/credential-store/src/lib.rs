//! TupleNest credential store (Phase 0, E0.6).
//!
//! Invariants (see docs/phase-0-plan.md):
//! - Secrets live ONLY in the OS keychain. SQLite, logs, IPC payloads, and
//!   frontend state hold opaque [`SecretRef`] keys, never values.
//! - `get` is never exposed over IPC; only backend crates resolve references.
//! - [`Secret`] redacts its Debug output and zeroes its own buffer on drop.
//!   That last part is narrower than it sounds — the driver's connection config
//!   makes a brief copy `Secret` cannot reach. See the `secret` module docs for
//!   what is and is not covered before relying on it.

use tuplenest_driver_api::SecretRef;
use uuid::Uuid;

mod secret;
pub use secret::Secret;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
mod keychain;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub use keychain::KeychainStore;

#[cfg(feature = "test-support")]
mod memory;
#[cfg(feature = "test-support")]
pub use memory::MemoryStore;

/// Errors surfaced by credential stores. Never contains secret material.
#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("secret not found for reference `{0}`")]
    NotFound(String),
    #[error("keychain backend unavailable: {0}")]
    BackendUnavailable(String),
    #[error("keychain operation failed: {0}")]
    Backend(String),
}

/// Backend-agnostic credential store.
///
/// Implementations MUST NOT log, serialize, or otherwise persist secret
/// values outside the underlying secure backend.
pub trait CredentialStore: Send + Sync {
    /// Stores `secret` and returns an opaque reference to it.
    fn set(&self, secret: Secret) -> Result<SecretRef, CredentialError>;

    /// Overwrites the secret behind an existing reference (e.g. password change).
    fn replace(&self, reference: &SecretRef, secret: Secret) -> Result<(), CredentialError>;

    /// Resolves a reference to its secret value. Backend-only; never over IPC.
    fn get(&self, reference: &SecretRef) -> Result<Secret, CredentialError>;

    /// Deletes the secret behind a reference. Idempotent.
    fn delete(&self, reference: &SecretRef) -> Result<(), CredentialError>;
}

pub(crate) fn new_ref() -> SecretRef {
    SecretRef::new(format!("tn-secret-{}", Uuid::new_v4()))
}
