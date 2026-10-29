//! The MCP server surface.
//!
//! Step 0 exposes the two tools that answer from `registry.json` and
//! `versions/<v>/meta.json`: `bevy_index_status` and `bevy_indexed_versions`.

use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, bail};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, ServiceExt, tool, tool_handler, tool_router};
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

fn with_structured(text: String, structured: serde_json::Value) -> CallToolResult {
    let mut result = CallToolResult::success(vec![ContentBlock::text(text)]);
    result.structured_content = Some(structured);
    result
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for BevyMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("bevy-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Version-accurate Bevy API docs, guides, examples and migration notes. \
                 Call bevy_index_status first to see which Bevy version is indexed.",
            )
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
