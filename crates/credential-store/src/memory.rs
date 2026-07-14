//! In-memory store for unit tests and headless CI. NOT for production use.

use std::collections::HashMap;
use std::sync::Mutex;

use tuplenest_driver_api::SecretRef;

use crate::{new_ref, CredentialError, CredentialStore, Secret};

/// Volatile credential store. Secrets vanish with the process.
#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<HashMap<String, String>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl CredentialStore for MemoryStore {
    fn set(&self, secret: Secret) -> Result<SecretRef, CredentialError> {
        let reference = new_ref();
        self.inner
            .lock()
            .expect("memory store poisoned")
            .insert(reference.key().to_string(), secret.expose().to_string());
        Ok(reference)
    }

    fn replace(&self, reference: &SecretRef, secret: Secret) -> Result<(), CredentialError> {
        let mut map = self.inner.lock().expect("memory store poisoned");
        if !map.contains_key(reference.key()) {
            return Err(CredentialError::NotFound(reference.key().to_string()));
        }
        map.insert(reference.key().to_string(), secret.expose().to_string());
        Ok(())
    }

    fn get(&self, reference: &SecretRef) -> Result<Secret, CredentialError> {
        self.inner
            .lock()
            .expect("memory store poisoned")
            .get(reference.key())
            .map(|v| Secret::new(v.clone()))
            .ok_or_else(|| CredentialError::NotFound(reference.key().to_string()))
    }

    fn delete(&self, reference: &SecretRef) -> Result<(), CredentialError> {
        self.inner
            .lock()
            .expect("memory store poisoned")
            .remove(reference.key());
        Ok(())
    }
}
