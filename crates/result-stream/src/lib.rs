//! Bounded, compressed row store (virtualized grid backend).
//!
//! Query rows stream into a `RowStore` on the Rust side; the WebView never
//! receives more than one visible window at a time. Storage is capped: rows
//! beyond the cap are counted but not kept, and the store reports itself
//! truncated so the UI can say "showing first N of M".
//!
//! ## Two caps, because rows are not a unit of memory
//!
//! The cap used to be a row count alone, and "bounded memory" was measured in
//! rows. A row is not a size: 100,000 rows of a `jsonb` column holding 10 MB
//! documents is a terabyte, and nothing stopped it. So there is also a byte
//! budget, counted on the rows' uncompressed text (what the user asked for,
//! not what it happens to compress to), and whichever runs out first stops
//! storage. Rows past either are still counted, so the "of M" total stays
//! true.
//!
//! ## Compressed blocks, spilled to disk past a threshold
//!
//! Each row is its finished text (for the desktop app, a JSON array). Rows are
//! appended to an open block; once it reaches [`DEFAULT_BLOCK_BYTES`] of text
//! it is sealed: deflated (fast level) and kept as one allocation. A result
//! row is mostly the same shapes over and over — `null,null,`, the same
//! column's kind of value — so it compresses several times over.
//!
//! Once the compressed blocks held in RAM pass [`DEFAULT_RAM_BYTES`], further
//! sealed blocks go to an anonymous temporary file and only their offset and
//! length stay in memory. The file is created on the first spill, so a small
//! result never touches the disk.
//!
//! ## Random access
//!
//! A sorted page asks for up to 1,000 rows scattered across the whole result.
//! Blocks are small (a few KB of text), so reading one row decompresses a few
//! KB, not a large block of neighbours nobody asked for; and [`RowStore::gather`]
//! groups a page's rows by block, so each block is decompressed once per page
//! whatever order the rows are wanted in. A small LRU of decompressed blocks
//! serves scrolling, where the next page starts in the block the last one
//! ended in.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};

use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

/// Text per block before it is sealed and compressed.
///
/// The trade-off: bigger blocks compress better and cost less per block to
/// seal, smaller ones make a scattered (sorted) page decompress less text it
/// does not need. 8 KB keeps a 1,000-row sorted page of the wide benchmark
/// under a few milliseconds and still compresses that result ~7x.
pub const DEFAULT_BLOCK_BYTES: usize = 8 * 1024;

/// Compressed bytes kept in RAM before further blocks are spilled to disk.
pub const DEFAULT_RAM_BYTES: usize = 16 * 1024 * 1024;

/// Decompressed blocks kept for paging, and the bytes they may hold together.
/// The byte bound matters for wide rows: one 10 MB row is one 10 MB block.
const CACHE_BLOCKS: usize = 8;
const CACHE_BYTES: usize = 1024 * 1024;

/// Where a sealed block's compressed bytes live.
enum Place {
    Ram(Box<[u8]>),
    Disk { offset: u64, len: u32 },
}

struct Block {
    /// Index of the block's first row.
    first: u32,
    /// Length of the block's text once decompressed.
    raw_len: u32,
    place: Place,
}

/// Rows read out of the store, in the order they were asked for.
pub struct Rows {
    text: String,
    spans: Vec<(usize, usize)>,
}

impl Rows {
    pub fn len(&self) -> usize {
        self.spans.len()
    }

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }

    pub fn get(&self, i: usize) -> Option<&str> {
        self.spans.get(i).map(|&(a, b)| &self.text[a..b])
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> + '_ {
        self.spans.iter().map(|&(a, b)| &self.text[a..b])
    }
}

/// A bounded, append-only store of text rows, compressed in blocks.
pub struct RowStore {
    capacity: usize,
    byte_budget: usize,
    bytes: usize,
    total_seen: u64,
    /// Set by the first refusal. From then on nothing is stored, so the kept
    /// rows are always a prefix of the stream — "the first N of M".
    full: bool,

