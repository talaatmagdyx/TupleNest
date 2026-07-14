//! Live SSH tunnel tests (E1.2). Require the dev sshd:
//!     ~/.tuplenest-dev-sshd (see docs) listening on 127.0.0.1:2222,
//! plus local PostgreSQL on 5432. Run with `cargo test -- --ignored`.

use russh::keys::HashAlg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tuplenest_ssh_core::{open_tunnel, HostKeyPolicy, SshAuth, SshTunnelConfig, TunnelError};

fn dev_dir() -> String {
    let home = std::env::var("HOME").expect("HOME");
    std::env::var("TUPLENEST_TEST_SSHD_DIR")
        .unwrap_or_else(|_| format!("{home}/.tuplenest-dev-sshd"))
}

fn host_fingerprint() -> String {
    let pub_key = std::fs::read_to_string(format!("{}/host_ed25519.pub", dev_dir()))
        .expect("dev sshd host key — is the local sshd set up?");
    russh::keys::PublicKey::from_openssh(&pub_key)
        .expect("parse host key")
        .fingerprint(HashAlg::Sha256)
        .to_string()
}

fn config(fingerprint: String) -> SshTunnelConfig {
    SshTunnelConfig {
        ssh_host: "127.0.0.1".into(),
        ssh_port: 2222,
        username: std::env::var("USER").expect("USER"),
        auth: SshAuth::KeyFile {
            path: format!("{}/client_ed25519", dev_dir()),
            passphrase: None,
        },
        host_key: HostKeyPolicy::PinnedFingerprint(fingerprint),
        target_host: "localhost".into(),
        target_port: 5432,
    }
}

#[tokio::test]
#[ignore]
async fn tunnel_reaches_postgres_end_to_end() {
    let tunnel = open_tunnel(config(host_fingerprint())).await.unwrap();

    // Speak the PostgreSQL wire protocol through the tunnel: an SSLRequest
    // (len=8, code 80877103) must yield a 1-byte 'S' or 'N' answer from a
    // real server. Proves bytes flow both directions to Postgres itself.
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", tunnel.local_port()))
        .await
        .unwrap();
    let mut request = Vec::new();
    request.extend_from_slice(&8i32.to_be_bytes());
    request.extend_from_slice(&80877103i32.to_be_bytes());
    stream.write_all(&request).await.unwrap();
    let mut answer = [0u8; 1];
    stream.read_exact(&mut answer).await.unwrap();
    assert!(
        answer[0] == b'S' || answer[0] == b'N',
        "unexpected SSLRequest answer: {:?}",
        answer[0]
    );

    // Multiple concurrent connections each get their own channel.
    let mut second = tokio::net::TcpStream::connect(("127.0.0.1", tunnel.local_port()))
        .await
        .unwrap();
    second.write_all(&request).await.unwrap();
    let mut answer2 = [0u8; 1];
    second.read_exact(&mut answer2).await.unwrap();
    assert!(answer2[0] == b'S' || answer2[0] == b'N');

    tunnel.close();
}

#[tokio::test]
#[ignore]
async fn wrong_host_fingerprint_fails_closed() {
    let bad = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string();
    let err = open_tunnel(config(bad)).await.err().expect("must fail");
    assert!(
        matches!(err, TunnelError::HostKeyRejected(_)),
        "expected HostKeyRejected, got: {err}"
    );
}

#[tokio::test]
#[ignore]
async fn unknown_host_key_fails_closed_via_known_hosts_policy() {
    // The dev sshd's key is (almost certainly) not in ~/.ssh/known_hosts
    // under this host/port; the KnownHosts policy must refuse it.
    let mut cfg = config(String::new());
    cfg.host_key = HostKeyPolicy::KnownHosts;
    cfg.ssh_host = "127.0.0.1".into();
    let err = open_tunnel(cfg).await.err().expect("must fail");
    assert!(matches!(err, TunnelError::HostKeyRejected(_)));
}
