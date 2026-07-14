//! SSH tunnels (Phase 1, E1.2).
//!
//! Opens an SSH session and exposes a local 127.0.0.1 listener; every
//! accepted connection becomes a direct-tcpip channel to the target host
//! as seen from the SSH server. Host key verification fails closed:
//! either a pinned SHA-256 fingerprint matches, or the key must already
//! be present in the user's known_hosts.

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
    #[error("SSH host key rejected: {0}")]
    HostKeyRejected(String),
    #[error("SSH authentication failed for user `{0}`")]
    AuthFailed(String),
    #[error("SSH error: {0}")]
    Ssh(#[from] russh::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
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
        key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
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

/// Opens the SSH session and starts the local forwarder.
pub async fn open_tunnel(config: SshTunnelConfig) -> Result<SshTunnel, TunnelError> {
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

    let auth_result = match &config.auth {
        SshAuth::KeyFile { path, passphrase } => {
            let key = russh::keys::load_secret_key(path, passphrase.as_deref()).map_err(|e| {
                TunnelError::KeyLoad {
                    path: path.clone(),
                    source: e,
                }
            })?;
            let hash_alg = session.best_supported_rsa_hash().await?.flatten();
            session
                .authenticate_publickey(
                    config.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await?
        }
        SshAuth::Password(password) => {
            session
                .authenticate_password(config.username.clone(), password.clone())
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
