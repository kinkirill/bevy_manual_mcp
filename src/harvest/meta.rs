//! Harvest per-version Bevy metadata from the engine repository.
//!
//! Port of `scripts/harvest-meta.mts`: error-code guides, the feature graph
//! (including implicit optional-dependency features), default features,
//! profiles, plugin gates and panic-site codes, written next to a provenance
//! `meta.json`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use super::http::Fetcher;

const REPO: &str = "bevyengine/bevy";
const RAW: &str = "https://raw.githubusercontent.com";
const API: &str = "https://api.github.com/repos";

#[derive(Debug, Clone, Serialize)]
struct PluginGate {
    plugin: String,
    requires_feature: String,
}

#[derive(Debug, Clone, Serialize)]
struct PanicSite {
    file: String,
    line: usize,
}

#[derive(Debug, Clone, Serialize)]
struct Profile {
    description: String,
    enables: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct Subcrate {
    optional: bool,
    /// Features that enable this optional dependency. Empty for unconditional
    /// dependencies such as `bevy_input`.
    features: Vec<String>,
}

#[derive(Debug, Serialize)]
struct FeaturesFile {
    bevy_version: String,
    features: BTreeMap<String, Vec<String>>,
    closure: BTreeMap<String, Vec<String>>,
    profiles: BTreeMap<String, Profile>,
    subcrates: BTreeMap<String, Subcrate>,
    default_features: Vec<String>,
    plugin_gates: Vec<PluginGate>,
    panic_sites: BTreeMap<String, Vec<PanicSite>>,
}

pub struct MetaOptions {
    pub version: String,
    pub tag: Option<String>,
    pub out: PathBuf,
    pub force: bool,
}

fn stable_version(version: &str) -> Result<()> {
    let stable = Regex::new(r"^\d+\.\d+\.\d+$").expect("version regex");
    if !stable.is_match(version) {
        bail!("Invalid Bevy version \"{version}\"; use a stable version such as 0.20.0.");
    }
    Ok(())
}

/// Feature entries can be `name`, `dep:name`, or `name/subfeature`.
fn resolve_entry(entry: &str, feature_names: &BTreeSet<String>) -> Option<String> {
    let base = entry.split('/').next().unwrap_or(entry);
    let feature = base.strip_prefix("dep:").unwrap_or(base);
    feature_names.contains(feature).then(|| feature.to_string())
}

fn closure(graph: &BTreeMap<String, Vec<String>>) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    for name in graph.keys() {
        let mut seen = BTreeSet::new();
        let mut stack: Vec<String> = graph.get(name).cloned().unwrap_or_default();
        while let Some(feature) = stack.pop() {
            if !seen.insert(feature.clone()) {
                continue;
            }
            for next in graph.get(&feature).cloned().unwrap_or_default() {
                stack.push(next);
            }
        }
        seen.remove(name);
        out.insert(name.clone(), seen.into_iter().collect());
    }
    out
}

