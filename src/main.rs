//! `bevy-mcp` — a native MCP server for version-accurate Bevy documentation.
//!
//! The bare command serves MCP over stdio because that is how MCP clients
//! launch a server. Help lives behind `--help`/`help`; subcommands cover the
//! maintainer and debugging surface.

mod config;
mod registry;
mod server;
mod status;
mod versions;

use std::io::IsTerminal;
use std::path::PathBuf;

use anyhow::bail;
use clap::{Parser, Subcommand};

use crate::config::Config;

#[derive(Parser, Debug)]
#[command(
    name = "bevy-mcp",
    version,
    about = "Version-accurate Bevy API docs, guides, examples and migration notes as an MCP server",
    long_about = None
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Serve MCP over stdio (the default when no subcommand is given).
    Serve,
    /// Show the detected Bevy version, corpus state and paths.
    Status,
    /// List the Bevy versions this installation has an index for.
    Versions,
    /// Download the prebuilt index bundle for a Bevy version.
    FetchIndex {
        /// Bevy version, e.g. 0.20.0. Defaults to the detected version.
        version: Option<String>,
    },
    /// Build a corpus bundle from local documentation.
    Build {
        /// `cargo doc` output (or a docs.rs mirror) to ingest.
        #[arg(long)]
        doc_dir: Option<PathBuf>,
        /// Where to write the bundle. Defaults to the data directory.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Search the corpus from the command line.
    Search {
        query: String,
        /// Emit structured JSON instead of markdown.
        #[arg(long)]
        json: bool,
        #[arg(long, default_value_t = 8)]
        limit: usize,
    },
    /// Look up an exact symbol.
    Lookup {
        symbol: String,
        /// Emit structured JSON instead of markdown.
        #[arg(long)]
        json: bool,
    },
    /// Show how a query is scored.
    Explain {
        query: String,
        /// Emit structured JSON instead of markdown.
        #[arg(long)]
        json: bool,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let config = Config::load();

    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => {
            if std::io::stdin().is_terminal() {
                eprintln!(
                    "bevy-mcp {}: serving MCP over stdio — Ctrl-C to exit; see --help",
                    env!("CARGO_PKG_VERSION")
                );
            }
            server::serve_blocking(config)
        }
        Command::Status => {
            let registry = registry::Registry::load(&config.data_dir);
            let (text, _) = status::status(&config, &registry);
            println!("{text}");
            Ok(())
        }
        Command::Versions => {
            let registry = registry::Registry::load(&config.data_dir);
            let (text, _) = status::versions(&config, &registry);
            println!("{text}");
            Ok(())
        }
        Command::FetchIndex { version } => bail!(
            "`fetch-index {}` is not implemented yet (arrives in step 1)",
            version.as_deref().unwrap_or("<detected>")
        ),
        Command::Build { doc_dir, out } => bail!(
            "`build` is not implemented yet (arrives in step 6); doc_dir={:?} out={:?}",
            doc_dir,
            out
        ),
        Command::Search { query, json, limit } => bail!(
            "`search {query:?}` is not implemented yet (arrives in step 2); json={json} limit={limit}"
        ),
        Command::Lookup { symbol, json } => {
            bail!("`lookup {symbol:?}` is not implemented yet (arrives in step 2); json={json}")
        }
        Command::Explain { query, json } => {
            bail!("`explain {query:?}` is not implemented yet (arrives in step 2); json={json}")
        }
    }
}
