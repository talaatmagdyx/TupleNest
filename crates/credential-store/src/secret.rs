//! In-memory secret wrapper: redacted Debug, zeroed on drop.
//!
//! ## What this does and does not buy you
//!
//! What it does: keeps a password out of `Debug` output and out of IPC, and
//! wipes *this* buffer when it drops.
//!
//! What it does not do: guarantee the password is gone from the process. A
//! `Secret` can only wipe the one allocation it owns, and by the time it holds
//! the value, copies exist that it will never see:
//!
//! - **`tokio_postgres::Config`** takes the password as `&str` and copies it
//!   into its own storage (see `pg.rs`, which calls `expose()`). That copy
//!   lives as long as the connection and is not wiped when it drops.
//! - **The `keyring` crate** builds a `String` from an OS buffer in
//!   `get_password()`. `Secret::new` moves that `String` rather than copying
//!   it, so the final allocation is covered — but keyring's intermediate
//!   buffers are not ours to wipe.
//! - **The OS.** A page holding any of the above can be swapped to disk or
//!   captured in a core dump before any wipe runs. Nothing at this layer helps.
//!
//! So the honest threat model is narrow: this reduces the *window* in which a
//! password sits in freed heap memory, and it makes an accidental `{:?}` safe.
//! It is not a defence against an attacker who can read this process's memory —
//! against that, the keychain is the control that matters, and once a password
//! is in a `tokio_postgres::Config` it is readable regardless.
//!
//! ### Why not the `zeroize` crate
//!
//! It would compile to what `Drop` below already does — volatile writes plus a
//! fence — and would not touch any of the copies above, which are the actual
//! gap. It would make the file *look* more rigorous without changing what an
//! attacker can read. Reconsider if `Secret` ever holds something structured
//! (a key, a `Vec<u8>` that reallocates), where hand-rolling gets easy to get
//! wrong.

/// A secret value held in memory as briefly as possible.
///
/// - `Debug` prints `Secret(<redacted>)`.
/// - No `Display`, no `Serialize`/`Deserialize` — it cannot cross IPC.
/// - The buffer is overwritten with zeroes on drop — **this allocation only**;
///   see the module docs for the copies that outlive it.
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
