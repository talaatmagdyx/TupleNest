//! Hand freed heap memory back to the operating system.
//!
//! Dropping a large result frees it inside the allocator, but the allocator
//! keeps the pages for reuse, so the app's footprint stays at its high-water
//! mark until something else needs them. A database client holds one big
//! result at a time and then sits idle, which is exactly the case where those
//! pages should go back.
//!
//! What this does is *ask*. Whether the allocator complies is its decision,
//! and the one measurement taken so far says not much: in a test harness on
//! macOS (audit of 2026-11-24, finding TN-017) the footprint after dropping a
//! result and calling this was within a couple of megabytes of what it was
//! while holding it. Peak memory is bounded by the result caps, not by this
//! call. It stays because it is cheap and correct to ask; it is not a
//! guarantee that memory returns.

/// Return free heap pages to the OS. Cheap when there is little to return;
/// call it after dropping something large, not in a loop.
pub fn release_free_memory() {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            // <malloc/malloc.h>: a null zone means every zone; goal 0 means
            // release as much as possible.
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        // SAFETY: documented libSystem call; takes no pointers we own.
        unsafe {
            malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
        }
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        extern "C" {
            fn malloc_trim(pad: usize) -> std::ffi::c_int;
        }
        // SAFETY: glibc call with no pointer arguments.
        unsafe {
            malloc_trim(0);
        }
    }
    // ponytail: Windows' process heap decommits free pages on its own; add
    // HeapCompact here if measurements ever show it holding on to them.
}

#[cfg(test)]
mod tests {
    #[test]
    fn releasing_after_a_large_drop_is_safe_to_call_repeatedly() {
        let big = vec![1u8; 64 * 1024 * 1024];
        drop(std::hint::black_box(big));
        super::release_free_memory();
        super::release_free_memory();
    }
}
