//! The compiled corpus archive: records, interned strings, exact-symbol table
//! and name-token index, stored as one rkyv archive and read through an mmap.
//!
//! The archive is a *cache*: `records.ndjson` stays canonical, and a format
//! mismatch is rebuilt or re-downloaded, never migrated.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use memmap2::Mmap;
use rkyv::primitive::ArchivedU32;
use rkyv::{Archive, Deserialize, Serialize};
use serde::Deserialize as SerdeDeserialize;
use sha1::{Digest as Sha1Digest, Sha1};
use sha2::{Digest as Sha2Digest, Sha256};

pub const FORMAT_VERSION: u32 = 1;
pub const ARCHIVE_FILE: &str = "corpus.rkyv";
pub const MANIFEST_FILE: &str = "corpus.manifest.json";

/// Interned string id; `0` is the empty string.
pub type StrId = u32;

/// Accept both the native and the archived representation of an id, so call
/// sites can pass `record.name` (archived) or a plain `u32` interchangeably.
pub trait MaybeNativeId {
    fn native(self) -> u32;
}

impl MaybeNativeId for u32 {
    fn native(self) -> u32 {
        self
    }
}

impl MaybeNativeId for ArchivedU32 {
    fn native(self) -> u32 {
        self.to_native()
    }
}

#[derive(Archive, Serialize, Deserialize, Debug)]
pub struct Corpus {
    pub format_version: u32,
    pub bevy_version: String,
    pub built_at_unix: u64,
    pub source_fingerprint: String,
    pub arena: Arena,
    pub records: Vec<Record>,
    pub symbols: Vec<Symbol>,
    pub name_tokens: Vec<Symbol>,
    pub by_kind: Vec<Count>,
    pub by_source: Vec<Count>,
    pub meta: Meta,
}

#[derive(Archive, Serialize, Deserialize, Debug)]
pub struct Arena {
    pub bytes: Vec<u8>,
    pub offsets: Vec<u32>,
}

#[derive(Archive, Serialize, Deserialize, Debug)]
pub struct Record {
    /// Dense position in `records` (the archive's internal primary key).
    pub dense_id: u32,
    /// The TypeScript-compatible 16-hex record id (used by `bevy://` URIs).
    pub hash: StrId,
    pub source: StrId,
    pub kind: StrId,
    pub name: StrId,
    pub full_path: StrId,
    pub docs: StrId,
    pub signature: StrId,
    pub module: StrId,
    pub file: StrId,
    pub owner: StrId,
    pub crate_name: StrId,
    pub source_ref: StrId,
    pub bevy_version: StrId,
    pub title: StrId,
    pub defaults: StrId,
    pub heading: StrId,
    pub description: StrId,
    pub code: StrId,
    pub file_abs: StrId,
    pub version: StrId,
    pub from_version: StrId,
    pub to_version: StrId,
    pub pr: Option<u32>,
    pub line_start: Option<u32>,
    pub line_count: Option<u32>,
    pub draft: bool,
    pub examples: Vec<Example>,
    pub breadcrumb: Vec<StrId>,
    pub categories: Vec<StrId>,
    pub required_features: Vec<StrId>,
}

#[derive(Archive, Serialize, Deserialize, Debug)]
pub struct Example {
    pub lang: StrId,
    pub code: StrId,
    pub compile_fail: bool,
    pub ignored: bool,
    pub scraped: bool,
    pub source_file: StrId,
}

/// Alias key -> dense record ids. Keys are unique and sorted by string order.
#[derive(Archive, Serialize, Deserialize, Debug)]
pub struct Symbol {
    pub key: StrId,
    pub ids: Vec<u32>,
}

#[derive(Archive, Serialize, Deserialize, Debug)]
pub struct Count {
    pub name: String,
    pub count: u64,
}

