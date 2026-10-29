//! `bevy://` resources: URI scheme, templates, reads and completions.
//!
//! Identity-based access includes items omitted from full-text search. Rust
//! paths are percent-encoded so embedded slashes survive transport.

use std::path::Path;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};

use crate::archive::{ArchivedCorpus, ArchivedRecord, LoadedCorpus, archive_path_for, base_name};
use crate::pagination::paginate;
use crate::versions::bump_between;

pub const SCHEME: &str = "bevy";
pub const INDEX_URI: &str = "bevy://index/versions";

const URI_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

pub fn api_uri(version: &str, full_path: &str) -> String {
    format!("{SCHEME}://api/{}/{}", encode(version), encode(full_path))
}
pub fn kind_uri(version: &str, kind: &str) -> String {
    format!("{SCHEME}://kind/{}/{}", encode(version), encode(kind))
}
pub fn module_uri(version: &str, module: &str) -> String {
    format!("{SCHEME}://module/{}/{}", encode(version), encode(module))
}
pub fn crate_uri(version: &str, name: &str) -> String {
    format!("{SCHEME}://crate/{}/{}", encode(version), encode(name))
}
pub fn owner_uri(version: &str, owner: &str) -> String {
    format!("{SCHEME}://owner/{}/{}", encode(version), encode(owner))
}
pub fn doc_uri(version: &str, file: &str) -> String {
    format!("{SCHEME}://doc/{}/{}", encode(version), encode(file))
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, URI_SET).to_string()
}

fn decode(value: &str) -> Option<String> {
    percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|decoded| decoded.into_owned())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Query {
    Api { version: String, path: String },
    Kind { version: String, kind: String },
    Module { version: String, module: String },
    Crate { version: String, crate_name: String },
    Owner { version: String, owner: String },
    Doc { version: String, file: String },
    Index,
}

impl Query {
    pub fn version(&self) -> Option<&str> {
        match self {
            Query::Index => None,
            Query::Api { version, .. }
            | Query::Kind { version, .. }
            | Query::Module { version, .. }
            | Query::Crate { version, .. }
            | Query::Owner { version, .. }
            | Query::Doc { version, .. } => Some(version),
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Query::Api { .. } => "api",
            Query::Kind { .. } => "kind",
            Query::Module { .. } => "module",
            Query::Crate { .. } => "crate",
            Query::Owner { .. } => "owner",
            Query::Doc { .. } => "doc",
            Query::Index => "index",
        }
    }

    pub fn value(&self) -> &str {
        match self {
            Query::Api { path, .. } => path,
            Query::Kind { kind, .. } => kind,
            Query::Module { module, .. } => module,
            Query::Crate { crate_name, .. } => crate_name,
            Query::Owner { owner, .. } => owner,
            Query::Doc { file, .. } => file,
            Query::Index => "versions",
        }
    }

    pub fn cursor_id(&self) -> String {
        format!("{}:{}", self.label(), self.value())
    }
}

/// Parse a `bevy://` URI. Returns `None` for malformed or unsupported URIs.
pub fn parse_uri(uri: &str) -> Option<Query> {
    let rest = uri.strip_prefix(&format!("{SCHEME}://"))?;
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let segments: Option<Vec<String>> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(decode)
        .collect();
    let segments = segments?;

    if host == "index" {
        return (segments.len() == 1 && segments[0] == "versions").then_some(Query::Index);
    }
    let version = segments.first()?.clone();
    let rest = &segments[1..];
    let joined = || rest.join("/");

    match host {
        "api" | "path" => (!rest.is_empty()).then(|| Query::Api {
            version,
            path: joined(),
        }),
        "kind" => (rest.len() == 1 && !rest[0].is_empty()).then(|| Query::Kind {
            version,
            kind: rest[0].clone(),
        }),
        "module" => (!rest.is_empty()).then(|| Query::Module {
            version,
            module: joined(),
        }),
        "crate" => (rest.len() == 1 && !rest[0].is_empty()).then(|| Query::Crate {
            version,
            crate_name: rest[0].clone(),
        }),
        "owner" => (rest.len() == 1 && !rest[0].is_empty()).then(|| Query::Owner {
            version,
            owner: rest[0].clone(),
        }),
        "doc" => (!rest.is_empty()).then(|| Query::Doc {
            version,
            file: joined(),
        }),
        _ => None,
    }
}

/// Continuation cursor carried in the resource URI (`?cursor=...`).
pub fn cursor_of(uri: &str) -> Option<String> {
    let (_, query) = uri.split_once('?')?;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        if key == "cursor" {
            return decode(value);
        }
    }
    None
}

