//! Reading the on-disk registry and per-version metadata.
//!
//! Step 0 reads `registry.json` and `versions/<v>/meta.json` only; the compiled
//! corpus itself is not loaded yet. All failures degrade to "nothing indexed".

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::versions::cmp_version;

/// Registry entry as written by the TypeScript build. Fields are consumed by
/// different steps, so not every one is read yet.
#[allow(dead_code)]
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RegistryEntry {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub cache_version: Option<u32>,
    #[serde(default)]
    pub built_at: Option<String>,
    #[serde(default)]
    pub records: Option<u64>,
    #[serde(default)]
    pub symbols: Option<u64>,
    #[serde(default)]
    pub doc_dir: Option<String>,
    #[serde(default)]
    pub by_kind: BTreeMap<String, u64>,
    #[serde(default)]
    pub by_source: BTreeMap<String, u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RegistryFile {
    #[serde(default)]
    versions: BTreeMap<String, RegistryEntry>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Meta {
    #[serde(default)]
    pub bevy_version: Option<String>,
    #[serde(default)]
    pub cache_version: Option<u32>,
    #[serde(default)]
    pub symbols: Option<u64>,
    #[serde(default)]
    pub api_records: Option<u64>,
    #[serde(default)]
    pub text_indexed: Option<u64>,
    #[serde(default)]
    pub built_at: Option<String>,
    #[serde(default)]
    pub doc_dir: Option<String>,
    #[serde(default)]
    pub website_dir: Option<String>,
    #[serde(default)]
    pub examples_dir: Option<String>,
    #[serde(default)]
    pub project_root: Option<String>,
    #[serde(default)]
    pub version_source: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Registry {
    data_dir: PathBuf,
    versions: BTreeMap<String, RegistryEntry>,
}

impl Registry {
    pub fn load(data_dir: &Path) -> Self {
        let file = fs::read_to_string(data_dir.join("registry.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<RegistryFile>(&text).ok())
            .unwrap_or_default();
        Self {
            data_dir: data_dir.to_path_buf(),
            versions: file.versions,
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn entry(&self, version: &str) -> Option<&RegistryEntry> {
        self.versions.get(version)
    }

    /// Registry versions plus any version directory that carries metadata.
    pub fn indexed_versions(&self) -> Vec<String> {
        let mut versions: Vec<String> = self.versions.keys().cloned().collect();
        if let Ok(entries) = fs::read_dir(self.data_dir.join("versions")) {
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                if entry.path().join("meta.json").is_file() && !versions.contains(&name) {
                    versions.push(name);
                }
            }
        }
        versions.sort_by(|a, b| cmp_version(a, b));
        versions
    }

    pub fn meta(&self, version: &str) -> Option<Meta> {
        let path = self
            .data_dir
            .join("versions")
            .join(version_dir_name(version))
            .join("meta.json");
        let text = fs::read_to_string(path).ok()?;
        serde_json::from_str(&text).ok()
    }
}

/// Mirror the TypeScript registry directory rule: unsafe characters become `_`.
pub fn version_dir_name(version: &str) -> String {
    version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}