fn parse_features(internal_toml: &str, facade_toml: Option<&str>) -> Result<FeaturesFile> {
    let internal: toml::Value =
        toml::from_str(internal_toml).context("cannot parse crates/bevy_internal/Cargo.toml")?;
    let facade: Option<toml::Value> = match facade_toml {
        Some(text) => Some(toml::from_str(text).context("cannot parse facade Cargo.toml")?),
        None => None,
    };
    let raw_features = internal
        .get("features")
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default();
    let facade_features = facade
        .as_ref()
        .and_then(|facade| facade.get("features"))
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default();
    let dependencies = internal
        .get("dependencies")
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default();

    // Cargo creates an implicit feature for every optional dependency unless
    // the package suppresses it with `dep:`; Bevy gates plugins on those names.
    let mut feature_names: BTreeSet<String> = raw_features.keys().cloned().collect();
    feature_names.extend(facade_features.keys().cloned());
    for (name, value) in &dependencies {
        if value
            .get("optional")
            .and_then(toml::Value::as_bool)
            .unwrap_or(false)
        {
            feature_names.insert(name.clone());
        }
    }

    let mut subcrates: BTreeMap<String, Subcrate> = BTreeMap::new();
    for (dependency_key, value) in &dependencies {
        let package = value
            .get("package")
            .and_then(toml::Value::as_str)
            .unwrap_or(dependency_key)
            .replace('-', "_");
        let optional = value
            .get("optional")
            .and_then(toml::Value::as_bool)
            .unwrap_or(false);
        let mut features = BTreeSet::new();
        if optional {
            // Cargo's implicit optional-dependency feature.
            features.insert(dependency_key.clone());
            for (feature, entries) in &raw_features {
                let Some(entries) = entries.as_array() else {
                    continue;
                };
                for entry in entries {
                    let Some(entry) = entry.as_str() else {
                        continue;
                    };
                    let base = entry.split('/').next().unwrap_or(entry);
                    let target = base.strip_prefix("dep:").unwrap_or(base);
                    if target == dependency_key {
                        features.insert(feature.clone());
                    }
                }
            }
        }
        subcrates.insert(
            package,
            Subcrate {
                optional,
                features: features.into_iter().collect(),
            },
        );
    }

    let mut graph: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (name, value) in &raw_features {
        let mut enables = BTreeSet::new();
        if let Some(entries) = value.as_array() {
            for entry in entries {
                if let Some(entry) = entry.as_str()
                    && let Some(feature) = resolve_entry(entry, &feature_names)
                {
                    enables.insert(feature);
                }
            }
        }
        graph.insert(name.clone(), enables.into_iter().collect());
    }
    // Facade features such as `2d`, `ui` and `ui_api` are part of the public
    // feature graph, not just profile labels. Merge them so the closure can
    // cascade through them.
    for (name, value) in &facade_features {
        let mut enables = BTreeSet::new();
        if let Some(entries) = value.as_array() {
            for entry in entries {
                if let Some(entry) = entry.as_str()
                    && let Some(feature) = resolve_entry(entry, &feature_names)
                {
                    enables.insert(feature);
                }
            }
        }
        graph.insert(name.clone(), enables.into_iter().collect());
    }
    for name in &feature_names {
        graph.entry(name.clone()).or_default();
    }

    let mut profiles = BTreeMap::new();
    let mut default_features = Vec::new();
    if let Some(facade) = &facade {
        if let Some(features) = facade.get("features").and_then(toml::Value::as_table) {
            for (name, value) in features {
                let Some(entries) = value.as_array() else {
                    continue;
                };
                let mut enables: Vec<String> = entries
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .map(str::to_string)
                    .collect();
                enables.sort();
                if name == "default" {
                    default_features = enables;
                } else if matches!(name.as_str(), "2d" | "3d" | "ui" | "audio") {
                    profiles.insert(
                        name.clone(),
                        Profile {
                            description: String::new(),
                            enables,
                        },
                    );
                }
            }
        }
    } else {
        eprintln!("  ! could not fetch facade Cargo.toml (profiles/default unavailable)");
    }

    Ok(FeaturesFile {
        bevy_version: String::new(),
        closure: closure(&graph),
        features: graph,
        profiles,
        subcrates,
        default_features,
        plugin_gates: Vec::new(),
        panic_sites: BTreeMap::new(),
    })
}

fn plugin_gates(source: &str) -> Vec<PluginGate> {
    // `#[cfg(feature = "X")]` followed by optional attributes and a plugin path.
    let regex = Regex::new(
        r#"(?s)#\[cfg\(feature\s*=\s*"([^"]+)"\)\]\s*\n(?:\s*#\[[^\]]*\]\s*\n)*\s*[A-Za-z0-9_:]+::([A-Za-z0-9_]+)"#,
    )
    .expect("plugin gate regex");
    regex
        .captures_iter(source)
        .filter_map(|captures| {
            Some(PluginGate {
                requires_feature: captures.get(1)?.as_str().to_string(),
                plugin: captures.get(2)?.as_str().to_string(),
            })
        })
        .collect()
}

fn panic_sites(source: &str) -> BTreeMap<String, Vec<PanicSite>> {
    let regex = Regex::new(r"(error|warning)\[(B\d{4})\]").expect("panic site regex");
    let mut sites: BTreeMap<String, Vec<PanicSite>> = BTreeMap::new();
    for (index, line) in source.lines().enumerate() {
        for captures in regex.captures_iter(line) {
            let Some(code) = captures.get(2) else {
                continue;
            };
            sites
                .entry(code.as_str().to_string())
                .or_default()
                .push(PanicSite {
                    file: "crates/bevy_ecs/src/system/system_param.rs".to_string(),
                    line: index + 1,
                });
        }
    }
    sites
}

fn error_code_names(list_json: &str) -> Result<Vec<String>> {
    let list: Vec<Value> = serde_json::from_str(list_json).context("invalid errors/ listing")?;
    let mut names: Vec<String> = list
        .iter()
        .filter(|entry| entry["type"].as_str() == Some("file"))
        .filter_map(|entry| entry["name"].as_str())
        .filter(|name| {
            Regex::new(r"^B\d{4}\.md$")
                .expect("code regex")
                .is_match(name)
        })
        .map(str::to_string)
        .collect();
    names.sort();
    Ok(names)
}

