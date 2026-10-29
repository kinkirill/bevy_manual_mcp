//! The MCP server surface.
//!
//! Step 0 exposes the two tools that answer from `registry.json` and
//! `versions/<v>/meta.json`: `bevy_index_status` and `bevy_indexed_versions`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, bail};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, CompleteRequestParams, CompleteResult, CompletionInfo, ContentBlock, ErrorData,
    Implementation, ListResourceTemplatesResult, ListResourcesResult, MetaObject,
    PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult,
    Reference, Resource, ResourceContents, ResourceTemplate, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{RoleServer, ServerHandler, ServiceExt, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::analysis::{compat, errors, perf, report, systems};
use crate::archive::{self, LoadedCorpus};
use crate::config::Config;
use crate::ecosystem;
use crate::features;
use crate::format;
use crate::plugin;
use crate::registry::Registry;
use crate::search::{self, SearchFilters, SearchState};
use crate::status;
use crate::text::{self, TextIndex};
use crate::versions::{bump_between, cmp_version};

pub struct BevyMcp {
    config: Config,
    registry: Registry,
    corpus: Option<Arc<LoadedCorpus>>,
    corpus_load_ms: u128,
    text: Option<TextIndex>,
    text_load_ms: u128,
    tool_router: ToolRouter<Self>,
}

impl BevyMcp {
    pub fn new(config: Config) -> Self {
        let registry = Registry::load(&config.data_dir);
        let mut corpus_dir: Option<PathBuf> = None;
        let (corpus, corpus_load_ms) = match config.bevy_version.as_deref() {
            Some(version) => match archive::load_optional_resolved(&config.data_dir, version) {
                Ok(Some((corpus, resolved_version, dir, load_ms))) => {
                    if resolved_version != version {
                        config.log(format!(
                            "using the Bevy {resolved_version} corpus for {version} (same minor)"
                        ));
                    }
                    corpus_dir = Some(dir);
                    (Some(Arc::new(corpus)), load_ms)
                }
                Ok(None) => (None, 0),
                Err(error) => {
                    config.log(format!("ignoring corpus archive: {error}"));
                    (None, 0)
                }
            },
            None => (None, 0),
        };
        let (text, text_load_ms) = match (&corpus, &corpus_dir) {
            (Some(_), Some(dir)) => {
                let dir = dir.join(text::TEXT_DIR);
                if !dir.is_dir() {
                    (None, 0)
                } else {
                    let started = Instant::now();
                    match TextIndex::open(&dir) {
                        Ok(index) => (Some(index), started.elapsed().as_millis()),
                        Err(error) => {
                            config.log(format!("ignoring text index: {error}"));
                            (None, 0)
                        }
                    }
                }
            }
            _ => (None, 0),
        };
        Self {
            config,
            registry,
            corpus,
            corpus_load_ms,
            text,
            text_load_ms,
            tool_router: Self::tool_router(),
        }
    }

    fn resource_source(&self) -> crate::resources::Source<'_> {
        crate::resources::Source {
            corpus: self.corpus.as_deref(),
            active_version: self.config.bevy_version.as_deref(),
            data_dir: &self.config.data_dir,
            versions: self.registry.indexed_versions(),
        }
    }

    fn search_state(&self) -> Option<SearchState<'_>> {
        match (self.corpus.as_deref(), self.text.as_ref()) {
            (Some(corpus), Some(text)) => Some(SearchState { corpus, text }),
            _ => None,
        }
    }

    fn check_version(&self, requested: Option<&str>) -> anyhow::Result<()> {
        if let Some(requested) = requested
            && self.config.bevy_version.as_deref() != Some(requested)
        {
            bail!(
                "only the active version ({}) is loaded by this build; multi-version search arrives with the registry work",
                self.config.bevy_version.as_deref().unwrap_or("none")
            );
        }
        Ok(())
    }
}

