//! SSH tunnels (Phase 1, E1.2).
//!
//! Opens an SSH session and exposes a local 127.0.0.1 listener; every
//! accepted connection becomes a direct-tcpip channel to the target host
//! as seen from the SSH server. Host key verification fails closed:
//! either a pinned SHA-256 fingerprint matches, or the key must already
//! be present in the user's known_hosts.
//!
//! Key files may be passphrase-protected (OpenSSH, PKCS#5/PKCS#8 PEM and
//! PuTTY formats). The caller resolves the passphrase from the credential
//! store; a key that needs one and has none, or has the wrong one, fails at
//! once with its own error, before any network traffic.

use std::sync::Arc;

use russh::client::{self, AuthResult};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

#[derive(Debug, thiserror::Error)]
pub enum TunnelError {
    #[error("cannot load SSH key {path}: {source}")]
    KeyLoad {
        path: String,
        source: russh::keys::Error,
    },
    /// The key file is encrypted and no passphrase was given.
    #[error(
        "the SSH key {path} is protected by a passphrase. Enter it in the connection's SSH settings"
    )]
    KeyEncrypted { path: String },
    /// A passphrase was given and it does not decrypt the key.
    #[error("the passphrase for the SSH key {path} is wrong")]
    WrongPassphrase { path: String },
    #[error("SSH host key rejected: {0}")]
    HostKeyRejected(String),
    #[error("SSH authentication failed for user `{0}`")]
    AuthFailed(String),
    #[error("SSH error: {0}")]
    Ssh(#[from] russh::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("the SSH server at {host}:{port} did not finish connecting within {seconds} seconds")]
    Timeout {
        host: String,
        port: u16,
        seconds: u64,
    },
}

/// How to authenticate to the SSH server. Passwords/passphrases are
/// resolved by the caller (from the credential store) — never stored here.
pub enum SshAuth {
    KeyFile {
        path: String,
        passphrase: Option<String>,
    },
    Password(String),
}

/// Host key trust policy. There is deliberately no "accept anything".
pub enum HostKeyPolicy {
    /// Exact SHA-256 fingerprint, with or without the `SHA256:` prefix.
    PinnedFingerprint(String),
    /// Key must already be in the default known_hosts. Unknown fails closed.
    KnownHosts,
}

pub struct SshTunnelConfig {
    pub ssh_host: String,
    pub ssh_port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub host_key: HostKeyPolicy,
    /// Target as resolved from the SSH server (e.g. `localhost:5432`).
    pub target_host: String,
    pub target_port: u16,
}

/// A live tunnel. Dropping it (or calling [`SshTunnel::close`]) stops the
/// accept loop and closes the SSH session.
pub struct SshTunnel {
    local_port: u16,
    shutdown: watch::Sender<bool>,
}

impl SshTunnel {
    /// Local endpoint to point the database driver at: `127.0.0.1:port`.
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    pub fn close(&self) {
        let _ = self.shutdown.send(true);
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

struct HostKeyChecker {
    policy: HostKeyPolicy,
    ssh_host: String,
    ssh_port: u16,
}

impl client::Handler for HostKeyChecker {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // ponytail: host certificates fail closed — nothing here checks a CA,
        // so trusting one would skip verification. Add @cert-authority support
        // if someone needs cert-signed bastions.
        let russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Ok(false);
        };
        match &self.policy {
            HostKeyPolicy::PinnedFingerprint(expected) => {
                let actual = key.fingerprint(HashAlg::Sha256).to_string();
                let expected_norm = if expected.starts_with("SHA256:") {
                    expected.clone()
                } else {
                    format!("SHA256:{expected}")
                };
                Ok(actual == expected_norm)
            }
            HostKeyPolicy::KnownHosts => {
                match russh::keys::check_known_hosts(&self.ssh_host, self.ssh_port, key) {
                    Ok(known) => Ok(known),
                    Err(_) => Ok(false), // fail closed on mismatch/parse errors
                }
            }
        }
    }
}

