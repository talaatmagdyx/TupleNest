//! Connection lifecycle (Phase 1, E1.2).
//!
//! Staged reachability probe: DNS resolution, then TCP connect, each with
//! its own timing and pass/fail result. Driver-level stages (TLS, auth,
//! server version) are appended by the caller so the full report reads
//! DNS → TCP → [SSH] → [TLS] → auth → version, per the phase plan.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use tokio::net::{lookup_host, TcpStream};
use tokio::time::timeout;
use tuplenest_driver_api::{TestStage, TestStageStatus};

/// Result of the network-level probe.
pub struct ProbeOutcome {
    pub stages: Vec<TestStage>,
    /// First resolved address, when DNS succeeded.
    pub resolved: Option<SocketAddr>,
    /// True when every executed stage passed.
    pub reachable: bool,
}

fn stage(name: &str, passed: bool, started: Instant, detail: Option<String>) -> TestStage {
    TestStage {
        name: name.into(),
        status: if passed {
            TestStageStatus::Passed
        } else {
            TestStageStatus::Failed
        },
        duration_ms: started.elapsed().as_millis() as u64,
        detail,
    }
}

/// Probes `host:port`: DNS resolution, then a TCP connect (bounded by
/// `per_stage_timeout`). Stops at the first failed stage.
pub async fn probe(host: &str, port: u16, per_stage_timeout: Duration) -> ProbeOutcome {
    let mut stages = Vec::new();

    // Stage 1: DNS.
    let started = Instant::now();
    let addrs = match timeout(per_stage_timeout, lookup_host((host, port))).await {
        Ok(Ok(iter)) => iter.collect::<Vec<_>>(),
        Ok(Err(e)) => {
            stages.push(stage("dns", false, started, Some(e.to_string())));
            return ProbeOutcome {
                stages,
                resolved: None,
                reachable: false,
            };
        }
        Err(_) => {
            stages.push(stage(
                "dns",
                false,
                started,
                Some(format!("timed out after {per_stage_timeout:?}")),
            ));
            return ProbeOutcome {
                stages,
                resolved: None,
                reachable: false,
            };
        }
    };
    let Some(&first) = addrs.first() else {
        stages.push(stage("dns", false, started, Some("no addresses".into())));
        return ProbeOutcome {
            stages,
            resolved: None,
            reachable: false,
        };
    };
    stages.push(stage(
        "dns",
        true,
        started,
        Some(format!("{} address(es), first {}", addrs.len(), first.ip())),
    ));

    // Stage 2: TCP connect to the first address.
    let started = Instant::now();
    let tcp_result = timeout(per_stage_timeout, TcpStream::connect(first)).await;
    match tcp_result {
        Ok(Ok(_stream)) => {
            stages.push(stage("tcp", true, started, Some(first.to_string())));
            ProbeOutcome {
                stages,
                resolved: Some(first),
                reachable: true,
            }
        }
        Ok(Err(e)) => {
            stages.push(stage("tcp", false, started, Some(e.to_string())));
            ProbeOutcome {
                stages,
                resolved: Some(first),
                reachable: false,
            }
        }
        Err(_) => {
            stages.push(stage(
                "tcp",
                false,
                started,
                Some(format!("timed out after {per_stage_timeout:?}")),
            ));
            ProbeOutcome {
                stages,
                resolved: Some(first),
                reachable: false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Duration = Duration::from_secs(3);

    #[tokio::test]
    async fn probe_succeeds_against_local_listener() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let out = probe("127.0.0.1", port, T).await;
        assert!(out.reachable);
        assert_eq!(out.stages.len(), 2);
        assert!(out
            .stages
            .iter()
            .all(|s| s.status == TestStageStatus::Passed));
        assert_eq!(out.resolved.unwrap().port(), port);
    }

    #[tokio::test]
    async fn probe_fails_dns_for_invalid_host() {
        let out = probe("definitely-not-a-real-host.invalid", 5432, T).await;
        assert!(!out.reachable);
        assert_eq!(out.stages.len(), 1, "stops at first failed stage");
        assert_eq!(out.stages[0].name, "dns");
        assert_eq!(out.stages[0].status, TestStageStatus::Failed);
    }

    #[tokio::test]
    async fn probe_fails_tcp_on_closed_port() {
        // Bind then drop to find a port that is (very likely) closed.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let out = probe("127.0.0.1", port, T).await;
        assert!(!out.reachable);
        assert_eq!(out.stages.len(), 2);
        assert_eq!(out.stages[0].status, TestStageStatus::Passed, "dns ok");
        assert_eq!(out.stages[1].name, "tcp");
        assert_eq!(out.stages[1].status, TestStageStatus::Failed);
    }
}
