//! `bevy-mcp` — a native MCP server for version-accurate Bevy documentation.
//!
//! The bare command serves MCP over stdio because that is how MCP clients
//! launch a server. Help lives behind `--help`/`help`; subcommands cover the
//! maintainer and debugging surface.

mod archive;
mod config;
mod format;
mod ingest;
mod registry;
mod search;
mod server;
mod status;
mod text;
mod versions;

use std::io::IsTerminal;
use std::path::PathBuf;

use anyhow::{anyhow, bail};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};

use crate::archive::LoadedCorpus;
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
        /// Compile an existing records.ndjson instead of ingesting sources.
        #[arg(long)]
        records: Option<PathBuf>,
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
            let (corpus, load_ms) = load_corpus(&config);
            let (text_documents, text_load_ms) = match corpus.as_ref() {
                Some(_) => match config.bevy_version.as_deref() {
                    Some(version) => {
                        let dir = config
                            .data_dir
                            .join("versions")
                            .join(registry::version_dir_name(version))
                            .join(text::TEXT_DIR);
                        if dir.is_dir() {
                            let started = std::time::Instant::now();
                            match text::TextIndex::open(&dir) {
                                Ok(index) => {
                                    (Some(index.doc_count()), started.elapsed().as_millis())
                                }
                                Err(_) => (None, 0),
                            }
                        } else {
                            (None, 0)
                        }
                    }
                    None => (None, 0),
                },
                None => (None, 0),
            };
            let (text, _) = status::status(
                &config,
                &registry,
                corpus.as_ref(),
                load_ms,
                text_documents,
                text_load_ms,
            );
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
            "`fetch-index {}` is not implemented yet (arrives with the published bundle)",
            version.as_deref().unwrap_or("<detected>")
        ),
        Command::Build {
            doc_dir,
            out,
            records,
        } => {
            let version = config
                .bevy_version
                .clone()
                .ok_or_else(|| anyhow!("no Bevy version detected; set BEVY_VERSION"))?;
            let out_dir = out.unwrap_or_else(|| {
                config
                    .data_dir
                    .join("versions")
                    .join(registry::version_dir_name(&version))
            });
            let records_path = match records {
                Some(path) => path,
                None => {
                    if let Some(doc_dir) = doc_dir {
                        bail!(
                            "ingest from {} arrives in step 6; pass --records for now",
                            doc_dir.display()
                        );
                    }
                    out_dir.join("records.ndjson")
                }
            };
            let registry = registry::Registry::load(&config.data_dir);
            let meta = registry.meta(&version);
            let options = archive::BuildOptions {
                bevy_version: Some(version.clone()),
                doc_dir: doc_dir
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .or_else(|| config.doc_dir.as_ref().map(|p| p.display().to_string()))
                    .or_else(|| meta.as_ref().and_then(|m| m.doc_dir.clone())),
                website_dir: config
                    .website_dir
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .or_else(|| meta.as_ref().and_then(|m| m.website_dir.clone())),
                examples_dir: config
                    .examples_dir
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .or_else(|| meta.as_ref().and_then(|m| m.examples_dir.clone())),
                project_root: meta
                    .as_ref()
                    .and_then(|m| m.project_root.clone())
                    .or_else(|| Some(config.project_root.display().to_string())),
                version_source: config.version_source.clone(),
                source_fingerprint: meta.as_ref().and_then(|m| m.fingerprint.clone()),
            };
            eprintln!(
                "[bevy-mcp] compiling {} for Bevy {version} into {}",
                records_path.display(),
                out_dir.display()
            );

            let website = ingest::markdown::ingest_website(
                config.website_dir.as_deref(),
                Some(version.as_str()),
            );
            let examples = ingest::examples::ingest_examples(
                config.examples_dir.as_deref(),
                config.website_dir.as_deref(),
                &version,
            );
            let error_codes = ingest::meta::ingest_error_codes(
                config.errors_dir.as_deref(),
                config.meta_dir.as_deref(),
                &version,
            );
            eprintln!(
                "[bevy-mcp] supplemental sources: website={}, examples={}, error_codes={}",
                website.len(),
                examples.len(),
                error_codes.len()
            );
            let mut inputs = archive::read_ndjson(&records_path)?;
            inputs.extend(website);
            inputs.extend(examples);
            inputs.extend(error_codes);
            let report = archive::build(inputs, &out_dir, &options)?;
            println!("# corpus built");
            println!();
            println!("- records: {}", report.records);
            println!("- merged duplicates: {}", report.duplicates_merged);
            println!("- symbol keys: {}", report.symbols);
            println!("- name tokens: {}", report.name_tokens);
            println!(
                "- text index: {} documents ({:.1} MB) in {} ms",
                report.text_documents,
                report.text_bytes as f64 / 1_000_000.0,
                report.text_build_ms
            );
            println!(
                "- archive: {} ({:.1} MB)",
                report.archive_path.display(),
                report.archive_bytes as f64 / 1_000_000.0
            );
            println!("- build: {} ms", report.build_ms);
            println!("- validated load: {} ms", report.load_test_ms);
            Ok(())
        }
        Command::Search { query, json, limit } => {
            let version = config
                .bevy_version
                .clone()
                .ok_or_else(|| anyhow!("no Bevy version detected; set BEVY_VERSION"))?;
            let (corpus, _) = load_corpus(&config);
            let Some(corpus) = corpus else {
                bail!(
                    "no corpus archive for Bevy {version}; run `bevy-mcp build --records <records.ndjson>` first"
                );
            };
            let text_dir = config
                .data_dir
                .join("versions")
                .join(registry::version_dir_name(&version))
                .join(text::TEXT_DIR);
            if !text_dir.is_dir() {
                bail!(
                    "no text index at {}; run `bevy-mcp build --records <records.ndjson>` first",
                    text_dir.display()
                );
            }
            let text_index = text::TextIndex::open(&text_dir)?;
            let state = search::SearchState {
                corpus: &corpus,
                text: &text_index,
            };
            let hits = search::search(
                &state,
                &query,
                limit.clamp(1, 20),
                &search::SearchFilters::default(),
            );
            if json {
                let rows: Vec<Value> = hits
                    .iter()
                    .map(|hit| format::hit_json(&state, hit))
                    .collect();
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "query": query,
                        "results": rows,
                    }))?
                );
            } else {
                println!("{}", format::search_markdown(&state, &hits, &query, None));
            }
            Ok(())
        }
        Command::Lookup { symbol, json } => {
            let version = config
                .bevy_version
                .clone()
                .ok_or_else(|| anyhow!("no Bevy version detected; set BEVY_VERSION"))?;
            let path = archive::archive_path_for(&config.data_dir, &version);
            if !path.is_file() {
                bail!(
                    "no corpus archive for Bevy {version} at {}; run `bevy-mcp build --records <records.ndjson>`",
                    path.display()
                );
            }
            let started = std::time::Instant::now();
            let corpus = LoadedCorpus::open(&path)?;
            let load_ms = started.elapsed().as_millis();
            if config.debug {
                eprintln!(
                    "[bevy-mcp] corpus loaded in {load_ms} ms ({} bytes, validation included)",
                    corpus.size()
                );
            }
            let hits = corpus.lookup(&symbol);
            if json {
                let rows: Vec<Value> = hits
                    .iter()
                    .map(|record| record_json(&corpus, record))
                    .collect();
                println!("{}", serde_json::to_string_pretty(&rows)?);
            } else if hits.is_empty() {
                println!("No symbol matched `{symbol}`.");
            } else {
                for record in &hits {
                    let root = corpus.root();
                    println!("## {}", root.string(record.full_path));
                    println!();
                    if !root.string(record.signature).is_empty() {
                        println!("```rust");
                        println!("{}", root.string(record.signature));
                        println!("```");
                        println!();
                    }
                    if !root.string(record.docs).is_empty() {
                        println!("{}", root.string(record.docs));
                        println!();
                    }
                }
            }
            if config.debug {
                eprintln!(
                    "[bevy-mcp] lookup {symbol:?} returned {} hit(s)",
                    hits.len()
                );
            }
            Ok(())
        }
        Command::Explain { query, json } => {
            bail!("`explain {query:?}` is not implemented yet (arrives in step 2); json={json}")
        }
    }
}

fn load_corpus(config: &Config) -> (Option<LoadedCorpus>, u128) {
    let Some(version) = config.bevy_version.as_deref() else {
        return (None, 0);
    };
    match archive::load_optional(&config.data_dir, version) {
        Ok(Some((corpus, load_ms))) => (Some(corpus), load_ms),
        Ok(None) => (None, 0),
        Err(error) => {
            config.log(format!("ignoring corpus archive: {error}"));
            (None, 0)
        }
    }
}

fn record_json(corpus: &LoadedCorpus, record: &archive::ArchivedRecord) -> Value {
    let root = corpus.root();
    let text = |id| root.string(id);
    let nullable = |value: &str| {
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value.to_string())
        }
    };
    json!({
        "id": text(record.hash),
        "source": text(record.source),
        "kind": text(record.kind),
        "name": text(record.name),
        "full_path": text(record.full_path),
        "signature": text(record.signature),
        "docs": text(record.docs),
        "module": text(record.module),
        "owner": nullable(text(record.owner)),
        "crate": nullable(text(record.crate_name)),
        "bevy_version": nullable(text(record.bevy_version)),
    })
}