pub struct TemplateDef {
    pub uri_template: &'static str,
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
}

pub const TEMPLATES: [TemplateDef; 6] = [
    TemplateDef {
        uri_template: "bevy://api/{version}/{path}",
        name: "bevy-api-item",
        title: "Bevy API item by full path",
        description: "One API item (struct, enum, trait, fn, method) by its Rust path, e.g. bevy::camera::primitives::Sphere. Works for items that are not full-text indexed.",
    },
    TemplateDef {
        uri_template: "bevy://kind/{version}/{kind}",
        name: "bevy-items-by-kind",
        title: "All Bevy API items of one kind",
        description: "Paginated list of items with the given kind: struct, enum, trait, fn, method.",
    },
    TemplateDef {
        uri_template: "bevy://module/{version}/{module}",
        name: "bevy-items-by-module",
        title: "All Bevy API items in a module",
        description: "Paginated list of items in a module path, e.g. bevy::render::render::graph.",
    },
    TemplateDef {
        uri_template: "bevy://crate/{version}/{crate}",
        name: "bevy-items-by-crate",
        title: "All Bevy API items in a sub-crate",
        description: "Paginated list of items defined in one Bevy sub-crate, e.g. bevy_render, bevy_ecs.",
    },
    TemplateDef {
        uri_template: "bevy://owner/{version}/{owner}",
        name: "bevy-items-by-type",
        title: "All methods and associated items on one type",
        description: "Paginated list of everything attached to a type, e.g. all methods on Camera.",
    },
    TemplateDef {
        uri_template: "bevy://doc/{version}/{file}",
        name: "bevy-items-by-source-file",
        title: "Items documented on one rustdoc page",
        description: "All items parsed from a single rustdoc HTML page.",
    },
];

pub struct Source<'a> {
    pub corpus: Option<&'a LoadedCorpus>,
    pub active_version: Option<&'a str>,
    pub data_dir: &'a Path,
    pub versions: Vec<String>,
}

enum Loaded<'a> {
    Borrowed(&'a LoadedCorpus),
    Owned(LoadedCorpus),
}

impl Loaded<'_> {
    fn root(&self) -> &ArchivedCorpus {
        match self {
            Loaded::Borrowed(corpus) => corpus.root(),
            Loaded::Owned(corpus) => corpus.root(),
        }
    }
}

impl Source<'_> {
    fn open(&self, version: &str) -> Option<Loaded<'_>> {
        if self.active_version == Some(version)
            && let Some(corpus) = self.corpus
        {
            return Some(Loaded::Borrowed(corpus));
        }
        let path = archive_path_for(self.data_dir, version);
        if !path.is_file() {
            return None;
        }
        LoadedCorpus::open(&path).ok().map(Loaded::Owned)
    }

    fn missing(&self, version: &str) -> String {
        format!(
            "Bevy {version} is not indexed. Available: {}",
            self.versions.join(", ")
        )
    }
}

pub struct ReadOutput {
    pub text: String,
    pub next_cursor: Option<String>,
    pub total: Option<usize>,
    pub page_size: Option<usize>,
}

pub fn read(source: &Source<'_>, uri: &str) -> Result<ReadOutput, String> {
    if !uri.starts_with(&format!("{SCHEME}://")) {
        return Err(format!("Not a bevy resource URI: {uri}"));
    }
    let query = parse_uri(uri).ok_or_else(|| format!("Malformed bevy URI: {uri}"))?;

    if query == Query::Index {
        return Ok(ReadOutput {
            text: index_text(source),
            next_cursor: None,
            total: None,
            page_size: None,
        });
    }

    let version = query.version().unwrap_or("unknown").to_string();
    let loaded = source
        .open(&version)
        .ok_or_else(|| source.missing(&version))?;
    let root = loaded.root();
    let cursor = cursor_of(uri);

    match &query {
        Query::Api { version, path } => {
            let record = root
                .records
                .iter()
                .find(|record| root.string(record.full_path) == path.as_str())
                .ok_or_else(|| {
                    format!(
                        "No API item at \"{path}\" in Bevy {version}. Check the path, or search with the bevy_search tool."
                    )
                })?;
            let body = format!(
                "> Read from `{uri}` · Bevy {version}\n\n{}",
                record_markdown(root, record, 4000)
            );
            Ok(ReadOutput {
                text: body,
                next_cursor: None,
                total: None,
                page_size: None,
            })
        }
        Query::Index => unreachable!(),
        listing => {
            let matches: Vec<&ArchivedRecord> = root
                .records
                .iter()
                .filter(|record| matches_listing(root, record, listing))
                .collect();
            if matches.is_empty() {
                return Err(format!(
                    "No items matched {}=\"{}\" in Bevy {version}.",
                    listing.label(),
                    listing.value()
                ));
            }
            let page = paginate(&matches, &listing.cursor_id(), cursor.as_deref(), None)?;
            let text = listing_markdown(root, &version, listing, &page);
            Ok(ReadOutput {
                text,
                next_cursor: page.next_cursor,
                total: Some(page.total),
                page_size: Some(page.page_size),
            })
        }
    }
}