#[tool_router]
impl BevyMcp {
    /// Reports which Bevy version is indexed, how many records exist, and which
    /// source directories were found.
    #[tool(
        name = "bevy_index_status",
        description = "Reports which Bevy version is indexed, how many records exist, and which source directories were found. Call this first if search results look wrong, empty, or from the wrong version - it is the fastest way to find out whether the API index is missing entirely."
    )]
    async fn bevy_index_status(&self) -> CallToolResult {
        let (text, structured) = status::status(
            &self.config,
            &self.registry,
            self.corpus.as_deref(),
            self.corpus_load_ms,
            self.text.as_ref().map(|index| index.doc_count()),
            self.text_load_ms,
        );
        with_structured(text, structured)
    }

    /// Hybrid search over the pinned Bevy corpus.
    #[tool(
        name = "bevy_search",
        description = "Hybrid search over the Bevy API reference (rustdoc), the Bevy Book, migration guides, release notes and engine examples, all pinned to the configured Bevy version. Use this for ANY question about how to do something in Bevy. Pass an exact symbol (e.g. \"App::add_systems\", \"Query\") to get its real signature; pass a concept (e.g. \"system ordering\", \"2d camera\") to get prose and examples. Call this before writing Bevy code - never rely on memory for signatures."
    )]
    async fn bevy_search(&self, Parameters(params): Parameters<SearchParams>) -> CallToolResult {
        match self.run_search(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Exact API lookup for a symbol.
    #[tool(
        name = "bevy_api",
        description = "Exact lookup of an API item in the rustdoc index for the configured Bevy version. Returns the real signature, full documentation, doctest examples and related items. Use this whenever you need to confirm a type, trait, method or function exists and how it is actually spelled in this version. Accepts \"Query\", \"Query::iter\", \"bevy::app::App::run\", or a pasted signature. Much more reliable than bevy_search for API questions."
    )]
    async fn bevy_api(&self, Parameters(params): Parameters<ApiParams>) -> CallToolResult {
        match self.run_api(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Find runnable code examples.
    #[tool(
        name = "bevy_examples",
        description = "Finds runnable Bevy example code, either from the engine's own `examples/` directory or from the Bevy Book's quick-start projects. Use this when you need a working pattern for a concrete task (2D/3D rendering, UI, input, audio, assets, state, gizmos) rather than an API signature. Returns the actual source code."
    )]
    async fn bevy_examples(
        &self,
        Parameters(params): Parameters<ExamplesParams>,
    ) -> CallToolResult {
        match self.run_examples(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Breaking changes between Bevy versions.
    #[tool(
        name = "bevy_migration",
        description = "Returns breaking changes between two Bevy versions. Use this whenever upgrading a project, when the user's code fails to compile, or when you are unsure whether an API changed between releases. Includes consolidated migration guides and per-PR breaking-change notes."
    )]
    async fn bevy_migration(
        &self,
        Parameters(params): Parameters<MigrationParams>,
    ) -> CallToolResult {
        match self.run_migration(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Compare one symbol across versions.
    #[tool(
        name = "bevy_api_diff",
        description = "Shows the same API symbol as it exists in each compiled Bevy version, and states plainly whether the signature changed. Use this during an upgrade to decide whether a specific call site actually needs rewriting, instead of guessing from a migration guide. Call bevy_indexed_versions first to see what is available."
    )]
    async fn bevy_api_diff(&self, Parameters(params): Parameters<DiffParams>) -> CallToolResult {
        match self.run_api_diff(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Check crates.io for a newer Bevy.
    #[tool(
        name = "bevy_check_version",
        description = "Checks crates.io for the newest published Bevy version and compares it to the version this server is indexed for. IMPORTANT: it distinguishes a PATCH release (bug fixes only, no API changes) from a MINOR release (where Bevy makes sweeping breaking API changes). Pre-releases are reported separately and never recommended as a target."
    )]
    async fn bevy_check_version(
        &self,
        Parameters(params): Parameters<CheckVersionParams>,
    ) -> CallToolResult {
        match self.run_check_version(params).await {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Lists every Bevy version this server has an index for.
    #[tool(
        name = "bevy_indexed_versions",
        description = "Lists every Bevy version this server knows about, marking the active one and whether its compiled corpus is installed. Use this to discover whether you can compare APIs across versions (for example to show a user how a signature differs between two releases). The active version is the one matching the host project's Cargo.lock; a version marked corpus=no must be installed with fetch-index before it can answer."
    )]
    async fn bevy_indexed_versions(&self) -> CallToolResult {
        let (text, structured) = status::versions(&self.config, &self.registry);
        with_structured(text, structured)
    }

    /// Check which Bevy features a project enables.
    #[tool(
        name = "bevy_check_manifest",
        description = "Checks which Bevy features are enabled in the project's Cargo.toml and whether specific symbols or subcrates are available. Use this when writing code to verify that types, plugins, or systems you reference are actually available given the project's feature flags. Returns a clear yes/no for each check with the reason why it is available or not. Uses `cargo metadata --offline --locked` when the project resolves and falls back to parsing Cargo.toml otherwise."
    )]
    async fn bevy_check_manifest(
        &self,
        Parameters(params): Parameters<CheckManifestParams>,
    ) -> CallToolResult {
        match self.run_check_manifest(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Validate system signatures against Bevy's access rules.
    #[tool(
        name = "bevy_validate_systems",
        description = "Lints one or more Rust `fn` items against Bevy's system access rules (R1-R5). Catches the class of bug that compiles cleanly but panics at runtime: B0001 (conflicting Query refs) and B0002 (Res/ResMut and &mut World conflicts). Parses with `syn`, so a `fn` inside a comment or string is ignored, and tuple queries such as Query<(&mut A, &B)> are checked per member. This is a syntax-level linter: it does not type-check, and B0001/B0002 are Bevy runtime panics, not compile errors. Reports analysis_complete: false when a parameter type or filter is not understood."
    )]
    async fn bevy_validate_systems(
        &self,
        Parameters(params): Parameters<ValidateSystemsParams>,
    ) -> CallToolResult {
        match self.run_validate_systems(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Performance advice and anti-pattern detection.
    #[tool(
        name = "bevy_perf_advisor",
        description = "Provides performance guidance for Bevy systems. With a topic argument, returns the exact API symbols to use. With code, detects anti-patterns such as manual is_changed/is_added checks that prevent archetype optimisation. Today the advice comes from built-in topics (change-detection, archetypes, scheduling) and the report says so; it is not yet derived from version-specific metadata."
    )]
    async fn bevy_perf_advisor(
        &self,
        Parameters(params): Parameters<PerfAdvisorParams>,
    ) -> CallToolResult {
        let (text, structured) = self.run_perf_advisor(params);
        with_structured(text, structured)
    }

    /// Explain a pasted Bevy panic or warning.
    #[tool(
        name = "bevy_explain_error",
        description = "Takes a pasted panic or warning message from Bevy and explains the cause, severity and suggested fix. Extracts error codes such as B0001/B0002 automatically, resolves them against the pinned version's vendored guides, and rejects codes that do not exist in that version. Uncoded panics get an honest refusal with the parsed resource type and access patterns - this tool never guesses."
    )]
    async fn bevy_explain_error(
        &self,
        Parameters(params): Parameters<ExplainErrorParams>,
    ) -> CallToolResult {
        match self.run_explain_error(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Fan-out search over the Bevy corpus and installed plugin corpora.
    #[tool(
        name = "bevy_ecosystem_search",
        description = "Fans out search across the primary Bevy corpus and any compiled plugin corpora installed under data/corpora/<crate>/<version>/ (or listed in the config's `corpora` array). Every result is labelled with its corpus id so bevy_egui::Button and bevy_ui::Button stay distinct. corpora_searched and corpora_skipped are reported truthfully; a plugin corpus that is configured but not installed is named, not silently ignored."
    )]
    async fn bevy_ecosystem_search(
        &self,
        Parameters(params): Parameters<EcosystemSearchParams>,
    ) -> CallToolResult {
        match self.run_ecosystem_search(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Plugin ↔ Bevy version compatibility from the vendored snapshot.
    #[tool(
        name = "bevy_ecosystem_compat",
        description = "Answers both directions of the plugin compatibility question: which plugin versions go with the pinned Bevy, and what does a plugin require. Uses the vendored vendor/ecosystem/compat.json snapshot only (offline, no crates.io fallback) and reports its provenance. Unsupported requirement operators yield compatible: \"unknown\", never a negative verdict, and candidate plugin versions are returned explicitly."
    )]
    async fn bevy_ecosystem_compat(
        &self,
        Parameters(params): Parameters<EcosystemCompatParams>,
    ) -> CallToolResult {
        match self.run_ecosystem_compat(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }

    /// Generate a self-contained plugin scaffold.
    #[tool(
        name = "bevy_generate_plugin",
        description = "Generates a self-contained plugin scaffold for the pinned Bevy version and fills supported parameters (PLUGIN_NAME, RESOURCE_TYPE, SYSTEM_NAME, SYSTEM_SET, UPDATE). The result is parsed with `syn` before it is returned, and every template is complete on its own. Symbol presence is reported as diagnostics only: compile_verified is always false because no compiler runs."
    )]
    async fn bevy_generate_plugin(
        &self,
        Parameters(params): Parameters<GeneratePluginParams>,
    ) -> CallToolResult {
        match self.run_generate_plugin(params) {
            Ok((text, structured)) => with_structured(text, structured),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
    }
}

impl BevyMcp {
    fn run_search(&self, params: SearchParams) -> anyhow::Result<(String, Value)> {
        self.check_version(params.version.as_deref())?;
        let state = self.search_state().ok_or_else(|| {
            anyhow!(
                "no corpus with a text index is installed for Bevy {}. Run `bevy-manual-mcp build --records <records.ndjson>` first.",
                self.config.bevy_version.as_deref().unwrap_or("<unknown>")
            )
        })?;
        let filters = SearchFilters {
            kind: params.kind,
            source: params.source,
            module: params.module,
            category: params.category,
            crate_name: params.crate_name,
            draft: params.draft,
        };
        let limit = params.limit.unwrap_or(self.config.max_results).clamp(1, 20);
        let hits = search::search(&state, &params.query, limit, &filters);
        let suggestions = if hits.is_empty() && search::looks_like_symbol(&params.query) {
            search::suggestions(state.root(), &params.query, 5)
        } else {
            Vec::new()
        };
        let text = format::search_markdown(&state, &hits, &params.query, None, &suggestions);
        let results: Vec<Value> = hits
            .iter()
            .map(|hit| format::hit_json(&state, hit))
            .collect();
        let suggestion_values: Vec<Value> = suggestions
            .iter()
            .map(|record| format::record_json(&state, record))
            .collect();
        Ok((
            text,
            json!({
                "query": params.query,
                "queried_version": self.config.bevy_version,
                "version_indexed": true,
                "results": results,
                "suggestions": suggestion_values,
            }),
        ))
    }

    fn run_api(&self, params: ApiParams) -> anyhow::Result<(String, Value)> {
        self.check_version(params.version.as_deref())?;
        let state = self.search_state().ok_or_else(|| {
            anyhow!(
                "no corpus is installed for Bevy {}. Run `bevy-manual-mcp build --records <records.ndjson>` first.",
                self.config.bevy_version.as_deref().unwrap_or("<unknown>")
            )
        })?;
        let records: Vec<_> = state
            .root()
            .lookup(&params.symbol)
            .into_iter()
            .take(6)
            .collect();
        let related = if params.include_related.unwrap_or(true) && !records.is_empty() {
            search::related_records(state.root(), records[0], 12)
        } else {
            Vec::new()
        };
        let suggestions = if records.is_empty() {
            search::suggestions(state.root(), &params.symbol, 5)
        } else {
            Vec::new()
        };
        let text = format::api_markdown(&state, &records, &params.symbol, &related, &suggestions);
        let suggestion_values: Vec<Value> = suggestions
            .iter()
            .map(|record| format::record_json(&state, record))
            .collect();
        let values: Vec<Value> = records
            .iter()
            .map(|record| format::record_json(&state, record))
            .collect();
        let related_values: Vec<Value> = related
            .iter()
            .map(|record| format::record_json(&state, record))
            .collect();
        Ok((
            text,
            json!({
                "symbol": params.symbol,
                "results": values,
                "related": related_values,
                "suggestions": suggestion_values,
            }),
        ))
    }
    fn run_examples(&self, params: ExamplesParams) -> anyhow::Result<(String, Value)> {
        let state = self.search_state().ok_or_else(|| {
            anyhow!(
                "no corpus is installed for Bevy {}. Run `bevy-manual-mcp build --records <records.ndjson>` or `bevy-manual-mcp fetch-index` first.",
                self.config.bevy_version.as_deref().unwrap_or("<unknown>")
            )
        })?;
        let filters = SearchFilters {
            kind: Some("code_example".into()),
            category: params.category.clone(),
            ..Default::default()
        };
        let limit = params.limit.unwrap_or(5).clamp(1, 15);
        let hits = search::search(&state, &params.task, limit, &filters);
        if hits.is_empty() {
            let count = state
                .root()
                .by_kind
                .iter()
                .find(|row| row.name.as_str() == "code_example")
                .map(|row| row.count.to_native())
                .unwrap_or(0);
            let engine_hint = if self.config.examples_dir.is_none() {
                " Engine examples are not installed; set BEVY_SRC_DIR to a Bevy checkout (or BEVY_EXAMPLES_DIR) to index them."
            } else {
                ""
            };
            bail!(
                "No examples matched \"{}\". The corpus has {count} code example(s){}.{}",
                params.task,
                params
                    .category
                    .as_deref()
                    .map(|category| format!(" in category \"{category}\""))
                    .unwrap_or_default(),
                engine_hint
            );
        }
        let text = format::examples_markdown(&state, &hits, &params.task);
        let results: Vec<Value> = hits
            .iter()
            .map(|hit| format::hit_json(&state, hit))
            .collect();
        Ok((
            text,
            json!({
                "task": params.task,
                "category": params.category,
                "results": results,
            }),
        ))
    }