#[derive(Archive, Serialize, Deserialize, Debug)]
pub struct Meta {
    pub doc_dir: StrId,
    pub website_dir: StrId,
    pub examples_dir: StrId,
    pub project_root: StrId,
    pub version_source: StrId,
    pub api_records: u64,
    pub text_indexed: u64,
}

impl Corpus {
    /// Build-time string access, mirroring [`ArchivedCorpus::string`].
    pub fn string(&self, id: StrId) -> &str {
        let index = id as usize;
        let Some(start) = self.arena.offsets.get(index) else {
            return "";
        };
        let Some(end) = self.arena.offsets.get(index + 1) else {
            return "";
        };
        let (start, end) = (*start as usize, *end as usize);
        std::str::from_utf8(&self.arena.bytes[start..end]).unwrap_or("")
    }
}

impl ArchivedCorpus {
    pub fn string(&self, id: impl MaybeNativeId) -> &str {
        let index = id.native() as usize;
        let bytes = self.arena.bytes.as_slice();
        let Some(start) = self.arena.offsets.get(index) else {
            return "";
        };
        let Some(end) = self.arena.offsets.get(index + 1) else {
            return "";
        };
        let (start, end) = (start.to_native() as usize, end.to_native() as usize);
        if start > end || end > bytes.len() {
            return "";
        }
        std::str::from_utf8(&bytes[start..end]).unwrap_or("")
    }

    pub fn record(&self, id: impl MaybeNativeId) -> Option<&ArchivedRecord> {
        self.records.get(id.native() as usize)
    }

    pub fn find_symbol(&self, key: &str) -> Option<&ArchivedSymbol> {
        self.symbols
            .binary_search_by(|symbol| self.string(symbol.key).cmp(key))
            .ok()
            .map(|index| &self.symbols[index])
    }

    pub fn find_name_token(&self, key: &str) -> Option<&ArchivedSymbol> {
        self.name_tokens
            .binary_search_by(|token| self.string(token.key).cmp(key))
            .ok()
            .map(|index| &self.name_tokens[index])
    }

    /// Exact symbol lookup, best match first (mirrors the TypeScript server).
    pub fn lookup(&self, query: &str) -> Vec<&ArchivedRecord> {
        let key = norm_key(query);
        if key.is_empty() {
            return Vec::new();
        }
        let Some(symbol) = self.find_symbol(&key) else {
            return Vec::new();
        };
        let qualified = key.contains("::");
        let mut seen: Vec<u32> = Vec::new();
        let mut hits: Vec<(u32, u8, &ArchivedRecord)> = Vec::new();
        for id in symbol.ids.iter() {
            let id = id.native();
            if seen.contains(&id) {
                continue;
            }
            seen.push(id);
            let Some(record) = self.record(id) else {
                continue;
            };
            if !qualified && norm_key(&base_name(self.string(record.name))) != key {
                continue;
            }
            let score = if qualified && norm_key(self.string(record.full_path)) == key {
                1100
            } else {
                1000
            };
            hits.push((score, symbol_rank(self.string(record.kind)), record));
        }
        hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        hits.into_iter().map(|(_, _, record)| record).collect()
    }
}

/// A memory-mapped, validated archive. The mapping never moves, so keeping a
/// raw pointer to the root is sound; the lifetime is tied to this struct.
pub struct LoadedCorpus {
    mmap: Mmap,
    root: NonNull<ArchivedCorpus>,
}

// The mapping is immutable and the archived tree is read-only.
unsafe impl Send for LoadedCorpus {}
unsafe impl Sync for LoadedCorpus {}

