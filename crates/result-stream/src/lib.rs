//! Bounded in-memory row store (Phase 1, virtualized grid backend).
//!
//! Query rows stream into a `RowStore` on the Rust side; the WebView never
//! receives more than one visible window at a time. Storage is capped: rows
//! beyond `capacity` are counted but not kept, and the store reports itself
//! truncated so the UI can say "showing first N of M".

/// A bounded, append-only store of rows of type `T`.
pub struct RowStore<T> {
    rows: Vec<T>,
    capacity: usize,
    total_seen: u64,
}

impl<T> RowStore<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            rows: Vec::new(),
            capacity,
            total_seen: 0,
        }
    }

    /// Appends a row if under capacity; always counts it.
    /// Returns true when the row was stored.
    pub fn push(&mut self, row: T) -> bool {
        self.total_seen += 1;
        if self.rows.len() < self.capacity {
            self.rows.push(row);
            true
        } else {
            false
        }
    }

    /// Rows actually stored (<= capacity).
    pub fn stored(&self) -> usize {
        self.rows.len()
    }

    /// Rows seen from the stream, including dropped ones.
    pub fn total_seen(&self) -> u64 {
        self.total_seen
    }

    /// True when at least one row was counted but not stored.
    pub fn truncated(&self) -> bool {
        self.total_seen > self.rows.len() as u64
    }

    /// A window of stored rows, clamped to bounds. Out-of-range offsets
    /// yield an empty slice rather than an error.
    pub fn window(&self, offset: usize, len: usize) -> &[T] {
        let start = offset.min(self.rows.len());
        let end = offset.saturating_add(len).min(self.rows.len());
        &self.rows[start..end]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_up_to_capacity_and_counts_overflow() {
        let mut store = RowStore::new(3);
        for i in 0..5 {
            let stored = store.push(i);
            assert_eq!(stored, i < 3);
        }
        assert_eq!(store.stored(), 3);
        assert_eq!(store.total_seen(), 5);
        assert!(store.truncated());
    }

    #[test]
    fn not_truncated_when_under_capacity() {
        let mut store = RowStore::new(10);
        store.push(1);
        store.push(2);
        assert!(!store.truncated());
        assert_eq!(store.total_seen(), 2);
    }

    #[test]
    fn window_clamps_to_bounds() {
        let mut store = RowStore::new(100);
        for i in 0..10 {
            store.push(i);
        }
        assert_eq!(store.window(0, 3), &[0, 1, 2]);
        assert_eq!(store.window(8, 5), &[8, 9]);
        assert_eq!(store.window(10, 5), &[] as &[i32]);
        assert_eq!(store.window(999, 5), &[] as &[i32]);
        // Offset + len overflow must not panic.
        assert_eq!(store.window(usize::MAX, usize::MAX), &[] as &[i32]);
    }

    #[test]
    fn zero_capacity_counts_everything_stores_nothing() {
        let mut store = RowStore::new(0);
        assert!(!store.push(42));
        assert_eq!(store.stored(), 0);
        assert_eq!(store.total_seen(), 1);
        assert!(store.truncated());
    }
}
