//! How the MCP server reaches a database: a seam, so the policy in
//! `server.rs` can be tested without one.

use async_trait::async_trait;
use tuplenest_credential_store::Secret;
use tuplenest_driver_api::{
    BatchSink, ConnectionConfig, DatabaseSession, DriverError, ExecutionSummary, QueryRequest,
};
use tuplenest_driver_postgres::{PostgresDriver, PostgresSession};

use crate::pg::SshParams;

/// Everything needed to open one session. Built by the server from a saved
/// profile and the keychain; the policy (`config.read_only`) is decided there.
pub struct OpenTarget {
    pub config: ConnectionConfig,
    pub password: Option<Secret>,
    /// The profile's SSH hop and its key's passphrase, if it has one.
    pub ssh: Option<(SshParams, Option<String>)>,
}

/// One open database session.
#[async_trait]
pub trait Session: Send {
    async fn execute(
        &mut self,
        request: QueryRequest,
        sink: &dyn BatchSink,
    ) -> Result<ExecutionSummary, Box<DriverError>>;
}

#[async_trait]
pub trait Connector: Send + Sync {
    async fn open(&self, target: OpenTarget) -> Result<Box<dyn Session>, String>;
}

/// The real thing: the same driver, read-only enforcement and SSH tunnel the
/// app's own `pg_connect` uses.
pub struct PostgresConnector;

struct PgSession {
    session: PostgresSession,
    /// Dropping the tunnel closes it, so it lives as long as the session.
    _tunnel: Option<tuplenest_ssh_core::SshTunnel>,
}

#[async_trait]
impl Session for PgSession {
    async fn execute(
        &mut self,
        request: QueryRequest,
        sink: &dyn BatchSink,
    ) -> Result<ExecutionSummary, Box<DriverError>> {
        self.session.execute(request, sink).await
    }
}

#[async_trait]
impl Connector for PostgresConnector {
    async fn open(&self, target: OpenTarget) -> Result<Box<dyn Session>, String> {
        let OpenTarget {
            mut config,
            password,
            ssh,
        } = target;
        let tunnel = match ssh {
            Some((ssh, passphrase)) => {
                let tunnel = tuplenest_ssh_core::open_tunnel(ssh.tunnel_config(
                    &config.host,
                    config.port,
                    passphrase,
                ))
                .await
                .map_err(|e| format!("SSH tunnel: {e}"))?;
                config.host = "127.0.0.1".into();
                config.port = tunnel.local_port();
                Some(tunnel)
            }
            None => None,
        };
        let session = PostgresDriver
            .connect_concrete_with_password(config, password.as_ref().map(|s| s.expose()))
            .await
            .map_err(|e| crate::pg::err_to_string(&e))?;
        Ok(Box::new(PgSession {
            session,
            _tunnel: tunnel,
        }))
    }
}
