//! TLS setup for PostgreSQL connections (Phase 1, E1.2).
//!
//! Modes (driver-api `TlsMode`):
//! - `Disabled`    → plain TCP (local development only)
//! - `Prefer`      → TLS negotiated, certificate NOT verified (discouraged)
//! - `VerifyCa`    → chain verified against roots (hostname too, see note)
//! - `VerifyFull`  → chain + hostname verified. Default; fails closed.
//!
//! Note: rustls always verifies the hostname when a real verifier is used,
//! so `VerifyCa` currently behaves like `VerifyFull` (strictly safer).
//! Roots = OS trust store, plus `tls_ca_path` PEM file when provided.

use std::sync::Arc;

use rustls::pki_types::CertificateDer;
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
        TlsMode::VerifyCa | TlsMode::VerifyFull => {
            let mut roots = rustls::RootCertStore::empty();
            let native = rustls_native_certs::load_native_certs();
            for cert in native.certs {
                // Ignore individual unparseable system certs; an empty store
                // still fails closed below.
                let _ = roots.add(cert);
            }
            if let Some(path) = &config.tls_ca_path {
                let pem = std::fs::read(path).map_err(|e| {
                    DriverError::new(
                        ErrorCategory::Tls,
                        format!("Cannot read CA file {path}: {e}"),
                    )
                })?;
                let certs: Vec<CertificateDer<'_>> = rustls_pemfile::certs(&mut pem.as_slice())
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
            let tls_config = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            Ok(TlsSetup::Rustls(Arc::new(tls_config)))
        }
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
