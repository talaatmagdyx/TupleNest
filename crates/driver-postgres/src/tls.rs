//! TLS setup for PostgreSQL connections (Phase 1, E1.2).
//!
//! Modes (driver-api `TlsMode`):
//! - `Disabled`    → plain TCP (local development only)
//! - `Prefer`      → TLS negotiated, certificate NOT verified (discouraged)
//! - `VerifyCa`    → chain verified against roots; hostname **not** checked
//! - `VerifyFull`  → chain + hostname verified. Default; fails closed.
//!
//! Roots = OS trust store, plus `tls_ca_path` PEM file when provided.
//!
//! `VerifyCa` used to be a lie: it built the same verifier as `VerifyFull`,
//! because rustls checks the hostname whenever a real verifier is used, and
//! the module note excused this as "strictly safer". Strictly safer is not the
//! same as what it says on the tin — a mode that silently does something other
//! than its name is a mode you cannot reason about, and "safer" is only true
//! until it refuses a connection the user was told it would allow.
//!
//! It has a real job here, which is why it is now implemented rather than
//! removed: **SSH tunnels**. Through a tunnel the driver dials `127.0.0.1`
//! while the server's certificate names the real host, so `VerifyFull` cannot
//! match and fails. The alternatives were `Prefer` — which verifies nothing at
//! all and would be a real downgrade — or this: prove the certificate chains
//! to a trusted root, and knowingly skip the name, because the name is already
//! established by the SSH host key.

use std::sync::Arc;

// `PemObject` is what replaced the rustls-pemfile crate: rustls-pki-types, which
// is already here under rustls, absorbed the PEM parsing and rustls-pemfile was
// left unmaintained (flagged by `cargo deny check advisories`). Same parser,
// one fewer dependency, and one that is still looked after.
use rustls::pki_types::{pem::PemObject, CertificateDer};
use tokio_postgres_rustls::MakeRustlsConnect;
use tuplenest_driver_api::{ConnectionConfig, DriverError, ErrorCategory, TlsMode};

/// Cheap-to-clone TLS decision, kept on the session for cancel requests
/// (the wire-protocol cancel connection must use the same TLS posture).
#[derive(Clone)]
pub enum TlsSetup {
    None,
    Rustls(Arc<rustls::ClientConfig>),
}

impl std::fmt::Debug for TlsSetup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TlsSetup::None => write!(f, "TlsSetup::None"),
            TlsSetup::Rustls(_) => write!(f, "TlsSetup::Rustls(..)"),
        }
    }
}

impl TlsSetup {
    pub fn make(&self) -> Option<MakeRustlsConnect> {
        match self {
            TlsSetup::None => None,
            TlsSetup::Rustls(cfg) => Some(MakeRustlsConnect::new(cfg.as_ref().clone())),
        }
    }
}

/// Builds the TLS setup for a connection config. Fails closed: any problem
/// loading roots or the CA file is an error, never a silent downgrade.
// DriverError is the crate-wide error type; its size is accepted API-wide.
#[allow(clippy::result_large_err)]
pub fn build(config: &ConnectionConfig) -> Result<TlsSetup, DriverError> {
    match config.tls_mode {
        TlsMode::Disabled => Ok(TlsSetup::None),
        TlsMode::Prefer => {
            let tls_config = rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoVerification::new()))
                .with_no_client_auth();
            Ok(TlsSetup::Rustls(Arc::new(tls_config)))
        }
        TlsMode::VerifyCa => {
            let roots = build_roots(config)?;
            // Delegate the entire chain check to rustls and forgive exactly one
            // error: the name mismatch. Everything else — expiry, an unknown
            // issuer, a bad signature, a cert not valid for server auth — still
            // fails closed. Hand-rolling the chain walk here to "skip the name"
            // would mean reimplementing path building, which is where the bugs
            // live; this borrows all of it and narrows one branch.
            let inner = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
                .build()
                .map_err(|e| {
                    DriverError::new(
                        ErrorCategory::Tls,
                        format!("Cannot build certificate verifier: {e}"),
                    )
                })?;
            let tls_config = rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(CaOnlyVerification { inner }))
                .with_no_client_auth();
            Ok(TlsSetup::Rustls(Arc::new(tls_config)))
        }
        TlsMode::VerifyFull => {
            let roots = build_roots(config)?;
            let tls_config = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            Ok(TlsSetup::Rustls(Arc::new(tls_config)))
        }
    }
}

