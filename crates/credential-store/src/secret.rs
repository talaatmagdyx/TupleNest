//! In-memory secret wrapper: redacted Debug, zeroed on drop.

/// A secret value held in memory as briefly as possible.
///
/// - `Debug` prints `Secret(<redacted>)`.
/// - No `Display`, no `Serialize`/`Deserialize` — it cannot cross IPC.
/// - The buffer is overwritten with zeroes on drop (best-effort).
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Explicit, greppable access point for the raw value.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret(<redacted>)")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // Best-effort zeroization without an extra dependency. `write_volatile`
        // prevents the compiler from eliding the wipe as a dead store.
        unsafe {
            let bytes = self.0.as_bytes_mut();
            for b in bytes.iter_mut() {
                std::ptr::write_volatile(b, 0);
            }
        }
        std::sync::atomic::fence(std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_is_redacted() {
        let s = Secret::new("hunter2");
        assert_eq!(format!("{s:?}"), "Secret(<redacted>)");
    }

    #[test]
    fn expose_returns_value() {
        let s = Secret::new("hunter2");
        assert_eq!(s.expose(), "hunter2");
    }
}
