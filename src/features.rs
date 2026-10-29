//! Bevy feature graph, enabled-feature detection and symbol gating checks.
//!
//! Backs `bevy_check_manifest`. `cargo metadata` is authoritative when the
//! project resolves; a Cargo.toml parser is the fallback (aliases, workspace
//! inheritance, target tables and `default-features = false`).

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
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
    pub profiles: Option<BTreeMap<String, Profile>>,
    #[serde(default)]
    pub subcrates: Option<BTreeMap<String, Subcrate>>,
    #[serde(default)]
    pub default_features: Option<Vec<String>>,
    #[serde(default)]
    pub plugin_gates: Option<Vec<PluginGate>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Profile {
    #[serde(default)]
    pub enables: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Subcrate {
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub features: Vec<String>,
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
    /// True only when Cargo resolved the complete dependency feature graph.
    pub authoritative: bool,
    /// Why `cargo metadata` could not be used, when the fallback parser ran.
    pub metadata_error: Option<String>,
}

pub fn load_path(path: &Path) -> Option<FeaturesData> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn enabled(project_root: &Path, data: &FeaturesData) -> Enabled {
    let manifest_found = project_root.join("Cargo.toml").is_file();
    let manual = parse_manifest(project_root);
    let metadata = match cargo_metadata_features(project_root) {
        Ok(features) => Ok(features),
        Err(full_error) => cargo_metadata_no_deps_features(project_root)
            .map_err(|no_deps_error| format!("{full_error}; {no_deps_error}")),
    };
    let metadata_error = metadata.as_ref().err().cloned();
    if let Ok((features, default_features, source)) = metadata {
        let no_deps = source == "cargo metadata (no-deps)";
        let explicit = if no_deps {
            features.clone()
        } else {
            manual
                .as_ref()
                .map(|(features, _)| features.clone())
                .unwrap_or_default()
        };
        let transitive = if no_deps {
            closure(&features, default_features, data)
        } else {
            features
        };
        return Enabled {
            explicit,
            transitive,
            default_features,
            manifest_found: true,
            source,
            authoritative: source == "cargo metadata",
            metadata_error: None,
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
                authoritative: false,
                metadata_error,
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
            authoritative: false,
            metadata_error,
        },
    }
}

/// Resolved features for the `bevy` package, via `cargo metadata`.
fn cargo_metadata_features(root: &Path) -> Result<(Vec<String>, bool, &'static str), String> {
    let cargo = cargo_executable();
    let output = Command::new(&cargo)
        .args(["metadata", "--format-version", "1", "--offline", "--locked"])
        .current_dir(root)
        .output()
        .map_err(|error| format!("could not run {}: {error}", cargo.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().next().unwrap_or("no stderr").trim();
        return Err(format!("cargo metadata failed: {detail}"));
    }
    let data: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("cargo metadata returned invalid JSON: {error}"))?;
    let package_id = data["packages"]
        .as_array()
        .and_then(|packages| packages.iter().find(|package| package["name"] == "bevy"))
        .and_then(|package| package["id"].as_str())
        .ok_or_else(|| "cargo metadata did not include a `bevy` package".to_string())?
        .to_string();
    let node = data["resolve"]["nodes"]
        .as_array()
        .and_then(|nodes| {
            nodes
                .iter()
                .find(|node| node["id"].as_str() == Some(package_id.as_str()))
        })
        .ok_or_else(|| "cargo metadata did not resolve the `bevy` package".to_string())?;
    let features: BTreeSet<String> = node["features"]
        .as_array()
        .ok_or_else(|| "cargo metadata omitted resolved features".to_string())?
        .iter()
        .filter_map(|feature| feature.as_str().map(str::to_string))
        .collect();
    let default_features = features.contains("default");
    Ok((
        features.into_iter().collect(),
        default_features,
        "cargo metadata",
    ))
}

/// Direct dependency features from `cargo metadata --no-deps`, which does not
/// resolve or download the dependency graph.
fn cargo_metadata_no_deps_features(
    root: &Path,
) -> Result<(Vec<String>, bool, &'static str), String> {
    let cargo = cargo_executable();
    let output = Command::new(&cargo)
        .args([
            "metadata",
            "--format-version",
            "1",
            "--offline",
            "--no-deps",
        ])
        .current_dir(root)
        .output()
        .map_err(|error| format!("could not run {}: {error}", cargo.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().next().unwrap_or("no stderr").trim();
        return Err(format!("cargo metadata --no-deps failed: {detail}"));
    }
    let data: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("cargo metadata --no-deps returned invalid JSON: {error}"))?;
    let packages = data["packages"]
        .as_array()
        .ok_or_else(|| "cargo metadata --no-deps omitted packages".to_string())?;

    let mut explicit: BTreeSet<String> = BTreeSet::new();
    let mut default_features = true;
    let mut found = false;
    for package in packages {
        let Some(dependencies) = package["dependencies"].as_array() else {
            continue;
        };
        for dependency in dependencies {
            if dependency["name"].as_str() != Some("bevy") {
                continue;
            }
            found = true;
            default_features &= dependency["uses_default_features"]
                .as_bool()
                .unwrap_or(true);
            if let Some(features) = dependency["features"].as_array() {
                explicit.extend(
                    features
                        .iter()
                        .filter_map(|feature| feature.as_str().map(str::to_string)),
                );
            }
        }
    }
    if !found {
        return Err("cargo metadata --no-deps found no `bevy` dependency".to_string());
    }
    Ok((
        explicit.into_iter().collect(),
        default_features,
        "cargo metadata (no-deps)",
    ))
}

/// MCP clients launched from a GUI often have a PATH without Cargo.
fn cargo_executable() -> PathBuf {
    if let Some(path) = env::var_os("CARGO")
        && !path.is_empty()
        && Path::new(&path).is_file()
    {
        return PathBuf::from(path);
    }
    let cargo_home = env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".cargo")));
    if let Some(home) = cargo_home {
        let cargo = home
            .join("bin")
            .join(if cfg!(windows) { "cargo.exe" } else { "cargo" });
        if cargo.is_file() {
            return cargo;
        }
    }
    PathBuf::from("cargo")
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
            let mut next: Vec<String> = Vec::new();
            if let Some(values) = data.features.get(&feature) {
                next.extend(values.iter().cloned());
            }
            if let Some(profile) = data
                .profiles
                .as_ref()
                .and_then(|profiles| profiles.get(&feature))
            {
                next.extend(profile.enables.iter().cloned());
            }
            if let Some(values) = data
                .closure
                .as_ref()
                .and_then(|closure| closure.get(&feature))
            {
                next.extend(values.iter().cloned());
            }
            for value in next {
                if enabled.insert(value) {
                    added = true;
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
    pub unknown: bool,
    pub recognized: bool,
    pub reason: String,
    pub gating_feature: Option<String>,
    pub text: String,
}

/// Feature check assuming the feature graph was fully resolved.
#[cfg(test)]
pub fn check(query: &str, data: &FeaturesData, transitive: &[String]) -> Verdict {
    check_with_resolution(query, data, transitive, true)
}

/// Feature check with a resolution flag. Disabled verdicts from an incomplete
/// graph become `unknown` instead of authoritative false negatives.
pub fn check_with_resolution(
    query: &str,
    data: &FeaturesData,
    transitive: &[String],
    resolved: bool,
) -> Verdict {
    let mut verdict = check_inner(query, data, transitive);
    if !resolved && verdict.recognized && !verdict.available {
        verdict.unknown = true;
        verdict.reason = format!(
            "Cannot prove disabled: full Cargo feature resolution is unavailable. {}",
            verdict.reason
        );
        verdict.text = format!(
            "? `{query}` — unknown (unresolved feature graph; rerun with network or a populated Cargo cache to confirm)"
        );
    }
    verdict
}

fn check_inner(query: &str, data: &FeaturesData, transitive: &[String]) -> Verdict {
    let enabled = |feature: &str| transitive.iter().any(|value| value == feature);
    let known = |feature: &str| data.features.contains_key(feature);

    if query == "DefaultPlugins" {
        let is_enabled = enabled("default");
        return Verdict {
            unknown: false,
            recognized: true,
            available: is_enabled,
            reason: if is_enabled {
                "Bevy's default feature set is enabled".to_string()
            } else {
                "Bevy's default feature set is disabled".to_string()
            },
            gating_feature: Some("default".to_string()),
            text: format!(
                "{} `DefaultPlugins` — {}",
                if is_enabled { "✓" } else { "✗" },
                if is_enabled {
                    "available with the default feature set"
                } else {
                    "requires the `[default]` feature set"
                }
            ),
        };
    }
    if query == "MinimalPlugins" {
        return Verdict {
            unknown: false,
            recognized: true,
            available: true,
            reason: "MinimalPlugins does not require Bevy's default feature set".to_string(),
            gating_feature: None,
            text: "✓ `MinimalPlugins` — available".to_string(),
        };
    }

    if known(query) {
        let is_enabled = enabled(query);
        return Verdict {
            unknown: false,
            recognized: true,
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
            unknown: false,
            recognized: true,
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
        if let Some(info) = data
            .subcrates
            .as_ref()
            .and_then(|subcrates| subcrates.get(&subcrate))
        {
            if !info.optional {
                return Verdict {
                    unknown: false,
                    recognized: true,
                    available: true,
                    reason: format!("subcrate \"{subcrate}\" is an unconditional Bevy dependency"),
                    gating_feature: None,
                    text: format!("✓ `{query}` — subcrate \"{subcrate}\" is always included"),
                };
            }
            if info.features.is_empty() {
                return Verdict {
                    unknown: true,
                    recognized: true,
                    available: false,
                    reason: format!(
                        "subcrate \"{subcrate}\" is optional, but no enabling feature is recorded"
                    ),
                    gating_feature: None,
                    text: format!(
                        "? `{query}` — subcrate \"{subcrate}\" is optional, but its feature gate is unknown"
                    ),
                };
            }
            let enabled_features: Vec<&str> = info
                .features
                .iter()
                .filter(|feature| enabled(feature))
                .map(String::as_str)
                .collect();
            let is_enabled = !enabled_features.is_empty();
            let gates = info.features.join(" or ");
            return Verdict {
                unknown: false,
                recognized: true,
                available: is_enabled,
                reason: format!("subcrate \"{subcrate}\" is gated by feature \"[{gates}]\""),
                gating_feature: info.features.first().cloned(),
                text: format!(
                    "{} `{query}` — subcrate \"{subcrate}\" {}",
                    if is_enabled { "✓" } else { "✗" },
                    if is_enabled {
                        "is available".to_string()
                    } else {
                        format!("requires `[{gates}]`")
                    }
                ),
            };
        }

        let gating = gating_feature_for(&subcrate, data);
        let Some(gating) = gating else {
            return Verdict {
                unknown: true,
                recognized: true,
                available: false,
                reason: format!(
                    "no feature gate is recorded for subcrate \"{subcrate}\"; it may be unconditional or metadata may be incomplete"
                ),
                gating_feature: None,
                text: format!(
                    "? `{query}` — subcrate \"{subcrate}\" has no recorded feature gate (unknown)"
                ),
            };
        };
        let is_enabled = enabled(&gating);
        return Verdict {
            unknown: false,
            recognized: true,
            available: is_enabled,
            reason: format!("subcrate \"{subcrate}\" gated by feature \"[{gating}]\""),
            gating_feature: Some(gating.clone()),
            text: format!(
                "{} `{query}` — subcrate \"{subcrate}\" {}",
                if is_enabled { "✓" } else { "✗" },
                if is_enabled {
                    "is available".to_string()
                } else {
                    format!("requires `[{gating}]`")
                }
            ),
        };
    }

    if let Some(gates) = &data.plugin_gates {
        for gate in gates {
            if gate.plugin.contains(query) || query.contains(&gate.plugin) {
                let is_enabled = enabled(&gate.requires_feature);
                return Verdict {
                    unknown: false,
                    recognized: true,
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
                unknown: false,
                recognized: true,
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
        unknown: false,
        recognized: false,
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
    fn profile_features_cascade_transitively() {
        let data: FeaturesData = serde_json::from_value(serde_json::json!({
            "bevy_version": "9.9.9",
            "features": {
                "bevy_ui": ["bevy_ui"],
                "bevy_render": ["bevy_render"],
                "ui_api": [],
                "ui_bevy_render": ["bevy_render"]
            },
            "profiles": {
                "ui": { "description": "", "enables": ["ui_api", "ui_bevy_render", "bevy_ui"] }
            },
            "default_features": ["ui"]
        }))
        .expect("features");
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n\n[dependencies]\nbevy = \"9.9.9\"\n",
        )
        .expect("manifest");
        let enabled = enabled(dir.path(), &data);
        assert!(enabled.transitive.contains(&"ui".to_string()));
        assert!(enabled.transitive.contains(&"bevy_ui".to_string()));
        assert!(enabled.transitive.contains(&"bevy_render".to_string()));
    }

    #[test]
    fn no_deps_metadata_is_used_when_full_resolution_fails() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(dir.path().join("src")).expect("src dir");
        fs::write(dir.path().join("src/lib.rs"), "").expect("lib");
        fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nbevy = \"9.9.9\"\n",
        )
        .expect("manifest");
        let enabled = enabled(dir.path(), &data());
        assert_eq!(enabled.source, "cargo metadata (no-deps)");
        assert!(enabled.default_features);
        assert!(enabled.transitive.contains(&"bevy_render".to_string()));
    }

    #[test]
    fn default_plugins_is_a_known_query() {
        let enabled = check(
            "DefaultPlugins",
            &data(),
            &["default".to_string(), "bevy_render".to_string()],
        );
        assert!(enabled.available, "{}", enabled.text);
        assert_eq!(enabled.gating_feature.as_deref(), Some("default"));

        let disabled = check("DefaultPlugins", &data(), &[]);
        assert!(!disabled.available);
        assert!(disabled.reason.contains("default"), "{}", disabled.reason);
    }

    #[test]
    fn subcrate_map_marks_unconditional_crates_available() {
        let data: FeaturesData = serde_json::from_value(serde_json::json!({
            "features": {
                "bevy_ui": ["bevy_ui"]
            },
            "subcrates": {
                "bevy_input": { "optional": false, "features": [] },
                "bevy_ui": { "optional": true, "features": ["bevy_ui"] }
            }
        }))
        .expect("features");
        let enabled = vec!["bevy_ui".to_string()];

        let input = check("bevy::input::keyboard::KeyboardInput", &data, &enabled);
        assert!(input.available, "{}", input.text);
        assert!(!input.unknown);

        let ui = check("bevy::ui::Node", &data, &enabled);
        assert!(ui.available, "{}", ui.text);

        let disabled = check("bevy::ui::Node", &data, &[]);
        assert!(!disabled.available, "{}", disabled.text);
        assert_eq!(disabled.gating_feature.as_deref(), Some("bevy_ui"));
    }

    #[test]
    fn disabled_features_are_unknown_when_the_graph_is_unresolved() {
        let verdict = check_with_resolution("bevy_ui", &data(), &[], false);
        assert!(!verdict.available);
        assert!(verdict.unknown, "{}", verdict.text);
        assert!(verdict.text.contains("unknown"), "{}", verdict.text);

        let resolved = check_with_resolution("bevy_ui", &data(), &[], true);
        assert!(!resolved.available);
        assert!(!resolved.unknown);
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