    fn run_migration(&self, params: MigrationParams) -> anyhow::Result<(String, Value)> {
        let state = self.search_state().ok_or_else(|| {
            anyhow!(
                "no corpus is installed for Bevy {}. Run `bevy-manual-mcp build --records <records.ndjson>` or `bevy-manual-mcp fetch-index` first.",
                self.config.bevy_version.as_deref().unwrap_or("<unknown>")
            )
        })?;
        let to = params
            .to_version
            .clone()
            .or_else(|| self.config.bevy_version.clone())
            .ok_or_else(|| anyhow!("specify `to_version`, or set BEVY_VERSION"))?;
        let entries = search::find_migrations(
            state.root(),
            params.from_version.as_deref(),
            Some(&to),
            params.topic.as_deref(),
            6,
        );
        let text = format::migration_markdown(
            &state,
            &entries,
            params.from_version.as_deref(),
            &to,
            params.topic.as_deref(),
        );
        let results: Vec<Value> = entries
            .iter()
            .map(|(record, score)| {
                let mut value = format::record_json(&state, record);
                if let Value::Object(ref mut map) = value {
                    map.insert("score".into(), json!(score));
                }
                value
            })
            .collect();
        Ok((
            text,
            json!({
                "from_version": params.from_version,
                "to_version": to,
                "topic": params.topic,
                "results": results,
            }),
        ))
    }

    fn run_api_diff(&self, params: DiffParams) -> anyhow::Result<(String, Value)> {
        let installed: Vec<String> = self
            .registry
            .indexed_versions()
            .into_iter()
            .filter(|version| archive::archive_path_for(&self.config.data_dir, version).is_file())
            .collect();
        let wanted: Vec<String> = match &params.versions {
            Some(list) => split_versions(list),
            None => installed.clone(),
        };
        if wanted.len() < 2 {
            bail!(
                "need at least two compiled corpora to diff; installed: {}. Build or fetch another version first.",
                if installed.is_empty() {
                    "none".to_string()
                } else {
                    installed.join(", ")
                }
            );
        }
        for version in &wanted {
            if !installed.contains(version) {
                bail!(
                    "version {version} has no compiled corpus; installed: {}. Run `bevy-manual-mcp fetch-index {version}` first.",
                    installed.join(", ")
                );
            }
        }

        let baseline = wanted
            .iter()
            .max_by(|a, b| cmp_version(a, b))
            .cloned()
            .unwrap_or_default();

        struct Row {
            version: String,
            found: bool,
            kind: String,
            signature: String,
            docs_len: usize,
        }
        let mut rows: Vec<Row> = Vec::new();
        for version in &wanted {
            let path = archive::archive_path_for(&self.config.data_dir, version);
            let corpus = LoadedCorpus::open(&path)?;
            let hit = corpus.root().lookup(&params.symbol).into_iter().next();
            rows.push(match hit {
                Some(record) => Row {
                    version: version.clone(),
                    found: true,
                    kind: corpus.root().string(record.kind).to_string(),
                    signature: corpus.root().string(record.signature).to_string(),
                    docs_len: corpus.root().string(record.docs).chars().count(),
                },
                None => Row {
                    version: version.clone(),
                    found: false,
                    kind: String::new(),
                    signature: String::new(),
                    docs_len: 0,
                },
            });
        }

        let baseline_row = rows.iter().find(|row| row.version == baseline);
        let mut lines = vec![
            format!("# `{}` across Bevy versions", params.symbol),
            String::new(),
            "| version | state | kind | signature |".to_string(),
            "|---|---|---|---|".to_string(),
        ];
        let mut values: Vec<Value> = Vec::new();
        for row in &rows {
            let changed = match baseline_row {
                Some(base) if base.found && row.found => {
                    if base.signature == row.signature {
                        "same"
                    } else {
                        "changed"
                    }
                }
                Some(_) if row.found => "only here",
                _ => "-",
            };
            let signature_cell = if row.signature.is_empty() {
                "-".to_string()
            } else {
                row.signature.replace('\n', " ")
            };
            let kind_cell = if row.kind.is_empty() {
                "-".to_string()
            } else {
                row.kind.clone()
            };
            lines.push(format!(
                "| {} | {} | {} | {} |",
                row.version,
                if row.found { changed } else { "not found" },
                kind_cell,
                signature_cell
            ));
            values.push(json!({
                "version": row.version,
                "found": row.found,
                "kind": row.kind,
                "signature": row.signature,
                "docs_chars": row.docs_len,
                "vs_baseline": changed,
            }));
        }
        lines.push(String::new());
        lines.push(format!("Baseline: Bevy {baseline}."));
        Ok((
            lines.join("\n"),
            json!({
                "symbol": params.symbol,
                "baseline": baseline,
                "versions": values,
            }),
        ))
    }

    async fn run_check_version(
        &self,
        params: CheckVersionParams,
    ) -> anyhow::Result<(String, Value)> {
        // No cache yet: `refresh` is accepted but has no work to do.
        let _ = params.refresh;
        if self.config.offline {
            bail!("BEVY_MCP_OFFLINE=1 disables the crates.io check");
        }
        // Prefer the sparse index: it is the same host cargo uses, usually
        // reachable even when the crates.io API is blocked. BEVY_MCP_CRATES_API
        // still overrides with a JSON response for mirrors and tests.
        let (newest, preview, source) = if let Ok(url) = std::env::var("BEVY_MCP_CRATES_API")
            && !url.is_empty()
        {
            let body = crate::bundle::read_url_timeout(&url, 6).map_err(|error| {
                anyhow!(
                    "Could not read {url}: {error}. Set BEVY_MCP_OFFLINE=1 to suppress this check."
                )
            })?;
            let (newest, preview) = parse_crates_api(&body)?;
            (newest, preview, "crates.io API")
        } else {
            let index_url = crate::bundle::sparse_index_url("bevy");
            match crate::bundle::read_url_timeout(&index_url, 6)
                .and_then(|body| parse_sparse_index(&body))
            {
                Ok((newest, preview)) => (newest, preview, "sparse index"),
                Err(index_error) => {
                    let api_url = "https://crates.io/api/v1/crates/bevy";
                    match crate::bundle::read_url_timeout(api_url, 6)
                        .and_then(|body| parse_crates_api(&body))
                    {
                        Ok((newest, preview)) => (newest, preview, "crates.io API"),
                        Err(api_error) => {
                            return Err(anyhow!(
                                "Could not reach crates.io or its sparse index (index: {index_error}; api: {api_error}). Set BEVY_MCP_OFFLINE=1 to suppress this check."
                            ));
                        }
                    }
                }
            }
        };
        let mine = self.config.bevy_version.clone();
        let bump = bump_between(mine.as_deref(), Some(&newest));
        let text = format!(
            "# Bevy version status\n\n- **Indexed for:** {}\n- **Newest stable:** {newest}\n- **Newest pre-release:** {}\n- **Source:** {source}\n\n## Assessment\n\n{}\n",
            mine.as_deref().unwrap_or("UNKNOWN"),
            preview.as_deref().unwrap_or("none"),
            bump.label
        );
        Ok((
            text,
            json!({
                "indexed": mine,
                "newest_stable": newest,
                "preview": preview,
                "level": bump.level,
                "breaks_api": bump.breaks_api,
                "direction": bump.direction,
                "source": source,
            }),
        ))
    }

