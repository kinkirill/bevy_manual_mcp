//! Markdown and structured rendering for search and API results.

use serde_json::{Value, json};

use crate::archive::ArchivedRecord;
use crate::search::{Hit, SearchState};

pub fn record_json(state: &SearchState<'_>, record: &ArchivedRecord) -> Value {
    let root = state.root();
    let text = |id| root.string(id);
    let nullable = |value: &str| {
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value.to_string())
        }
    };
    json!({
        "id": text(record.hash),
        "source": text(record.source),
        "kind": text(record.kind),
        "name": text(record.name),
        "full_path": text(record.full_path),
        "signature": text(record.signature),
        "docs": text(record.docs),
        "module": text(record.module),
        "owner": nullable(text(record.owner)),
        "crate": nullable(text(record.crate_name)),
        "bevy_version": nullable(text(record.bevy_version)),
        "heading": nullable(text(record.heading)),
        "title": nullable(text(record.title)),
    })
}

pub fn hit_json(state: &SearchState<'_>, hit: &Hit<'_>) -> Value {
    let mut value = record_json(state, hit.record);
    if let Value::Object(ref mut map) = value {
        map.insert("score".into(), json!(hit.score));
    }
    value
}

pub fn search_markdown(
    state: &SearchState<'_>,
    hits: &[Hit<'_>],
    query: &str,
    label: Option<&str>,
) -> String {
    let root = state.root();
    let version = label.unwrap_or_else(|| root.bevy_version.as_str());
    if hits.is_empty() {
        return format!("# Search results: \"{query}\"\n\nNo match in the Bevy {version} corpus.");
    }

    let mut lines = vec![
        format!("# Search results: \"{query}\""),
        String::new(),
        format!("**Bevy {version}** · {} result(s)", hits.len()),
    ];
    for (index, hit) in hits.iter().enumerate() {
        let record = hit.record;
        lines.push(String::new());
        lines.push(format!(
            "## {}. `{}` — {}",
            index + 1,
            root.string(record.full_path),
            root.string(record.kind)
        ));
        let source = root.string(record.source);
        let mut meta = format!("source: {source}");
        if let Some(heading) = non_empty(root.string(record.heading)) {
            meta.push_str(&format!(" · section: {heading}"));
        }
        lines.push(meta);
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
            lines.push(truncate_chars(docs, 700));
        }
    }
    lines.join("\n")
}

pub fn api_markdown(
    state: &SearchState<'_>,
    records: &[&ArchivedRecord],
    symbol: &str,
    related: &[&ArchivedRecord],
) -> String {
    let root = state.root();
    if records.is_empty() {
        return format!(
            "# `{symbol}`\n\nNo API symbol matched in the Bevy {} corpus.",
            root.bevy_version
        );
    }
    let mut lines = Vec::new();
    for record in records {
        lines.push(format!("# `{}`", root.string(record.full_path)));
        lines.push(String::new());
        let mut meta = format!(
            "**{}** · Bevy {}",
            root.string(record.kind),
            root.bevy_version
        );
        let source_ref = root.string(record.source_ref);
        if !source_ref.is_empty() {
            meta.push_str(&format!(" · [source]({source_ref})"));
        }
        lines.push(meta);
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
            lines.push(truncate_chars(docs, 3000));
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
        lines.push(String::new());
    }
    if !related.is_empty() {
        lines.push("## Related items on this type".to_string());
        lines.push(String::new());
        for record in related {
            lines.push(format!(
                "- `{}` ({})",
                root.string(record.name),
                root.string(record.kind)
            ));
        }
    }
    lines.join("\n")
}

fn non_empty(value: &str) -> Option<&str> {
    if value.is_empty() { None } else { Some(value) }
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max).collect();
    out.push('…');
    out
}