fn matches_listing(root: &ArchivedCorpus, record: &ArchivedRecord, query: &Query) -> bool {
    match query {
        Query::Kind { kind, .. } => root.string(record.kind) == kind.as_str(),
        Query::Module { module, .. } => root.string(record.module).starts_with(module.as_str()),
        Query::Crate { crate_name, .. } => {
            sub_crate_of(root, record).as_deref() == Some(crate_name.as_str())
        }
        Query::Owner { owner, .. } => base_name(root.string(record.owner)) == owner.as_str(),
        Query::Doc { file, .. } => root.string(record.file) == file.as_str(),
        _ => false,
    }
}

fn sub_crate_of(root: &ArchivedCorpus, record: &ArchivedRecord) -> Option<String> {
    let source_ref = root.string(record.source_ref);
    if let Some(rest) = source_ref.split("docs.rs/").nth(1)
        && let Some(name) = rest.split('/').next()
        && !name.is_empty()
    {
        return Some(name.to_string());
    }
    let crate_name = root.string(record.crate_name);
    (!crate_name.is_empty()).then(|| crate_name.to_string())
}

fn record_markdown(root: &ArchivedCorpus, record: &ArchivedRecord, docs_chars: usize) -> String {
    let mut lines = vec![
        format!("# `{}`", root.string(record.full_path)),
        String::new(),
        format!(
            "**{}** · Bevy {}",
            root.string(record.kind),
            root.bevy_version
        ),
    ];
    let source_ref = root.string(record.source_ref);
    if !source_ref.is_empty() {
        lines[2].push_str(&format!(" · [source]({source_ref})"));
    }
    let signature = root.string(record.signature);
    if !signature.is_empty() {
        lines.push(String::new());
        lines.push("```rust".to_string());
        lines.push(signature.to_string());
        lines.push("```".to_string());
    }
    let docs = root.string(record.docs);
    if !docs.is_empty() {
        lines.push(String::new());
        lines.push(truncate_chars(docs, docs_chars));
    }
    let defaults = root.string(record.defaults);
    if !defaults.is_empty() {
        lines.push(String::new());
        lines.push("## Defaults".to_string());
        lines.push(String::new());
        lines.push(defaults.to_string());
    }
    if let Some(example) = record.examples.first() {
        let code = root.string(example.code);
        if !code.is_empty() {
            lines.push(String::new());
            lines.push("## Example".to_string());
            lines.push(String::new());
            lines.push(format!("```{}\n{}\n```", root.string(example.lang), code));
        }
    }
    lines.join("\n")
}

fn listing_markdown(
    root: &ArchivedCorpus,
    version: &str,
    query: &Query,
    page: &crate::pagination::Page<'_, &ArchivedRecord>,
) -> String {
    let mut lines = vec![
        format!("# Bevy {version} - {}: {}", query.label(), query.value()),
        String::new(),
        format!(
            "_{} item(s), showing {}. Paged; re-read with `cursor` to continue._",
            page.total,
            page.items.len()
        ),
        String::new(),
    ];
    for record in page.items {
        let signature = root.string(record.signature).replace('\n', " ");
        let signature = if signature.is_empty() {
            String::new()
        } else {
            format!(" - `{}`", truncate_chars(&signature, 110))
        };
        lines.push(format!(
            "- [`{}`] **{}**{signature}\n  `{}`",
            root.string(record.kind),
            root.string(record.name),
            api_uri(version, root.string(record.full_path))
        ));
    }
    lines.join("\n")
}

