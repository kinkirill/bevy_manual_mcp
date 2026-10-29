//! Website markdown: Book, guides, release notes, migration guides.
//!
//! Ported 1:1 from `src/ingest/markdown.ts`: Zola-style front matter, path
//! classification, heading-scoped chunks with citation breadcrumbs, and the
//! weight-zero kinds that never become records.

use std::fs;
use std::path::{Path, PathBuf};

use crate::archive::RecordInput;

const MAX_CHARS: usize = 4000;
const MIN_CHUNK_CHARS: usize = 40;
const MAX_WHOLE_FILE_CHARS: usize = 6000;

#[derive(Debug, Default, Clone)]
pub struct FrontMatter {
    pub title: Option<String>,
    pub weight: Option<u32>,
    pub status: Option<String>,
    pub long_title: Option<String>,
    pub public_draft: bool,
}

#[derive(Debug, Default, Clone)]
pub struct FileInfo {
    pub kind: String,
    pub title: Option<String>,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub version: Option<String>,
    pub pr: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct Chunk {
    pub heading: Option<String>,
    pub heading_line: usize,
    pub breadcrumb: Vec<String>,
    pub text: String,
}

/// Kinds with weight zero in the search index; they never become records.
fn excluded_kind(kind: &str) -> bool {
    matches!(kind, "foundation" | "donate" | "sponsorship")
}

pub fn ingest_website(dir: Option<&Path>, bevy_version: Option<&str>) -> Vec<RecordInput> {
    let Some(dir) = dir else {
        return Vec::new();
    };
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut records = Vec::new();
    for file in walk_markdown(dir) {
        let Ok(rel) = file.strip_prefix(dir) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let info = classify(&rel);
        if excluded_kind(&info.kind) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&file) else {
            continue;
        };
        let (front, body) = split_front_matter(&raw);
        if body.trim().is_empty() {
            continue;
        }
        let title = info
            .title
            .clone()
            .or_else(|| front.long_title.clone())
            .or_else(|| front.title.clone())
            .unwrap_or_else(|| {
                Path::new(&rel)
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
        let draft = front.status.as_deref() == Some("hidden") || front.public_draft;
        let module = Path::new(rel.as_str())
            .parent()
            .map(|parent| parent.to_string_lossy().replace(['/', '\\'], "::"))
            .unwrap_or_default();

        let chunks = chunk_by_headings(body, MAX_CHARS);
        if chunks.len() <= 1 {
            records.push(RecordInput {
                source: "website".into(),
                kind: info.kind.clone(),
                name: title.clone(),
                full_path: format!("{}:{}", info.kind, rel),
                docs: truncate(body.trim(), MAX_WHOLE_FILE_CHARS).to_string(),
                signature: String::new(),
                module: module.clone(),
                file: rel.clone(),
                owner: None,
                crate_name: Some("bevy-website".into()),
                source_ref: None,
                bevy_version: bevy_version.map(str::to_string),
                title: Some(title),
                heading: None,
                breadcrumb: None,
                line_start: Some(1),
                draft,
                version: info.version.clone(),
                from_version: info.from_version.clone(),
                to_version: info.to_version.clone(),
                pr: info.pr,
                ..Default::default()
            });
            continue;
        }

        for chunk in chunks {
            records.push(RecordInput {
                source: "website".into(),
                kind: info.kind.clone(),
                name: title.clone(),
                full_path: format!("{}:{}", info.kind, rel),
                docs: chunk.text,
                signature: String::new(),
                module: module.clone(),
                file: rel.clone(),
                owner: None,
                crate_name: Some("bevy-website".into()),
                source_ref: None,
                bevy_version: bevy_version.map(str::to_string),
                title: Some(title.clone()),
                heading: chunk.heading,
                breadcrumb: Some(chunk.breadcrumb),
                line_start: Some(chunk.heading_line as u32),
                draft,
                version: info.version.clone(),
                from_version: info.from_version.clone(),
                to_version: info.to_version.clone(),
                pr: info.pr,
                ..Default::default()
            });
        }
    }
    records
}

fn truncate(value: &str, max: usize) -> &str {
    if value.len() <= max {
        return value;
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn walk_markdown(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(dir, &mut out);
    out
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let path = entry.path();
        if path.is_dir() {
            if name == ".git" || name == "target" {
                continue;
            }
            walk(&path, out);
        } else if name.ends_with(".md") {
            out.push(path);
        }
    }
}

/// Strip a Zola/TOML front matter block and parse the keys we care about.
pub fn split_front_matter(text: &str) -> (FrontMatter, &str) {
    let Some(rest) = text.strip_prefix("+++") else {
        return (FrontMatter::default(), text);
    };
    // The opening line must be exactly `+++` (allow CRLF).
    let mut rest = rest;
    if let Some(after) = rest.strip_prefix("\r\n") {
        rest = after;
    } else if let Some(after) = rest.strip_prefix('\n') {
        rest = after;
    } else {
        return (FrontMatter::default(), text);
    }
    let Some(end) = rest.find("\n+++") else {
        return (FrontMatter::default(), text);
    };
    let block = &rest[..end];
    let after = &rest[end + 1..];
    // Drop the closing delimiter line and its optional trailing newline.
    let after = after
        .strip_prefix("+++")
        .and_then(|value| {
            value
                .strip_prefix("\r\n")
                .or_else(|| value.strip_prefix('\n'))
        })
        .unwrap_or("");

    let mut meta = FrontMatter::default();
    for line in block.lines() {
        let line = line.trim_start();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "title" => meta.title = parse_double_quoted(value),
            "long_title" => meta.long_title = parse_double_quoted(value),
            "status" => meta.status = parse_single_quoted(value),
            "weight" => meta.weight = value.parse().ok(),
            "public_draft" => meta.public_draft = true,
            _ => {}
        }
    }
    (meta, after)
}

fn parse_double_quoted(value: &str) -> Option<String> {
    let start = value.find('"')?;
    let rest = &value[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn parse_single_quoted(value: &str) -> Option<String> {
    let start = value.find('\'')?;
    let rest = &value[start + 1..];
    let end = rest.find('\'')?;
    Some(rest[..end].to_string())
}

/// Classify a file by its path inside the website repo.
pub fn classify(rel: &str) -> FileInfo {
    if let Some((from, to)) = migration_guide_versions(rel) {
        return FileInfo {
            kind: "migration_guide".into(),
            title: Some(format!("Migration guide {from} -> {to}")),
            from_version: Some(from),
            to_version: Some(to),
            ..Default::default()
        };
    }
    if rel.starts_with("content/learn/migration-guides/") {
        return FileInfo {
            kind: "migration_guide".into(),
            title: Some("Migration guides (index)".into()),
            ..Default::default()
        };
    }
    if let Some((version, pr, slug)) = release_migration(rel) {
        return FileInfo {
            kind: "migration_entry".into(),
            title: Some(slug.replace('_', " ")),
            version: Some(version),
            pr,
            ..Default::default()
        };
    }
    if let Some((version, slug)) = release_notes(rel) {
        return FileInfo {
            kind: "release_notes".into(),
            title: Some(slug.replace('_', " ")),
            version: Some(version),
            ..Default::default()
        };
    }
    let kind = if rel.starts_with("content/learn/book/") {
        "book"
    } else if rel.starts_with("content/learn/quick-start/")
        || rel.starts_with("content/learn/advanced-examples/")
    {
        "tutorial"
    } else if rel.starts_with("content/learn/") {
        "guide"
    } else if rel.starts_with("content/faq") {
        return FileInfo {
            kind: "faq".into(),
            title: Some("FAQ".into()),
            ..Default::default()
        };
    } else if rel.starts_with("content/news/") {
        "news"
    } else if rel.starts_with("content/foundation") {
        "foundation"
    } else if rel.starts_with("content/donate") {
        "donate"
    } else if rel.starts_with("content/sponsorship-pledge") {
        "sponsorship"
    } else {
        "doc"
    };
    FileInfo {
        kind: kind.into(),
        ..Default::default()
    }
}

/// `content/learn/migration-guides/0.15-to-0.16.md` -> ("0.15", "0.16").
fn migration_guide_versions(rel: &str) -> Option<(String, String)> {
    let rest = rel.strip_prefix("content/learn/migration-guides/")?;
    let stem = rest.strip_suffix(".md")?;
    if stem.contains('/') {
        return None;
    }
    let (from, to) = stem.split_once("-to-")?;
    if !is_version(from) || !is_version(to) {
        return None;
    }
    Some((from.to_string(), to.to_string()))
}

/// `release-content/0.16/migration-guides/1234_title.md` -> (version, pr, title).
fn release_migration(rel: &str) -> Option<(String, Option<u32>, String)> {
    let rest = rel.strip_prefix("release-content/")?;
    let (version, rest) = rest.split_once('/')?;
    let rest = rest.strip_prefix("migration-guides/")?;
    let stem = rest.strip_suffix(".md")?;
    if stem.contains('/') {
        return None;
    }
    let (pr, slug) = match stem.split_once('_') {
        Some((prefix, slug)) if prefix.chars().all(|c| c.is_ascii_digit()) => {
            (prefix.parse().ok(), slug.to_string())
        }
        _ => (None, stem.to_string()),
    };
    Some((version.to_string(), pr, slug))
}

/// `release-content/0.16/release-notes/title.md` -> (version, title).
fn release_notes(rel: &str) -> Option<(String, String)> {
    let rest = rel.strip_prefix("release-content/")?;
    let (version, rest) = rest.split_once('/')?;
    let rest = rest.strip_prefix("release-notes/")?;
    let stem = rest.strip_suffix(".md")?;
    if stem.contains('/') {
        return None;
    }
    Some((version.to_string(), stem.to_string()))
}

fn is_version(value: &str) -> bool {
    value.split('.').count() == 2
        && value
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// Split headings into bounded chunks with citation breadcrumbs.
pub fn chunk_by_headings(body: &str, max_chars: usize) -> Vec<Chunk> {
    let lines: Vec<&str> = body
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let mut chunks = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut heading: Option<String> = None;
    let mut heading_line = 0usize;
    let mut buffer: Vec<&str> = Vec::new();

    let flush = |buffer: &mut Vec<&str>,
                 heading: &mut Option<String>,
                 heading_line: usize,
                 stack: &[String],
                 chunks: &mut Vec<Chunk>| {
        let text = buffer.join("\n");
        let text = text.trim();
        if text.len() >= MIN_CHUNK_CHARS {
            let breadcrumb = stack
                .iter()
                .map(|entry| {
                    entry
                        .trim_start_matches('#')
                        .trim()
                        .split('{')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string()
                })
                .filter(|entry| !entry.is_empty())
                .collect();
            chunks.push(Chunk {
                heading: heading.take(),
                heading_line,
                breadcrumb,
                text: truncate(text, max_chars).to_string(),
            });
        }
        buffer.clear();
    };

    for (index, line) in lines.iter().enumerate() {
        match heading_level(line) {
            Some(level) if !is_inside_fence(&lines, index) => {
                flush(&mut buffer, &mut heading, heading_line, &stack, &mut chunks);
                while stack
                    .last()
                    .and_then(|entry| heading_level(entry))
                    .is_some_and(|top| top >= level)
                {
                    stack.pop();
                }
                stack.push((*line).to_string());
                heading = Some(
                    line.trim_start_matches('#')
                        .split('{')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string(),
                );
                heading_line = index + 1;
                buffer.push(line);
            }
            _ => buffer.push(line),
        }
    }
    flush(&mut buffer, &mut heading, heading_line, &stack, &mut chunks);
    chunks
}

fn heading_level(line: &str) -> Option<usize> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    if line.chars().nth(hashes).is_some_and(char::is_whitespace) {
        Some(hashes)
    } else {
        None
    }
}

fn is_inside_fence(lines: &[&str], index: usize) -> bool {
    let fences = lines[..index]
        .iter()
        .filter(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("```") || trimmed.starts_with("~~~")
        })
        .count();
    fences % 2 == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_website_paths() {
        assert_eq!(
            classify("content/learn/migration-guides/0.15-to-0.16.md").kind,
            "migration_guide"
        );
        assert_eq!(
            classify("content/learn/migration-guides/0.15-to-0.16.md")
                .title
                .as_deref(),
            Some("Migration guide 0.15 -> 0.16")
        );
        assert_eq!(
            classify("release-content/0.16/migration-guides/2345_widgets.md").kind,
            "migration_entry"
        );
        assert_eq!(
            classify("release-content/0.16/migration-guides/2345_widgets.md").pr,
            Some(2345)
        );
        assert_eq!(
            classify("release-content/0.16/migration-guides/2345_widgets.md")
                .title
                .as_deref(),
            Some("widgets")
        );
        assert_eq!(
            classify("content/learn/book/getting-started.md").kind,
            "book"
        );
        assert_eq!(classify("content/news/2024-01-01.md").kind, "news");
        assert_eq!(classify("content/foundation/team.md").kind, "foundation");
    }

    #[test]
    fn parses_front_matter_and_marks_drafts() {
        let text = "+++\ntitle = \"Hello\"\nstatus = 'hidden'\npublic_draft = true\n+++\nBody";
        let (front, body) = split_front_matter(text);
        assert_eq!(front.title.as_deref(), Some("Hello"));
        assert_eq!(front.status.as_deref(), Some("hidden"));
        assert!(front.public_draft);
        assert_eq!(body, "Body");
        assert_eq!(split_front_matter("no front matter").1, "no front matter");
    }

    #[test]
    fn chunks_by_heading_and_ignores_fences() {
        let body = "# Intro\n\nThis is a long enough paragraph to become a chunk.\n\n```\n# not a heading\n```\n\n## Details\n\nAnother paragraph that is long enough to survive the minimum.\n";
        let chunks = chunk_by_headings(body, 4000);
        assert_eq!(chunks.len(), 2, "{chunks:?}");
        assert_eq!(chunks[0].heading.as_deref(), Some("Intro"));
        assert_eq!(chunks[1].heading.as_deref(), Some("Details"));
        assert_eq!(chunks[1].breadcrumb, vec!["Intro", "Details"]);
    }
}