    fn run_check_manifest(&self, params: CheckManifestParams) -> anyhow::Result<(String, Value)> {
        let version = self.config.bevy_version.clone().ok_or_else(|| {
            anyhow!(
                "no Bevy version detected; set BEVY_VERSION or point BEVY_PROJECT_ROOT at a Cargo project"
            )
        })?;
        let data = self
            .config
            .feature_graph_path(&version)
            .as_deref()
            .and_then(features::load_path)
            .ok_or_else(|| {
                anyhow!(
                    "No feature graph available for Bevy {version}. Expected metadata/features.json in the installed bundle, or vendor/bevy-meta/{version}/features.json."
                )
            })?;
        let graph_version = data.bevy_version.clone().unwrap_or_else(|| version.clone());
        let enabled = features::enabled(&self.config.project_root, &data);
        let source = enabled.source;
        let no_manifest = !enabled.manifest_found;

        if let Some(query) = params
            .check
            .as_deref()
            .map(str::trim)
            .filter(|query| !query.is_empty())
        {
            let verdict = features::check(query, &data, &enabled.transitive);
            let mut text = format!("## Check: `{query}`\n\n{}\n\n", verdict.text);
            text.push_str(&format!(
                "- Feature graph: Bevy {graph_version}\n- Feature source: {source}\n"
            ));
            if no_manifest {
                text.push_str(
                    "- No Cargo.toml found in the project root; no features are enabled.\n",
                );
            }
            return Ok((
                text,
                json!({
                    "query": query,
                    "available": verdict.available,
                    "reason": verdict.reason,
                    "gating_feature": verdict.gating_feature,
                    "bevy_version": graph_version,
                    "source": source,
                    "no_manifest": no_manifest,
                }),
            ));
        }

        let all: Vec<String> = data.features.keys().cloned().collect();
        let disabled: Vec<String> = all
            .iter()
            .filter(|feature| !enabled.transitive.contains(feature))
            .cloned()
            .collect();

        let mut text = format!("## Bevy {graph_version} — Feature Report\n\n");
        if no_manifest {
            text.push_str(
                "> No Cargo.toml found in the project root. Showing known features for this version.\n\n",
            );
        } else {
            text.push_str(&format!("Feature source: {source}.\n"));
        }
        text.push_str(&format!(
            "**Explicit**: {}\n",
            join_or_none(&enabled.explicit)
        ));
        text.push_str(&format!(
            "**Transitive**: {}\n\n",
            join_or_none(&enabled.transitive)
        ));
        text.push_str("| Feature | Explicit | Transitive | Status |\n");
        text.push_str("|---------|----------|------------|--------|\n");
        for feature in &all {
            let explicit = enabled.explicit.contains(feature);
            let transitive = enabled.transitive.contains(feature);
            let status = if explicit {
                "explicit"
            } else if transitive {
                "transitive"
            } else {
                "off"
            };
            text.push_str(&format!(
                "| `{feature}` | {} | {} | {status} |\n",
                if explicit { "✓" } else { "-" },
                if transitive { "✓" } else { "-" }
            ));
        }
        if let Some(gates) = &data.plugin_gates
            && !gates.is_empty()
        {
            text.push_str("\n### Plugin Gates\n\n");
            for gate in gates.iter().take(20) {
                let is_enabled = enabled.transitive.contains(&gate.requires_feature);
                text.push_str(&format!(
                    "- `{}` requires `[{}]`: {}\n",
                    gate.plugin,
                    gate.requires_feature,
                    if is_enabled {
                        "✓ enabled"
                    } else {
                        "✗ disabled"
                    }
                ));
            }
            if gates.len() > 20 {
                text.push_str(&format!("\n({} more gates not shown.)\n", gates.len() - 20));
            }
        }

        Ok((
            text,
            json!({
                "bevy_version": graph_version,
                "source": source,
                "no_manifest": no_manifest,
                "default_features_enabled": enabled.default_features,
                "explicit": enabled.explicit,
                "transitive": enabled.transitive,
                "disabled": disabled,
            }),
        ))
    }

    fn run_validate_systems(
        &self,
        params: ValidateSystemsParams,
    ) -> anyhow::Result<(String, Value)> {
        let analysis = systems::analyze(&params.code);
        if let Some(error) = &analysis.parse_error {
            bail!(
                "Could not parse the provided Rust code: {error}\n\nPass one or more `fn` items, a whole file, or system signatures."
            );
        }
        if analysis.systems.is_empty() {
            bail!("No fn items found in the provided code.");
        }

        let text = report::format(&analysis, self.config.bevy_version.as_deref());
        let findings: Vec<Value> = analysis
            .findings
            .iter()
            .map(|finding| {
                json!({
                    "rule": finding.rule,
                    "severity": finding.severity,
                    "resource_type": finding.resource_type,
                    "param_a": finding.param_a,
                    "param_b": finding.param_b,
                    "description": finding.description,
                    "error_code": finding.error_code,
                    "system": finding.system,
                })
            })
            .collect();
        let analysed: Vec<Value> = analysis
            .systems
            .iter()
            .map(|system| {
                json!({
                    "name": system.name,
                    "params": system.params,
                    "accesses": system
                        .accesses
                        .iter()
                        .map(|access| json!({
                            "kind": access.kind,
                            "target": access.target,
                            "mutable": access.mutable,
                        }))
                        .collect::<Vec<_>>(),
                })
            })
            .collect();
        Ok((
            text,
            json!({
                "bevy_version": self.config.bevy_version,
                "systems_checked": analysis.systems.len(),
                "findings_count": analysis.findings.len(),
                "findings": findings,
                "systems": analysed,
                "analysis_complete": analysis.complete(),
                "unsupported": analysis.unsupported,
                "unanalyzed": analysis.unanalyzed,
                "type_checked": false,
            }),
        ))
    }

