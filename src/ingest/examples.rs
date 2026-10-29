//! Engine and Book `.rs` examples, with adjacent Cargo feature metadata.
//!
//! Ported from `src/ingest/examples.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use crate::archive::RecordInput;

const CATEGORY_RULES: &[(&str, &[&str], &[&str])] = &[
    // (tag, path fences, free-text needles)
    ("2d", &["/2d/"], &[]),
    ("3d", &["/3d/"], &[]),
    ("ui", &["/ui/", "/ui.rs"], &[]),
    (
        "input",
        &["/input/", "/input.rs"],
        &["keyboard", "mouse", "gamepad"],
    ),
    ("audio", &["/audio/", "/audio.rs"], &[]),
    ("assets", &["/asset/"], &["assets"]),
    (
        "ecs",
        &["/ecs/"],
        &["system", "schedule", "query", "component"],
    ),
    ("state", &["/state/", "/state.rs"], &[]),
    ("time", &["/time/"], &["timer"]),
    ("window", &["/window/", "/window.rs"], &[]),
    ("render", &["/render/"], &["camera", "material", "mesh"]),
    ("scene", &["/scene/"], &["gltf", "scn"]),
    ("gizmos", &["/gizmo"], &[]),
    ("animation", &["/animation/"], &["animat"]),
    ("lighting", &["/light"], &[]),
    ("text", &["/font", "/text.rs"], &["ui_text"]),
    ("transforms", &["/transform"], &[]),
    ("diagnostics", &["/diagnostic"], &["error"]),
    ("math", &["/math/"], &[]),
    ("observers", &["/ecs/observer"], &["observ"]),
];

pub fn ingest_examples(
    examples_dir: Option<&Path>,
    website_dir: Option<&Path>,
    bevy_version: &str,
) -> Vec<RecordInput> {
    let mut records = Vec::new();
    if let Some(dir) = examples_dir {
        records.extend(ingest_dir(dir, "bevy-examples", bevy_version));
    }
    if let Some(website) = website_dir {
        let dir = website.join("learning-code-examples").join("examples");
        records.extend(ingest_dir(&dir, "learn-examples", bevy_version));
    }
    records
}

fn ingest_dir(root: &Path, source: &str, bevy_version: &str) -> Vec<RecordInput> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut records = Vec::new();
    for file in walk_rs(root, 0) {
        let Ok(rel) = file.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let Ok(code) = fs::read_to_string(&file) else {
            continue;
        };
        let dir_meta = read_cargo_features(file.parent().unwrap_or(root));
        let doc = module_doc(&code);
        let name = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let module = module_of(&rel);
        let docs = if doc.is_empty() {
            format!("```rust\n{code}\n```")
        } else {
            format!("{doc}\n\n```rust\n{code}\n```")
        };
        let line_count = code.split('\n').count() as u32;
        records.push(RecordInput {
            source: source.into(),
            kind: "code_example".into(),
            name: name.clone(),
            full_path: format!("{source}:{rel}"),
            owner: None,
            crate_name: Some(source.into()),
            module,
            signature: String::new(),
            docs,
            description: if doc.is_empty() { None } else { Some(doc) },
            code: Some(code),
            file: rel.clone(),
            file_abs: Some(file.to_string_lossy().to_string()),
            line_count: Some(line_count),
            categories: Some(categorise(&rel)),
            required_features: dir_meta,
            bevy_version: Some(bevy_version.to_string()),
            source_ref: None,
            title: Some(name),
            ..Default::default()
        });
    }
    records
}

fn module_of(rel: &str) -> String {
    match Path::new(rel).parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            parent.to_string_lossy().replace(['/', '\\'], "::")
        }
        _ => ".".to_string(),
    }
}

fn walk_rs(dir: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(dir, depth, &mut out);
    out
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, depth + 1, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// The `//!` module comment at the top of a Bevy example describes it.
pub fn module_doc(code: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in code.split('\n') {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("//!") {
            out.push(rest.trim_start().to_string());
        } else if !out.is_empty() && trimmed.is_empty() {
            continue;
        } else {
            break;
        }
    }
    out.join("\n").trim().to_string()
}

fn read_cargo_features(dir: &Path) -> Option<Vec<String>> {
    let text = fs::read_to_string(dir.join("Cargo.toml")).ok()?;
    let parsed: toml::Value = toml::from_str(&text).ok()?;
    let default = parsed
        .get("features")
        .and_then(|features| features.get("default"))
        .and_then(toml::Value::as_array)?;
    Some(
        default
            .iter()
            .filter_map(toml::Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

/// Classify an example by path. Order matters and duplicates are collapsed.
pub fn categorise(rel: &str) -> Vec<String> {
    let with_slash = if rel.starts_with('/') {
        rel.to_string()
    } else {
        format!("/{rel}")
    };
    let mut tags: Vec<String> = Vec::new();
    for (tag, fences, needles) in CATEGORY_RULES {
        let hit = fences.iter().any(|fence| with_slash.contains(fence))
            || needles.iter().any(|needle| with_slash.contains(needle));
        if hit && !tags.iter().any(|existing| existing == tag) {
            tags.push((*tag).to_string());
        }
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_doc_reads_leading_comments() {
        assert_eq!(
            module_doc("//! Camera demo.\n//!\n//! Second line.\n\nfn main() {}"),
            "Camera demo.\n\nSecond line."
        );
        assert_eq!(module_doc("fn main() {}"), "");
    }

    #[test]
    fn categorises_example_paths() {
        assert_eq!(
            categorise("3d/camera.rs"),
            vec!["3d".to_string(), "render".to_string()]
        );
        assert_eq!(categorise("ui/button.rs"), vec!["ui".to_string()]);
        assert_eq!(
            categorise("ecs/observer.rs"),
            vec!["ecs".to_string(), "observers".to_string()]
        );
    }

    #[test]
    fn reads_default_features() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"demo\"\n\n[features]\ndefault = [\"bevy/2d\", \"bevy/ui\"]\n",
        )
        .expect("cargo toml");
        assert_eq!(
            read_cargo_features(dir.path()),
            Some(vec!["bevy/2d".to_string(), "bevy/ui".to_string()])
        );
    }
}
