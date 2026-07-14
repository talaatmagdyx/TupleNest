//! Contract tests every CredentialStore backend must pass, run here against
//! MemoryStore, plus a live OS-keychain round-trip (macOS/Windows/Linux).

use tuplenest_credential_store::{CredentialError, CredentialStore, MemoryStore, Secret};

fn contract(store: &dyn CredentialStore) {
    // set -> get round-trip
    let r = store.set(Secret::new("p@ssw0rd-1")).unwrap();
    assert!(r.key().starts_with("tn-secret-"), "opaque namespaced ref");
    assert_eq!(store.get(&r).unwrap().expose(), "p@ssw0rd-1");

    // replace overwrites in place
    store.replace(&r, Secret::new("p@ssw0rd-2")).unwrap();
    assert_eq!(store.get(&r).unwrap().expose(), "p@ssw0rd-2");

    // two sets produce distinct refs
    let r2 = store.set(Secret::new("other")).unwrap();
    assert_ne!(r.key(), r2.key());

    // delete is effective and idempotent
    store.delete(&r).unwrap();
    store.delete(&r).unwrap();
    assert!(matches!(store.get(&r), Err(CredentialError::NotFound(_))));
    store.delete(&r2).unwrap();
}

#[test]
fn memory_store_contract() {
    contract(&MemoryStore::new());
}

#[test]
fn refs_serialize_but_secrets_do_not_leak_via_debug() {
    let store = MemoryStore::new();
    let r = store.set(Secret::new("SENTINEL_XYZZY")).unwrap();
    // SecretRef Debug is redacted; Secret Debug is redacted.
    let dbg_ref = format!("{r:?}");
    let dbg_secret = format!("{:?}", store.get(&r).unwrap());
    assert!(!dbg_ref.contains("SENTINEL_XYZZY"));
    assert!(!dbg_secret.contains("SENTINEL_XYZZY"));
    assert_eq!(dbg_secret, "Secret(<redacted>)");
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[test]
fn live_os_keychain_contract() {
    use tuplenest_credential_store::KeychainStore;
    // Separate service name so test entries never mix with real app secrets.
    let store = KeychainStore::with_service("app.tuplenest.desktop.test");
    contract(&store);
}