/// Does the private key file at `path` need a passphrase?
///
/// Reads the file but runs no KDF, so it is quick even for a key with many
/// bcrypt rounds.
pub fn key_is_encrypted(path: &str) -> Result<bool, TunnelError> {
    let text = read_key(path)?;
    match russh::keys::decode_secret_key(&text, None) {
        Ok(_) => Ok(false),
        Err(e) if is_encrypted(&text, &e) => Ok(true),
        Err(e) => Err(TunnelError::KeyLoad {
            path: path.to_string(),
            source: e,
        }),
    }
}

/// Loads a private key, decrypting it with `passphrase` when it is encrypted.
/// An empty passphrase counts as none.
pub fn load_key(
    path: &str,
    passphrase: Option<&str>,
) -> Result<russh::keys::PrivateKey, TunnelError> {
    decode_key(path, &read_key(path)?, passphrase)
}

fn read_key(path: &str) -> Result<String, TunnelError> {
    std::fs::read_to_string(path).map_err(|e| TunnelError::KeyLoad {
        path: path.to_string(),
        source: e.into(),
    })
}

fn decode_key(
    path: &str,
    text: &str,
    passphrase: Option<&str>,
) -> Result<russh::keys::PrivateKey, TunnelError> {
    let passphrase = passphrase.filter(|p| !p.is_empty());
    // Without a passphrase first: that tells an encrypted key from a broken
    // one, so a damaged file is never reported as a wrong passphrase.
    match russh::keys::decode_secret_key(text, None) {
        Ok(key) => Ok(key),
        Err(e) if is_encrypted(text, &e) => match passphrase {
            None => Err(TunnelError::KeyEncrypted {
                path: path.to_string(),
            }),
            // Whatever the format's own failure is (a checkint mismatch, bad
            // padding, a MAC), the key is known to be encrypted: the
            // passphrase did not open it.
            Some(p) => russh::keys::decode_secret_key(text, Some(p)).map_err(|_| {
                TunnelError::WrongPassphrase {
                    path: path.to_string(),
                }
            }),
        },
        Err(e) => Err(TunnelError::KeyLoad {
            path: path.to_string(),
            source: e,
        }),
    }
}

/// Did decoding without a passphrase fail because the key is encrypted?
///
/// OpenSSH and PKCS#5 keys say so (`KeyIsEncrypted`); an encrypted PKCS#8 or
/// PuTTY key fails with a format error instead, so their headers are checked.
fn is_encrypted(text: &str, err: &russh::keys::Error) -> bool {
    if matches!(
        err,
        russh::keys::Error::KeyIsEncrypted
            | russh::keys::Error::SshKey(russh::keys::ssh_key::Error::Encrypted)
    ) {
        return true;
    }
    text.lines().any(|l| {
        let l = l.trim();
        l == "-----BEGIN ENCRYPTED PRIVATE KEY-----"
            || l == "Proc-Type: 4,ENCRYPTED"
            || (l.starts_with("Encryption:") && l != "Encryption: none")
    })
}

/// How long the SSH handshake and authentication may take together.
///
/// There was no limit. A host that accepts the TCP connection and then says
/// nothing — a firewall tarpit, the wrong port, a half-dead bastion — left
/// Connect waiting forever, with no way to cancel it. The PostgreSQL side has
/// had a 15 second connect timeout all along; a tunnel adds one more hop.
const OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Opens the SSH session and starts the local forwarder.
pub async fn open_tunnel(config: SshTunnelConfig) -> Result<SshTunnel, TunnelError> {
    open_tunnel_within(config, OPEN_TIMEOUT).await
}

async fn open_tunnel_within(
    config: SshTunnelConfig,
    limit: std::time::Duration,
) -> Result<SshTunnel, TunnelError> {
    let (host, port) = (config.ssh_host.clone(), config.ssh_port);
    // Dropping the future on timeout drops the half-open session with it.
    match tokio::time::timeout(limit, open_tunnel_unbounded(config)).await {
        Ok(result) => result,
        Err(_) => Err(TunnelError::Timeout {
            host,
            port,
            seconds: limit.as_secs(),
        }),
    }
}

