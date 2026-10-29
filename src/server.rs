//! The MCP server surface.
//!
//! Step 0 exposes the two tools that answer from `registry.json` and
//! `versions/<v>/meta.json`: `bevy_index_status` and `bevy_indexed_versions`.

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

use crate::archive::{self, LoadedCorpus};
use crate::config::Config;
use crate::format;
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
        let (corpus, corpus_load_ms) = match config.bevy_version.as_deref() {
            Some(version) => match archive::load_optional(&config.data_dir, version) {
                Ok(Some((corpus, load_ms))) => (Some(Arc::new(corpus)), load_ms),
                Ok(None) => (None, 0),
                Err(error) => {
                    config.log(format!("ignoring corpus archive: {error}"));
                    (None, 0)
                }
            },
            None => (None, 0),
        };
        let (text, text_load_ms) = match (&config.bevy_version, &corpus) {
            (Some(version), Some(_)) => {
                let dir = config
                    .data_dir
                    .join("versions")
                    .join(crate::registry::version_dir_name(version))
                    .join(text::TEXT_DIR);
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
        description = "Lists every Bevy version this server has an index for, marking which one is active. Use this to discover whether you can compare APIs across versions (for example to show a user how a signature differs between two releases). The active version is the one matching the host project's Cargo.lock."
    )]
    async fn bevy_indexed_versions(&self) -> CallToolResult {
        let (text, structured) = status::versions(&self.config, &self.registry);
        with_structured(text, structured)
    }
}

impl BevyMcp {
    fn run_search(&self, params: SearchParams) -> anyhow::Result<(String, Value)> {
        self.check_version(params.version.as_deref())?;
        let state = self.search_state().ok_or_else(|| {
            anyhow!(
                "no corpus with a text index is installed for Bevy {}. Run `bevy-mcp build --records <records.ndjson>` first.",
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
                "no corpus is installed for Bevy {}. Run `bevy-mcp build --records <records.ndjson>` first.",
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
                "no corpus is installed for Bevy {}. Run `bevy-mcp build --records <records.ndjson>` or `bevy-mcp fetch-index` first.",
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
                "no corpus is installed for Bevy {}. Run `bevy-mcp build --records <records.ndjson>` or `bevy-mcp fetch-index` first.",
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
                    "version {version} has no compiled corpus; installed: {}",
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
        let url = std::env::var("BEVY_MCP_CRATES_API")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "https://crates.io/api/v1/crates/bevy".to_string());
        // A hard outer cap guarantees a response even if name resolution or a
        // proxy misbehaves beyond ureq's own timeouts.
        let background_url = url.clone();
        let body = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            tokio::task::spawn_blocking(move || {
                crate::bundle::read_url_timeout(&background_url, 6)
            }),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "crates.io request timed out after 8s. Set BEVY_MCP_OFFLINE=1 to suppress this check."
            )
        })?
        .map_err(|error| anyhow!("crates.io request task failed: {error}"))?
        .map_err(|error| {
            anyhow!(
                "Could not reach crates.io at {url}: {error}. Set BEVY_MCP_OFFLINE=1 to suppress this check."
            )
        })?;
        let data: Value = serde_json::from_slice(&body)
            .map_err(|error| anyhow!("invalid crates.io response from {url}: {error}"))?;
        let newest = data["crate"]["max_stable_version"]
            .as_str()
            .or_else(|| data["crate"]["max_version"].as_str())
            .ok_or_else(|| anyhow!("crates.io response did not contain a version"))?
            .to_string();
        let max_version = data["crate"]["max_version"]
            .as_str()
            .unwrap_or(&newest)
            .to_string();
        let preview = if max_version.contains('-') && max_version != newest {
            Some(max_version)
        } else {
            None
        };
        let mine = self.config.bevy_version.clone();
        let bump = bump_between(mine.as_deref(), Some(&newest));
        let text = format!(
            "# Bevy version status\n\n- **Indexed for:** {}\n- **Newest stable:** {newest}\n- **Newest pre-release:** {}\n\n## Assessment\n\n{}\n",
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
            }),
        ))
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
            .with_server_info(Implementation::new("bevy-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Version-accurate Bevy API docs, guides, examples and migration notes. \
                 Call bevy_index_status first to see which Bevy version is indexed. \
                 The bevy:// resources expose individual API items, paginated listings \
                 by kind/module/crate/owner/file, and the indexed-version table.",
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
