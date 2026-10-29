//! Vendored Bevy error-code guides (`vendor/bevy-meta/<version>/error-codes`).

use std::fs;
use std::path::Path;

use crate::archive::RecordInput;

pub fn ingest_error_codes(
    errors_dir: Option<&Path>,
    meta_dir: Option<&Path>,
    bevy_version: &str,
) -> Vec<RecordInput> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = errors_dir {
        dirs.push(dir.to_path_buf());
    }
    if let Some(meta) = meta_dir {
        dirs.push(meta.join(bevy_version).join("error-codes"));
    }

    for dir in dirs {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut files: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .filter(|name| is_error_code(name))
            .collect();
        if files.is_empty() {
            continue;
        }
        files.sort();
        return files
            .into_iter()
            .filter_map(|file| {
                let name = file.strip_suffix(".md")?.to_string();
                let docs = fs::read_to_string(dir.join(&file)).ok()?;
                Some(RecordInput {
                    source: "bevy-meta".into(),
                    kind: "error_code".into(),
                    name: name.clone(),
                    full_path: format!("bevy::errors::{name}"),
                    docs,
                    signature: String::new(),
                    module: "bevy::errors".into(),
                    file: format!("errors/{file}"),
                    owner: None,
                    crate_name: None,
                    source_ref: None,
                    bevy_version: Some(bevy_version.to_string()),
                    title: Some(format!("Error {name}")),
                    ..Default::default()
                })
            })
            .collect();
    }
    Vec::new()
}

fn is_error_code(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".md") else {
        return false;
    };
    let bytes = stem.as_bytes();
    bytes.len() == 5 && bytes[0] == b'B' && bytes[1..].iter().all(u8::is_ascii_digit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_bnnnn_markdown() {
        assert!(is_error_code("B0001.md"));
        assert!(is_error_code("B9999.md"));
        assert!(!is_error_code("B001.md"));
        assert!(!is_error_code("X0001.md"));
        assert!(!is_error_code("B0001.markdown"));
    }
}