    fn run_perf_advisor(&self, params: PerfAdvisorParams) -> (String, Value) {
        let version = self.config.bevy_version.clone();
        let vendored = version
            .as_deref()
            .and_then(|version| self.config.version_metadata_dir(version))
            .map(|dir| perf::load_vendored(Some(&dir)))
            .unwrap_or_default();

        let mut topics = vendored.clone();
        for topic in perf::builtin_topics() {
            if !topics.iter().any(|known| known.topic == topic.topic) {
                topics.push(topic);
            }
        }
        let topic_source = |topic: &perf::PerfTopic| {
            if vendored.iter().any(|known| known.topic == topic.topic) {
                "vendored"
            } else {
                "builtin"
            }
        };
        let limit = params.limit.unwrap_or(8).clamp(1, 20);
        let overall_source = if vendored.is_empty() {
            "builtin"
        } else if vendored.len() == topics.len() {
            "vendored"
        } else {
            "mixed"
        };
        let anti_patterns = params
            .code
            .as_deref()
            .map(|code| perf::detect(params.topic.as_deref(), code))
            .unwrap_or_default();
        let anti_patterns_json: Vec<Value> = anti_patterns
            .iter()
            .map(|finding| {
                json!({
                    "pattern": finding.pattern,
                    "suggestion": finding.suggestion,
                })
            })
            .collect();
        let available: Vec<Value> = topics
            .iter()
            .take(limit)
            .map(|topic| {
                json!({
                    "topic": topic.topic,
                    "source": topic_source(topic),
                    "rationale": topic.rationale,
                })
            })
            .collect();

        if let Some(name) = params.topic.as_deref() {
            let Some(matched) = topics.iter().find(|topic| topic.topic == name) else {
                let names: Vec<&str> = topics.iter().map(|topic| topic.topic.as_str()).collect();
                let text = format!(
                    "## Bevy Performance Advisor\n\n⚠️ Topic `{name}` not found.\n\n**Available topics**: {}\n",
                    names.join(", ")
                );
                return (
                    text,
                    json!({
                        "topic": name,
                        "bevy_version": version,
                        "found": false,
                        "source": overall_source,
                        "available_topics": names,
                        "anti_patterns": anti_patterns_json,
                    }),
                );
            };
            let source = topic_source(matched);
            let mut text = format!(
                "## Bevy Performance Advisor\n\n### Topic: {}\n\n",
                matched.topic
            );
            if let Some(rationale) = &matched.rationale {
                text.push_str(&format!("**Rationale**: {rationale}\n\n"));
            }
            if !matched.symptoms.is_empty() {
                text.push_str("**Symptoms**:\n");
                for symptom in &matched.symptoms {
                    text.push_str(&format!("- {symptom}\n"));
                }
                text.push('\n');
            }
            if !matched.recommend.is_empty() {
                text.push_str("**Use these symbols**:\n");
                for symbol in &matched.recommend {
                    text.push_str(&format!("- `{symbol}`\n"));
                }
                text.push('\n');
            }
            if !matched.avoid.is_empty() {
                text.push_str("**Avoid these patterns**:\n");
                for pattern in &matched.avoid {
                    text.push_str(&format!("- {pattern}\n"));
                }
                text.push('\n');
            }
            if params.code.is_some() {
                if anti_patterns_json.is_empty() {
                    text.push_str("No anti-patterns detected in the provided code.\n\n");
                } else {
                    text.push_str("### Anti-Patterns Detected\n\n");
                    for finding in &anti_patterns {
                        text.push_str(&format!("- **Found**: `{}`\n", finding.pattern));
                        text.push_str(&format!("  - **Suggestion**: {}\n", finding.suggestion));
                    }
                    text.push('\n');
                }
            }
            let note = if source == "builtin" {
                " Built-in guidance is not pinned to a Bevy release; no version-specific perf metadata was loaded."
            } else {
                ""
            };
            text.push_str(&format!("> Source: {source}.{note}\n"));
            return (
                text,
                json!({
                    "topic": matched.topic,
                    "bevy_version": version,
                    "found": true,
                    "source": source,
                    "rationale": matched.rationale,
                    "symptoms": matched.symptoms,
                    "recommend": matched.recommend,
                    "avoid": matched.avoid,
                    "anti_patterns": anti_patterns_json,
                }),
            );
        }

        let mut text = String::from("## Bevy Performance Advisor\n\n**Available topics**:\n");
        for topic in topics.iter().take(limit) {
            let summary = topic
                .rationale
                .as_deref()
                .map(|rationale| {
                    let short: String = rationale.chars().take(100).collect();
                    format!(" — {short}")
                })
                .unwrap_or_default();
            text.push_str(&format!("- `{}`{summary}\n", topic.topic));
        }
        let note = if overall_source == "builtin" {
            " Built-in guidance is not pinned to a Bevy release; no version-specific perf metadata was loaded."
        } else {
            ""
        };
        text.push_str(&format!("\n> Source: {overall_source}.{note}\n"));
        (
            text,
            json!({
                "bevy_version": version,
                "found": true,
                "source": overall_source,
                "topics": available,
                "anti_patterns": anti_patterns_json,
            }),
        )
    }
}

fn corpus_hits(
    state: &SearchState<'_>,
    corpus_id: &str,
    query: &str,
    limit: usize,
) -> (Vec<Value>, String) {
    let hits = search::search(state, query, limit, &SearchFilters::default());
    let root = state.root();
    let mut values = Vec::new();
    let mut markdown = String::new();
    for hit in &hits {
        let record = hit.record;
        let mut value = format::hit_json(state, hit);
        if let Value::Object(map) = &mut value {
            map.insert("corpus".into(), json!(corpus_id));
        }
        values.push(value);
        markdown.push_str(&format!(
            "- `{}` — [{}] — `{}`\n",
            root.string(record.name),
            root.string(record.kind),
            root.string(record.full_path)
        ));
        let docs = root.string(record.docs);
        if !docs.is_empty() {
            let snippet: String = docs.chars().take(200).collect();
            markdown.push_str(&format!("  {}\n", snippet.replace('\n', " ")));
        }
    }
    (values, markdown)
}

impl BevyMcp {
    fn run_explain_error(&self, params: ExplainErrorParams) -> anyhow::Result<(String, Value)> {
        let extracted = errors::extract(&params.message);
        let version = self.config.bevy_version.clone();
        let codes_dir = version
            .as_deref()
            .and_then(|version| self.config.error_codes_dir(version));
        let version_indexed = codes_dir.is_some();

        let Some(code) = extracted.code.as_deref() else {
            let mut text = String::from("## Error Explanation\n\n");
            text.push_str("⚠️ **No error code was extracted from the message.**\n\n");
            text.push_str(
                "This is not a recognised Bevy error code, so the tool will not guess at a cause.\n\n",
            );
            if let Some(resource) = &extracted.resource_type {
                text.push_str(&format!("- Resource type: `{resource}`\n"));
            }
            for access in &extracted.access_list {
                text.push_str(&format!("- Access pattern: `{access}`\n"));
            }
            text.push_str(
                "\nFor unknown panics, use `bevy_search` or `bevy_api` to look up the types and systems named in the message.",
            );
            return Ok((
                text,
                json!({
                    "tier": 3,
                    "no_error_code_found": true,
                    "resource_type": extracted.resource_type,
                    "access_list": extracted.access_list,
                    "applicable_version": version,
                    "version_indexed": version_indexed,
                }),
            ));
        };

        let lookup_available = version_indexed && version.is_some();
        let mut guide = None;
        let mut exists_in_version = false;
        if lookup_available
            && let (Some(_version), Some(codes_dir)) = (version.as_deref(), codes_dir.as_deref())
        {
            let path = errors::guide_path(codes_dir, code);
            exists_in_version = path.is_file();
            if exists_in_version {
                guide = std::fs::read_to_string(path).ok();
            }
        }

        if lookup_available && !exists_in_version {
            let mut text = String::from("## Error Explanation\n\n");
            text.push_str(&format!(
                "⚠️ **Error code [{code}] does not exist in Bevy {}.**\n\n",
                version.as_deref().unwrap_or("UNKNOWN")
            ));
            text.push_str(
                "This code may have been introduced after your pinned version. The tool will not answer from a different version's index.",
            );
            return Ok((
                text,
                json!({
                    "code": code,
                    "severity": extracted.severity.unwrap_or("unknown"),
                    "system_name": extracted.system_name,
                    "resource_type": extracted.resource_type,
                    "access_list": extracted.access_list,
                    "applicable_version": version,
                    "version_indexed": version_indexed,
                    "does_not_exist_in_version": true,
                    "guide_available": false,
                }),
            ));
        }

        let mut text = String::from("## Error Explanation\n\n");
        text.push_str(&format!("**Error Code**: `{code}`\n"));
        text.push_str(&format!(
            "**Severity**: {}\n",
            extracted.severity.unwrap_or("unknown")
        ));
        if let Some(system) = &extracted.system_name {
            text.push_str(&format!("**System**: `{system}`\n"));
        }
        if let Some(resource) = &extracted.resource_type {
            text.push_str(&format!("**Resource Type**: `{resource}`\n"));
        }
        if !extracted.access_list.is_empty() {
            text.push_str(&format!(
                "**Access**: {}\n",
                extracted.access_list.join(", ")
            ));
        }
        text.push_str("\n---\n\n");

        let mut guide_available = false;
        if let Some(guide) = &guide {
            guide_available = true;
            let body = if params.full.unwrap_or(false) {
                guide.trim().to_string()
            } else {
                errors::short_guide(guide)
            };
            text.push_str("### Guide\n\n");
            text.push_str(&body);
            text.push('\n');
            if !params.full.unwrap_or(false) && !guide.contains("## Fix") {
                text.push_str(
                    "\n> This is the opening of the pinned guide. Request `full: true` for the complete document.\n",
                );
            }
        } else {
            text.push_str(&format!("No detailed guide available for `{code}`.\n\n"));
            if let Some(fix) = generic_error_fix(code) {
                text.push_str(&format!("**General fix**: {fix}\n"));
            }
            if !lookup_available {
                text.push_str(&format!(
                    "\nNo vendored error-code directory is available for Bevy {}; the answer cannot be version-checked.\n",
                    version.as_deref().unwrap_or("UNKNOWN")
                ));
            }
            text.push_str("\nRequest `full: true` for the full guide when one is installed.\n");
        }

        Ok((
            text,
            json!({
                "code": code,
                "severity": extracted.severity.unwrap_or("unknown"),
                "system_name": extracted.system_name,
                "resource_type": extracted.resource_type,
                "access_list": extracted.access_list,
                "applicable_version": version,
                "version_indexed": version_indexed,
                "version_checked": lookup_available,
                "does_not_exist_in_version": false,
                "guide_available": guide_available,
            }),
        ))
    }

