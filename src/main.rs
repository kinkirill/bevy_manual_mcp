//! `bevy-manual-mcp` — a native MCP server for version-accurate Bevy documentation.
//!
//! The bare command serves MCP over stdio because that is how MCP clients
//! launch a server. Help lives behind `--help`/`help`; subcommands cover the
//! maintainer and debugging surface.

mod analysis;
mod archive;
mod bundle;
mod config;
mod ecosystem;
mod features;
mod format;
mod harvest;
mod ingest;
mod pagination;
mod plugin;
mod registry;
mod resources;
mod search;
mod server;
mod status;
mod text;
mod versions;

use std::fs;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};

use crate::archive::LoadedCorpus;
use crate::config::Config;

#[derive(Parser, Debug)]
#[command(
    name = "bevy-manual-mcp",
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
        /// Reinstall even when a corpus is already present.
        #[arg(long)]
        force: bool,
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
        /// Also pack the built version into a release `.tar.zst` bundle.
        #[arg(long)]
        pack: Option<PathBuf>,
        /// Write the `index-manifest.json` for the packed bundle.
        #[arg(long)]
        manifest: Option<PathBuf>,
        /// Index revision recorded in the manifest (default 1).
        #[arg(long, default_value_t = 1)]
        revision: u32,
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
    /// Mirror docs.rs rustdoc HTML for a Bevy version (maintainer tool).
    FetchDocs {
        /// Bevy version, e.g. 0.20.0. Defaults to the detected version.
        version: Option<String>,
        /// Mirror directory. Defaults to the cache next to the data dir.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Fetch bevy-website prose with a sparse git checkout (maintainer tool).
    FetchWebsite {
        /// Output directory. Defaults to <vendor>/bevy-website.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Branch or tag to fetch.
        #[arg(long = "ref", default_value = "main")]
        reference: String,
    },
    /// Harvest feature graphs and error codes from the Bevy repo (maintainer tool).
    HarvestMeta {
        version: String,
        /// Git tag to harvest. Defaults to v<version>.
        #[arg(long)]
        tag: Option<String>,
        /// Output directory. Defaults to <vendor>/bevy-meta/<version>.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Replace an existing harvest.
        #[arg(long)]
        force: bool,
    },
    /// Harvest plugin compatibility from crates.io (maintainer tool).
    HarvestCompat {
        /// Output directory. Defaults to <vendor>/ecosystem.
        #[arg(long)]
        out: Option<PathBuf>,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let config = Config::load();

    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => {
            if std::io::stdin().is_terminal() {
                eprintln!(
                    "bevy-manual-mcp {}: serving MCP over stdio — Ctrl-C to exit; see --help",
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
                        let dir = archive::resolve_version_dir(&config.data_dir, version)
                            .map(|(_, dir)| dir.join(text::TEXT_DIR));
                        if let Some(dir) = dir.filter(|dir| dir.is_dir()) {
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
        Command::FetchIndex { version, force } => {
            if config.offline {
                bail!("BEVY_MCP_OFFLINE=1 forbids downloading an index");
            }
            let version = version
                .or_else(|| config.bevy_version.clone())
                .ok_or_else(|| {
                    anyhow!("no Bevy version given and none detected; pass a version")
                })?;
            match bundle::fetch(&version, &config.data_dir, force)? {
                Some(path) => {
                    println!("# index installed");
                    println!();
                    println!("- Bevy version: {version}");
                    println!("- location: {}", path.display());
                    println!("- data dir: {}", config.data_dir.display());
                    Ok(())
                }
                None => {
                    println!(
                        "Index for Bevy {version} is already installed at {}. Use --force to reinstall.",
                        config
                            .data_dir
                            .join("versions")
                            .join(registry::version_dir_name(&version))
                            .display()
                    );
                    Ok(())
                }
            }
        }
        Command::Build {
            doc_dir,
            out,
            records,
            pack,
            manifest,
            revision,
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
            let doc_root = doc_dir
                .clone()
                .or_else(|| config.doc_dir.clone())
                .or_else(|| {
                    registry::Registry::load(&config.data_dir)
                        .meta(&version)
                        .and_then(|meta| meta.doc_dir.map(PathBuf::from))
                });
            let mut inputs = match records.as_ref() {
                Some(path) => archive::read_ndjson(path)?,
                None => {
                    let Some(doc_root) = doc_root.as_deref() else {
                        bail!(
                            "no --records given and no rustdoc directory found; pass --doc-dir or set BEVY_DOC_DIR"
                        );
                    };
                    eprintln!(
                        "[bevy-manual-mcp] ingesting rustdoc from {}",
                        doc_root.display()
                    );
                    ingest::rustdoc::ingest_rustdoc(Some(doc_root), Some(version.as_str()))
                }
            };
            let registry = registry::Registry::load(&config.data_dir);
            let meta = registry.meta(&version);
            let options = archive::BuildOptions {
                bevy_version: Some(version.clone()),
                doc_dir: doc_root.as_ref().map(|path| path.display().to_string()),
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
                "[bevy-manual-mcp] compiling {} source record(s) for Bevy {version} into {}",
                inputs.len(),
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
                "[bevy-manual-mcp] supplemental sources: website={}, examples={}, error_codes={}",
                website.len(),
                examples.len(),
                error_codes.len()
            );
            inputs.extend(website);
            inputs.extend(examples);
            inputs.extend(error_codes);
            let report = archive::build(inputs, &out_dir, &options)?;
            if let Err(error) = copy_version_metadata(&config, &version, &out_dir) {
                eprintln!("[bevy-manual-mcp] metadata not bundled: {error}");
            }
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
            if let Some(path) = pack {
                let size = bundle::pack(&out_dir, &path)?;
                println!(
                    "- bundle: {} ({:.1} MB)",
                    path.display(),
                    size as f64 / 1_000_000.0
                );
                if let Some(manifest_path) = manifest {
                    bundle::write_release_manifest(&path, &version, &manifest_path, revision)?;
                    println!("- manifest: {}", manifest_path.display());
                }
            }
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
                    "no corpus archive for Bevy {version}; run `bevy-manual-mcp build --records <records.ndjson>` first"
                );
            };
            let text_dir = archive::resolve_version_dir(&config.data_dir, &version)
                .map(|(_, dir)| dir.join(text::TEXT_DIR))
                .filter(|dir| dir.is_dir())
                .ok_or_else(|| {
                    anyhow!(
                        "no text index for Bevy {version}; run `bevy-manual-mcp build --records <records.ndjson>` first"
                    )
                })?;
            if !text_dir.is_dir() {
                bail!(
                    "no text index at {}; run `bevy-manual-mcp build --records <records.ndjson>` first",
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
            let suggestions = if hits.is_empty() && search::looks_like_symbol(&query) {
                search::suggestions(state.root(), &query, 5)
            } else {
                Vec::new()
            };
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
                println!(
                    "{}",
                    format::search_markdown(&state, &hits, &query, None, &suggestions)
                );
            }
            Ok(())
        }
        Command::Lookup { symbol, json } => {
            let version = config
                .bevy_version
                .clone()
                .ok_or_else(|| anyhow!("no Bevy version detected; set BEVY_VERSION"))?;
            let Some((_, corpus_dir)) = archive::resolve_version_dir(&config.data_dir, &version)
            else {
                bail!(
                    "no corpus archive for Bevy {version}; run `bevy-manual-mcp build --records <records.ndjson>` or `bevy-manual-mcp fetch-index {version}`"
                );
            };
            let path = corpus_dir.join(archive::ARCHIVE_FILE);
            let started = std::time::Instant::now();
            let corpus = LoadedCorpus::open(&path)?;
            let load_ms = started.elapsed().as_millis();
            if config.debug {
                eprintln!(
                    "[bevy-manual-mcp] corpus loaded in {load_ms} ms ({} bytes, validation included)",
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
                let suggestions = search::suggestions(corpus.root(), &symbol, 5);
                if !suggestions.is_empty() {
                    println!();
                    println!(
                        "{}",
                        format::suggestions_markdown(corpus.root(), &suggestions)
                    );
                }
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
                    "[bevy-manual-mcp] lookup {symbol:?} returned {} hit(s)",
                    hits.len()
                );
            }
            Ok(())
        }
        Command::Explain { query, json } => {
            bail!("`explain {query:?}` is not implemented yet (arrives in step 2); json={json}")
        }
        Command::FetchDocs { version, out } => {
            let version = version
                .or_else(|| config.bevy_version.clone())
                .ok_or_else(|| anyhow!("no Bevy version given and none detected"))?;
            let out = out.unwrap_or_else(|| {
                config
                    .data_dir
                    .parent()
                    .map(|parent| parent.join(format!("bevy-{version}")))
                    .unwrap_or_else(|| PathBuf::from(format!("bevy-{version}")))
            });
            harvest::docs::fetch_docs(&version, &out)?;
            Ok(())
        }
        Command::FetchWebsite { out, reference } => {
            let vendor = config
                .meta_dir
                .as_ref()
                .and_then(|meta| meta.parent())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| config.data_dir.clone());
            let out = out.unwrap_or_else(|| vendor.join("bevy-website"));
            harvest::website::fetch_website(&out, &reference)?;
            Ok(())
        }
        Command::HarvestMeta {
            version,
            tag,
            out,
            force,
        } => {
            let out = out
                .or_else(|| config.meta_dir.as_ref().map(|meta| meta.join(&version)))
                .unwrap_or_else(|| harvest::meta::default_out(&version));
            harvest::meta::harvest_meta(&harvest::meta::MetaOptions {
                version,
                tag,
                out,
                force,
            })?;
            Ok(())
        }
        Command::HarvestCompat { out } => {
            let out = out.unwrap_or_else(|| {
                config
                    .meta_dir
                    .as_ref()
                    .and_then(|meta| meta.parent())
                    .map(|vendor| vendor.join("ecosystem"))
                    .unwrap_or_else(|| PathBuf::from("vendor").join("ecosystem"))
            });
            harvest::compat::harvest_compat(&out)?;
            Ok(())
        }
    }
}

/// Copy the checkout's feature graph, error codes and compat snapshot into the
/// version directory so they travel inside the release bundle.
fn copy_version_metadata(config: &Config, version: &str, out_dir: &Path) -> anyhow::Result<()> {
    let Some(source) = config
        .meta_dir
        .as_ref()
        .map(|meta| meta.join(version))
        .filter(|path| path.is_dir())
    else {
        return Ok(());
    };
    let target = out_dir.join("metadata");
    fs::create_dir_all(&target)?;
    for name in ["features.json", "perf.json"] {
        let file = source.join(name);
        if file.is_file() {
            fs::copy(&file, target.join(name))?;
        }
    }
    let codes = source.join("error-codes");
    if codes.is_dir() {
        let destination = target.join("error-codes");
        fs::create_dir_all(&destination)?;
        for entry in fs::read_dir(codes)?.flatten() {
            let path = entry.path();
            if path.is_file()
                && path.extension().is_some_and(|ext| ext == "md")
                && let Some(name) = path.file_name()
            {
                fs::copy(&path, destination.join(name))?;
            }
        }
    }
    if let Some(vendor) = config.meta_dir.as_ref().and_then(|meta| meta.parent()) {
        let compat = vendor.join("ecosystem").join("compat.json");
        if compat.is_file() {
            fs::copy(compat, target.join("compat.json"))?;
        }
    }
    Ok(())
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