impl LoadedCorpus {
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path)
            .with_context(|| format!("cannot open corpus archive {}", path.display()))?;
        // Safety: mmap of a read-only file; the mapping outlives every reference.
        let mmap = unsafe { Mmap::map(&file) }
            .with_context(|| format!("cannot mmap {}", path.display()))?;
        let root: NonNull<ArchivedCorpus> = {
            let archived = rkyv::access::<ArchivedCorpus, rkyv::rancor::Error>(&mmap)
                .map_err(|error| anyhow!("corpus archive failed validation: {error}"))?;
            NonNull::from(archived)
        };
        Ok(Self { mmap, root })
    }

    pub fn root(&self) -> &ArchivedCorpus {
        // Safety: `mmap` owns the bytes for as long as `self` lives.
        unsafe { self.root.as_ref() }
    }

    pub fn size(&self) -> usize {
        self.mmap.len()
    }

    pub fn lookup(&self, query: &str) -> Vec<&ArchivedRecord> {
        self.root().lookup(query)
    }

    pub fn format_version(&self) -> u32 {
        self.root().format_version.to_native()
    }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

#[derive(Default, Debug, Clone)]
pub struct BuildOptions {
    pub bevy_version: Option<String>,
    pub doc_dir: Option<String>,
    pub website_dir: Option<String>,
    pub examples_dir: Option<String>,
    pub project_root: Option<String>,
    pub version_source: Option<String>,
    pub source_fingerprint: Option<String>,
}

#[derive(Debug)]
pub struct BuildReport {
    pub records: usize,
    pub symbols: usize,
    pub name_tokens: usize,
    pub duplicates_merged: usize,
    pub archive_bytes: u64,
    pub archive_path: PathBuf,
    pub text_documents: usize,
    pub text_bytes: u64,
    pub text_build_ms: u128,
    pub load_test_ms: u128,
    pub build_ms: u128,
}

#[derive(SerdeDeserialize, Debug, Clone)]
pub struct RawExample {
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub compile_fail: bool,
    #[serde(default)]
    pub ignored: bool,
    #[serde(default)]
    pub scraped: bool,
    #[serde(default)]
    pub source_file: Option<String>,
}

#[derive(SerdeDeserialize, Debug, Clone, Default)]
pub struct RecordInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub full_path: String,
    #[serde(default)]
    pub docs: String,
    #[serde(default)]
    pub signature: String,
    #[serde(default)]
    pub module: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default, rename = "crate")]
    pub crate_name: Option<String>,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub bevy_version: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub defaults: Option<String>,
    #[serde(default)]
    pub examples: Option<Vec<RawExample>>,
    #[serde(default)]
    pub heading: Option<String>,
    #[serde(default)]
    pub breadcrumb: Option<Vec<String>>,
    #[serde(default)]
    pub line_start: Option<u32>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub from_version: Option<String>,
    #[serde(default)]
    pub to_version: Option<String>,
    #[serde(default)]
    pub pr: Option<u32>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub file_abs: Option<String>,
    #[serde(default)]
    pub line_count: Option<u32>,
    #[serde(default)]
    pub categories: Option<Vec<String>>,
    #[serde(default)]
    pub required_features: Option<Vec<String>>,
}

impl RecordInput {
    fn hash_id(&self) -> String {
        if let Some(id) = &self.id
            && !id.is_empty()
        {
            return id.clone();
        }
        let version_scoped = if is_version_specific_source(&self.source) {
            self.bevy_version.as_deref().unwrap_or("?")
        } else {
            ""
        };
        raw_id(
            &self.source,
            version_scoped,
            &self.kind,
            &self.full_path,
            &self.name,
            self.heading.as_deref().unwrap_or(""),
        )
    }

    fn identity(&self) -> (&str, &str, &str, &str, Option<&str>) {
        (
            &self.source,
            &self.kind,
            &self.full_path,
            &self.name,
            self.bevy_version.as_deref(),
        )
    }
}

fn is_version_specific_source(source: &str) -> bool {
    source == "rustdoc" || source == "bevy-examples"
}