    block_bytes: usize,
    ram_limit: usize,
    /// End offset of each stored row within its block's text. A row starts
    /// where the previous one ended, or at 0 if it is its block's first.
    ends: Vec<u32>,
    blocks: Vec<Block>,
    /// Rows in sealed blocks; the rest are in `open`.
    sealed_rows: usize,
    /// Text of the rows not sealed yet.
    open: Vec<u8>,
    /// Compressed bytes of the blocks held in RAM.
    ram_bytes: usize,
    /// Spilled blocks. `tempfile::tempfile()` has no name: on macOS and
    /// Linux it is unlinked as it is created (or never linked, with
    /// O_TMPFILE), on Windows it is opened delete-on-close — so the OS
    /// removes it when the store is dropped, and also if the app crashes.
    /// The spilled rows are query results, compressed but NOT encrypted,
    /// and sit in the OS temp directory until then.
    file: Option<File>,
    file_len: u64,

    deflate: Option<Compress>,
    inflate: Option<Decompress>,
    /// Compressed bytes in transit: a block being sealed or read from disk.
    scratch: Vec<u8>,
    /// Decompressed blocks, most recently used first.
    cache: Vec<(usize, String)>,
}

impl RowStore {
    /// Row-capped only. Equivalent to `with_budget(capacity, usize::MAX)`.
    pub fn new(capacity: usize) -> Self {
        Self::with_budget(capacity, usize::MAX)
    }

    /// Capped on rows *and* bytes of row text; storage stops at whichever is
    /// reached first.
    pub fn with_budget(capacity: usize, byte_budget: usize) -> Self {
        Self {
            // Row indexes are u32 throughout.
            capacity: capacity.min(u32::MAX as usize),
            byte_budget,
            bytes: 0,
            total_seen: 0,
            full: false,
            block_bytes: DEFAULT_BLOCK_BYTES,
            ram_limit: DEFAULT_RAM_BYTES,
            ends: Vec::new(),
            blocks: Vec::new(),
            sealed_rows: 0,
            open: Vec::new(),
            ram_bytes: 0,
            file: None,
            file_len: 0,
            deflate: None,
            inflate: None,
            scratch: Vec::new(),
            cache: Vec::new(),
        }
    }

    /// Overrides the block size and the RAM threshold for spilling.
    pub fn with_layout(mut self, block_bytes: usize, ram_limit: usize) -> Self {
        self.block_bytes = block_bytes.max(1);
        self.ram_limit = ram_limit;
        self
    }

    /// Appends a row if under both caps, counting its text against the byte
    /// budget; always counts it. Returns true when the row was stored.
    pub fn push(&mut self, row: &str) -> bool {
        self.push_sized(row, row.len())
    }

    /// Appends a row of the given size if under both caps; always counts it.
    /// The first row is always stored, whatever its size: a store that refused
    /// everything because row one is 200 MB would show an empty grid for a
    /// query that returned data, which reads as a bug rather than a limit.
    pub fn push_sized(&mut self, row: &str, bytes: usize) -> bool {
        self.total_seen += 1;
        let room = !self.full
            && self.ends.len() < self.capacity
            && (self.ends.is_empty() || self.bytes.saturating_add(bytes) <= self.byte_budget)
            // Offsets within a block are u32.
            && row.len() <= u32::MAX as usize;
        if !room {
            // Without this, a small row after a refused large one would still
            // fit the byte budget, and the store would hold rows 1..k and then
            // row k+5 — not the first N rows it reports.
            self.full = true;
            return false;
        }
        if self.open.len() + row.len() > u32::MAX as usize {
            self.seal();
        }
        self.bytes = self.bytes.saturating_add(bytes);
        self.open.extend_from_slice(row.as_bytes());
        self.ends.push(self.open.len() as u32);
        if self.open.len() >= self.block_bytes {
            self.seal();
        }
        true
    }