/// OS trust store plus the caller's CA file. Fails closed: an unreadable or
/// empty CA file is an error, never a silent downgrade to fewer roots.
#[allow(clippy::result_large_err)]
fn build_roots(config: &ConnectionConfig) -> Result<rustls::RootCertStore, DriverError> {
    let mut roots = rustls::RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        // Ignore individual unparseable system certs; an empty store
        // still fails closed below.
        let _ = roots.add(cert);
    }
    if let Some(path) = &config.tls_ca_path {
        /*
         * An unscoped read, deliberately, and outside Tauri's fs ACL —
         * that scope only covers the plugin surface, and this runs
         * Rust-side.
         *
         * It is not a privilege boundary being crossed: the path is one
         * the user typed into their own connection form, read with
         * their own privileges, and a CA certificate can legitimately
         * live anywhere they keep one, so there is no meaningful root
         * to confine it to. The file's bytes never return to the
         * WebView — only "parsed" or "rejected" does — so a
         * hypothetically compromised frontend could not use this to
         * read a file it could not already read.
         */
        let pem = std::fs::read(path).map_err(|e| {
            DriverError::new(
                ErrorCategory::Tls,
                format!("Cannot read CA file {path}: {e}"),
            )
        })?;
        let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(&pem)
            .collect::<Result<_, _>>()
            .map_err(|e| {
                DriverError::new(ErrorCategory::Tls, format!("Invalid CA file {path}: {e}"))
            })?;
        if certs.is_empty() {
            return Err(DriverError::new(
                ErrorCategory::Tls,
                format!("CA file {path} contains no certificates"),
            ));
        }
        for cert in certs {
            roots.add(cert).map_err(|e| {
                DriverError::new(
                    ErrorCategory::Tls,
                    format!("Rejected certificate in {path}: {e}"),
                )
            })?;
        }
    }
    if roots.is_empty() {
        return Err(DriverError::new(
            ErrorCategory::Tls,
            "No trusted root certificates available",
        ));
    }
    Ok(roots)
}

/// Verifier for `VerifyCa`: the full rustls chain check, with the hostname
/// mismatch — and only that — treated as acceptable.
#[derive(Debug)]
struct CaOnlyVerification {
    inner: Arc<rustls::client::WebPkiServerVerifier>,
}

impl rustls::client::danger::ServerCertVerifier for CaOnlyVerification {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        use rustls::client::danger::ServerCertVerified;
        use rustls::CertificateError;

        match self.inner.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Ok(v) => Ok(v),
            // The certificate is trusted and current; it just names a
            // different host. That is precisely what verify-ca means, and
            // both spellings of the error must be caught — rustls added
            // `NotValidForNameContext` alongside the bare variant, and
            // matching only one of them would turn this mode back into
            // verify-full without anyone noticing.
            Err(rustls::Error::InvalidCertificate(CertificateError::NotValidForName))
            | Err(rustls::Error::InvalidCertificate(CertificateError::NotValidForNameContext {
                ..
            })) => Ok(ServerCertVerified::assertion()),
            // Everything else still fails closed: expired, unknown issuer,
            // bad signature, not valid for server auth.
            Err(e) => Err(e),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// Verifier for `Prefer` mode: encrypts the channel but accepts any server
/// certificate. Explicitly marked dangerous; discouraged outside local dev.
#[derive(Debug)]
struct NoVerification {
    schemes: Vec<rustls::SignatureScheme>,
}

impl NoVerification {
    fn new() -> Self {
        Self {
            schemes: rustls::crypto::ring::default_provider()
                .signature_verification_algorithms
                .supported_schemes(),
        }
    }
}

impl rustls::client::danger::ServerCertVerifier for NoVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.schemes.clone()
    }
}

#[cfg(test)]
mod ca_only_tests {
    use super::*;
    use rustls::client::danger::ServerCertVerifier;
    use rustls::pki_types::{ServerName, UnixTime};

    /// A CA and a leaf certificate for `real.example.com`, signed by it.
    fn ca_and_leaf() -> (CertificateDer<'static>, CertificateDer<'static>) {
        let mut ca_params = rcgen::CertificateParams::new(Vec::new()).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let ca_cert = ca_params.self_signed(&ca_key).unwrap();

        let leaf_params =
            rcgen::CertificateParams::new(vec!["real.example.com".to_string()]).unwrap();
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let leaf = leaf_params.signed_by(&leaf_key, &ca_cert, &ca_key).unwrap();

        (ca_cert.der().clone(), leaf.der().clone())
    }

