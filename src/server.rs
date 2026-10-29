//! The MCP server surface.
//!
//! Step 0 exposes the two tools that answer from `registry.json` and
//! `versions/<v>/meta.json`: `bevy_index_status` and `bevy_indexed_versions`.

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, ServiceExt, tool, tool_handler, tool_router};

use std::sync::Arc;

use crate::archive::{self, LoadedCorpus};
use crate::config::Config;
use crate::registry::Registry;
use crate::status;

#[derive(Clone)]
pub struct BevyMcp {
    config: Config,
    registry: Registry,
    corpus: Option<Arc<LoadedCorpus>>,
    corpus_load_ms: u128,
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
        Self {
            config,
            registry,
            corpus,
            corpus_load_ms,
            tool_router: Self::tool_router(),
        }
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
        );
        with_structured(text, structured)
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