async fn open_tunnel_unbounded(config: SshTunnelConfig) -> Result<SshTunnel, TunnelError> {
    // The key first: a missing file, an encrypted key with no passphrase and
    // a wrong passphrase are local problems, and are reported as such before
    // anything is sent to the server. A file read plus, for an encrypted key,
    // a deliberately slow KDF: blocking work, so it runs off the async workers.
    enum Credential {
        Key(Arc<russh::keys::PrivateKey>),
        Password(String),
    }
    let credential = match &config.auth {
        SshAuth::KeyFile { path, passphrase } => {
            let (key_path, key_pass) = (path.clone(), passphrase.clone());
            let key = tokio::task::spawn_blocking(move || load_key(&key_path, key_pass.as_deref()))
                .await
                .map_err(|e| TunnelError::Io(std::io::Error::other(e)))??;
            Credential::Key(Arc::new(key))
        }
        SshAuth::Password(password) => Credential::Password(password.clone()),
    };

    let checker = HostKeyChecker {
        policy: config.host_key,
        ssh_host: config.ssh_host.clone(),
        ssh_port: config.ssh_port,
    };
    let ssh_config = Arc::new(client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });

    let mut session = client::connect(
        ssh_config,
        (config.ssh_host.as_str(), config.ssh_port),
        checker,
    )
    .await
    .map_err(|e| match e {
        russh::Error::UnknownKey => TunnelError::HostKeyRejected(
            "server key does not match the pinned fingerprint / known_hosts".into(),
        ),
        other => TunnelError::Ssh(other),
    })?;

    let auth_result = match credential {
        Credential::Key(key) => {
            let hash_alg = session.best_supported_rsa_hash().await?.flatten();
            session
                .authenticate_publickey(
                    config.username.clone(),
                    PrivateKeyWithHashAlg::new(key, hash_alg),
                )
                .await?
        }
        Credential::Password(password) => {
            session
                .authenticate_password(config.username.clone(), password)
                .await?
        }
    };
    if !matches!(auth_result, AuthResult::Success) {
        return Err(TunnelError::AuthFailed(config.username));
    }

    // Local listener on an ephemeral port.
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    let target_host = config.target_host.clone();
    let target_port = config.target_port;

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                accepted = listener.accept() => {
                    let Ok((local_stream, _)) = accepted else { break };
                    match session
                        .channel_open_direct_tcpip(
                            target_host.clone(),
                            target_port as u32,
                            "127.0.0.1",
                            local_port as u32,
                        )
                        .await
                    {
                        Ok(channel) => {
                            tokio::spawn(pipe(local_stream, channel));
                        }
                        Err(e) => {
                            tracing::warn!(component = "ssh", error = %e, "direct-tcpip open failed");
                        }
                    }
                }
            }
        }
        let _ = session
            .disconnect(russh::Disconnect::ByApplication, "tunnel closed", "en")
            .await;
    });

    Ok(SshTunnel {
        local_port,
        shutdown: shutdown_tx,
    })
}

async fn pipe(mut local: TcpStream, channel: russh::Channel<client::Msg>) {
    let mut remote = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
}