    /// True once the store has refused a row; every later row is refused too.
    /// Callers can then count rows with [`skip`](Self::skip) instead of
    /// building them.
    pub fn is_full(&self) -> bool {
        self.full || self.ends.len() >= self.capacity
    }

    /// Counts a row that will not be stored, without the caller building it.
    pub fn skip(&mut self) {
        self.total_seen += 1;
        self.full = true;
    }

    /// Call once the stream has ended: seals the last block and gives back
    /// what only appending needed — the compressor's state (a few hundred KB),
    /// the open block's buffer and the spare capacity of the indexes. The
    /// store stays usable afterwards.
    pub fn shrink_to_fit(&mut self) {
        self.seal();
        self.deflate = None;
        self.open = Vec::new();
        self.scratch = Vec::new();
        self.ends.shrink_to_fit();
        self.blocks.shrink_to_fit();
    }

    /// Bytes of row text attributed to the stored rows (the budget's measure).
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Rows actually stored (<= capacity).
    pub fn stored(&self) -> usize {
        self.ends.len()
    }

    /// Rows seen from the stream, including dropped ones.
    pub fn total_seen(&self) -> u64 {
        self.total_seen
    }

    /// True when at least one row was counted but not stored.
    pub fn truncated(&self) -> bool {
        self.total_seen > self.ends.len() as u64
    }

    /// Compressed bytes held in RAM.
    pub fn ram_bytes(&self) -> usize {
        self.ram_bytes
    }

    /// Compressed bytes written to the spill file (0 if there is none).
    pub fn file_bytes(&self) -> u64 {
        self.file_len
    }

    /// True once a spill file exists.
    pub fn spilled(&self) -> bool {
        self.file.is_some()
    }

    /// Sealed blocks.
    pub fn blocks(&self) -> usize {
        self.blocks.len()
    }

    /// Stored rows `ids`, in that order. Ids past the end are left out.
    ///
    /// The rows are read in block order, whatever order they are asked for
    /// in, so each block is decompressed at most once per call.
    pub fn gather(&mut self, ids: &[usize]) -> io::Result<Rows> {
        let n = self.stored();
        let ids: Vec<usize> = ids.iter().copied().filter(|&i| i < n).collect();
        let mut by_row: Vec<u32> = (0..ids.len() as u32).collect();
        // Already sorted for a sequential window, which the sort detects.
        by_row.sort_unstable_by_key(|&k| ids[k as usize]);
        let mut text = String::new();
        let mut spans = vec![(0, 0); ids.len()];
        for k in by_row {
            let row = ids[k as usize];
            let (block, start, end) = self.locate(row);
            let start_at = text.len();
            if block == self.blocks.len() {
                text.push_str(as_text(&self.open[start..end])?);
            } else {
                let block = self.cached(block)?;
                text.push_str(&block[start..end]);
            }
            spans[k as usize] = (start_at, text.len());
        }
        Ok(Rows { text, spans })
    }

    /// Stored rows `[offset, offset + len)`, clamped to bounds. Out-of-range
    /// offsets yield no rows rather than an error.
    pub fn window(&mut self, offset: usize, len: usize) -> io::Result<Rows> {
        let start = offset.min(self.stored());
        let end = offset.saturating_add(len).min(self.stored());
        self.gather(&(start..end).collect::<Vec<_>>())
    }

    /// Calls `f` with every stored row in order. Decompresses each block once
    /// into a buffer of its own, so a full scan (a sort, a chart) does not
    /// push the paging cache's blocks out.
    pub fn for_each(&mut self, mut f: impl FnMut(usize, &str)) -> io::Result<()> {
        let mut buf = Vec::new();
        for b in 0..self.blocks.len() {
            self.decompress(b, &mut buf)?;
            let text = as_text(&buf)?;
            let first = self.blocks[b].first as usize;
            let last = self
                .blocks
                .get(b + 1)
                .map_or(self.sealed_rows, |n| n.first as usize);
            self.each_in(text, first, last, &mut f);
        }
        let text = as_text(&self.open)?;
        self.each_in(text, self.sealed_rows, self.ends.len(), &mut f);
        Ok(())
    }

