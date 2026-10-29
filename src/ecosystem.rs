//! Plugin corpus discovery for `bevy_ecosystem_search`.
//!
//! Preferred layout (Rust): `data/corpora/<crate>/<version>/` containing the
//! same artifacts as a Bevy version corpus (`corpus.rkyv`, `tantivy/`). The
//! older TypeScript spelling `data/corpora/<crate>-<version>/` is accepted when
//! a config entry names the exact version. With no config entries, every
//! `<crate>/<version>` directory is discovered.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::archive::{self, LoadedCorpus};
use crate::config::CorpusConfig;
use crate::text::{self, TextIndex};

#[derive(Debug, Clone)]
pub struct Source {
    pub id: String,
    pub crate_name: String,
    pub version: Option<String>,
    pub dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Skipped {
    pub crate_name: String,
    pub version: Option<String>,
    pub reason: String,
}

pub struct Loaded {
    pub id: String,
    pub corpus: LoadedCorpus,
    pub text: TextIndex,
}

#[derive(Debug, Default, Deserialize)]
struct Descriptor {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    crate_version: Option<String>,
}

/// Find configured (or auto-discovered) plugin corpora under `data/corpora/`.
pub fn discover(data_dir: &Path, configs: &[CorpusConfig]) -> (Vec<Source>, Vec<Skipped>) {
    let root = data_dir.join("corpora");
    let mut sources = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = BTreeSet::new();

    if configs.is_empty() {
        if root.is_dir() {
            for crate_dir in directories(&root) {
                let Some(crate_name) = crate_dir.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                for version_dir in directories(&crate_dir) {
                    let Some(version) = version_dir.file_name().and_then(|name| name.to_str())
                    else {
                        continue;
                    };
                    let source =
                        source_for(crate_name, version.to_string(), version_dir, &mut skipped);
                    if let Some(source) = source
                        && seen.insert(source.dir.clone())
                    {
                        sources.push(source);
                    }
                }
            }
        }
        source_order(&mut sources);
        return (sources, skipped);
    }

    for config in configs {
        let crate_name = config.crate_name.trim();
        if crate_name.is_empty() {
            continue;
        }
        match config
            .version
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            Some(version) => {
                let mut candidates = vec![root.join(crate_name).join(version)];
                let sanitized = version.replace(['.', '+'], "-");
                candidates.push(root.join(format!("{crate_name}-{sanitized}")));
                let mut found = false;
                for candidate in candidates {
                    if !candidate.is_dir() {
                        continue;
                    }
                    if let Some(source) =
                        source_for(crate_name, version.to_string(), candidate, &mut skipped)
                        && seen.insert(source.dir.clone())
                    {
                        sources.push(source);
                        found = true;
                    }
                }
                if !found && !skipped.iter().any(|row| row.crate_name == crate_name) {
                    skipped.push(Skipped {
                        crate_name: crate_name.to_string(),
                        version: Some(version.to_string()),
                        reason: format!(
                            "no compiled corpus under {}/{} or {}/{crate_name}-{}",
                            root.display(),
                            crate_name,
                            root.display(),
                            version.replace(['.', '+'], "-")
                        ),
                    });
                }
            }
            None => {
                let mut found = false;
                let crate_root = root.join(crate_name);
                for version_dir in directories(&crate_root) {
                    let Some(version) = version_dir.file_name().and_then(|name| name.to_str())
                    else {
                        continue;
                    };
                    if let Some(source) =
                        source_for(crate_name, version.to_string(), version_dir, &mut skipped)
                        && seen.insert(source.dir.clone())
                    {
                        sources.push(source);
                        found = true;
                    }
                }
                if let Ok(entries) = fs::read_dir(&root) {
                    let prefix = format!("{crate_name}-");
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let Some(version) = name.strip_prefix(&prefix) else {
                            continue;
                        };
                        let dir = entry.path();
                        if !dir.is_dir() {
                            continue;
                        }
                        if let Some(source) =
                            source_for(crate_name, version.to_string(), dir, &mut skipped)
                            && seen.insert(source.dir.clone())
                        {
                            sources.push(source);
                            found = true;
                        }
                    }
                }
                if !found && !skipped.iter().any(|row| row.crate_name == crate_name) {
                    skipped.push(Skipped {
                        crate_name: crate_name.to_string(),
                        version: None,
                        reason: format!(
                            "no compiled corpus under {}/{}",
                            root.display(),
                            crate_name
                        ),
                    });
                }
            }
        }
    }
    source_order(&mut sources);
    (sources, skipped)
}

fn source_order(sources: &mut Vec<Source>) {
    sources.sort_by(|a, b| a.id.cmp(&b.id));
    sources.dedup_by(|a, b| a.id == b.id);
}

