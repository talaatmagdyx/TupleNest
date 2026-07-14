//! OS keychain-backed store (macOS Keychain / Windows Credential Manager /
//! Linux Secret Service) via the `keyring` crate.

use tuplenest_driver_api::SecretRef;

use crate::{new_ref, CredentialError, CredentialStore, Secret};

const SERVICE: &str = "app.tuplenest.desktop";

/// Production credential store backed by the OS keychain.
///
/// Each secret is a keychain entry: service = `app.tuplenest.desktop`,
/// account = the opaque `SecretRef` key. The SQLite workspace store only
/// ever sees the reference.
pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    pub fn new() -> Self {
        Self {
            service: SERVICE.to_string(),
        }
    }

    /// Store under a custom service name (used by tests to avoid
    /// polluting the real app namespace).
    pub fn with_service(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(&self.service, key)
            .map_err(|e| CredentialError::BackendUnavailable(e.to_string()))
    }
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStore for KeychainStore {
    fn set(&self, secret: Secret) -> Result<SecretRef, CredentialError> {
        let reference = new_ref();
        self.entry(reference.key())?
            .set_password(secret.expose())
            .map_err(|e| CredentialError::Backend(e.to_string()))?;
        Ok(reference)
    }

    fn replace(&self, reference: &SecretRef, secret: Secret) -> Result<(), CredentialError> {
        self.entry(reference.key())?
            .set_password(secret.expose())
            .map_err(|e| CredentialError::Backend(e.to_string()))
    }

    fn get(&self, reference: &SecretRef) -> Result<Secret, CredentialError> {
        match self.entry(reference.key())?.get_password() {
            Ok(value) => Ok(Secret::new(value)),
            Err(keyring::Error::NoEntry) => {
                Err(CredentialError::NotFound(reference.key().to_string()))
            }
            Err(e) => Err(CredentialError::Backend(e.to_string())),
        }
    }

    fn delete(&self, reference: &SecretRef) -> Result<(), CredentialError> {
        match self.entry(reference.key())?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CredentialError::Backend(e.to_string())),
        }
    }
}