    fn each_in(&self, text: &str, first: usize, last: usize, f: &mut impl FnMut(usize, &str)) {
        let mut start = 0;
        for row in first..last {
            let end = self.ends[row] as usize;
            f(row, &text[start..end]);
            start = end;
        }
    }

    /// The block holding `row` (`blocks.len()` for the open one) and the
    /// row's byte range within the block's text.
    fn locate(&self, row: usize) -> (usize, usize, usize) {
        let (block, first) = if row >= self.sealed_rows {
            (self.blocks.len(), self.sealed_rows)
        } else {
            let b = self.blocks.partition_point(|b| b.first as usize <= row) - 1;
            (b, self.blocks[b].first as usize)
        };
        let start = if row == first {
            0
        } else {
            self.ends[row - 1] as usize
        };
        (block, start, self.ends[row] as usize)
    }

    /// Decompressed text of sealed block `b`, through the LRU.
    fn cached(&mut self, b: usize) -> io::Result<&str> {
        if let Some(at) = self.cache.iter().position(|(id, _)| *id == b) {
            if at != 0 {
                let hit = self.cache.remove(at);
                self.cache.insert(0, hit);
            }
        } else {
            // Reuse the least recently used block's buffer once the cache is
            // full, so steady paging allocates nothing.
            let mut buf = if self.cache.len() >= CACHE_BLOCKS {
                self.cache
                    .pop()
                    .map(|(_, s)| s.into_bytes())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            self.decompress(b, &mut buf)?;
            let text = String::from_utf8(buf).map_err(|_| corrupt())?;
            self.cache.insert(0, (b, text));
            let mut held = 0;
            let mut keep = 0;
            for (_, s) in &self.cache {
                held += s.capacity();
                // The block just read is always kept, however large.
                if keep > 0 && held > CACHE_BYTES {
                    break;
                }
                keep += 1;
            }
            self.cache.truncate(keep);
        }
        Ok(&self.cache[0].1)
    }

    /// Decompresses sealed block `b` into `out` (replacing its contents).
    fn decompress(&mut self, b: usize, out: &mut Vec<u8>) -> io::Result<()> {
        let Self {
            blocks,
            file,
            scratch,
            inflate,
            ..
        } = self;
        let block = &blocks[b];
        let input: &[u8] = match &block.place {
            Place::Ram(bytes) => bytes,
            Place::Disk { offset, len } => {
                let file = file.as_mut().ok_or_else(corrupt)?;
                file.seek(SeekFrom::Start(*offset))?;
                scratch.resize(*len as usize, 0);
                file.read_exact(scratch)?;
                scratch
            }
        };
        let inflate = inflate.get_or_insert_with(|| Decompress::new(false));
        inflate.reset(false);
        out.clear();
        out.reserve_exact(block.raw_len as usize);
        let status = inflate
            .decompress_vec(input, out, FlushDecompress::Finish)
            .map_err(|_| corrupt())?;
        if status != Status::StreamEnd || out.len() != block.raw_len as usize {
            return Err(corrupt());
        }
        Ok(())
    }

    /// Compresses the open block and files it in RAM or, past the threshold,
    /// in the spill file.
    fn seal(&mut self) {
        if self.open.is_empty() {
            return;
        }
        let deflate = self
            .deflate
            .get_or_insert_with(|| Compress::new(Compression::fast(), false));
        deflate.reset();
        self.scratch.clear();
        self.scratch.reserve(self.open.len() / 2 + 64);
        loop {
            let consumed = deflate.total_in() as usize;
            let status = deflate
                .compress_vec(
                    &self.open[consumed..],
                    &mut self.scratch,
                    FlushCompress::Finish,
                )
                .expect("deflating a buffer in memory cannot fail");
            if status == Status::StreamEnd {
                break;
            }
            let more = self.scratch.len().max(4096);
            self.scratch.reserve(more);
        }
        let len = self.scratch.len();
        let place = if self.ram_bytes + len > self.ram_limit {
            self.spill().ok()
        } else {
            None
        }
        .unwrap_or_else(|| {
            // Under the threshold — or the disk refused the write (full, no
            // temp directory). Keeping the block in RAM then is better than
            // losing rows the store has already said it holds.
            self.ram_bytes += len;
            Place::Ram(Box::from(&self.scratch[..]))
        });
        self.blocks.push(Block {
            first: self.sealed_rows as u32,
            raw_len: self.open.len() as u32,
            place,
        });
        self.sealed_rows = self.ends.len();
        self.open.clear();
        // One huge row grew the buffers; do not keep that for small ones.
        if self.open.capacity() > 2 * self.block_bytes {
            self.open.shrink_to(self.block_bytes);
        }
        if self.scratch.capacity() > 2 * self.block_bytes {
            self.scratch.shrink_to(self.block_bytes);
        }
    }

    /// Appends `scratch` to the spill file, creating it on first use.
    fn spill(&mut self) -> io::Result<Place> {
        let file = match &mut self.file {
            Some(file) => file,
            empty => empty.insert(tempfile::tempfile()?),
        };
        let len = u32::try_from(self.scratch.len()).map_err(|_| corrupt())?;
        file.seek(SeekFrom::Start(self.file_len))?;
        file.write_all(&self.scratch)?;
        let offset = self.file_len;
        self.file_len += u64::from(len);
        Ok(Place::Disk { offset, len })
    }
}

fn as_text(bytes: &[u8]) -> io::Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| corrupt())
}