fn source_for(
    crate_name: &str,
    version: String,
    dir: PathBuf,
    skipped: &mut Vec<Skipped>,
) -> Option<Source> {
    let descriptor = fs::read_to_string(dir.join("corpus.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Descriptor>(&text).ok())
        .unwrap_or_default();
    let display_version = descriptor
        .crate_version
        .clone()
        .unwrap_or_else(|| display_version(&version));
    let id = descriptor
        .id
        .clone()
        .unwrap_or_else(|| format!("{crate_name}@{display_version}"));

    if !dir.join(archive::ARCHIVE_FILE).is_file() {
        skipped.push(Skipped {
            crate_name: crate_name.to_string(),
            version: Some(display_version),
            reason: format!("{} is missing {}", dir.display(), archive::ARCHIVE_FILE),
        });
        return None;
    }
    if !dir.join(text::TEXT_DIR).is_dir() {
        skipped.push(Skipped {
            crate_name: crate_name.to_string(),
            version: Some(display_version),
            reason: format!("{} is missing {}/", dir.display(), text::TEXT_DIR),
        });
        return None;
    }
    Some(Source {
        id,
        crate_name: crate_name.to_string(),
        version: Some(display_version),
        dir,
    })
}

/// `0-43-1` from a sanitized directory name becomes `0.43.1`; anything with a
/// non-numeric character is left alone.
fn display_version(version: &str) -> String {
    if version.chars().all(|ch| ch.is_ascii_digit() || ch == '-')
        && version.chars().any(|ch| ch.is_ascii_digit())
    {
        version.replace('-', ".")
    } else {
        version.to_string()
    }
}

fn directories(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

/// Open a discovered corpus. Failures are reported per corpus by the caller.
pub fn load(source: &Source) -> Result<Loaded> {
    let corpus = LoadedCorpus::open(&source.dir.join(archive::ARCHIVE_FILE))
        .with_context(|| format!("cannot open corpus {}", source.dir.display()))?;
    let text = TextIndex::open(&source.dir.join(text::TEXT_DIR))
        .with_context(|| format!("cannot open text index for {}", source.dir.display()))?;
    Ok(Loaded {
        id: source.id.clone(),
        corpus,
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus_dir(root: &Path, crate_name: &str, version: &str) -> PathBuf {
        let dir = root.join("corpora").join(crate_name).join(version);
        fs::create_dir_all(dir.join(text::TEXT_DIR)).expect("text dir");
        fs::write(dir.join(archive::ARCHIVE_FILE), b"fixture").expect("archive");
        dir
    }

    #[test]
    fn configured_corpora_use_the_preferred_layout() {
        let root = tempfile::tempdir().expect("temp dir");
        let dir = corpus_dir(root.path(), "bevy_egui", "0.43.1");
        let configs = vec![CorpusConfig {
            crate_name: "bevy_egui".to_string(),
            version: Some("0.43.1".to_string()),
            auto: None,
        }];
        let (sources, skipped) = discover(root.path(), &configs);
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "bevy_egui@0.43.1");
        assert_eq!(sources[0].dir, dir);
    }

    #[test]
    fn the_typescript_sanitized_layout_is_accepted() {
        let root = tempfile::tempdir().expect("temp dir");
        let dir = root.path().join("corpora").join("bevy_egui-0-43-1");
        fs::create_dir_all(dir.join(text::TEXT_DIR)).expect("text dir");
        fs::write(dir.join(archive::ARCHIVE_FILE), b"fixture").expect("archive");
        let configs = vec![CorpusConfig {
            crate_name: "bevy_egui".to_string(),
            version: Some("0.43.1".to_string()),
            auto: None,
        }];
        let (sources, skipped) = discover(root.path(), &configs);
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(sources[0].id, "bevy_egui@0.43.1");
        assert_eq!(sources[0].version.as_deref(), Some("0.43.1"));
    }

    #[test]
    fn auto_discovery_walks_crate_and_version_directories() {
        let root = tempfile::tempdir().expect("temp dir");
        corpus_dir(root.path(), "bevy_egui", "0.43.1");
        corpus_dir(root.path(), "bevy_rapier3d", "0.37.0");
        let (sources, skipped) = discover(root.path(), &[]);
        assert!(skipped.is_empty(), "{skipped:?}");
        let ids: Vec<&str> = sources.iter().map(|source| source.id.as_str()).collect();
        assert_eq!(ids, vec!["bevy_egui@0.43.1", "bevy_rapier3d@0.37.0"]);
    }

    #[test]
    fn a_missing_corpus_is_reported_not_dropped_silently() {
        let root = tempfile::tempdir().expect("temp dir");
        let configs = vec![CorpusConfig {
            crate_name: "bevy_egui".to_string(),
            version: Some("0.43.1".to_string()),
            auto: None,
        }];
        let (sources, skipped) = discover(root.path(), &configs);
        assert!(sources.is_empty());
        assert_eq!(skipped.len(), 1);
        assert!(
            skipped[0].reason.contains("no compiled corpus"),
            "{skipped:?}"
        );
    }
}
