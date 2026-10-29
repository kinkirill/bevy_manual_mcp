//! Bundle packing, release manifests, and `fetch-index`.
//!
//! A bundle is a zstd-compressed tar of one version directory's compiled
//! artifacts (`corpus.rkyv`, `tantivy/`, manifests, `meta.json`). The canonical
//! `records.ndjson` is deliberately not shipped.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::archive::{ARCHIVE_FILE, FORMAT_VERSION, LoadedCorpus};
use crate::registry::version_dir_name;
use crate::text::TEXT_DIR;

pub const RELEASE_MANIFEST: &str = "index-manifest.json";
/// 1 was the TypeScript bundle; Rust bundles are 2.
pub const RUST_MANIFEST_VERSION: u32 = 2;
pub const DEFAULT_RELEASES_BASE: &str =
    "https://github.com/kinkirill/bevy_manual_mcp/releases/download";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseManifest {
    pub manifest_version: u32,
    pub bevy_version: String,
    pub asset: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub format_version: Option<u32>,
    #[serde(default)]
    pub revision: Option<u32>,
    #[serde(default)]
    pub records: Option<u64>,
    #[serde(default)]
    pub text_documents: Option<u64>,
}

/// Pack a built version directory into `out`.
pub fn pack(version_dir: &Path, out: &Path) -> Result<u64> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let file =
        File::create(out).with_context(|| format!("cannot create bundle {}", out.display()))?;
    let mut encoder = zstd::Encoder::new(file, 10)?;
    {
        let mut tar = tar::Builder::new(&mut encoder);
        append(&mut tar, version_dir, ARCHIVE_FILE)?;
        let tantivy = version_dir.join(TEXT_DIR);
        if tantivy.is_dir() {
            tar.append_dir_all(TEXT_DIR, &tantivy)
                .context("cannot add the text index to the bundle")?;
        }
        append(&mut tar, version_dir, "corpus.manifest.json")?;
        append(&mut tar, version_dir, "meta.json")?;
        tar.finish().context("cannot finish the bundle tar")?;
    }
    encoder.finish().context("cannot finish the zstd stream")?;

    Ok(fs::metadata(out).map(|meta| meta.len()).unwrap_or(0))
}

fn append<W: Write>(tar: &mut tar::Builder<W>, dir: &Path, name: &str) -> Result<()> {
    let path = dir.join(name);
    if !path.is_file() {
        return Ok(());
    }
    tar.append_path_with_name(&path, name)
        .with_context(|| format!("cannot add {name} to the bundle"))?;
    Ok(())
}

/// Extract a bundle into `dest`, rejecting paths that escape it.
pub fn unpack(archive: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    let file =
        File::open(archive).with_context(|| format!("cannot open bundle {}", archive.display()))?;
    let decoder = zstd::Decoder::new(file)
        .with_context(|| format!("cannot read {} as zstd", archive.display()))?;
    let mut tar = tar::Archive::new(decoder);
    for entry in tar.entries().context("cannot read the bundle tar")? {
        let mut entry = entry.context("corrupt bundle entry")?;
        let path = entry.path().context("corrupt bundle path")?.into_owned();
        if path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::RootDir))
        {
            bail!("bundle contains an unsafe path: {}", path.display());
        }
        entry
            .unpack_in(dest)
            .with_context(|| format!("cannot extract {}", path.display()))?;
    }
    Ok(())
}

/// Replace a version's compiled artifacts with those from a staging directory,
/// keeping unrelated local files (such as `records.ndjson`).
pub fn install(staging: &Path, data_dir: &Path, version: &str) -> Result<PathBuf> {
    let corpus_path = staging.join(ARCHIVE_FILE);
    let corpus = LoadedCorpus::open(&corpus_path).with_context(|| {
        format!(
            "downloaded corpus failed validation: {}",
            corpus_path.display()
        )
    })?;
    if corpus.format_version() != FORMAT_VERSION {
        bail!(
            "downloaded corpus has format version {}, expected {}",
            corpus.format_version(),
            FORMAT_VERSION
        );
    }
    drop(corpus);

    let target = data_dir.join("versions").join(version_dir_name(version));
    fs::create_dir_all(&target)?;

    for name in [ARCHIVE_FILE, TEXT_DIR, "corpus.manifest.json", "meta.json"] {
        let source = staging.join(name);
        if !source.exists() {
            continue;
        }
        let destination = target.join(name);
        if destination.exists() {
            if destination.is_dir() {
                fs::remove_dir_all(&destination)?;
            } else {
                fs::remove_file(&destination)?;
            }
        }
        fs::rename(&source, &destination)
            .with_context(|| format!("cannot install {name} into {}", target.display()))?;
    }
    Ok(target)
}