fn corrupt() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "stored result block is corrupt")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(store: &mut RowStore) -> Vec<String> {
        store
            .window(0, usize::MAX)
            .unwrap()
            .iter()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn stays_a_prefix_once_a_row_is_refused() {
        // Budget 100: rows of 60, 60 (refused), then 10 — which would fit.
        let mut store = RowStore::with_budget(10, 100);
        assert!(store.push_sized("1", 60));
        assert!(!store.push_sized("2", 60));
        assert!(
            !store.push_sized("3", 10),
            "a later small row must not leapfrog the refused one"
        );
        assert_eq!(all(&mut store), ["1"]);
        assert!(store.is_full());
        assert_eq!(store.total_seen(), 3);
    }

    #[test]
    fn shrinking_keeps_the_rows() {
        let mut store = RowStore::new(100);
        for i in 0..5 {
            store.push(&i.to_string());
        }
        store.shrink_to_fit();
        assert_eq!(store.blocks(), 1, "the tail is sealed too");
        assert_eq!(all(&mut store), ["0", "1", "2", "3", "4"]);
        assert!(store.push("5"));
        assert_eq!(all(&mut store), ["0", "1", "2", "3", "4", "5"]);
    }

    #[test]
    fn skip_counts_without_storing() {
        let mut store = RowStore::new(1);
        assert!(store.push("1"));
        assert!(store.is_full());
        store.skip();
        store.skip();
        assert_eq!(store.total_seen(), 3);
        assert_eq!(store.stored(), 1);
        assert!(store.truncated());
    }

    #[test]
    fn stores_up_to_capacity_and_counts_overflow() {
        let mut store = RowStore::new(3);
        for i in 0..5 {
            let stored = store.push(&i.to_string());
            assert_eq!(stored, i < 3);
        }
        assert_eq!(store.stored(), 3);
        assert_eq!(store.total_seen(), 5);
        assert!(store.truncated());
    }

    #[test]
    fn not_truncated_when_under_capacity() {
        let mut store = RowStore::new(10);
        store.push("1");
        store.push("2");
        assert!(!store.truncated());
        assert_eq!(store.total_seen(), 2);
    }

    #[test]
    fn window_clamps_to_bounds() {
        let mut store = RowStore::new(100).with_layout(4, usize::MAX);
        for i in 0..10 {
            store.push(&i.to_string());
        }
        let w = |s: &mut RowStore, o, l| -> Vec<String> {
            s.window(o, l).unwrap().iter().map(str::to_owned).collect()
        };
        assert_eq!(w(&mut store, 0, 3), ["0", "1", "2"]);
        assert_eq!(w(&mut store, 8, 5), ["8", "9"]);
        assert!(w(&mut store, 10, 5).is_empty());
        assert!(w(&mut store, 999, 5).is_empty());
        // Offset + len overflow must not panic.
        assert!(w(&mut store, usize::MAX, usize::MAX).is_empty());
    }

    #[test]
    fn zero_capacity_counts_everything_stores_nothing() {
        let mut store = RowStore::new(0);
        assert!(!store.push("42"));
        assert_eq!(store.stored(), 0);
        assert_eq!(store.total_seen(), 1);
        assert!(store.truncated());
    }

    #[test]
    fn empty_rows_round_trip() {
        let mut store = RowStore::new(10).with_layout(1, usize::MAX);
        for row in ["", "a", "", "", "bc", ""] {
            store.push(row);
        }
        store.shrink_to_fit();
        assert_eq!(all(&mut store), ["", "a", "", "", "bc", ""]);
    }
}

