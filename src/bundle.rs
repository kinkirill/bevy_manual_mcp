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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub records: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
        let metadata = version_dir.join("metadata");
        if metadata.is_dir() {
            tar.append_dir_all("metadata", &metadata)
                .context("cannot add version metadata to the bundle")?;
        }
        tar.finish().context("cannot finish the bundle tar")?;
    }
    encoder.finish().context("cannot finish the zstd stream")?;

    Ok(fs::metadata(out).map(|meta| meta.len()).unwrap_or(0))
}

/// Write the release manifest that `fetch-index` reads for an asset.
pub fn write_release_manifest(
    asset: &Path,
    version: &str,
    out: &Path,
    revision: u32,
) -> Result<()> {
    let bytes = fs::read(asset).with_context(|| format!("cannot read {}", asset.display()))?;
    let digest = Sha256::digest(&bytes);
    let sha256 = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let manifest = ReleaseManifest {
        manifest_version: RUST_MANIFEST_VERSION,
        bevy_version: version.to_string(),
        asset: asset
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| asset.display().to_string()),
        sha256,
        size: Some(bytes.len() as u64),
        format_version: Some(FORMAT_VERSION),
        revision: Some(revision),
        records: None,
        text_documents: None,
    };
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(out, serde_json::to_string_pretty(&manifest)? + "\n")
        .with_context(|| format!("cannot write {}", out.display()))
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

    for name in [
        ARCHIVE_FILE,
        TEXT_DIR,
        "corpus.manifest.json",
        "meta.json",
        "metadata",
    ] {
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

/// Release tags to try for a requested Bevy version: exact first, then the
/// Bevy minor (index releases are published per minor).
pub fn release_tags(version: &str) -> Vec<String> {
    let mut tags = vec![format!("v{version}")];
    if let Some(minor) = crate::versions::minor_label(version) {
        let tag = format!("v{minor}");
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags
}

/// Download and install the published bundle for `version`.
///
/// Exact releases win; otherwise the same Bevy minor is used. The bundle is
/// installed under the exact corpus version from its manifest, and the loaders
/// resolve same-minor corpora on demand.
pub fn fetch(version: &str, data_dir: &Path, force: bool) -> Result<Option<PathBuf>> {
    if crate::archive::resolve_version_dir(data_dir, version).is_some() && !force {
        return Ok(None);
    }

    let base = std::env::var("BEVY_MCP_INDEX_BASE_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_RELEASES_BASE.to_string());

    let mut errors = Vec::new();
    let mut selected = None;
    for release in release_tags(version) {
        let manifest_url = join(&base, &release, RELEASE_MANIFEST);
        eprintln!("[bevy-manual-mcp] fetching {manifest_url}");
        let bytes = match read_url(&manifest_url) {
            Ok(bytes) => bytes,
            Err(error) => {
                errors.push(format!("{release}: {error}"));
                continue;
            }
        };
        let manifest: ReleaseManifest = match serde_json::from_slice(&bytes) {
            Ok(manifest) => manifest,
            Err(error) => {
                errors.push(format!("{release}: invalid manifest ({error})"));
                continue;
            }
        };
        if manifest.manifest_version != RUST_MANIFEST_VERSION {
            errors.push(format!(
                "{release}: manifest version {} (this binary needs {RUST_MANIFEST_VERSION})",
                manifest.manifest_version
            ));
            continue;
        }
        if !crate::versions::same_minor(&manifest.bevy_version, version) {
            errors.push(format!(
                "{release}: contains Bevy {}, not {version}",
                manifest.bevy_version
            ));
            continue;
        }
        if let Some(format_version) = manifest.format_version
            && format_version != FORMAT_VERSION
        {
            errors.push(format!(
                "{release}: corpus format {format_version} (this binary needs {FORMAT_VERSION})"
            ));
            continue;
        }
        selected = Some((release, manifest));
        break;
    }

    let Some((release, manifest)) = selected else {
        bail!(
            "could not fetch a compatible index for Bevy {version}. Tried {}.",
            errors.join("; ")
        );
    };

    let asset_url = join(&base, &release, &manifest.asset);
    eprintln!("[bevy-manual-mcp] downloading {}", manifest.asset);
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
    let target_version = manifest.bevy_version.clone();
    if target_version != version {
        eprintln!(
            "[bevy-manual-mcp] {release} answers for the {target_version} corpus (your project is on {version})"
        );
    }
    let staging = data_dir.join(format!(
        ".bevy-index-stage-{}-{}",
        std::process::id(),
        version_dir_name(&target_version)
    ));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    let archive = data_dir.join(format!(".bevy-index-{}.tar.zst", std::process::id()));
    fs::write(&archive, &bytes).with_context(|| format!("cannot write {}", archive.display()))?;

    let result = (|| -> Result<PathBuf> {
        unpack(&archive, &staging)?;
        install(&staging, data_dir, &target_version)
    })();
    let _ = fs::remove_file(&archive);
    let _ = fs::remove_dir_all(&staging);
    result.map(Some)
}

/// crates.io sparse-index path for a crate name.
pub fn sparse_index_url(crate_name: &str) -> String {
    let name = crate_name.to_ascii_lowercase();
    let path = match name.len() {
        0 => name.clone(),
        1 => format!("1/{name}"),
        2 => format!("2/{name}"),
        3 => format!("3/{}/{name}", &name[..1]),
        _ => format!("{}/{}/{name}", &name[..2], &name[2..4]),
    };
    format!("https://index.crates.io/{path}")
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
        // ureq defaults to a 10 MB body limit; index assets are ~35 MB.
        response
            .body_mut()
            .with_config()
            .limit(512 * 1024 * 1024)
            .read_to_vec()
            .map_err(|error| anyhow!("cannot read {url}: {error}"))
    } else {
        let path = url.strip_prefix("file://").unwrap_or(url);
        fs::read(path).with_context(|| format!("cannot read {path}"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn release_tags_try_exact_then_minor() {
        assert_eq!(release_tags("0.20.1"), vec!["v0.20.1", "v0.20"]);
        assert_eq!(release_tags("0.20.0"), vec!["v0.20.0", "v0.20"]);
        assert_eq!(release_tags("0.20"), vec!["v0.20"]);
    }

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
