//! Bevy feature graph, enabled-feature detection and symbol gating checks.
//!
//! Backs `bevy_check_manifest`. `cargo metadata` is authoritative when the
//! project resolves; a Cargo.toml parser is the fallback (aliases, workspace
//! inheritance, target tables and `default-features = false`).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::process::Command;

use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FeaturesData {
    #[serde(default)]
    pub bevy_version: Option<String>,
    #[serde(default)]
    pub features: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub closure: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default)]
    pub default_features: Option<Vec<String>>,
    #[serde(default)]
    pub plugin_gates: Option<Vec<PluginGate>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PluginGate {
    pub plugin: String,
    pub requires_feature: String,
}

pub struct Enabled {
    pub explicit: Vec<String>,
    pub transitive: Vec<String>,
    pub default_features: bool,
    /// Whether a `Cargo.toml` exists in the project root. A manifest without a
    /// Bevy dependency is still a manifest; `no_manifest` means missing.
    pub manifest_found: bool,
    pub source: &'static str,
}

pub fn load_path(path: &Path) -> Option<FeaturesData> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn enabled(project_root: &Path, data: &FeaturesData) -> Enabled {
    let manifest_found = project_root.join("Cargo.toml").is_file();
    let manual = parse_manifest(project_root);
    if let Some((features, default_features, source)) = cargo_metadata_features(project_root) {
        let explicit = manual
            .as_ref()
            .map(|(features, _)| features.clone())
            .unwrap_or_default();
        return Enabled {
            explicit,
            transitive: features,
            default_features,
            manifest_found: true,
            source,
        };
    }

    match manual {
        Some((explicit, default_features)) => {
            let transitive = closure(&explicit, default_features, data);
            Enabled {
                explicit,
                transitive,
                default_features,
                manifest_found,
                source: "Cargo.toml",
            }
        }
        None => Enabled {
            explicit: Vec::new(),
            transitive: Vec::new(),
            default_features: true,
            manifest_found,
            source: if manifest_found {
                "Cargo.toml (no bevy dependency)"
            } else {
                "none"
            },
        },
    }
}

/// Resolved features for the `bevy` package, via `cargo metadata`.
fn cargo_metadata_features(root: &Path) -> Option<(Vec<String>, bool, &'static str)> {
    let output = Command::new("cargo")
        .args(["metadata", "--format-version", "1", "--offline", "--locked"])
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let data: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let package_id = data["packages"]
        .as_array()?
        .iter()
        .find(|package| package["name"] == "bevy")?["id"]
        .as_str()?
        .to_string();
    let node = data["resolve"]["nodes"]
        .as_array()?
        .iter()
        .find(|node| node["id"].as_str() == Some(package_id.as_str()))?;
    let features: BTreeSet<String> = node["features"]
        .as_array()?
        .iter()
        .filter_map(|feature| feature.as_str().map(str::to_string))
        .collect();
    let default_features = features.contains("default");
    Some((
        features.into_iter().collect(),
        default_features,
        "cargo metadata",
    ))
}

/// Parse the bevy dependency from Cargo.toml as a fallback.
fn parse_manifest(root: &Path) -> Option<(Vec<String>, bool)> {
    let text = fs::read_to_string(root.join("Cargo.toml")).ok()?;
    let parsed: toml::Value = toml::from_str(&text).ok()?;
    let workspace_deps = parsed
        .get("workspace")
        .and_then(|workspace| workspace.get("dependencies"));

    let mut explicit: Vec<String> = Vec::new();
    let mut default_features = true;
    let mut found = false;

    let mut tables: Vec<&toml::Value> = Vec::new();
    for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(table) = parsed.get(key) {
            tables.push(table);
        }
    }
    if let Some(targets) = parsed.get("target").and_then(toml::Value::as_table) {
        for target in targets.values() {
            for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
                if let Some(table) = target.get(key) {
                    tables.push(table);
                }
            }
        }
    }

    for table in tables {
        let Some(entries) = table.as_table() else {
            continue;
        };
        for (name, entry) in entries {
            let is_bevy = name == "bevy"
                || entry.get("package").and_then(toml::Value::as_str) == Some("bevy");
            if !is_bevy {
                continue;
            }
            // Normal, dev, build and target tables can all name the same
            // package (under different aliases); features merge, while a
            // single `default-features = false` turns defaults off.
            if let Some((features, defaults)) = dependency_features(entry, workspace_deps, name) {
                explicit.extend(features);
                default_features &= defaults;
                found = true;
            }
        }
    }
    if !found {
        return None;
    }
    explicit.sort();
    explicit.dedup();
    Some((explicit, default_features))
}

