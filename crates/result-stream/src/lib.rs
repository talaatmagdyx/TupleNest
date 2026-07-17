//! Bounded in-memory row store (Phase 1, virtualized grid backend).
//!
//! Query rows stream into a `RowStore` on the Rust side; the WebView never
//! receives more than one visible window at a time. Storage is capped: rows
//! beyond the cap are counted but not kept, and the store reports itself
//! truncated so the UI can say "showing first N of M".
//!
//! ## Two caps, because rows are not a unit of memory
//!
//! The cap used to be a row count alone, and "bounded memory" was measured in
//! rows: 100,000 of them. A row is not a size. 100,000 rows of a `jsonb`
//! column holding 10 MB documents is a terabyte, and nothing stopped it — the
//! bound was on the wrong axis entirely.
//!
//! So there is also a byte budget, and whichever runs out first stops storage.
//! Rows past either are still counted, so the "of M" total stays true.

/// A bounded, append-only store of rows of type `T`.
///
/// Bounded on two axes: a row count and a byte budget. The caller measures the
/// row, because only it knows what `T` costs.
pub struct RowStore<T> {
    rows: Vec<T>,
    capacity: usize,
    byte_budget: usize,
    bytes: usize,
    total_seen: u64,
}

impl<T> RowStore<T> {
    /// Row-capped only. Equivalent to `with_budget(capacity, usize::MAX)`.
    pub fn new(capacity: usize) -> Self {
        Self::with_budget(capacity, usize::MAX)
    }

    /// Capped on rows *and* bytes; storage stops at whichever is reached first.
    pub fn with_budget(capacity: usize, byte_budget: usize) -> Self {
        Self {
            rows: Vec::new(),
            capacity,
            byte_budget,
            bytes: 0,
            total_seen: 0,
        }
    }

    /// Appends a row if under capacity; always counts it.
    /// Returns true when the row was stored.
    ///
    /// Contributes nothing to the byte budget — use [`push_sized`] where the
    /// row's size is known and worth bounding.
    pub fn push(&mut self, row: T) -> bool {
        self.push_sized(row, 0)
    }

    /// Appends a row of known size if under both caps; always counts it.
    ///
    /// The first row is always stored, whatever its size: a store that refused
    /// everything because row one is 200 MB would show an empty grid for a
    /// query that returned data, which reads as a bug rather than a limit.
    pub fn push_sized(&mut self, row: T, bytes: usize) -> bool {
        self.total_seen += 1;
        let room = self.rows.len() < self.capacity
            && (self.rows.is_empty() || self.bytes.saturating_add(bytes) <= self.byte_budget);
        if room {
            self.bytes = self.bytes.saturating_add(bytes);
            self.rows.push(row);
            true
        } else {
            false
        }
    }

    /// Bytes attributed to the stored rows, as measured by the caller.
    pub fn bytes(&self) -> usize {
        self.bytes
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

#[cfg(test)]
mod byte_budget_tests {
    use super::*;

    #[test]
    fn stops_at_the_byte_budget_before_the_row_cap() {
        // The point of the second axis: 1,000 rows are allowed, but only ~10
        // of this size fit in the budget.
        let mut store = RowStore::with_budget(1_000, 100);
        for i in 0..50 {
            store.push_sized(i, 10);
        }
        assert_eq!(store.stored(), 10);
        assert_eq!(store.total_seen(), 50);
        assert!(store.truncated());
    }

    #[test]
    fn stops_at_the_row_cap_before_the_byte_budget() {
        let mut store = RowStore::with_budget(3, usize::MAX);
        for i in 0..10 {
            store.push_sized(i, 1);
        }
        assert_eq!(store.stored(), 3);
    }

    #[test]
    fn always_keeps_the_first_row_however_large() {
        // A store that refused everything because row one is 200 MB would show
        // an empty grid for a query that returned data — that reads as a bug,
        // not as a limit.
        let mut store = RowStore::with_budget(10, 100);
        assert!(store.push_sized(1, 10_000_000));
        assert_eq!(store.stored(), 1);
        // And the next one is refused, because now there is something to show.
        assert!(!store.push_sized(2, 10_000_000));
    }

    #[test]
    fn reports_the_bytes_it_is_holding() {
        let mut store = RowStore::with_budget(10, 1_000);
        store.push_sized(1, 30);
        store.push_sized(2, 40);
        assert_eq!(store.bytes(), 70);
    }

    #[test]
    fn counts_rows_it_dropped_so_the_total_stays_true() {
        // "showing first N of M" is only honest if M keeps counting.
        let mut store = RowStore::with_budget(1_000, 50);
        for i in 0..100 {
            store.push_sized(i, 10);
        }
        assert_eq!(store.total_seen(), 100);
        assert_eq!(store.stored(), 5);
    }

    #[test]
    fn plain_push_is_unbounded_by_bytes() {
        // `new` keeps the old behaviour for callers that have no size to give.
        let mut store = RowStore::new(3);
        for i in 0..5 {
            store.push(i);
        }
        assert_eq!(store.stored(), 3);
        assert_eq!(store.bytes(), 0);
    }

    #[test]
    fn a_saturating_budget_does_not_overflow() {
        let mut store = RowStore::with_budget(10, usize::MAX);
        store.push_sized(1, usize::MAX);
        store.push_sized(2, usize::MAX);
        assert_eq!(store.stored(), 2);
    }
}