#[cfg(test)]
mod block_tests {
    use super::*;

    fn row(i: usize) -> String {
        // Varied lengths, multi-byte text, so a wrong offset shows.
        format!("[{i},\"r\u{e9}-{}\",null]", "x".repeat(i % 37))
    }

    fn filled(rows: usize, block: usize, ram: usize) -> RowStore {
        let mut store = RowStore::new(usize::MAX).with_layout(block, ram);
        for i in 0..rows {
            assert!(store.push(&row(i)));
        }
        store
    }

    #[test]
    fn rows_across_many_blocks_and_a_spill_read_back_unchanged() {
        // ~150 blocks of 256 bytes; past 2 KB of compressed blocks in RAM the
        // rest go to the file.
        let mut store = filled(2_000, 256, 2_048);
        store.shrink_to_fit();
        assert!(store.blocks() > 100, "{} blocks", store.blocks());
        assert!(store.spilled());
        assert!(store.file_bytes() > 0);
        assert!(store.ram_bytes() <= 2_048);

        let window = store.window(0, usize::MAX).unwrap();
        assert_eq!(window.len(), 2_000);
        for (i, text) in window.iter().enumerate() {
            assert_eq!(text, row(i));
        }
        // A window straddling block boundaries, and one in the spilled part.
        let w = store.window(995, 10).unwrap();
        assert!(w
            .iter()
            .eq((995..1_005).map(row).collect::<Vec<_>>().iter()));
        let w = store.window(1_990, 50).unwrap();
        assert!(w
            .iter()
            .eq((1_990..2_000).map(row).collect::<Vec<_>>().iter()));
        // The full scan sees the same rows.
        let mut seen = Vec::new();
        store
            .for_each(|i, text| {
                assert_eq!(text, row(i));
                seen.push(i);
            })
            .unwrap();
        assert_eq!(seen, (0..2_000).collect::<Vec<_>>());
    }

    #[test]
    fn scattered_ids_come_back_in_the_order_asked() {
        let mut store = filled(1_000, 128, 1_024);
        // Not shrunk: the last rows are still in the open block.
        let ids: Vec<usize> = (0..1_000).map(|i| (i * 7_919) % 1_000).rev().collect();
        let rows = store.gather(&ids).unwrap();
        assert_eq!(rows.len(), 1_000);
        for (k, text) in rows.iter().enumerate() {
            assert_eq!(text, row(ids[k]));
        }
        // Repeats and ids past the end.
        let rows = store.gather(&[5, 5, 999, 1_000, 3]).unwrap();
        let got: Vec<&str> = rows.iter().collect();
        assert_eq!(got, [row(5), row(5), row(999), row(3)]);
    }

