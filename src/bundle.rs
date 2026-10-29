//! Bundle packing, release manifests, and `fetch-index`.
//!
//! A bundle is a zstd-compressed tar of one version directory's compiled
//! artifacts (`corpus.rkyv`, `tantivy/`, manifests, `meta.json`). The canonical
//! `records.ndjson` is deliberately not shipped.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::archive::{ARCHIVE_FILE, FORMAT_VERSION, LoadedCorpus};
use crate::registry::version_dir_name;
use crate::text::TEXT_DIR;

pub const RELEASE_MANIFEST: &str = "index-manifest.json";
pub const INSTALLED_MANIFEST: &str = ".installed-index.json";
/// 1 was the TypeScript bundle; Rust bundles are 2.
pub const RUST_MANIFEST_VERSION: u32 = 2;
pub const DEFAULT_RELEASES_BASE: &str =
    "https://github.com/kinkirill/bevy_manual_mcp/releases/download";

/// Artifacts that make up one generation of an installed corpus. A replacement
/// installs all of them together; anything else in the version directory is a
/// local file (for example `records.ndjson`) and is carried over.
const MANAGED_ARTIFACTS: &[&str] = &[
    ARCHIVE_FILE,
    TEXT_DIR,
    "corpus.manifest.json",
    "meta.json",
    "metadata",
    INSTALLED_MANIFEST,
];

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
    let target = data_dir.join("versions").join(version_dir_name(version));
    install_artifacts(staging, &target)?;
    Ok(target)
}

/// Install a complete artifact generation from `staging` into `target`.
///
/// The replacement is assembled in a sibling directory, validated, and then
/// swapped in with directory renames. If the swap fails, the previous install is
/// restored (or left at the reported backup path), so a failed update never
/// leaves the corpus and text index from different generations.
pub fn install_artifacts(staging: &Path, target: &Path) -> Result<()> {
    let replacement = create_staging(target, "installing")?;
    let result = (|| -> Result<()> {
        if target.exists() {
            if !target.is_dir() {
                bail!("cannot install into {}: not a directory", target.display());
            }
            copy_local_entries(target, &replacement)?;
        }

        for name in MANAGED_ARTIFACTS {
            let source = staging.join(name);
            if !source.exists() {
                continue;
            }
            fs::rename(&source, replacement.join(name)).with_context(|| {
                format!(
                    "cannot stage {name} for installation into {}",
                    target.display()
                )
            })?;
        }

        // Metadata is not tied to record ids. Keep an existing copy when a
        // build or bundle does not carry it, otherwise `build --pack` after
        // copying metadata into a version directory would silently drop it.
        if target.is_dir() {
            for name in ["metadata", "meta.json"] {
                let destination = replacement.join(name);
                let source = target.join(name);
                if !destination.exists() && source.exists() {
                    copy_entry(&source, &destination)?;
                }
            }
        }

        validate_installation(&replacement)?;
        swap_directories(&replacement, target)
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&replacement);
    }
    result
}

/// Create a fresh sibling directory for staging an atomic replacement.
pub(crate) fn create_staging(target: &Path, label: &str) -> Result<PathBuf> {
    let path = unique_sibling_path(target, label);
    fs::create_dir_all(&path)
        .with_context(|| format!("cannot create staging directory {}", path.display()))?;
    Ok(path)
}

/// Swap two directories, keeping the old one until the new one is in place.
pub(crate) fn swap_directories(replacement: &Path, target: &Path) -> Result<()> {
    if !target.exists() {
        return fs::rename(replacement, target).with_context(|| {
            format!(
                "cannot install {} as {}",
                replacement.display(),
                target.display()
            )
        });
    }

    let backup = unique_sibling_path(target, "previous");
    fs::rename(target, &backup).with_context(|| {
        format!(
            "cannot move the previous installation {} aside",
            target.display()
        )
    })?;

    match fs::rename(replacement, target) {
        Ok(()) => {
            if let Err(error) = fs::remove_dir_all(&backup) {
                eprintln!(
                    "[bevy-manual-mcp] previous installation kept at {}: {error}",
                    backup.display()
                );
            }
            Ok(())
        }
        Err(error) => {
            let rollback = fs::rename(&backup, target);
            match rollback {
                Ok(()) => Err(error).with_context(|| {
                    format!("cannot install the replacement as {}", target.display())
                }),
                Err(rollback_error) => bail!(
                    "cannot install the replacement as {} ({error}); the previous installation is kept at {} (rollback failed: {rollback_error})",
                    target.display(),
                    backup.display()
                ),
            }
        }
    }
}

pub(crate) fn validate_installation(dir: &Path) -> Result<()> {
    let corpus_path = dir.join(ARCHIVE_FILE);
    if !corpus_path.is_file() {
        bail!("bundle is incomplete: {} is missing", corpus_path.display());
    }
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

    let text_dir = dir.join(TEXT_DIR);
    if !text_dir.is_dir() {
        bail!("bundle is incomplete: {} is missing", text_dir.display());
    }
    crate::text::TextIndex::open(&text_dir)
        .with_context(|| format!("text index failed validation: {}", text_dir.display()))?;
    Ok(())
}

fn unique_sibling_path(target: &Path, label: &str) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("index");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    parent.join(format!(".{name}.{label}-{}-{nanos}", std::process::id()))
}