    fn run_ecosystem_search(
        &self,
        params: EcosystemSearchParams,
    ) -> anyhow::Result<(String, Value)> {
        let limit = params.limit.unwrap_or(8).clamp(1, 20);
        let filter = params
            .crate_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty());
        let include_bevy = filter.is_none() || filter == Some("bevy");

        let mut rows: Vec<(String, Vec<Value>, String)> = Vec::new();
        let mut searched: Vec<String> = Vec::new();
        let mut skipped: Vec<ecosystem::Skipped> = Vec::new();

        if include_bevy
            && let (Some(corpus), Some(text)) = (self.corpus.as_deref(), self.text.as_ref())
        {
            let state = SearchState { corpus, text };
            let id = format!(
                "bevy@{}",
                self.config.bevy_version.as_deref().unwrap_or("unknown")
            );
            let (hits, markdown) = corpus_hits(&state, &id, &params.query, limit);
            searched.push(id.clone());
            rows.push((id, hits, markdown));
        }

        let (sources, discovered_skips) =
            ecosystem::discover(&self.config.data_dir, &self.config.corpora);
        skipped.extend(
            discovered_skips
                .into_iter()
                .filter(|skip| filter.is_none() || Some(skip.crate_name.as_str()) == filter),
        );
        for source in sources {
            if let Some(filter) = filter
                && filter != "bevy"
                && source.crate_name != filter
            {
                continue;
            }
            if filter == Some("bevy") {
                continue;
            }
            match ecosystem::load(&source) {
                Ok(loaded) => {
                    let state = SearchState {
                        corpus: &loaded.corpus,
                        text: &loaded.text,
                    };
                    let (hits, markdown) = corpus_hits(&state, &loaded.id, &params.query, limit);
                    searched.push(loaded.id.clone());
                    rows.push((loaded.id.clone(), hits, markdown));
                }
                Err(error) => skipped.push(ecosystem::Skipped {
                    crate_name: source.crate_name.clone(),
                    version: source.version.clone(),
                    reason: error.to_string(),
                }),
            }
        }

        let total_hits: usize = rows.iter().map(|(_, hits, _)| hits.len()).sum();
        let mut text = format!("# Ecosystem search: \"{}\"\n\n", params.query);
        if searched.is_empty() {
            text.push_str("No corpora were searched. ");
        } else {
            text.push_str(&format!("**Corpora searched:** {}\n", searched.join(", ")));
        }
        for (id, hits, markdown) in &rows {
            text.push_str(&format!("\n## {id} — {} hit(s)\n\n", hits.len()));
            if hits.is_empty() {
                text.push_str("No matching symbols in this corpus.\n");
            } else {
                text.push_str(markdown);
            }
        }
        if total_hits == 0 {
            text.push_str("\nNo matching symbols were found in the searched corpora.\n");
        }
        if !skipped.is_empty() {
            text.push_str("\n### Corpora skipped\n\n");
            for skip in &skipped {
                let version = skip
                    .version
                    .as_deref()
                    .map(|version| format!("@{version}"))
                    .unwrap_or_default();
                text.push_str(&format!(
                    "- `{}{version}`: {}\n",
                    skip.crate_name, skip.reason
                ));
            }
        }

        let results: Vec<Value> = rows.into_iter().flat_map(|(_, hits, _)| hits).collect();
        let skipped_json: Vec<Value> = skipped
            .iter()
            .map(|skip| {
                json!({
                    "crate": skip.crate_name,
                    "version": skip.version,
                    "reason": skip.reason,
                })
            })
            .collect();
        Ok((
            text,
            json!({
                "query": params.query,
                "bevy_version": self.config.bevy_version,
                "corpora_searched": searched,
                "corpora_skipped": skipped_json,
                "total_hits": total_hits,
                "results": results,
            }),
        ))
    }

    fn run_ecosystem_compat(
        &self,
        params: EcosystemCompatParams,
    ) -> anyhow::Result<(String, Value)> {
        let Some(path) = self.config.compat_path() else {
            bail!(
                "No compat snapshot installed. Expected metadata/compat.json in the installed bundle, vendor/ecosystem/compat.json, or BEVY_MCP_COMPAT_PATH."
            );
        };
        let snapshot = compat::load_file(&path)?;
        let provenance = serde_json::to_value(&snapshot.provenance)?;
        let version = self.config.bevy_version.clone();

        let Some(name) = params
            .crate_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            let mut text = String::from("## Plugin Compatibility\n\n");
            match version.as_deref() {
                Some(version) => text.push_str(&format!("For Bevy {version}:\n\n")),
                None => text.push_str("No Bevy version is pinned.\n\n"),
            }
            let mut plugins = Vec::new();
            for (plugin_name, entries) in &snapshot.plugins {
                let verdict = compat::aggregate(entries, version.as_deref());
                let matching = compat::matching_versions(entries, version.as_deref());
                let newest = compat::newest(entries);
                let marker = match verdict {
                    compat::Verdict::Satisfied => "OK",
                    compat::Verdict::NotSatisfied => "WARN",
                    compat::Verdict::Unknown => "UNKNOWN",
                };
                let detail = if matching.is_empty() {
                    newest
                        .map(|entry| {
                            format!(
                                "newest {} requires `{}`",
                                entry.plugin_version, entry.requires_bevy
                            )
                        })
                        .unwrap_or_else(|| "(no recorded releases)".to_string())
                } else {
                    matching.join(", ")
                };
                text.push_str(&format!("[{marker}] `{plugin_name}`: {detail}\n"));
                plugins.push(json!({
                    "crate": plugin_name,
                    "compatible": verdict.as_json(),
                    "matching_versions": matching,
                    "newest_version": newest.map(|entry| entry.plugin_version.clone()),
                    "newest_requires_bevy": newest.map(|entry| entry.requires_bevy.clone()),
                }));
            }
            text.push_str(&compat_footer(&snapshot));
            return Ok((
                text,
                json!({
                    "bevy_version": version,
                    "plugins": plugins,
                    "provenance": provenance,
                }),
            ));
        };

        let Some(entries) = snapshot.plugins.get(name) else {
            bail!(
                "No compat data for `{name}`. Available plugins: {}.",
                snapshot.provenance.crates.join(", ")
            );
        };
        let verdict = compat::aggregate(entries, version.as_deref());
        let matching = compat::matching_versions(entries, version.as_deref());
        let newest = compat::newest(entries);
        let mut available_versions = Vec::new();
        let mut seen = BTreeSet::new();
        for entry in entries {
            if seen.insert(entry.plugin_version.clone()) {
                available_versions.push(entry.plugin_version.clone());
            }
        }

        let mut text = String::from("## Plugin Compatibility\n\n");
        match verdict {
            compat::Verdict::Satisfied => {
                text.push_str(&format!(
                    "[OK] `{name}` is compatible with Bevy {}.\n\n",
                    version.as_deref().unwrap_or("UNKNOWN")
                ));
                text.push_str(&format!(
                    "Candidate plugin versions: {}.\n",
                    matching.join(", ")
                ));
            }
            compat::Verdict::NotSatisfied => {
                text.push_str(&format!(
                    "[WARN] `{name}` has no recorded release compatible with Bevy {}.\n\n",
                    version.as_deref().unwrap_or("UNKNOWN")
                ));
                if let Some(newest) = newest {
                    text.push_str(&format!(
                        "Newest recorded release: {} requires `{}` (you are on {}).\n",
                        newest.plugin_version,
                        newest.requires_bevy,
                        version.as_deref().unwrap_or("UNKNOWN")
                    ));
                }
                text.push_str(&format!(
                    "Available versions: {}.\n",
                    available_versions.join(", ")
                ));
            }
            compat::Verdict::Unknown => {
                text.push_str(&format!(
                    "[UNKNOWN] Compatibility of `{name}` with Bevy {} cannot be decided.\n\n",
                    version.as_deref().unwrap_or("UNKNOWN")
                ));
                match version.as_deref() {
                    None => text.push_str(
                        "No Bevy version is pinned, so no requirement can be evaluated.\n",
                    ),
                    Some(_) => text.push_str(
                        "At least one recorded release uses a requirement operator this build does not evaluate, so the answer is unknown rather than incompatible.\n",
                    ),
                }
                if !matching.is_empty() {
                    text.push_str(&format!(
                        "Other releases that do match: {}.\n",
                        matching.join(", ")
                    ));
                }
                text.push_str(&format!(
                    "Available versions: {}.\n",
                    available_versions.join(", ")
                ));
            }
        }
        text.push_str(&compat_footer(&snapshot));

        let verdict_label = match verdict {
            compat::Verdict::Satisfied => "satisfied",
            compat::Verdict::NotSatisfied => "not_satisfied",
            compat::Verdict::Unknown => "unknown",
        };
        Ok((
            text,
            json!({
                "crate": name,
                "bevy_version": version,
                "compatible": verdict.as_json(),
                "verdict": verdict_label,
                "matching_versions": matching,
                "newest_version": newest.map(|entry| entry.plugin_version.clone()),
                "newest_requires_bevy": newest.map(|entry| entry.requires_bevy.clone()),
                "available_versions": available_versions,
                "provenance": provenance,
            }),
        ))
    }

    fn run_generate_plugin(&self, params: GeneratePluginParams) -> anyhow::Result<(String, Value)> {
        let Some(template) = plugin::find(&params.template) else {
            let available: Vec<String> = plugin::templates()
                .iter()
                .map(|template| format!("`{}`", template.id))
                .collect();
            bail!(
                "Unknown template id `{}`. Available: {}.",
                params.template,
                available.join(", ")
            );
        };
        let defaults = BTreeMap::new();
        let rendered = plugin::render(&template, params.params.as_ref().unwrap_or(&defaults))
            .map_err(|error| anyhow!(error))?;

        let mut symbol_checks = Vec::new();
        let mut missing = Vec::new();
        if let Some(corpus) = self.corpus.as_deref() {
            for symbol in template.requires {
                let found = !corpus.lookup(symbol).is_empty();
                symbol_checks.push(json!({ "symbol": symbol, "found": found }));
                if !found {
                    missing.push(*symbol);
                }
            }
            if !missing.is_empty() {
                bail!(
                    "Template requires symbols not found in Bevy {}: {}.",
                    self.config.bevy_version.as_deref().unwrap_or("UNKNOWN"),
                    missing.join(", ")
                );
            }
        }
        let symbol_check = if self.corpus.is_some() {
            "checked"
        } else {
            "unavailable"
        };

        let text = format!(
            "## Plugin Scaffold\n\n```rust\n{}\n```\n\n> Symbol checks are diagnostics only. The scaffold was parsed with `syn` but not compiled (`compile_verified: false`).\n",
            rendered.code
        );
        Ok((
            text,
            json!({
                "template_id": template.id,
                "title": template.title,
                "bevy_version": self.config.bevy_version,
                "code": rendered.code,
                "compile_verified": false,
                "symbol_check": symbol_check,
                "symbols_checked": symbol_checks,
                "missing_symbols": missing,
                "ignored_params": rendered.ignored_params,
            }),
        ))
    }
}