    #[test]
    fn a_store_that_stays_under_the_threshold_creates_no_file() {
        let mut store = filled(5_000, DEFAULT_BLOCK_BYTES, DEFAULT_RAM_BYTES);
        store.shrink_to_fit();
        assert!(store.blocks() > 1);
        assert!(!store.spilled());
        assert_eq!(store.file_bytes(), 0);
        assert_eq!(store.window(4_999, 1).unwrap().get(0), Some(&*row(4_999)));
    }

    #[test]
    fn compresses_repetitive_rows() {
        let mut store = RowStore::new(usize::MAX);
        let text = format!("[1,{}\"a\"]", "null,".repeat(200));
        for _ in 0..1_000 {
            store.push(&text);
        }
        store.shrink_to_fit();
        assert!(
            store.ram_bytes() * 10 < store.bytes(),
            "{}",
            store.ram_bytes()
        );
    }

    #[test]
    fn a_row_larger_than_a_block_is_a_block_of_its_own() {
        let big = "y".repeat(3 * DEFAULT_BLOCK_BYTES + 1);
        let mut store = RowStore::new(10);
        store.push("a");
        store.push(&big);
        store.push("b");
        store.shrink_to_fit();
        let rows = store.gather(&[2, 1, 0]).unwrap();
        assert_eq!(rows.iter().collect::<Vec<_>>(), ["b", big.as_str(), "a"]);
    }
}

#[cfg(test)]
mod byte_budget_tests {
    use super::*;

    #[test]
    fn stops_at_the_byte_budget_before_the_row_cap() {
        // The point of the second axis: 1,000 rows are allowed, but only 10
        // of this size fit in the budget.
        let mut store = RowStore::with_budget(1_000, 100);
        for _ in 0..50 {
            store.push("0123456789");
        }
        assert_eq!(store.stored(), 10);
        assert_eq!(store.total_seen(), 50);
        assert!(store.truncated());
    }

    #[test]
    fn stops_at_the_row_cap_before_the_byte_budget() {
        let mut store = RowStore::with_budget(3, usize::MAX);
        for _ in 0..10 {
            store.push("x");
        }
        assert_eq!(store.stored(), 3);
    }

    #[test]
    fn always_keeps_the_first_row_however_large() {
        // A store that refused everything because row one is 200 MB would show
        // an empty grid for a query that returned data — that reads as a bug,
        // not as a limit.
        let mut store = RowStore::with_budget(10, 100);
        assert!(store.push_sized("1", 10_000_000));
        assert_eq!(store.stored(), 1);
        // And the next one is refused, because now there is something to show.
        assert!(!store.push_sized("2", 10_000_000));
    }

    #[test]
    fn counts_the_uncompressed_text() {
        let mut store = RowStore::with_budget(10, 1_000);
        store.push(&"a".repeat(30));
        store.push(&"b".repeat(40));
        store.shrink_to_fit();
        assert_eq!(
            store.bytes(),
            70,
            "what was asked for, not what it packs to"
        );
    }

    #[test]
    fn counts_rows_it_dropped_so_the_total_stays_true() {
        // "showing first N of M" is only honest if M keeps counting.
        let mut store = RowStore::with_budget(1_000, 50);
        for _ in 0..100 {
            store.push("0123456789");
        }
        assert_eq!(store.total_seen(), 100);
        assert_eq!(store.stored(), 5);
    }

    #[test]
    fn a_saturating_budget_does_not_overflow() {
        let mut store = RowStore::with_budget(10, usize::MAX);
        store.push_sized("1", usize::MAX);
        store.push_sized("2", usize::MAX);
        assert_eq!(store.stored(), 2);
    }
}