fn raw_id(
    source: &str,
    version_scoped: &str,
    kind: &str,
    full_path: &str,
    name: &str,
    heading: &str,
) -> String {
    let joined = [source, version_scoped, kind, full_path, name, heading].join("|");
    let digest = Sha1::digest(joined.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_legacy_tuple_field(record: &RecordInput) -> bool {
    record.source == "rustdoc"
        && record.kind == "field"
        && !record.name.is_empty()
        && record.name.chars().all(|c| c.is_ascii_digit())
}

fn merge_raw(existing: &mut RecordInput, incoming: RecordInput) -> Result<()> {
    if existing.identity() != incoming.identity() {
        bail!(
            "record id collision between different API identities: {}",
            incoming.hash_id()
        );
    }
    if incoming.docs.len() > existing.docs.len() {
        existing.docs = incoming.docs;
    }
    if existing.signature.is_empty() && !incoming.signature.is_empty() {
        existing.signature = incoming.signature;
    }
    if existing.source_ref.is_none() && incoming.source_ref.is_some() {
        existing.source_ref = incoming.source_ref;
    }
    if existing.defaults.is_none() && incoming.defaults.is_some() {
        existing.defaults = incoming.defaults;
    }
    if let Some(examples) = incoming.examples {
        let target = existing.examples.get_or_insert_with(Vec::new);
        for example in examples {
            let duplicate = target.iter().any(|current| {
                current.lang == example.lang
                    && current.code == example.code
                    && current.compile_fail == example.compile_fail
                    && current.ignored == example.ignored
                    && current.scraped == example.scraped
                    && current.source_file == example.source_file
            });
            if !duplicate {
                target.push(example);
            }
        }
    }
    Ok(())
}

#[derive(Default)]
struct Interner {
    map: HashMap<String, StrId>,
    bytes: Vec<u8>,
    offsets: Vec<u32>,
}

impl Interner {
    fn new() -> Self {
        let mut interner = Self::default();
        interner.offsets.push(0);
        interner.intern("");
        interner
    }

    fn intern(&mut self, value: &str) -> StrId {
        if let Some(&id) = self.map.get(value) {
            return id;
        }
        let id = (self.offsets.len() - 1) as StrId;
        self.bytes.extend_from_slice(value.as_bytes());
        self.offsets.push(self.bytes.len() as u32);
        self.map.insert(value.to_string(), id);
        id
    }

    fn get(&self, id: StrId) -> &str {
        let index = id as usize;
        let start = self.offsets[index] as usize;
        let end = self.offsets[index + 1] as usize;
        std::str::from_utf8(&self.bytes[start..end]).unwrap_or("")
    }

    fn intern_opt(&mut self, value: Option<&str>) -> StrId {
        value.map(|v| self.intern(v)).unwrap_or(0)
    }
}

/// Read the canonical NDJSON record stream.
pub fn read_ndjson(input: &Path) -> Result<Vec<RecordInput>> {
    let file = File::open(input)
        .with_context(|| format!("cannot open records file {}", input.display()))?;
    let reader = BufReader::new(file);
    let mut inputs: Vec<RecordInput> = Vec::new();
    for (line_number, line) in reader.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let record: RecordInput = serde_json::from_str(&line)
            .with_context(|| format!("{}:{}", input.display(), line_number + 1))?;
        inputs.push(record);
    }
    Ok(inputs)
}

/// Compile any set of records (rustdoc NDJSON plus ingested sources).
pub fn build(
    inputs: Vec<RecordInput>,
    out_dir: &Path,
    options: &BuildOptions,
) -> Result<BuildReport> {
    let started = std::time::Instant::now();
    let mut raw: Vec<RecordInput> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut duplicates_merged = 0usize;

    for record in inputs {
        if is_legacy_tuple_field(&record) {
            continue;
        }
        let id = record.hash_id();
        match seen.get(&id) {
            Some(&index) => {
                merge_raw(&mut raw[index], record)?;
                duplicates_merged += 1;
            }
            None => {
                seen.insert(id, raw.len());
                raw.push(record);
            }
        }
    }

    let mut interner = Interner::new();
    let mut records = Vec::with_capacity(raw.len());
    let mut by_kind: BTreeMap<String, u64> = BTreeMap::new();
    let mut by_source: BTreeMap<String, u64> = BTreeMap::new();

    for record in &raw {
        *by_kind.entry(record.kind.clone()).or_default() += 1;
        *by_source.entry(record.source.clone()).or_default() += 1;
        let dense_id = records.len() as u32;
        records.push(Record {
            dense_id,
            hash: interner.intern(&record.hash_id()),
            source: interner.intern(&record.source),
            kind: interner.intern(&record.kind),
            name: interner.intern(&record.name),
            full_path: interner.intern(&record.full_path),
            docs: interner.intern(&record.docs),
            signature: interner.intern(&record.signature),
            module: interner.intern(&record.module),
            file: interner.intern(&record.file),
            owner: interner.intern_opt(record.owner.as_deref()),
            crate_name: interner.intern_opt(record.crate_name.as_deref()),
            source_ref: interner.intern_opt(record.source_ref.as_deref()),
            bevy_version: interner.intern_opt(record.bevy_version.as_deref()),
            title: interner.intern_opt(record.title.as_deref()),
            defaults: interner.intern_opt(record.defaults.as_deref()),
            heading: interner.intern_opt(record.heading.as_deref()),
            description: interner.intern_opt(record.description.as_deref()),
            code: interner.intern_opt(record.code.as_deref()),
            file_abs: interner.intern_opt(record.file_abs.as_deref()),
            version: interner.intern_opt(record.version.as_deref()),
            from_version: interner.intern_opt(record.from_version.as_deref()),
            to_version: interner.intern_opt(record.to_version.as_deref()),
            pr: record.pr,
            line_start: record.line_start,
            line_count: record.line_count,
            draft: record.draft,
            examples: record
                .examples
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|example| Example {
                    lang: interner.intern(&example.lang),
                    code: interner.intern(&example.code),
                    compile_fail: example.compile_fail,
                    ignored: example.ignored,
                    scraped: example.scraped,
                    source_file: interner.intern_opt(example.source_file.as_deref()),
                })
                .collect(),
            breadcrumb: record
                .breadcrumb
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|value| interner.intern(value))
                .collect(),
            categories: record
                .categories
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|value| interner.intern(value))
                .collect(),
            required_features: record
                .required_features
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|value| interner.intern(value))
                .collect(),
        });
    }

    let (symbol_map, token_map) = build_symbol_maps(&raw);
    let symbol_count = symbol_map.len();
    let token_count = token_map.len();

    let mut symbols: Vec<Symbol> = symbol_map
        .into_iter()
        .map(|(key, ids)| Symbol {
            key: interner.intern(&key),
            ids,
        })
        .collect();
    symbols.sort_by(|a, b| interner.get(a.key).cmp(interner.get(b.key)));

    let mut name_tokens: Vec<Symbol> = token_map
        .into_iter()
        .map(|(key, ids)| Symbol {
            key: interner.intern(&key),
            ids,
        })
        .collect();
    name_tokens.sort_by(|a, b| interner.get(a.key).cmp(interner.get(b.key)));

    let bevy_version = options
        .bevy_version
        .clone()
        .unwrap_or_else(|| "unversioned".to_string());
    let api_records = raw.iter().filter(|r| r.source == "rustdoc").count() as u64;
    let text_indexed = raw
        .iter()
        .filter(|r| r.source != "rustdoc" || r.kind != "field")
        .count() as u64;

    // Intern the metadata before the arena is moved into the corpus.
    let meta = Meta {
        doc_dir: interner.intern_opt(options.doc_dir.as_deref()),
        website_dir: interner.intern_opt(options.website_dir.as_deref()),
        examples_dir: interner.intern_opt(options.examples_dir.as_deref()),
        project_root: interner.intern_opt(options.project_root.as_deref()),
        version_source: interner.intern_opt(options.version_source.as_deref()),
        api_records,
        text_indexed,
    };

    let corpus = Corpus {
        format_version: FORMAT_VERSION,
        bevy_version,
        built_at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        source_fingerprint: options.source_fingerprint.clone().unwrap_or_default(),
        arena: Arena {
            bytes: interner.bytes,
            offsets: interner.offsets,
        },
        records,
        symbols,
        name_tokens,
        by_kind: counts_to_rows(by_kind),
        by_source: counts_to_rows(by_source),
        meta,
    };

    let text_started = std::time::Instant::now();
    let text = crate::text::build_index(&corpus, &out_dir.join(crate::text::TEXT_DIR))?;
    let text_build_ms = text_started.elapsed().as_millis();

    let bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&corpus)
        .map_err(|error| anyhow!("cannot serialize corpus: {error}"))?;

    fs::create_dir_all(out_dir).with_context(|| format!("cannot create {}", out_dir.display()))?;
    let archive_path = out_dir.join(ARCHIVE_FILE);
    write_atomic(&archive_path, &bytes)?;

    let sha256 = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let manifest = serde_json::json!({
        "format_version": FORMAT_VERSION,
        "rkyv": "0.8.18",
        "bevy_version": corpus.bevy_version,
        "file": ARCHIVE_FILE,
        "size": bytes.len(),
        "sha256": sha256,
        "built_at_unix": corpus.built_at_unix,
        "records": corpus.records.len(),
        "symbols": symbol_count,
        "name_tokens": token_count,
        "text": {
            "dir": crate::text::TEXT_DIR,
            "documents": text.documents,
            "bytes": text.bytes,
        },
    });
    write_atomic(
        &out_dir.join(MANIFEST_FILE),
        serde_json::to_string_pretty(&manifest)?.as_bytes(),
    )?;

    // Prove the archive loads before reporting success.
    let load_started = std::time::Instant::now();
    let loaded = LoadedCorpus::open(&archive_path)?;
    if loaded.format_version() != FORMAT_VERSION {
        bail!("archive reported the wrong format version");
    }
    let load_test_ms = load_started.elapsed().as_millis();
    let build_ms = started.elapsed().as_millis();

    Ok(BuildReport {
        records: loaded.root().records.len(),
        symbols: symbol_count,
        name_tokens: token_count,
        duplicates_merged,
        archive_bytes: bytes.len() as u64,
        archive_path,
        text_documents: text.documents,
        text_bytes: text.bytes,
        text_build_ms,
        load_test_ms,
        build_ms,
    })
}

