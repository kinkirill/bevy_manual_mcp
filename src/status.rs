//! Rendering for `bevy_index_status` and `bevy_indexed_versions`.
//!
//! The markdown mirrors the TypeScript tools; statistics come from the registry
//! and per-version metadata until the compiled corpus loads (step 1).

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::config::Config;
use crate::registry::Registry;
use crate::versions::bump_between;

pub fn status(config: &Config, registry: &Registry) -> (String, Value) {
    let version = config.bevy_version.as_deref();
    let entry = version.and_then(|v| registry.entry(v));
    let meta = version.and_then(|v| registry.meta(v));

    let records = entry
        .and_then(|e| e.records)
        .or_else(|| meta.as_ref().and_then(|m| m.api_records))
        .unwrap_or(0);
    let symbols = entry
        .and_then(|e| e.symbols)
        .or_else(|| meta.as_ref().and_then(|m| m.symbols))
        .unwrap_or(0);
    let by_kind: BTreeMap<&str, u64> = entry
        .map(|e| e.by_kind.iter().map(|(k, v)| (k.as_str(), *v)).collect())
        .unwrap_or_default();
    let by_source: BTreeMap<&str, u64> = entry
        .map(|e| e.by_source.iter().map(|(k, v)| (k.as_str(), *v)).collect())
        .unwrap_or_default();
    let has_api_index = meta
        .as_ref()
        .and_then(|m| m.api_records)
        .map(|n| n > 0)
        .unwrap_or(false);

    let mut lines = vec![
        "# bevy-mcp index status".to_string(),
        String::new(),
        format!("- **Bevy version:** {}", version.unwrap_or("UNKNOWN")),
        format!(
            "- **Detected from:** {}",
            config.version_source.as_deref().unwrap_or("n/a")
        ),
        format!("- **Host project:** {}", config.project_root.display()),
        format!("- **Records:** {records} ({symbols} exact symbols)"),
    ];

    if meta.is_none() {
        lines.push(String::new());
        lines.push(format!(
            "No compiled corpus is installed for Bevy {}. Run `bevy-mcp fetch-index {}` to install one.",
            version.unwrap_or("<version>"),
            version.unwrap_or("<version>")
        ));
    }
    if version.is_none()
        && let Some(note) = &config.version_note
    {
        lines.push(String::new());
        lines.push(note.clone());
    }

    if !by_kind.is_empty() {
        lines.push(String::new());
        lines.push("## By kind".to_string());
        lines.push(String::new());
        let mut kinds: Vec<(&str, u64)> = by_kind.into_iter().collect();
        kinds.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
        for (kind, count) in kinds {
            lines.push(format!("- `{kind}`: {count}"));
        }
    }

    lines.push(String::new());
    lines.push("## Paths".to_string());
    lines.push(String::new());
    let path_or = |value: Option<&str>, fallback: &str| match value {
        Some(path) if !path.is_empty() => path.to_string(),
        _ => fallback.to_string(),
    };
    lines.push(format!(
        "- cargo doc: {}",
        path_or(
            meta.as_ref().and_then(|m| m.doc_dir.as_deref()),
            "**not found** - run `cargo doc` in your Bevy project"
        )
    ));
    lines.push(format!(
        "- bevy-website: {}",
        path_or(
            meta.as_ref().and_then(|m| m.website_dir.as_deref()),
            "**not found**"
        )
    ));
    lines.push(format!(
        "- engine examples: {}",
        path_or(
            meta.as_ref().and_then(|m| m.examples_dir.as_deref()),
            "**not found** - clone the bevy repo for `examples/`"
        )
    ));
    lines.push(format!("- corpus data: {}", registry.data_dir().display()));

    let structured = json!({
        "bevy_version": version,
        "doc_version": Value::Null,
        "version_mismatch": false,
        "version_source": config.version_source,
        "project_root": config.project_root.display().to_string(),
        "doc_dir": meta.as_ref().and_then(|m| m.doc_dir.clone()),
        "website_dir": meta.as_ref().and_then(|m| m.website_dir.clone()),
        "examples_dir": meta.as_ref().and_then(|m| m.examples_dir.clone()),
        "meta_dir": Value::Null,
        "errors_dir": Value::Null,
        "stats": {
            "total": records,
            "by_source": by_source,
            "by_kind": entry.map(|e| e.by_kind.clone()).unwrap_or_default(),
        },
        "symbols": symbols,
        "built_at": entry
            .and_then(|e| e.built_at.clone())
            .or_else(|| meta.as_ref().and_then(|m| m.built_at.clone())),
        "has_api_index": has_api_index,
    });

    (lines.join("\n"), structured)
}

pub fn versions(config: &Config, registry: &Registry) -> (String, Value) {
    let active = config.bevy_version.clone();
    let mut all = registry.indexed_versions();
    if let Some(active) = &active
        && !all.contains(active)
    {
        all.insert(0, active.clone());
    }

    let mut rows: Vec<Value> = Vec::new();
    let mut lines = vec![
        "# Indexed Bevy versions".to_string(),
        String::new(),
        format!(
            "**Active:** {} (from {})",
            active.as_deref().unwrap_or("UNKNOWN"),
            config.version_source.as_deref().unwrap_or("n/a")
        ),
        String::new(),
        "| version | active | records | symbols | vs active |".to_string(),
        "|---|---|---|---|---|".to_string(),
    ];

    for version in &all {
        let entry = registry.entry(version);
        let meta = registry.meta(version);
        let is_active = active.as_deref() == Some(version.as_str());
        let records = entry
            .and_then(|e| e.records)
            .or_else(|| meta.as_ref().and_then(|m| m.api_records));
        let symbols = entry
            .and_then(|e| e.symbols)
            .or_else(|| meta.as_ref().and_then(|m| m.symbols));
        let built_at = entry
            .and_then(|e| e.built_at.clone())
            .or_else(|| meta.as_ref().and_then(|m| m.built_at.clone()));
        let relative = if is_active {
            None
        } else {
            Some(bump_between(active.as_deref(), Some(version.as_str())))
        };

        let vs_active = relative
            .as_ref()
            .map(|bump| {
                format!(
                    "{}{}",
                    bump.level,
                    if bump.breaks_api { " (breaking)" } else { "" }
                )
            })
            .unwrap_or_else(|| "-".to_string());
        lines.push(format!(
            "| {} | {} | {} | {} | {} |",
            version,
            if is_active { "**yes**" } else { "" },
            records
                .map(|n| n.to_string())
                .unwrap_or_else(|| "-".to_string()),
            symbols
                .map(|n| n.to_string())
                .unwrap_or_else(|| "-".to_string()),
            vs_active,
        ));

        rows.push(json!({
            "version": version,
            "active": is_active,
            "records": records,
            "symbols": symbols,
            "built_at": built_at,
            "relative_to_active": relative,
        }));
    }

    let others = rows
        .iter()
        .filter(|row| row["active"] != json!(true))
        .count();
    lines.push(String::new());
    if others > 0 {
        lines.push(
            "You can pass `version` to `bevy_api` and `bevy_search` to query any of these."
                .to_string(),
        );
    } else {
        lines.push("_Only one version is indexed. To add another:_".to_string());
        lines.push(String::new());
        lines.push(
            "- `bevy-mcp fetch-index <version>` and set `BEVY_VERSION=<version>`.".to_string(),
        );
        lines.push("- or run `cargo doc` in a project pinned to that version.".to_string());
    }

    (
        lines.join("\n"),
        json!({ "active": active, "versions": rows }),
    )
}