#[cfg(test)]
mod open_timeout_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn config_for(port: u16) -> SshTunnelConfig {
        SshTunnelConfig {
            ssh_host: "127.0.0.1".into(),
            ssh_port: port,
            username: "nobody".into(),
            auth: SshAuth::Password("unused".into()),
            host_key: HostKeyPolicy::KnownHosts,
            target_host: "127.0.0.1".into(),
            target_port: 5432,
        }
    }

    /// Audit TN-016. A peer that accepts the connection and never speaks used
    /// to hold `open_tunnel` open indefinitely.
    #[tokio::test]
    async fn a_silent_server_is_given_up_on() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accept and hold the socket open without sending a byte.
        let held = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(socket);
        });

        let started = Instant::now();
        let err = open_tunnel_within(config_for(port), Duration::from_millis(300))
            .await
            .err()
            .expect("a silent server is not a tunnel");
        assert!(
            matches!(&err, TunnelError::Timeout { host, port: p, .. } if host == "127.0.0.1" && *p == port),
            "{err}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert!(
            err.to_string().contains("did not finish connecting"),
            "{err}"
        );
        held.abort();
    }

    /// The limit must not turn an ordinary failure into a timeout: a refused
    /// connection is reported as itself, at once.
    #[tokio::test]
    async fn a_refused_connection_is_still_reported_as_refused() {
        // Bind to learn a free port, then close it so nothing is listening.
        let port = {
            let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            l.local_addr().unwrap().port()
        };
        let started = Instant::now();
        let err = open_tunnel_within(config_for(port), Duration::from_secs(10))
            .await
            .err()
            .expect("nothing is listening");
        assert!(!matches!(err, TunnelError::Timeout { .. }), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn the_limit_is_longer_than_the_postgres_connect_timeout() {
        assert!(OPEN_TIMEOUT >= Duration::from_secs(15));
    }

    /// Phase 2 safety verification, TN-016: `open_tunnel`, the entry point
    /// the app and the MCP server call, gives up on a silent server within a
    /// bounded time. The test above shows the limit is applied; this one
    /// that the limit the app uses is one a person would wait for.
    #[test]
    fn the_limit_the_app_uses_is_bounded() {
        assert!(OPEN_TIMEOUT <= Duration::from_secs(30), "{OPEN_TIMEOUT:?}");
    }
}

/// Passphrase-protected keys. Every key here is generated in the test from a
/// fixed seed and exists only in a temporary file: TEST-ONLY, never a real key.
#[cfg(test)]
mod key_passphrase_tests {
    use super::*;
    use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
    use russh::keys::ssh_key::{Cipher, Kdf, LineEnding, PrivateKey};
    use std::io::Write;
    use std::time::{Duration, Instant};

    const PASSPHRASE: &str = "correct horse battery staple";

    fn plain_key() -> PrivateKey {
        let pair = Ed25519Keypair::from_seed(&[7u8; 32]);
        PrivateKey::new(KeypairData::Ed25519(pair), "tuplenest-test-only").unwrap()
    }

    /// OpenSSH format, bcrypt KDF, AES-256-CTR: what `ssh-keygen -N` writes.
    fn encrypted_openssh() -> String {
        plain_key()
            .encrypt_with(
                Cipher::Aes256Ctr,
                Kdf::Bcrypt {
                    salt: vec![1u8; 16],
                    rounds: 16,
                },
                0x5eed_5eed,
                PASSPHRASE,
            )
            .unwrap()
            .to_openssh(LineEnding::LF)
            .unwrap()
            .to_string()
    }

    fn file_with(text: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(text.as_bytes()).unwrap();
        f
    }

    fn path(f: &tempfile::NamedTempFile) -> String {
        f.path().to_str().unwrap().to_string()
    }

    #[test]
    fn an_encrypted_key_is_detected_as_such() {
        let enc = file_with(&encrypted_openssh());
        assert!(key_is_encrypted(&path(&enc)).unwrap());
        let plain = file_with(&plain_key().to_openssh(LineEnding::LF).unwrap());
        assert!(!key_is_encrypted(&path(&plain)).unwrap());
    }

    #[test]
    fn the_right_passphrase_opens_the_key() {
        let enc = file_with(&encrypted_openssh());
        let key = load_key(&path(&enc), Some(PASSPHRASE)).unwrap();
        assert_eq!(
            key.public_key().key_data(),
            plain_key().public_key().key_data()
        );
    }

    #[test]
    fn no_passphrase_for_an_encrypted_key_says_one_is_needed() {
        let enc = file_with(&encrypted_openssh());
        for missing in [None, Some("")] {
            let err = load_key(&path(&enc), missing).unwrap_err();
            assert!(matches!(err, TunnelError::KeyEncrypted { .. }), "{err}");
            assert!(
                err.to_string().contains("protected by a passphrase"),
                "{err}"
            );
        }
    }

    #[test]
    fn a_wrong_passphrase_fails_at_once_and_says_so() {
        let enc = file_with(&encrypted_openssh());
        let started = Instant::now();
        let err = load_key(&path(&enc), Some("not it")).unwrap_err();
        assert!(matches!(err, TunnelError::WrongPassphrase { .. }), "{err}");
        assert!(err.to_string().contains("passphrase"), "{err}");
        assert!(err.to_string().contains("is wrong"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_error_never_contains_the_passphrase() {
        let enc = file_with(&encrypted_openssh());
        let err = load_key(&path(&enc), Some("hunter2-secret")).unwrap_err();
        assert!(!err.to_string().contains("hunter2-secret"));
        assert!(!format!("{err:?}").contains("hunter2-secret"));
    }

    #[test]
    fn an_unencrypted_key_ignores_a_passphrase() {
        let plain = file_with(&plain_key().to_openssh(LineEnding::LF).unwrap());
        assert!(load_key(&path(&plain), None).is_ok());
        assert!(load_key(&path(&plain), Some("anything")).is_ok());
    }

    #[test]
    fn a_damaged_key_is_not_reported_as_a_wrong_passphrase() {
        let junk = file_with(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
        );
        let err = load_key(&path(&junk), Some(PASSPHRASE)).unwrap_err();
        assert!(matches!(err, TunnelError::KeyLoad { .. }), "{err}");
    }

    #[test]
    fn an_encrypted_pkcs8_key_is_detected_and_opened() {
        let mut pem = Vec::new();
        russh::keys::encode_pkcs8_pem_encrypted(&plain_key(), PASSPHRASE.as_bytes(), 16, &mut pem)
            .unwrap();
        let enc = file_with(std::str::from_utf8(&pem).unwrap());
        assert!(key_is_encrypted(&path(&enc)).unwrap());
        assert!(matches!(
            load_key(&path(&enc), None).unwrap_err(),
            TunnelError::KeyEncrypted { .. }
        ));
        assert!(matches!(
            load_key(&path(&enc), Some("not it")).unwrap_err(),
            TunnelError::WrongPassphrase { .. }
        ));
        assert!(load_key(&path(&enc), Some(PASSPHRASE)).is_ok());
    }

    /// The key is checked before the network: with nothing listening, a
    /// missing passphrase is still what the tunnel reports.
    #[tokio::test]
    async fn the_tunnel_reports_the_key_problem_before_dialling() {
        let enc = file_with(&encrypted_openssh());
        let port = {
            let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            l.local_addr().unwrap().port()
        };
        let config = |passphrase: Option<&str>| SshTunnelConfig {
            ssh_host: "127.0.0.1".into(),
            ssh_port: port,
            username: "nobody".into(),
            auth: SshAuth::KeyFile {
                path: path(&enc),
                passphrase: passphrase.map(str::to_string),
            },
            host_key: HostKeyPolicy::KnownHosts,
            target_host: "127.0.0.1".into(),
            target_port: 5432,
        };
        let err = open_tunnel(config(None)).await.err().unwrap();
        assert!(matches!(err, TunnelError::KeyEncrypted { .. }), "{err}");
        let err = open_tunnel(config(Some("not it"))).await.err().unwrap();
        assert!(matches!(err, TunnelError::WrongPassphrase { .. }), "{err}");
        // The right one gets as far as the (absent) server.
        let err = open_tunnel(config(Some(PASSPHRASE))).await.err().unwrap();
        assert!(
            matches!(err, TunnelError::Ssh(_) | TunnelError::Io(_)),
            "{err}"
        );
    }
}