fn counts_to_rows(map: BTreeMap<String, u64>) -> Vec<Count> {
    map.into_iter()
        .map(|(name, count)| Count { name, count })
        .collect()
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("corpus");
    let temporary = path.with_file_name(format!(".{file_name}.tmp"));
    {
        let mut file = File::create(&temporary)
            .with_context(|| format!("cannot create {}", temporary.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&temporary, path).with_context(|| format!("cannot install {}", path.display()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Symbol table and name tokens
// ---------------------------------------------------------------------------

fn build_symbol_maps(
    records: &[RecordInput],
) -> (HashMap<String, Vec<u32>>, HashMap<String, Vec<u32>>) {
    let mut symbols: HashMap<String, Vec<u32>> = HashMap::new();
    let mut tokens: HashMap<String, Vec<u32>> = HashMap::new();
    let mut keys: Vec<String> = Vec::new();

    for (index, record) in records.iter().enumerate() {
        if record.source != "rustdoc" {
            continue;
        }
        let id = index as u32;
        keys.clear();

        let leaf = base_name(&record.name);
        let owner = record.owner.as_deref().map(base_name).unwrap_or_default();
        let crate_key = record
            .crate_name
            .as_deref()
            .map(norm_key)
            .unwrap_or_default();

        if record.kind != "field" {
            for term in split_name_tokens(&leaf) {
                add_token(&mut tokens, &term, id, 1000);
            }
            if !owner.is_empty() {
                for term in split_name_tokens(&owner) {
                    add_token(&mut tokens, &term, id, 1000);
                }
            }
        }

        push_path(&mut keys, &record.full_path, &crate_key);
        if !owner.is_empty() {
            push_unique(
                &mut keys,
                &norm_key(&format!("{owner}::{}", norm_key(&leaf))),
            );
        }
        if !record.module.is_empty() {
            if owner.is_empty() {
                push_path(
                    &mut keys,
                    &format!("{}::{}", record.module, leaf),
                    &crate_key,
                );
            } else {
                push_path(
                    &mut keys,
                    &format!("{}::{}::{}", record.module, owner, leaf),
                    &crate_key,
                );
            }
        }
        push_unique(&mut keys, &norm_key(&leaf));

        for key in &keys {
            if key.is_empty() {
                continue;
            }
            let entry = symbols.entry(key.clone()).or_default();
            if entry.len() < 60 {
                entry.push(id);
            }
        }
    }

    (symbols, tokens)
}

fn push_unique(keys: &mut Vec<String>, key: &str) {
    if key.is_empty() {
        return;
    }
    if !keys.iter().any(|existing| existing == key) {
        keys.push(key.to_string());
    }
}

fn push_path(keys: &mut Vec<String>, full_path: &str, crate_key: &str) {
    let key = norm_key(full_path);
    if key.is_empty() {
        return;
    }
    push_unique(keys, &key);
    if !crate_key.is_empty()
        && let Some(rest) = key.strip_prefix(&format!("{crate_key}::"))
    {
        push_unique(keys, rest);
    }
}

fn add_token(tokens: &mut HashMap<String, Vec<u32>>, term: &str, id: u32, cap: usize) {
    if term.is_empty() {
        return;
    }
    let entry = tokens.entry(term.to_string()).or_default();
    if entry.len() < cap {
        entry.push(id);
    }
}

/// Strip generics and whitespace so `Query<'_, '_, &T>` and `Query` unify.
pub fn base_name(name: &str) -> String {
    match name.find('<') {
        Some(index) => name[..index].trim().to_string(),
        None => name.trim().to_string(),
    }
}

pub fn norm_key(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let without_generics = if value.contains('<') {
        let mut out = String::new();
        let mut depth = 0usize;
        for ch in value.chars() {
            match ch {
                '<' => {
                    if depth == 0 {
                        let trimmed = out.trim_end();
                        if trimmed.ends_with("::") {
                            let keep = trimmed.len() - 2;
                            out.truncate(keep);
                        }
                    }
                    depth += 1;
                }
                '>' => depth = depth.saturating_sub(1),
                _ if depth == 0 => out.push(ch),
                _ => {}
            }
        }
        out
    } else {
        value.to_string()
    };

    let mut cleaned: String = without_generics
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    if cleaned.ends_with("()") {
        cleaned.truncate(cleaned.len() - 2);
    }
    if let Some(rest) = cleaned.strip_prefix("::") {
        cleaned = rest.to_string();
    }
    cleaned.to_lowercase()
}

pub fn split_name_tokens(base: &str) -> Vec<String> {
    let chars: Vec<char> = base.chars().collect();
    let mut spaced = String::with_capacity(base.len() + 8);
    for (index, ch) in chars.iter().enumerate() {
        if index > 0 {
            let previous = chars[index - 1];
            let next = chars.get(index + 1).copied();
            let boundary = (ch.is_uppercase()
                && (previous.is_lowercase() || previous.is_ascii_digit()))
                || (ch.is_uppercase()
                    && previous.is_uppercase()
                    && next.is_some_and(|next| next.is_lowercase()))
                || (ch.is_ascii_digit() && previous.is_alphabetic());
            if boundary {
                spaced.push(' ');
            }
        }
        spaced.push(*ch);
    }

    spaced
        .to_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(singular_term)
        .collect()
}

pub fn singular_term(term: &str) -> String {
    if term.len() > 4 && term.ends_with("ies") {
        return format!("{}y", &term[..term.len() - 3]);
    }
    if term.ends_with("ches")
        || term.ends_with("shes")
        || term.ends_with("xes")
        || term.ends_with("zes")
    {
        return term[..term.len() - 2].to_string();
    }
    if term.len() > 3 && term.ends_with('s') && !term.ends_with("ss") && !term.ends_with("us") {
        return term[..term.len() - 1].to_string();
    }
    term.to_string()
}

pub fn symbol_rank(kind: &str) -> u8 {
    match kind {
        "struct" | "enum" | "trait" | "fn" => 0,
        "method" => 1,
        "associated_const" | "associated_type" => 2,
        _ => 3,
    }
}

/// The archive and its manifest next to a version's metadata.
pub fn archive_path_for(data_dir: &Path, version: &str) -> PathBuf {
    data_dir
        .join("versions")
        .join(crate::registry::version_dir_name(version))
        .join(ARCHIVE_FILE)
}

/// Open the corpus for a version when one has been built or downloaded.
pub fn load_optional(data_dir: &Path, version: &str) -> Result<Option<(LoadedCorpus, u128)>> {
    let path = archive_path_for(data_dir, version);
    if !path.is_file() {
        return Ok(None);
    }
    let started = std::time::Instant::now();
    let corpus = LoadedCorpus::open(&path)?;
    Ok(Some((corpus, started.elapsed().as_millis())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interner_round_trips_and_dedupes() {
        let mut interner = Interner::new();
        let empty = interner.intern("");
        let first = interner.intern("bevy_ecs");
        let again = interner.intern("bevy_ecs");
        let second = interner.intern("Query");
        assert_eq!(empty, 0);
        assert_eq!(first, again);
        assert_ne!(first, second);
        assert_eq!(interner.get(first), "bevy_ecs");
        assert_eq!(interner.get(second), "Query");
        assert_eq!(interner.get(empty), "");
    }

    #[test]
    fn norm_key_strips_generics_and_whitespace() {
        assert_eq!(norm_key("Query<'_, '_, &T>"), "query");
        assert_eq!(norm_key("App::add_systems()"), "app::add_systems");
        assert_eq!(norm_key("  ::bevy_ecs::Query  "), "bevy_ecs::query");
        assert_eq!(norm_key("HashMap<Entity, Vec<T>>"), "hashmap");
    }

    #[test]
    fn name_tokens_split_camel_case_and_singularise() {
        assert_eq!(
            split_name_tokens("HTTPServer"),
            vec!["http".to_string(), "server".to_string()]
        );
        assert_eq!(
            split_name_tokens("Camera2d"),
            vec!["camera".to_string(), "2d".to_string()]
        );
        assert_eq!(split_name_tokens("Meshes"), vec!["mesh".to_string()]);
        assert_eq!(
            split_name_tokens("AccessibilitySystems"),
            vec!["accessibility".to_string(), "system".to_string()]
        );
    }

    #[test]
    fn record_ids_match_the_typescript_rule() {
        // sha1("rustdoc|0.20.0|struct|a::B|B|") hex, first 16 chars.
        assert_eq!(
            raw_id("rustdoc", "0.20.0", "struct", "a::B", "B", "").len(),
            16
        );
        let a = raw_id("rustdoc", "0.20.0", "struct", "a::B", "B", "");
        let b = raw_id("rustdoc", "0.20.0", "struct", "a::B", "B", "");
        assert_eq!(a, b);
        let c = raw_id("rustdoc", "0.20.0", "struct", "a::C", "C", "");
        assert_ne!(a, c);
    }
}