fn index_text(source: &Source<'_>) -> String {
    let active = source.active_version.unwrap_or("UNKNOWN");
    let mut lines = vec![
        "# Indexed Bevy versions".to_string(),
        String::new(),
        format!("Active (from the host project's Cargo.lock): **{active}**"),
        String::new(),
        "| version | available |".to_string(),
        "|---|---|".to_string(),
    ];
    for version in &source.versions {
        let breaking = if version == active {
            String::new()
        } else if bump_between(Some(active), Some(version)).breaks_api {
            " (breaking change from active)".to_string()
        } else {
            String::new()
        };
        lines.push(format!(
            "| {version} | {}{breaking} |",
            if version == active {
                "**active**"
            } else {
                "yes"
            }
        ));
    }
    lines.push(String::new());
    lines.push("Read an item with:".to_string());
    lines.push(format!("- `{}`", api_uri("<version>", "<full::path>")));
    lines.push(format!(
        "- `{}` - everything on one type",
        owner_uri("<version>", "<TypeName>")
    ));
    lines.push(format!(
        "- `{}` - a whole sub-crate",
        crate_uri("<version>", "bevy_render")
    ));
    lines.push(format!(
        "- `{}` - every method",
        kind_uri("<version>", "method")
    ));
    lines.push(format!(
        "- `{}` - all items in a module",
        module_uri("<version>", "bevy::render::render::graph")
    ));
    lines.push(format!(
        "- `{}` - items from one rustdoc page",
        doc_uri("<version>", "bevy_camera/struct.Camera.html")
    ));
    lines.join("\n")
}

const KINDS: [&str; 12] = [
    "struct",
    "enum",
    "trait",
    "fn",
    "method",
    "associated_type",
    "associated_const",
    "type",
    "constant",
    "macro",
    "field",
    "variant",
];

/// Complete a template argument. Returns `(values, total_matches)`.
pub fn complete(
    source: &Source<'_>,
    template: &str,
    argument: &str,
    value: &str,
    context: &std::collections::HashMap<String, String>,
) -> (Vec<String>, usize) {
    if !template.contains(&format!("{{{argument}}}")) {
        return (Vec::new(), 0);
    }
    let needle = value.to_lowercase();
    if argument == "version" {
        let values: Vec<String> = source
            .versions
            .iter()
            .filter(|version| version.to_lowercase().starts_with(&needle))
            .cloned()
            .collect();
        return (values.clone(), values.len());
    }
    if argument == "kind" {
        let values: Vec<String> = KINDS
            .iter()
            .filter(|kind| kind.starts_with(&needle))
            .map(|kind| (*kind).to_string())
            .collect();
        return (values.clone(), values.len());
    }

    let selected = context
        .get("version")
        .map(String::as_str)
        .or(source.active_version);
    let Some(selected) = selected else {
        return (Vec::new(), 0);
    };
    let Some(loaded) = source.open(selected) else {
        return (Vec::new(), 0);
    };
    let root = loaded.root();

    let mut matches: Vec<String> = Vec::new();
    let push = |matches: &mut Vec<String>, candidate: String| {
        if candidate.to_lowercase().starts_with(&needle) {
            matches.push(candidate);
        }
    };
    match argument {
        "crate" => {
            for record in root.records.iter() {
                if let Some(name) = sub_crate_of(root, record) {
                    push(&mut matches, name);
                }
            }
        }
        "path" => {
            for record in root.records.iter() {
                if root.string(record.source) == "rustdoc" {
                    push(&mut matches, root.string(record.full_path).to_string());
                }
            }
        }
        "module" => {
            for record in root.records.iter() {
                push(&mut matches, root.string(record.module).to_string());
            }
        }
        "owner" => {
            for record in root.records.iter() {
                let owner = base_name(root.string(record.owner));
                if !owner.is_empty() {
                    push(&mut matches, owner);
                }
            }
        }
        "file" => {
            for record in root.records.iter() {
                push(&mut matches, root.string(record.file).to_string());
            }
        }
        _ => return (Vec::new(), 0),
    }
    matches.sort_unstable();
    matches.dedup();
    let total = matches.len();
    matches.truncate(100);
    (matches, total)
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_builds_uris() {
        let uri = api_uri("0.20.0", "bevy::ecs::Query");
        assert_eq!(
            parse_uri(&uri),
            Some(Query::Api {
                version: "0.20.0".into(),
                path: "bevy::ecs::Query".into()
            })
        );
        assert_eq!(parse_uri(INDEX_URI), Some(Query::Index));
        assert_eq!(
            parse_uri(&owner_uri("0.20.0", "Camera")),
            Some(Query::Owner {
                version: "0.20.0".into(),
                owner: "Camera".into()
            })
        );
        assert_eq!(parse_uri("bevy://nope/1/x"), None);
        assert_eq!(parse_uri("https://example.test"), None);
    }

    #[test]
    fn cursor_is_read_from_the_query_string() {
        let uri = format!("{}?cursor=50.abc", api_uri("0.20.0", "X"));
        assert_eq!(cursor_of(&uri), Some("50.abc".into()));
        assert_eq!(cursor_of("bevy://index/versions"), None);
    }
}
