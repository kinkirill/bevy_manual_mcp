//! Ecosystem compatibility: requirement parsing and the vendored plugin snapshot.
//!
//! The TypeScript line treated an unparsable requirement as a definitive "not
//! compatible" and collapsed any historical match into `compatible: true`.
//! This port keeps three verdicts instead: satisfied, not satisfied, and
//! unknown. Unsupported operators therefore never become a negative answer.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::versions::cmp_version;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Satisfied,
    NotSatisfied,
    Unknown,
}

impl Verdict {
    pub fn as_json(self) -> serde_json::Value {
        match self {
            Self::Satisfied => serde_json::Value::Bool(true),
            Self::NotSatisfied => serde_json::Value::Bool(false),
            Self::Unknown => serde_json::Value::String("unknown".to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VersionRange {
    min: String,
    max: Option<String>,
    exact: bool,
}

/// Parse a caret, tilde, exact or wildcard requirement.
///
/// Anything else (`>=`, `<=`, comma lists, hyphen ranges, pre-releases) is
/// intentionally unsupported and yields `None`, which callers surface as
/// `unknown` rather than an incompatibility.
fn parse_requirement(requirement: &str) -> Option<VersionRange> {
    let trimmed = requirement.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix('^') {
        let parts = numeric_parts(rest)?;
        return caret_range(rest, &parts);
    }
    if let Some(rest) = trimmed.strip_prefix('~') {
        let parts = numeric_parts(rest)?;
        let max = if parts.len() == 1 {
            format!("{}.0.0", parts[0] + 1)
        } else {
            format!("{}.{}.0", parts[0], parts[1] + 1)
        };
        return Some(VersionRange {
            min: rest.to_string(),
            max: Some(max),
            exact: false,
        });
    }
    if trimmed.contains(['*', 'x', 'X']) {
        return wildcard_range(trimmed);
    }
    let parts = numeric_parts(trimmed)?;
    match parts.len() {
        3 => Some(VersionRange {
            min: trimmed.to_string(),
            max: Some(trimmed.to_string()),
            exact: true,
        }),
        // Cargo treats a bare `0.20` like `^0.20`.
        1 | 2 => caret_range(trimmed, &parts),
        _ => None,
    }
}

fn numeric_parts(version: &str) -> Option<Vec<u64>> {
    if version.is_empty() {
        return None;
    }
    version
        .split('.')
        .map(|part| part.parse::<u64>().ok())
        .collect()
}

fn caret_range(text: &str, parts: &[u64]) -> Option<VersionRange> {
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let major = parts[0];
    let minor = parts.get(1).copied();
    let patch = parts.get(2).copied();
    let max = if major > 0 {
        format!("{}.0.0", major + 1)
    } else {
        match (minor, patch) {
            // `^0` spans the whole 0.x line.
            (None, _) => "1.0.0".to_string(),
            // `^0.0` stops at 0.1.0.
            (Some(0), None) => "0.1.0".to_string(),
            // `^0.0.3` stops at 0.0.4.
            (Some(0), Some(patch)) => format!("0.0.{}", patch + 1),
            (Some(minor), _) => format!("0.{}.0", minor + 1),
        }
    };
    Some(VersionRange {
        min: text.to_string(),
        max: Some(max),
        exact: false,
    })
}

fn wildcard_range(text: &str) -> Option<VersionRange> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut wildcard_at = None;
    let mut numeric = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if matches!(*part, "*" | "x" | "X") {
            wildcard_at.get_or_insert(index);
        } else if wildcard_at.is_some() || part.parse::<u64>().is_err() {
            return None;
        } else {
            numeric.push(part.parse::<u64>().ok()?);
        }
    }
    let at = wildcard_at?;
    let mut min_parts = numeric.clone();
    min_parts.resize(3, 0);
    let min = format!("{}.{}.{}", min_parts[0], min_parts[1], min_parts[2]);
    let max = match at {
        0 => None,
        1 => Some(format!("{}.0.0", numeric[0] + 1)),
        _ => Some(format!("{}.{}.0", numeric[0], numeric[1] + 1)),
    };
    Some(VersionRange {
        min,
        max,
        exact: false,
    })
}

/// Does `version` satisfy `requirement`? Unsupported syntax is `Unknown`.
pub fn satisfies_requirement(requirement: &str, version: &str) -> Verdict {
    let Some(range) = parse_requirement(requirement) else {
        return Verdict::Unknown;
    };
    let min = cmp_version(version, &range.min);
    if range.exact {
        return if min.is_eq() {
            Verdict::Satisfied
        } else {
            Verdict::NotSatisfied
        };
    }
    if min.is_lt() {
        return Verdict::NotSatisfied;
    }
    match &range.max {
        Some(max) if cmp_version(version, max).is_lt() => Verdict::Satisfied,
        Some(_) => Verdict::NotSatisfied,
        None => Verdict::Satisfied,
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompatEntry {
    pub plugin_version: String,
    pub requires_bevy: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Provenance {
    pub source: String,
    pub path: String,
    pub harvested_at: String,
    pub version_count: usize,
    pub crates: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub plugins: BTreeMap<String, Vec<CompatEntry>>,
    pub provenance: Provenance,
}

#[derive(Debug, Default, Deserialize)]
struct MetaFile {
    #[serde(default)]
    harvested_at: Option<String>,
    #[serde(default)]
    source: Option<String>,
}

/// Locate the vendored snapshot: explicit override first, then the sibling of
/// `vendor/bevy-meta`, then the host project's vendor directory.
pub fn locate(meta_dir: Option<&Path>, project_root: &Path) -> Option<PathBuf> {
    if let Ok(value) = std::env::var("BEVY_MCP_COMPAT_PATH")
        && !value.is_empty()
    {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(meta_dir) = meta_dir
        && let Some(parent) = meta_dir.parent()
    {
        let path = parent.join("ecosystem").join("compat.json");
        if path.is_file() {
            return Some(path);
        }
    }
    let path = project_root
        .join("vendor")
        .join("ecosystem")
        .join("compat.json");
    if path.is_file() {
        return Some(path);
    }
    let path = PathBuf::from("vendor")
        .join("ecosystem")
        .join("compat.json");
    path.is_file().then_some(path)
}

/// Load the snapshot and its provenance, if one is installed.
pub fn load(meta_dir: Option<&Path>, project_root: &Path) -> Result<Option<Snapshot>> {
    let Some(path) = locate(meta_dir, project_root) else {
        return Ok(None);
    };
    load_file(&path).map(Some)
}

/// Load a snapshot from an explicit path (used by tests and mirrors).
pub fn load_file(path: &Path) -> Result<Snapshot> {
    let text = fs::read_to_string(path)
        .with_context(|| format!("cannot read compat snapshot {}", path.display()))?;
    let plugins: BTreeMap<String, Vec<CompatEntry>> = serde_json::from_str(&text)
        .with_context(|| format!("invalid compat snapshot {}", path.display()))?;
    let version_count = plugins.values().map(Vec::len).sum();
    let crates: Vec<String> = plugins.keys().cloned().collect();

    let meta_path = path
        .parent()
        .map(|parent| parent.join("compat-meta.json"))
        .unwrap_or_else(|| PathBuf::from("compat-meta.json"));
    let meta = fs::read_to_string(&meta_path)
        .ok()
        .and_then(|text| serde_json::from_str::<MetaFile>(&text).ok())
        .unwrap_or_default();
    let (harvested_at, source) = match meta.harvested_at {
        Some(harvested_at) => (
            harvested_at,
            meta.source
                .unwrap_or_else(|| "vendored compat snapshot".to_string()),
        ),
        None => (
            file_timestamp(path).unwrap_or_else(|| "unknown".to_string()),
            "compat.json file mtime (compat-meta.json is missing)".to_string(),
        ),
    };

    Ok(Snapshot {
        plugins,
        provenance: Provenance {
            source,
            path: path.display().to_string(),
            harvested_at,
            version_count,
            crates,
        },
    })
}

fn file_timestamp(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let seconds = modified.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(format!("unix:{seconds}"))
}

/// The newest recorded release for one plugin.
pub fn newest(entries: &[CompatEntry]) -> Option<&CompatEntry> {
    entries
        .iter()
        .max_by(|a, b| cmp_version(&a.plugin_version, &b.plugin_version))
}

/// Aggregate verdict for a plugin: any satisfied release is a positive answer;
/// unsupported requirements keep the answer unknown rather than negative.
pub fn aggregate(entries: &[CompatEntry], bevy_version: Option<&str>) -> Verdict {
    let Some(bevy_version) = bevy_version else {
        return Verdict::Unknown;
    };
    let mut unknown = false;
    for entry in entries {
        match satisfies_requirement(&entry.requires_bevy, bevy_version) {
            Verdict::Satisfied => return Verdict::Satisfied,
            Verdict::Unknown => unknown = true,
            Verdict::NotSatisfied => {}
        }
    }
    if unknown {
        Verdict::Unknown
    } else {
        Verdict::NotSatisfied
    }
}

/// Plugin versions whose requirement is satisfied by `bevy_version`, in the
/// snapshot's newest-first order.
pub fn matching_versions(entries: &[CompatEntry], bevy_version: Option<&str>) -> Vec<String> {
    let Some(bevy_version) = bevy_version else {
        return Vec::new();
    };
    entries
        .iter()
        .filter(|entry| {
            satisfies_requirement(&entry.requires_bevy, bevy_version) == Verdict::Satisfied
        })
        .map(|entry| entry.plugin_version.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caret_on_zero_x_stops_at_the_next_minor() {
        assert_eq!(
            satisfies_requirement("^0.20.0", "0.20.0"),
            Verdict::Satisfied
        );
        assert_eq!(
            satisfies_requirement("^0.20.0", "0.20.4"),
            Verdict::Satisfied
        );
        assert_eq!(
            satisfies_requirement("^0.20.0", "0.21.0"),
            Verdict::NotSatisfied
        );
        assert_eq!(
            satisfies_requirement("^0.15.0", "0.20.0"),
            Verdict::NotSatisfied
        );
        assert_eq!(satisfies_requirement("^0.19", "0.19.1"), Verdict::Satisfied);
        assert_eq!(
            satisfies_requirement("^0.19", "0.20.0"),
            Verdict::NotSatisfied
        );
    }

    #[test]
    fn caret_keeps_cargo_s_zero_zero_rules() {
        assert_eq!(satisfies_requirement("^0.0.3", "0.0.3"), Verdict::Satisfied);
        assert_eq!(
            satisfies_requirement("^0.0.3", "0.0.4"),
            Verdict::NotSatisfied
        );
        assert_eq!(satisfies_requirement("^0.0", "0.0.9"), Verdict::Satisfied);
        assert_eq!(
            satisfies_requirement("^0.0", "0.1.0"),
            Verdict::NotSatisfied
        );
        assert_eq!(satisfies_requirement("^0", "0.99.0"), Verdict::Satisfied);
        assert_eq!(satisfies_requirement("^0", "1.0.0"), Verdict::NotSatisfied);
        assert_eq!(satisfies_requirement("^1", "1.9.0"), Verdict::Satisfied);
        assert_eq!(satisfies_requirement("^1", "2.0.0"), Verdict::NotSatisfied);
    }

    #[test]
    fn tilde_and_exact_rules() {
        assert_eq!(
            satisfies_requirement("~0.20.0", "0.20.5"),
            Verdict::Satisfied
        );
        assert_eq!(
            satisfies_requirement("~0.20.0", "0.21.0"),
            Verdict::NotSatisfied
        );
        assert_eq!(satisfies_requirement("~1.2.3", "1.2.9"), Verdict::Satisfied);
        assert_eq!(
            satisfies_requirement("~1.2.3", "1.3.0"),
            Verdict::NotSatisfied
        );
        assert_eq!(
            satisfies_requirement("0.20.0", "0.20.0"),
            Verdict::Satisfied
        );
        assert_eq!(
            satisfies_requirement("0.20.0", "0.20.1"),
            Verdict::NotSatisfied
        );
        assert_eq!(satisfies_requirement("0.20", "0.20.7"), Verdict::Satisfied);
    }

    #[test]
    fn wildcards_are_honoured() {
        assert_eq!(
            satisfies_requirement("0.20.*", "0.20.5"),
            Verdict::Satisfied
        );
        assert_eq!(
            satisfies_requirement("0.20.*", "0.21.0"),
            Verdict::NotSatisfied
        );
        assert_eq!(satisfies_requirement("0.*", "0.99.0"), Verdict::Satisfied);
        assert_eq!(satisfies_requirement("0.*", "1.0.0"), Verdict::NotSatisfied);
        assert_eq!(satisfies_requirement("*", "9.9.9"), Verdict::Satisfied);
    }

    #[test]
    fn unsupported_requirements_are_unknown_not_negative() {
        for requirement in [
            ">=0.20.0",
            ">=0.20, <0.21",
            "0.20.0 || 0.21.0",
            "",
            "latest",
        ] {
            assert_eq!(
                satisfies_requirement(requirement, "0.21.0"),
                Verdict::Unknown,
                "{requirement}"
            );
        }
    }

    #[test]
    fn the_vendored_snapshot_parses_with_provenance() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let snapshot = load_file(&root.join("vendor/ecosystem/compat.json")).expect("load");
        assert!(snapshot.provenance.version_count >= 70);
        assert!(!snapshot.provenance.harvested_at.is_empty());
        assert_eq!(snapshot.provenance.crates.len(), snapshot.plugins.len());
        let egui = snapshot.plugins.get("bevy_egui").expect("bevy_egui");
        assert!(
            matching_versions(egui, Some("0.20.0"))
                .iter()
                .any(|version| version == "0.43.1")
        );
        assert!(
            !matching_versions(egui, Some("0.15.3"))
                .iter()
                .any(|version| version == "0.43.1")
        );
        assert_eq!(
            newest(egui).map(|entry| entry.plugin_version.as_str()),
            Some("0.43.1")
        );
    }
}
