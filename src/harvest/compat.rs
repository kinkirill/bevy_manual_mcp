//! Harvest plugin ↔ Bevy compatibility from the crates.io sparse index.
//!
//! Port of `scripts/harvest-compat.mts`, switched from the crates.io API to the
//! sparse index (one request per crate instead of one per release). The index
//! records carry the dependency requirements, so the snapshot has the same
//! information and works on hosts where `crates.io:443` is blocked.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result, anyhow};
use serde::Serialize;
use serde_json::Value;

use crate::bundle;
use crate::versions::cmp_version;

use super::http::Fetcher;

const CRATES: [&str; 3] = ["bevy_egui", "bevy_rapier3d", "leafwing_input_manager"];
const MAX_VERSIONS: usize = 24;

#[derive(Debug, Clone, Serialize)]
struct CompatEntry {
    plugin: String,
    plugin_version: String,
    requires_bevy: String,
}

fn requirement_from_deps(deps: &Value) -> Option<String> {
    let deps = deps.as_array()?;
    let bevy = deps
        .iter()
        .find(|dependency| dependency["name"].as_str() == Some("bevy"));
    if let Some(requirement) = bevy.and_then(|dependency| dependency["req"].as_str()) {
        return Some(requirement.to_string());
    }
    deps.iter()
        .find(|dependency| {
            dependency["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("bevy_"))
        })
        .and_then(|dependency| dependency["req"].as_str())
        .map(str::to_string)
}

/// Parse sparse-index NDJSON into newest-first compatibility entries.
fn entries_from_index(ndjson: &str, crate_name: &str) -> Vec<CompatEntry> {
    let mut entries: Vec<CompatEntry> = Vec::new();
    for line in ndjson.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry["yanked"].as_bool() == Some(true) {
            continue;
        }
        let Some(version) = entry["vers"].as_str() else {
            continue;
        };
        if version.contains('-') {
            continue;
        }
        let Some(requirement) = requirement_from_deps(&entry["deps"]) else {
            continue;
        };
        entries.push(CompatEntry {
            plugin: crate_name.to_string(),
            plugin_version: version.to_string(),
            requires_bevy: requirement,
        });
    }
    entries.sort_by(|a, b| cmp_version(&b.plugin_version, &a.plugin_version));
    entries.truncate(MAX_VERSIONS);
    entries
}

/// Harvest compat data into `out/compat.json` (with a `meta` provenance block).
pub fn harvest_compat(out: &Path) -> Result<()> {
    let fetcher = Fetcher::new(60);
    let mut compat: BTreeMap<String, Vec<CompatEntry>> = BTreeMap::new();

    for crate_name in CRATES {
        println!("Harvesting {crate_name} from the sparse index…");
        let mut url = bundle::sparse_index_url(crate_name);
        let mut body = fetcher.text(&url, 4).map_err(|error| anyhow!(error))?;
        // Crate names use hyphens on crates.io; Rust import names use
        // underscores. Try the canonical spelling before giving up.
        if body.is_none() && crate_name.contains('_') {
            url = bundle::sparse_index_url(&crate_name.replace('_', "-"));
            body = fetcher.text(&url, 4).map_err(|error| anyhow!(error))?;
        }
        let body = body.ok_or_else(|| anyhow!("no sparse-index entry for {crate_name}"))?;
        let entries = entries_from_index(&body, crate_name);
        if entries.is_empty() {
            eprintln!("  ! no usable versions for {crate_name}");
        }
        println!("  {} versions recorded", entries.len());
        compat.insert(crate_name.to_string(), entries);
    }

    fs::create_dir_all(out).with_context(|| format!("cannot create {}", out.display()))?;
    let version_count: usize = compat.values().map(Vec::len).sum();
    let complete = !compat.is_empty() && compat.values().all(|entries| !entries.is_empty());
    let snapshot = serde_json::json!({
        "meta": {
            "harvested_at": chrono::Utc::now().to_rfc3339(),
            "source": "crates.io sparse index via bevy-manual-mcp harvest-compat",
            "version_count": version_count,
            "plugin_count": compat.len(),
            "complete": complete,
        },
        "plugins": compat,
    });
    fs::write(
        out.join("compat.json"),
        serde_json::to_string_pretty(&snapshot)? + "\n",
    )
    .context("cannot write compat.json")?;

    println!(
        "\nWrote {version_count} entries to {}",
        out.join("compat.json").display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bevy_dependency_wins_over_subcrates() {
        let deps = serde_json::json!([
            {"name":"bevy_ecs","req":"^0.20.0"},
            {"name":"bevy","req":"^0.19.0"}
        ]);
        assert_eq!(requirement_from_deps(&deps), Some("^0.19.0".to_string()));
        let subcrate = serde_json::json!([{"name":"bevy_ecs","req":"^0.20.0"}]);
        assert_eq!(
            requirement_from_deps(&subcrate),
            Some("^0.20.0".to_string())
        );
        assert_eq!(requirement_from_deps(&serde_json::json!([])), None);
    }

    #[test]
    fn index_entries_skip_yanked_prereleases_and_sort_newest_first() {
        let ndjson = r#"
{"vers":"0.9.0","yanked":false,"deps":[{"name":"bevy","req":"^0.10"}]}
{"vers":"0.43.1","yanked":false,"deps":[{"name":"bevy","req":"^0.20"}]}
{"vers":"0.44.0-rc.1","yanked":false,"deps":[{"name":"bevy","req":"^0.21"}]}
{"vers":"0.42.0","yanked":true,"deps":[{"name":"bevy","req":"^0.19"}]}
{"vers":"0.41.0","yanked":false,"deps":[{"name":"serde","req":"^1"}]}
"#;
        let entries = entries_from_index(ndjson, "bevy_egui");
        let versions: Vec<&str> = entries
            .iter()
            .map(|entry| entry.plugin_version.as_str())
            .collect();
        assert_eq!(versions, vec!["0.43.1", "0.9.0"]);
        assert_eq!(entries[0].requires_bevy, "^0.20");
        assert_eq!(entries[0].plugin, "bevy_egui");
    }

    #[test]
    fn the_list_is_capped_at_the_newest_versions() {
        let mut lines = Vec::new();
        for patch in 0..40 {
            lines.push(format!(
                r#"{{"vers":"0.20.{patch}","yanked":false,"deps":[{{"name":"bevy","req":"^0.20"}}]}}"#
            ));
        }
        let entries = entries_from_index(&lines.join("\n"), "plugin");
        assert_eq!(entries.len(), MAX_VERSIONS);
        assert_eq!(entries[0].plugin_version, "0.20.39");
    }
}