/// Harvest one version into `options.out`.
pub fn harvest_meta(options: &MetaOptions) -> Result<()> {
    stable_version(&options.version)?;
    let tag = options
        .tag
        .clone()
        .unwrap_or_else(|| format!("v{}", options.version));
    let out = options.out.clone();
    let marker = out.join("meta.json");
    if marker.is_file() && !options.force {
        println!(
            "Already harvested {} at {}. Use --force to replace.",
            options.version,
            out.display()
        );
        return Ok(());
    }

    println!("Harvesting Bevy {} from tag {tag}", options.version);
    println!("  repo:   {REPO}");
    println!("  target: {}\n", out.display());
    fs::create_dir_all(out.join("error-codes"))
        .with_context(|| format!("cannot create {}", out.join("error-codes").display()))?;
    let fetcher = Fetcher::new(60);

    println!("Fetching error codes…");
    let list_url = format!("{API}/{REPO}/contents/errors?ref={tag}");
    let list = fetcher
        .text(&list_url, 4)
        .map_err(|error| anyhow::anyhow!(error))?
        .ok_or_else(|| anyhow::anyhow!("Could not list errors/ at tag {tag}."))?;
    let names = error_code_names(&list)?;
    let mut codes_written = 0usize;
    for name in &names {
        let url = format!("{RAW}/{REPO}/{tag}/errors/{name}");
        match fetcher.text(&url, 4) {
            Ok(Some(body)) => {
                fs::write(out.join("error-codes").join(name), body)
                    .with_context(|| format!("cannot write error code {name}"))?;
                codes_written += 1;
            }
            Ok(None) => eprintln!("  ! {name} returned 404"),
            Err(error) => eprintln!("  ! failed to fetch {name}: {error}"),
        }
    }
    println!("  error codes: {codes_written}/{}", names.len());

    println!("Fetching feature graph…");
    let internal = fetcher
        .text(
            &format!("{RAW}/{REPO}/{tag}/crates/bevy_internal/Cargo.toml"),
            4,
        )
        .map_err(|error| anyhow::anyhow!(error))?
        .ok_or_else(|| anyhow::anyhow!("Could not fetch bevy_internal/Cargo.toml."))?;
    let facade = fetcher
        .text(&format!("{RAW}/{REPO}/{tag}/Cargo.toml"), 4)
        .map_err(|error| anyhow::anyhow!(error))?;
    let mut features = parse_features(&internal, facade.as_deref())?;
    features.bevy_version = options.version.clone();

    println!("Fetching default plugin gates…");
    let plugins = fetcher
        .text(
            &format!("{RAW}/{REPO}/{tag}/crates/bevy_internal/src/default_plugins.rs"),
            4,
        )
        .map_err(|error| anyhow::anyhow!(error))?;
    features.plugin_gates = plugins.as_deref().map(plugin_gates).unwrap_or_default();
    println!("  plugin gates: {}", features.plugin_gates.len());

    println!("Scanning panic sites…");
    let system_param = fetcher
        .text(
            &format!("{RAW}/{REPO}/{tag}/crates/bevy_ecs/src/system/system_param.rs"),
            4,
        )
        .map_err(|error| anyhow::anyhow!(error))?;
    features.panic_sites = system_param.as_deref().map(panic_sites).unwrap_or_default();
    println!(
        "  panic-site codes found: {}",
        features
            .panic_sites
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ")
    );

    let commit = fetcher
        .text(&format!("{API}/{REPO}/commits/{tag}"), 4)
        .map_err(|error| anyhow::anyhow!(error))?;
    let source_commit = commit
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .and_then(|value| value["sha"].as_str().map(str::to_string));

    let meta = serde_json::json!({
        "bevy_version": options.version,
        "tag": tag,
        "source_commit": source_commit,
        "harvested_at": chrono::Utc::now().to_rfc3339(),
        "error_codes": names.iter().map(|name| name.trim_end_matches(".md")).collect::<Vec<_>>(),
        "panic_site_codes": features.panic_sites.keys().collect::<Vec<_>>(),
    });
    fs::write(
        out.join("meta.json"),
        serde_json::to_string_pretty(&meta)? + "\n",
    )
    .context("cannot write meta.json")?;
    fs::write(
        out.join("features.json"),
        serde_json::to_string_pretty(&features)? + "\n",
    )
    .context("cannot write features.json")?;

    println!(
        "\nDone. {} features, {codes_written} error codes, {} plugin gates.",
        features.features.len(),
        features.plugin_gates.len()
    );
    println!("Output: {}", out.display());
    Ok(())
}