fn dependency_features(
    entry: &toml::Value,
    workspace_deps: Option<&toml::Value>,
    name: &str,
) -> Option<(Vec<String>, bool)> {
    let mut explicit: Vec<String> = Vec::new();
    let mut default_features = true;

    if let Some(features) = entry.get("features").and_then(toml::Value::as_array) {
        explicit.extend(
            features
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::to_string),
        );
    }
    if entry.get("default-features").and_then(toml::Value::as_bool) == Some(false) {
        default_features = false;
    }
    if entry.get("default_features").and_then(toml::Value::as_bool) == Some(false) {
        default_features = false;
    }

    if entry.get("workspace").and_then(toml::Value::as_bool) == Some(true)
        && let Some(inherited) = workspace_deps.and_then(|deps| deps.get(name))
    {
        if let Some(features) = inherited.get("features").and_then(toml::Value::as_array) {
            explicit.extend(
                features
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .map(str::to_string),
            );
        }
        if inherited
            .get("default-features")
            .and_then(toml::Value::as_bool)
            == Some(false)
        {
            default_features = false;
        }
    }

    explicit.sort();
    explicit.dedup();
    Some((explicit, default_features))
}

/// Explicit features plus defaults, expanded through the vendored closure.
fn closure(explicit: &[String], default_features: bool, data: &FeaturesData) -> Vec<String> {
    let mut enabled: BTreeSet<String> = explicit.iter().cloned().collect();
    if default_features {
        if let Some(defaults) = &data.default_features {
            enabled.extend(defaults.iter().cloned());
        }
        enabled.insert("default".to_string());
    }
    loop {
        let mut added = false;
        for feature in enabled.clone() {
            if let Some(values) = data.closure.as_ref().and_then(|c| c.get(&feature)) {
                for value in values {
                    if enabled.insert(value.clone()) {
                        added = true;
                    }
                }
            }
        }
        if !added {
            break;
        }
    }
    enabled.into_iter().collect()
}

pub struct Verdict {
    pub available: bool,
    pub reason: String,
    pub gating_feature: Option<String>,
    pub text: String,
}

pub fn check(query: &str, data: &FeaturesData, transitive: &[String]) -> Verdict {
    let enabled = |feature: &str| transitive.iter().any(|value| value == feature);
    let known = |feature: &str| data.features.contains_key(feature);

    if known(query) {
        let is_enabled = enabled(query);
        return Verdict {
            available: is_enabled,
            reason: if is_enabled {
                format!("\"{query}\" is enabled")
            } else {
                format!("\"{query}\" is disabled")
            },
            gating_feature: None,
            text: format!(
                "{} `{query}` — {}",
                if is_enabled { "✓" } else { "✗" },
                if is_enabled {
                    "available"
                } else {
                    "disabled by feature flags"
                }
            ),
        };
    }

    let prefixed = format!("bevy_{query}");
    if known(&prefixed) {
        let is_enabled = enabled(&prefixed);
        return Verdict {
            available: is_enabled,
            reason: format!(
                "\"{prefixed}\" is {}",
                if is_enabled { "enabled" } else { "disabled" }
            ),
            gating_feature: Some(prefixed.clone()),
            text: format!(
                "{} `{query}` (gated by `[{prefixed}]`) — {}",
                if is_enabled { "✓" } else { "✗" },
                if is_enabled { "available" } else { "disabled" }
            ),
        };
    }

    if let Some(subcrate) = subcrate_of(query) {
        let gating = gating_feature_for(&subcrate, data);
        let is_enabled = gating.as_deref().is_some_and(enabled);
        return Verdict {
            available: is_enabled,
            reason: format!(
                "subcrate \"{subcrate}\" gated by feature \"[{}]\"",
                gating.as_deref().unwrap_or("unknown")
            ),
            gating_feature: gating.clone(),
            text: format!(
                "{} `{query}` — subcrate \"{subcrate}\" {}",
                if is_enabled { "✓" } else { "✗" },
                if is_enabled {
                    "is available".to_string()
                } else {
                    format!("requires `[{}]`", gating.as_deref().unwrap_or("unknown"))
                }
            ),
        };
    }

    if let Some(gates) = &data.plugin_gates {
        for gate in gates {
            if gate.plugin.contains(query) || query.contains(&gate.plugin) {
                let is_enabled = enabled(&gate.requires_feature);
                return Verdict {
                    available: is_enabled,
                    reason: format!(
                        "\"{}\" gated by \"[{}]\"",
                        gate.plugin, gate.requires_feature
                    ),
                    gating_feature: Some(gate.requires_feature.clone()),
                    text: format!(
                        "{} `{query}` — plugin \"{}\" {}",
                        if is_enabled { "✓" } else { "✗" },
                        gate.plugin,
                        if is_enabled {
                            "is available".to_string()
                        } else {
                            format!("requires `[{}]`", gate.requires_feature)
                        }
                    ),
                };
            }
        }
    }

    if !query.contains("::") {
        let fallback = format!("bevy_{query}");
        if known(&fallback) {
            let is_enabled = enabled(&fallback);
            return Verdict {
                available: is_enabled,
                reason: format!(
                    "{} via feature \"[{fallback}]\"",
                    if is_enabled { "available" } else { "disabled" }
                ),
                gating_feature: Some(fallback.clone()),
                text: format!(
                    "{} `{query}` — {}",
                    if is_enabled { "✓" } else { "✗" },
                    if is_enabled {
                        "available"
                    } else {
                        "disabled by feature flags"
                    }
                ),
            };
        }
    }

    Verdict {
        available: false,
        reason: format!("\"{query}\" is not a known feature or module in Bevy"),
        gating_feature: None,
        text: format!(
            "✗ `{query}` — unknown query (not a recognized feature, subcrate, or plugin)"
        ),
    }
}