/// Download and install the published bundle for `version`.
pub fn fetch(version: &str, data_dir: &Path, force: bool) -> Result<Option<PathBuf>> {
    let target = data_dir.join("versions").join(version_dir_name(version));
    let installed = target.join(ARCHIVE_FILE).is_file() && target.join(TEXT_DIR).is_dir();
    if installed && !force {
        return Ok(None);
    }

    let base = std::env::var("BEVY_MCP_INDEX_BASE_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_RELEASES_BASE.to_string());
    let release = format!("v{version}");

    let manifest_url = join(&base, &release, RELEASE_MANIFEST);
    eprintln!("[bevy-mcp] fetching {manifest_url}");
    let manifest_bytes = read_url(&manifest_url)?;
    let manifest: ReleaseManifest = serde_json::from_slice(&manifest_bytes)
        .with_context(|| format!("invalid release manifest at {manifest_url}"))?;

    if manifest.manifest_version != RUST_MANIFEST_VERSION {
        bail!(
            "release {release} advertises manifest version {}; this bevy-mcp needs {RUST_MANIFEST_VERSION} (a Rust-format bundle). Publish one with `bevy-mcp build --pack` first.",
            manifest.manifest_version
        );
    }
    if manifest.bevy_version != version {
        bail!(
            "release {release} contains Bevy {}, not {version}",
            manifest.bevy_version
        );
    }
    if let Some(format_version) = manifest.format_version
        && format_version != FORMAT_VERSION
    {
        bail!(
            "release {release} uses corpus format {format_version}; this binary needs {FORMAT_VERSION}"
        );
    }

    let asset_url = join(&base, &release, &manifest.asset);
    eprintln!("[bevy-mcp] downloading {}", manifest.asset);
    let bytes = read_url_timeout(&asset_url, 600)?;
    if let Some(size) = manifest.size
        && bytes.len() as u64 != size
    {
        bail!(
            "downloaded {} bytes but the manifest says {size}",
            bytes.len()
        );
    }
    let digest = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest != manifest.sha256 {
        bail!(
            "checksum mismatch for {}: got {digest}, expected {}",
            manifest.asset,
            manifest.sha256
        );
    }

    fs::create_dir_all(data_dir)?;
    let staging = data_dir.join(format!(
        ".bevy-index-stage-{}-{}",
        std::process::id(),
        version_dir_name(version)
    ));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    let archive = data_dir.join(format!(".bevy-index-{}.tar.zst", std::process::id()));
    fs::write(&archive, &bytes).with_context(|| format!("cannot write {}", archive.display()))?;

    let result = (|| -> Result<PathBuf> {
        unpack(&archive, &staging)?;
        install(&staging, data_dir, version)
    })();
    let _ = fs::remove_file(&archive);
    let _ = fs::remove_dir_all(&staging);
    result.map(Some)
}

fn join(base: &str, release: &str, name: &str) -> String {
    format!(
        "{}/{}/{}",
        base.trim_end_matches('/'),
        release.trim_matches('/'),
        name.trim_start_matches('/')
    )
}

/// Read a URL with hard timeouts. Without this a blocked host can hang an MCP
/// tool call indefinitely.
pub fn read_url(url: &str) -> Result<Vec<u8>> {
    read_url_timeout(url, 60)
}

pub fn read_url_timeout(url: &str, global_seconds: u64) -> Result<Vec<u8>> {
    if url.starts_with("http://") || url.starts_with("https://") {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(global_seconds)))
            .timeout_connect(Some(Duration::from_secs(5)))
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let mut response = agent
            .get(url)
            .header(
                "User-Agent",
                concat!(
                    "bevy-manual-mcp/",
                    env!("CARGO_PKG_VERSION"),
                    " (https://github.com/kinkirill/bevy_manual_mcp)"
                ),
            )
            .call()
            .map_err(|error| anyhow!("GET {url} failed: {error}"))?;
        response
            .body_mut()
            .read_to_vec()
            .map_err(|error| anyhow!("cannot read {url}: {error}"))
    } else {
        let path = url.strip_prefix("file://").unwrap_or(url);
        fs::read(path).with_context(|| format!("cannot read {path}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_urls_without_double_slashes() {
        assert_eq!(
            join(
                "https://example.test/dl/",
                "/v0.20.0",
                "/index-manifest.json"
            ),
            "https://example.test/dl/v0.20.0/index-manifest.json"
        );
    }
}