/// Default harvest target for a version.
pub fn default_out(version: &str) -> PathBuf {
    Path::new("vendor").join("bevy-meta").join(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_entries_resolve_dep_prefixes_and_subfeatures() {
        let names: BTreeSet<String> = ["bevy_ui", "bevy_render", "trace"]
            .iter()
            .map(|name| name.to_string())
            .collect();
        assert_eq!(
            resolve_entry("bevy_ui", &names),
            Some("bevy_ui".to_string())
        );
        assert_eq!(
            resolve_entry("dep:bevy_render", &names),
            Some("bevy_render".to_string())
        );
        assert_eq!(
            resolve_entry("bevy_ui/bevy_text", &names),
            Some("bevy_ui".to_string())
        );
        assert_eq!(resolve_entry("serde", &names), None);
    }

    #[test]
    fn closure_is_transitive_and_excludes_self() {
        let graph = BTreeMap::from([
            ("a".to_string(), vec!["b".to_string()]),
            ("b".to_string(), vec!["c".to_string()]),
            ("c".to_string(), vec![]),
        ]);
        let closed = closure(&graph);
        assert_eq!(closed["a"], vec!["b".to_string(), "c".to_string()]);
        assert_eq!(closed["b"], vec!["c".to_string()]);
        assert!(closed["c"].is_empty());
    }

    #[test]
    fn implicit_optional_dependencies_become_features() {
        let internal = r#"
[features]
default = ["bevy_ui"]
bevy_ui = ["dep:bevy_ui_crate", "bevy_render/texture"]

[dependencies]
bevy_input = "0.20.0"
bevy_ui_crate = { package = "bevy_ui", optional = true }
bevy_render = { optional = true }
serde = "1"
"#;
        let facade = r#"
[features]
default = ["2d", "ui"]
2d = ["bevy_2d"]
3d = ["bevy_3d"]
ui = ["bevy_ui"]
"#;
        let parsed = parse_features(internal, Some(facade)).expect("features");
        assert!(parsed.features.contains_key("bevy_ui_crate"));
        assert!(parsed.features.contains_key("bevy_render"));
        assert!(parsed.features.contains_key("ui"));
        assert!(!parsed.features.contains_key("serde"));
        assert_eq!(parsed.default_features, vec!["2d", "ui"]);
        assert!(parsed.profiles.contains_key("2d"));
        let bevy_ui = &parsed.subcrates["bevy_ui"];
        assert!(bevy_ui.optional);
        assert!(bevy_ui.features.contains(&"bevy_ui".to_string()));
        assert!(!parsed.subcrates["bevy_render"].features.is_empty());
        let bevy_input = &parsed.subcrates["bevy_input"];
        assert!(!bevy_input.optional);
        assert!(bevy_input.features.is_empty());
        let default_closure = &parsed.closure["default"];
        assert!(default_closure.contains(&"ui".to_string()));
        assert!(default_closure.contains(&"bevy_ui".to_string()));
        assert!(default_closure.contains(&"bevy_render".to_string()));
    }

    #[test]
    fn plugin_gates_and_panic_sites_are_scanned() {
        let source = r#"
#[cfg(feature = "bevy_log")]
#[derive(Debug)]
bevy_log:::LogPlugin,
#[cfg(feature = "bevy_ui")]
bevy::ui:::UiPlugin,
"#;
        let gates = plugin_gates(source);
        assert!(
            gates
                .iter()
                .any(|gate| gate.plugin == "LogPlugin" && gate.requires_feature == "bevy_log")
        );
        assert!(gates.iter().any(|gate| gate.plugin == "UiPlugin"));

        let panic =
            "panic!(\"error[B0002]: ResMut<T>...\");\nlet _ = 1;\npanic!(\"warning[B0004]: x\");";
        let sites = panic_sites(panic);
        assert_eq!(sites["B0002"][0].line, 1);
        assert_eq!(sites["B0004"][0].line, 3);
    }

    #[test]
    fn error_code_listing_filters_markdown_files() {
        let listing = r#"[
            {"name":"B0001.md","type":"file"},
            {"name":"README.md","type":"file"},
            {"name":"errors","type":"dir"}
        ]"#;
        assert_eq!(error_code_names(listing).expect("names"), vec!["B0001.md"]);
    }
}