    fn verifier_for(ca: CertificateDer<'static>) -> CaOnlyVerification {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca).unwrap();
        CaOnlyVerification {
            inner: rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
                .build()
                .unwrap(),
        }
    }

    fn name(s: &'static str) -> ServerName<'static> {
        ServerName::try_from(s).unwrap()
    }

    /// The one case that makes verify-ca a distinct mode. It cannot be
    /// produced against the live test server — that certificate names both
    /// `localhost` and `127.0.0.1`, so every address which reaches it matches
    /// — which is exactly why this is built here instead.
    #[test]
    fn accepts_a_trusted_certificate_that_names_a_different_host() {
        let (ca, leaf) = ca_and_leaf();
        let v = verifier_for(ca);
        assert!(
            v.verify_server_cert(&leaf, &[], &name("other.example.com"), &[], UnixTime::now())
                .is_ok(),
            "verify-ca must accept a chain-valid cert whose name does not match"
        );
    }

    /// ...and the check that keeps it honest: verify-full must still refuse
    /// the identical certificate. If this ever passes, the two modes have
    /// collapsed back into one and `VerifyCa` is decorative again.
    #[test]
    fn verify_full_refuses_the_very_same_certificate() {
        let (ca, leaf) = ca_and_leaf();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca).unwrap();
        let full = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
            .build()
            .unwrap();
        let err = full
            .verify_server_cert(&leaf, &[], &name("other.example.com"), &[], UnixTime::now())
            .expect_err("verify-full must refuse a name mismatch");
        assert!(
            matches!(
                err,
                rustls::Error::InvalidCertificate(
                    rustls::CertificateError::NotValidForName
                        | rustls::CertificateError::NotValidForNameContext { .. }
                )
            ),
            "expected a name error, got {err:?}"
        );
    }

    /// verify-ca skips the name, not the chain. An unknown issuer must still
    /// fail closed, or the mode is `Prefer` with a reassuring label.
    #[test]
    fn refuses_a_certificate_from_an_untrusted_issuer() {
        let (_ca, leaf) = ca_and_leaf();
        // A verifier that trusts a *different* CA entirely.
        let (other_ca, _) = ca_and_leaf();
        let v = verifier_for(other_ca);
        assert!(
            v.verify_server_cert(&leaf, &[], &name("real.example.com"), &[], UnixTime::now())
                .is_err(),
            "verify-ca must still refuse a chain it cannot build to a trusted root"
        );
    }

    /// Even the host it *does* name must chain. Belt and braces on the above.
    #[test]
    fn accepts_the_matching_host_when_the_chain_is_good() {
        let (ca, leaf) = ca_and_leaf();
        let v = verifier_for(ca);
        assert!(v
            .verify_server_cert(&leaf, &[], &name("real.example.com"), &[], UnixTime::now())
            .is_ok());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tuplenest_driver_api::{Environment, SecretRef};

    fn cfg(tls_mode: TlsMode, ca: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            driver_id: "postgres".into(),
            name: "t".into(),
            environment: Environment::Dev,
            read_only: false,
            host: "localhost".into(),
            port: 5432,
            database: "postgres".into(),
            username: "u".into(),
            secret_ref: None::<SecretRef>,
            tls_mode,
            tls_ca_path: ca.map(String::from),
            options: BTreeMap::new(),
            default_statement_timeout_ms: 0,
        }
    }

    #[test]
    fn disabled_yields_no_tls() {
        assert!(matches!(
            build(&cfg(TlsMode::Disabled, None)).unwrap(),
            TlsSetup::None
        ));
    }

    #[test]
    fn verify_full_with_missing_ca_file_fails_closed() {
        let err = build(&cfg(TlsMode::VerifyFull, Some("/nonexistent/ca.pem"))).unwrap_err();
        assert!(err.to_string().contains("Cannot read CA file"));
    }

    #[test]
    fn verify_full_with_garbage_ca_file_fails_closed() {
        let dir = std::env::temp_dir().join("tn-tls-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("garbage.pem");
        std::fs::write(&path, "this is not a certificate").unwrap();
        let err = build(&cfg(TlsMode::VerifyFull, path.to_str())).unwrap_err();
        assert!(err.to_string().contains("no certificates"));
    }

    #[test]
    fn verify_full_and_prefer_build_tls_configs() {
        assert!(matches!(
            build(&cfg(TlsMode::VerifyFull, None)).unwrap(),
            TlsSetup::Rustls(_)
        ));
        assert!(matches!(
            build(&cfg(TlsMode::Prefer, None)).unwrap(),
            TlsSetup::Rustls(_)
        ));
    }
}