fn generic_error_fix(code: &str) -> Option<&'static str> {
    match code {
        "B0001" | "B0003" => Some(
            "Use `Without<T>` to prove the queries are disjoint, or combine the conflicting access in a `ParamSet<(…)>`.",
        ),
        "B0002" | "B0004" => Some(
            "Do not mix mutable and immutable access to the same resource; use a `ParamSet` or defer one access.",
        ),
        _ => None,
    }
}

fn compat_footer(snapshot: &compat::Snapshot) -> String {
    format!(
        "\n> Snapshot: {} versions across {} crate(s), harvested {} ({}).\n",
        snapshot.provenance.version_count,
        snapshot.provenance.crates.len(),
        snapshot.provenance.harvested_at,
        snapshot.provenance.source
    )
}

fn join_or_none(values: &[String]) -> String {
    if values.is_empty() {
        "(none)".to_string()
    } else {
        values.join(", ")
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SearchParams {
    /// What to look for, e.g. "Query::iter", "add_systems ordering", "spawn ui text".
    query: String,
    /// Max results (default 8).
    #[serde(default)]
    limit: Option<usize>,
    /// Query a different indexed Bevy version (only the active one is loaded here).
    #[serde(default)]
    version: Option<String>,
    /// Restrict to record kinds, comma-separated (struct,enum,method,...).
    #[serde(default)]
    kind: Option<String>,
    /// Restrict to sources, comma-separated (rustdoc,website,bevy-examples,...).
    #[serde(default)]
    source: Option<String>,
    /// Restrict to a module path prefix.
    #[serde(default)]
    module: Option<String>,
    /// Restrict to example categories, comma-separated (2d,3d,ui,input,...).
    #[serde(default)]
    category: Option<String>,
    /// Restrict to a crate name.
    #[serde(default, rename = "crate")]
    crate_name: Option<String>,
    /// Set to false to exclude draft pages.
    #[serde(default)]
    draft: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ExamplesParams {
    /// What you want to build, e.g. "2d camera", "button ui", "keyboard input".
    task: String,
    /// Max results (default 5).
    #[serde(default)]
    limit: Option<usize>,
    /// Optional category filter, e.g. "ui", "2d", "input", "audio".
    #[serde(default)]
    category: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct MigrationParams {
    /// Version being upgraded from, e.g. "0.19". Omit with to_version for a release summary.
    #[serde(default)]
    from_version: Option<String>,
    /// Version being upgraded to, e.g. "0.20". Defaults to the configured version.
    #[serde(default)]
    to_version: Option<String>,
    /// Optional topic filter, e.g. "scheduler", "render", "ui", "asset".
    #[serde(default)]
    topic: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DiffParams {
    /// Symbol to compare, e.g. "App::add_systems", "Query", "Camera2d".
    symbol: String,
    /// Comma-separated versions, e.g. "0.19.1,0.20.0". Defaults to every compiled corpus.
    #[serde(default)]
    versions: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CheckVersionParams {
    /// Accepted for compatibility; this build always queries crates.io.
    #[serde(default)]
    refresh: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CheckManifestParams {
    /// Check a specific symbol, subcrate, or feature: "bevy_ui", "ui", "bevy::ui::Node", "DefaultPlugins". Omit to get the full manifest report.
    #[serde(default)]
    check: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ValidateSystemsParams {
    /// One or more fn items to validate (e.g. "fn move_it(q: Query<&Transform>, mut r: ResMut<Assets<Mesh>>) {}"). A whole file or method signatures are accepted too.
    code: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct PerfAdvisorParams {
    /// Topic: change-detection, archetypes, scheduling.
    #[serde(default)]
    topic: Option<String>,
    /// Optional system code to analyse for anti-patterns.
    #[serde(default)]
    code: Option<String>,
    /// Max topics to list (default 8).
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ExplainErrorParams {
    /// A pasted Bevy panic or warning message to explain.
    message: String,
    /// Include the complete guide instead of just the fix (default false).
    #[serde(default)]
    full: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct EcosystemSearchParams {
    /// Search query for API symbols, types or concepts.
    query: String,
    /// Restrict to one corpus crate, e.g. bevy_egui (or "bevy" for the engine corpus).
    #[serde(default, rename = "crate")]
    crate_name: Option<String>,
    /// Max results per corpus (default 8).
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct EcosystemCompatParams {
    /// Plugin crate name, e.g. bevy_egui. Omit to get the full matrix.
    #[serde(default, rename = "crate")]
    crate_name: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GeneratePluginParams {
    /// Template id: plugin-skeleton, plugin-with-systemset.
    template: String,
    /// Optional slot values: PLUGIN_NAME, RESOURCE_TYPE, SYSTEM_NAME, SYSTEM_SET, UPDATE. Identifier slots take a bare Rust identifier (e.g. FooPlugin); UPDATE takes a schedule path.
    #[serde(default)]
    params: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ApiParams {
    /// Symbol to look up, e.g. "App::add_systems", "Query", "Commands::spawn".
    symbol: String,
    /// Also list other methods on the same type (default true).
    #[serde(default)]
    include_related: Option<bool>,
    /// Query a different indexed Bevy version (only the active one is loaded here).
    #[serde(default)]
    version: Option<String>,
}

/// Newest stable and newest pre-release from a crates.io API response.
fn parse_crates_api(body: &[u8]) -> anyhow::Result<(String, Option<String>)> {
    let data: Value = serde_json::from_slice(body)
        .map_err(|error| anyhow!("invalid crates.io response: {error}"))?;
    let newest = data["crate"]["max_stable_version"]
        .as_str()
        .or_else(|| data["crate"]["max_version"].as_str())
        .ok_or_else(|| anyhow!("crates.io response did not contain a version"))?
        .to_string();
    let max_version = data["crate"]["max_version"]
        .as_str()
        .unwrap_or(&newest)
        .to_string();
    let preview = (max_version.contains('-') && cmp_version(&max_version, &newest).is_gt())
        .then_some(max_version);
    Ok((newest, preview))
}

/// Newest stable and newest pre-release from sparse-index NDJSON.
fn parse_sparse_index(body: &[u8]) -> anyhow::Result<(String, Option<String>)> {
    let text = std::str::from_utf8(body)
        .map_err(|error| anyhow!("sparse index response is not UTF-8: {error}"))?;
    let mut stable: Option<String> = None;
    let mut preview: Option<String> = None;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let entry: Value = serde_json::from_str(line)
            .map_err(|error| anyhow!("invalid sparse index line: {error}"))?;
        if entry["yanked"].as_bool() == Some(true) {
            continue;
        }
        let Some(version) = entry["vers"].as_str() else {
            continue;
        };
        let slot = if version.contains('-') {
            &mut preview
        } else {
            &mut stable
        };
        let better = slot
            .as_deref()
            .is_none_or(|current| cmp_version(version, current).is_gt());
        if better {
            *slot = Some(version.to_string());
        }
    }
    let newest = stable.ok_or_else(|| anyhow!("sparse index contained no stable version"))?;
    // An old RC (e.g. 0.20.0-rc.1 when 0.20.1 is stable) is not a preview of
    // anything; only show pre-releases newer than the newest stable.
    let preview = preview.filter(|preview| cmp_version(preview, &newest).is_gt());
    Ok((newest, preview))
}

fn split_versions(list: &str) -> Vec<String> {
    let mut versions: Vec<String> = Vec::new();
    for part in list.split(',') {
        let part = part.trim();
        if !part.is_empty() && !versions.iter().any(|existing| existing == part) {
            versions.push(part.to_string());
        }
    }
    versions
}

fn with_structured(text: String, structured: serde_json::Value) -> CallToolResult {
    let mut result = CallToolResult::success(vec![ContentBlock::text(text)]);
    result.structured_content = Some(structured);
    result
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for BevyMcp {
    fn get_info(&self) -> ServerConfig {
        let mut capabilities = ServerCapabilities::builder()
            .enable_tools()
            .enable_resources()
            .build();
        capabilities.completions = Some(serde_json::Map::new());
        ServerConfig::new(capabilities)
            .with_server_info(Implementation::new(
                "bevy-manual-mcp",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "Version-accurate Bevy API docs, guides, examples and migration notes. \
                 Call bevy_index_status first to see which Bevy version is indexed. \
                 Use bevy_check_manifest before suggesting feature-gated APIs, and \
                 bevy_validate_systems for a syntax-level B0001/B0002 lint (it does not \
                 type-check). The bevy:// resources expose individual API items, paginated \
                 listings by kind/module/crate/owner/file, and the indexed-version table.",
            )
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult::with_all_items(vec![
            Resource::new(crate::resources::INDEX_URI, "bevy-index")
                .with_title("Indexed Bevy versions")
                .with_description(
                    "Which Bevy versions this server can answer for, and how to construct a resource URI for any item, type, crate or kind.",
                )
                .with_mime_type("text/markdown"),
        ]))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        let templates = crate::resources::TEMPLATES
            .iter()
            .map(|template| {
                ResourceTemplate::new(template.uri_template, template.name)
                    .with_title(template.title)
                    .with_description(template.description)
                    .with_mime_type("text/markdown")
            })
            .collect();
        Ok(ListResourceTemplatesResult::with_all_items(templates))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let source = self.resource_source();
        match crate::resources::read(&source, &request.uri) {
            Ok(output) => {
                let content_uri = match &output.next_cursor {
                    Some(cursor) if request.uri.contains('?') => {
                        format!("{}&cursor={cursor}", request.uri)
                    }
                    Some(cursor) => format!("{}?cursor={cursor}", request.uri),
                    None => request.uri.clone(),
                };
                let contents = vec![
                    ResourceContents::text(output.text, content_uri)
                        .with_mime_type("text/markdown"),
                ];
                let mut result = ReadResourceResult::new(contents);
                result.ttl_ms = Some(if output.next_cursor.is_some() {
                    60_000
                } else {
                    600_000
                });
                if let (Some(total), Some(page_size)) = (output.total, output.page_size) {
                    let mut meta = serde_json::Map::new();
                    meta.insert("total".into(), json!(total));
                    meta.insert("pageSize".into(), json!(page_size));
                    if let Some(cursor) = &output.next_cursor {
                        meta.insert("nextCursor".into(), json!(cursor));
                    }
                    result.meta = Some(MetaObject(meta));
                }
                Ok(result.into())
            }
            Err(message) => Err(ErrorData::invalid_params(message, None)),
        }
    }

    async fn complete(
        &self,
        request: CompleteRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CompleteResult, ErrorData> {
        let Reference::Resource(reference) = request.r#ref else {
            return Ok(CompleteResult::default());
        };
        let context = request
            .context
            .and_then(|context| context.arguments)
            .unwrap_or_default();
        let source = self.resource_source();
        let (values, total) = crate::resources::complete(
            &source,
            &reference.uri,
            &request.argument.name,
            &request.argument.value,
            &context,
        );
        let mut info =
            CompletionInfo::new(values).map_err(|error| ErrorData::internal_error(error, None))?;
        info.total = Some(total as u32);
        info.has_more = Some(total > info.values.len());
        Ok(CompleteResult::new(info))
    }
}

pub async fn serve(config: Config) -> anyhow::Result<()> {
    if config.bevy_version.is_none() {
        config.log("WARNING: Bevy version not detected.");
        if let Some(note) = &config.version_note {
            config.log(note);
        }
        config.log("Set BEVY_VERSION, or point BEVY_PROJECT_ROOT at your Bevy Cargo project.");
    } else if !config.offline
        && let Some(version) = config.bevy_version.clone()
        && archive::resolve_version_dir(&config.data_dir, &version).is_none()
    {
        let data_dir = config.data_dir.clone();
        let fetch_version = version.clone();
        match tokio::task::spawn_blocking(move || {
            crate::bundle::fetch(&fetch_version, &data_dir, false)
        })
        .await
        {
            Ok(Ok(Some(path))) => config.log(format!(
                "installed the index for Bevy {version} at {}",
                path.display()
            )),
            Ok(Ok(None)) => {}
            Ok(Err(error)) => config.log(format!(
                "could not download the index for Bevy {version}: {error}; run `bevy-manual-mcp fetch-index {version}`"
            )),
            Err(error) => config.log(format!("index download task failed: {error}")),
        }
    }
    let service = BevyMcp::new(config).serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

pub fn serve_blocking(config: Config) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(serve(config))
}

#[cfg(test)]
mod version_source_tests {
    use super::*;

    #[test]
    fn sparse_index_picks_newest_stable_and_preview() {
        let body = br#"{"name":"bevy","vers":"0.19.1","yanked":false}
{"name":"bevy","vers":"0.20.0","yanked":false}
{"name":"bevy","vers":"0.20.1","yanked":true}
{"name":"bevy","vers":"0.21.0-rc.1","yanked":false}
{"name":"bevy","vers":"0.20.2","yanked":false}"#;
        let (stable, preview) = parse_sparse_index(body).expect("parse");
        assert_eq!(stable, "0.20.2");
        assert_eq!(preview.as_deref(), Some("0.21.0-rc.1"));

        let old_rc = br#"{"name":"bevy","vers":"0.20.0-rc.1","yanked":false}
{"name":"bevy","vers":"0.20.1","yanked":false}"#;
        let (stable, preview) = parse_sparse_index(old_rc).expect("parse");
        assert_eq!(stable, "0.20.1");
        assert_eq!(preview, None);
    }

    #[test]
    fn sparse_index_paths_follow_crates_io_rules() {
        assert_eq!(
            crate::bundle::sparse_index_url("bevy"),
            "https://index.crates.io/be/vy/bevy"
        );
        assert_eq!(
            crate::bundle::sparse_index_url("syn"),
            "https://index.crates.io/3/s/syn"
        );
    }
}
