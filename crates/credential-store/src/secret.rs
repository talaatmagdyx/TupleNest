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
//!   into its own `Vec<u8>`. That copy is **short-lived** — `pg_config` builds
//!   the `Config` as a local, `connect` borrows it, and it drops when the call
//!   returns. Nothing retains it: `tokio_postgres::Client` holds
//!   `socket_config`, `ssl_mode`, `process_id` and `secret_key`, and no
//!   password; within the crate the word appears only in `config.rs` and
//!   `connect_raw.rs`, which uses it to authenticate and does not keep it. But
//!   `Config` has no `Drop` that wipes, so the bytes are left in freed heap.
//! - **`connect_raw`'s authentication buffers** (SCRAM/md5 intermediates) are
//!   likewise not wiped, and are not reachable from here.
//! - **The `keyring` crate** builds a `String` from an OS buffer in
//!   `get_password()`. `Secret::new` moves that `String` rather than copying
//!   it, so the final allocation is covered — but keyring's intermediate
//!   buffers are not ours to wipe.
//! - **The OS.** A page holding any of the above can be swapped to disk or
//!   captured in a core dump before any wipe runs. Nothing at this layer helps.
//!
//! So the honest threat model is narrow: this shortens the *window* in which a
//! password sits in freed heap, and it makes an accidental `{:?}` safe. It is
//! not a defence against an attacker who can read this process's memory. The
//! keychain is the control that matters.
//!
//! An earlier version of this note claimed the `Config` copy "lives as long as
//! the connection". That was written without reading `tokio_postgres`, and it
//! is wrong — the copy dies with the `connect` call. The residue is real but
//! brief, and overstating it was its own kind of inaccuracy: a threat model
//! that exaggerates is as hard to act on as one that reassures.
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