fn subcrate_of(module_path: &str) -> Option<String> {
    let rest = module_path.strip_prefix("bevy::")?;
    let segment = rest.split("::").next()?;
    if segment.is_empty()
        || !segment
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        return None;
    }
    Some(format!("bevy_{segment}"))
}

fn gating_feature_for(subcrate: &str, data: &FeaturesData) -> Option<String> {
    let expected = if subcrate.starts_with("bevy_") {
        subcrate.to_string()
    } else {
        format!("bevy_{subcrate}")
    };
    if let Some(gates) = &data.plugin_gates {
        for gate in gates {
            if gate.requires_feature == expected || gate.plugin.contains(subcrate) {
                return Some(gate.requires_feature.clone());
            }
        }
    }
    data.features.contains_key(&expected).then_some(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> FeaturesData {
        serde_json::from_value(serde_json::json!({
            "bevy_version": "9.9.9",
            "features": {
                "bevy_ui": ["bevy_ui"],
                "bevy_render": ["bevy_render"],
                "default": ["bevy_render"]
            },
            "closure": {
                "bevy_ui": ["bevy_ui"],
                "bevy_render": ["bevy_render"],
                "default": ["bevy_render"]
            },
            "default_features": ["bevy_render"],
            "plugin_gates": [
                { "plugin": "UiPlugin", "requires_feature": "bevy_ui" }
            ]
        }))
        .expect("features")
    }

    #[test]
    fn falls_back_to_the_manifest_with_defaults_disabled() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            dir.path().join("Cargo.toml"),
            r#"
[package]
name = "demo"
version = "0.1.0"

[dependencies]
b = { package = "bevy", version = "9.9.9", default-features = false, features = ["bevy_ui"] }
"#,
        )
        .expect("manifest");
        let enabled = enabled(dir.path(), &data());
        assert_eq!(enabled.source, "Cargo.toml");
        assert!(enabled.manifest_found);
        assert!(!enabled.default_features);
        assert!(enabled.explicit.contains(&"bevy_ui".to_string()));
        assert!(enabled.transitive.contains(&"bevy_ui".to_string()));
        assert!(!enabled.transitive.contains(&"bevy_render".to_string()));
    }

    #[test]
    fn implicit_default_features_are_enabled() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            dir.path().join("Cargo.toml"),
            r#"
[package]
name = "demo"
version = "0.1.0"

[dependencies]
bevy = "9.9.9"
"#,
        )
        .expect("manifest");
        let enabled = enabled(dir.path(), &data());
        assert!(enabled.default_features);
        assert!(enabled.transitive.contains(&"bevy_render".to_string()));
    }

    #[test]
    fn workspace_inheritance_and_target_tables_are_read() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            dir.path().join("Cargo.toml"),
            r#"
[package]
name = "demo"
version = "0.1.0"

[workspace.dependencies]
bevy = { version = "9.9.9", default-features = false }
serde = { version = "1", features = ["derive"] }

[dependencies]
bevy = { workspace = true, features = ["bevy_render"] }

[target.'cfg(unix)'.dependencies]
b2 = { package = "bevy", version = "9.9.9", features = ["bevy_ui"] }
"#,
        )
        .expect("manifest");
        let enabled = enabled(dir.path(), &data());
        assert!(!enabled.default_features);
        assert!(enabled.transitive.contains(&"bevy_render".to_string()));
        assert!(enabled.transitive.contains(&"bevy_ui".to_string()));
        assert!(!enabled.explicit.contains(&"derive".to_string()));
    }

    #[test]
    fn a_missing_manifest_is_reported_as_such() {
        let dir = tempfile::tempdir().expect("temp dir");
        let enabled = enabled(dir.path(), &data());
        assert!(!enabled.manifest_found);
        assert_eq!(enabled.source, "none");
        assert!(enabled.transitive.is_empty());
    }

    #[test]
    fn a_manifest_without_bevy_is_not_a_missing_manifest() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            dir.path().join("Cargo.toml"),
            r#"
[package]
name = "demo"
version = "0.1.0"
"#,
        )
        .expect("manifest");
        let enabled = enabled(dir.path(), &data());
        assert!(enabled.manifest_found);
        assert_eq!(enabled.source, "Cargo.toml (no bevy dependency)");
        assert!(enabled.transitive.is_empty());
    }

    #[test]
    fn checks_features_subcrates_and_plugins() {
        let data = data();
        let on = vec!["bevy_ui".to_string(), "bevy_render".to_string()];
        assert!(check("ui", &data, &on).available);
        assert!(!check("bevy::render::Mesh", &data, &["bevy_ui".to_string()]).available);
        assert!(check("bevy::ui::Node", &data, &on).available);
        assert!(check("UiPlugin", &data, &on).available);
        assert!(!check("nonexistent", &data, &on).available);
    }
}