fn copy_local_entries(source: &Path, destination: &Path) -> Result<()> {
    for entry in
        fs::read_dir(source).with_context(|| format!("cannot read {}", source.display()))?
    {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if MANAGED_ARTIFACTS.contains(&name_str) {
            continue;
        }
        copy_entry(&entry.path(), &destination.join(&name))?;
    }
    Ok(())
}

fn copy_entry(source: &Path, destination: &Path) -> Result<()> {
    if source.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if source.is_file() {
        fs::copy(source, destination).with_context(|| {
            format!(
                "cannot preserve local file {} as {}",
                source.display(),
                destination.display()
            )
        })?;
    }
    Ok(())
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

/// Find a compatible published manifest for `version`: exact tag first, then
/// its Bevy minor. Errors list every attempted release.
pub fn find_release_manifest(
    version: &str,
    base: &str,
) -> Result<(String, ReleaseManifest), String> {
    let mut errors = Vec::new();
    for release in release_tags(version) {
        let manifest_url = join(base, &release, RELEASE_MANIFEST);
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
        return Ok((release, manifest));
    }
    Err(format!(
        "could not find a compatible index for Bevy {version}. Tried {}.",
        errors.join("; ")
    ))
}

/// Read the manifest recorded when a corpus was fetched or built.
pub fn installed_manifest(version_dir: &Path) -> Option<ReleaseManifest> {
    let path = version_dir.join(INSTALLED_MANIFEST);
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Download and install the published bundle for `version`.
///
/// Exact releases win; otherwise the same Bevy minor is used. The bundle is
/// installed under the exact corpus version from its manifest, and the loaders
/// resolve same-minor corpora on demand.
pub fn fetch(version: &str, data_dir: &Path, force: bool) -> Result<Option<PathBuf>> {
    // An explicit fetch upgrades to the requested exact corpus. Same-minor
    // fallback is a loader concern, not an "already installed" shortcut. An
    // existing but unusable directory is repaired even without --force.
    let exact_dir = data_dir.join("versions").join(version_dir_name(version));
    let exact = exact_dir.join(ARCHIVE_FILE);
    if exact.is_file() && !force {
        match validate_installation(&exact_dir) {
            Ok(()) => return Ok(None),
            Err(error) => eprintln!(
                "[bevy-manual-mcp] installed index at {} is unusable ({error}); reinstalling",
                exact_dir.display()
            ),
        }
    }

    let base = std::env::var("BEVY_MCP_INDEX_BASE_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_RELEASES_BASE.to_string());

    let (release, manifest) =
        find_release_manifest(version, &base).map_err(|error| anyhow!(error))?;

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
        fs::write(
            staging.join(INSTALLED_MANIFEST),
            serde_json::to_string_pretty(&manifest)? + "\n",
        )
        .with_context(|| format!("cannot write installed manifest into {}", staging.display()))?;
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

    fn record(name: &str) -> crate::archive::RecordInput {
        crate::archive::RecordInput {
            source: "rustdoc".into(),
            kind: "struct".into(),
            name: name.into(),
            full_path: format!("demo::{name}"),
            crate_name: Some("demo".into()),
            module: "demo".into(),
            signature: format!("pub struct {name};"),
            docs: format!("The {name} item."),
            file: "demo.html".into(),
            bevy_version: Some("9.9.9".into()),
            ..Default::default()
        }
    }

    fn build(dir: &Path, name: &str) -> Result<()> {
        crate::archive::build(
            vec![record(name)],
            dir,
            &crate::archive::BuildOptions {
                bevy_version: Some("9.9.9".into()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    #[test]
    fn install_swaps_a_complete_generation_and_keeps_local_files() {
        let temp = tempfile::tempdir().expect("temp dir");
        let target = temp.path().join("versions/9.9.9");
        build(&target, "Old").expect("build old");
        fs::write(target.join("records.ndjson"), "local canonical records").expect("local file");

        let staging = temp.path().join("staging");
        build(&staging, "New").expect("build new");
        install_artifacts(&staging, &target).expect("install");

        let corpus = LoadedCorpus::open(&target.join(ARCHIVE_FILE)).expect("new corpus");
        assert_eq!(corpus.lookup("New").len(), 1);
        assert!(corpus.lookup("Old").is_empty());
        assert!(target.join(TEXT_DIR).is_dir());
        assert_eq!(
            fs::read_to_string(target.join("records.ndjson")).expect("local file"),
            "local canonical records"
        );
    }

    #[test]
    fn an_incomplete_generation_never_replaces_the_old_one() {
        let temp = tempfile::tempdir().expect("temp dir");
        let target = temp.path().join("versions/9.9.9");
        build(&target, "Old").expect("build old");
        fs::write(target.join("records.ndjson"), "keep me").expect("local file");

        let staging = temp.path().join("staging");
        fs::create_dir_all(&staging).expect("staging");
        fs::copy(target.join(ARCHIVE_FILE), staging.join(ARCHIVE_FILE))
            .expect("copy archive without a text index");

        let error = install_artifacts(&staging, &target).expect_err("reject incomplete bundle");
        assert!(error.to_string().contains("incomplete"), "{error}");
        let corpus = LoadedCorpus::open(&target.join(ARCHIVE_FILE)).expect("old corpus");
        assert_eq!(corpus.lookup("Old").len(), 1);
        assert!(target.join(TEXT_DIR).is_dir());
        assert_eq!(
            fs::read_to_string(target.join("records.ndjson")).expect("local file"),
            "keep me"
        );
    }
}
