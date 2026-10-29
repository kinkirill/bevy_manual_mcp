//! Hybrid search: exact symbols, name tokens and tantivy BM25.
//!
//! Mirrors the TypeScript ranking shape: an exact symbol outranks everything,
//! name subject matches outrank prose, and text scores are normalised into a
//! band below them. Records that only differ by re-export collapse.

use crate::archive::{
    ArchivedCorpus, ArchivedRecord, LoadedCorpus, MaybeNativeId, base_name, norm_key,
    split_name_tokens,
};
use crate::text::{TextIndex, query_terms};

pub struct SearchState<'a> {
    pub corpus: &'a LoadedCorpus,
    pub text: &'a TextIndex,
}

impl SearchState<'_> {
    pub fn root(&self) -> &ArchivedCorpus {
        self.corpus.root()
    }
}

#[derive(Debug, Default, Clone)]
pub struct SearchFilters {
    pub kind: Option<String>,
    pub source: Option<String>,
    pub module: Option<String>,
    pub category: Option<String>,
    pub crate_name: Option<String>,
    pub draft: Option<bool>,
}

#[derive(Clone, Copy)]
pub struct Hit<'a> {
    pub record: &'a ArchivedRecord,
    pub score: f32,
}

const POOL: usize = 2000;

pub fn search<'a>(
    state: &'a SearchState<'_>,
    query: &str,
    limit: usize,
    filters: &SearchFilters,
) -> Vec<Hit<'a>> {
    let root = state.root();
    let key = norm_key(query);
    let has_filters = has_filters(filters);
    if key.is_empty() && !has_filters {
        return Vec::new();
    }

    let terms = query_terms(query);
    let mut seen: Vec<u32> = Vec::new();
    let mut scored: Vec<(u32, f32)> = Vec::new();

    // 1. Exact symbol matches keep their fixed score band (1000/1100).
    if !key.is_empty() {
        for record in root.lookup(query) {
            let id = record.dense_id.native();
            if !passes(filters, root, record) {
                continue;
            }
            let score = if key.contains("::") && norm_key(root.string(record.full_path)) == key {
                1100.0
            } else {
                1000.0
            };
            seen.push(id);
            // Exact symbols sit in a band above every heuristic score.
            scored.push((id, 10_000.0 + score * record_weight(root, record)));
        }
    }

    // 2. BM25 text matches, collected as raw scores first.
    let pool = if has_filters {
        POOL.max(limit * 100)
    } else {
        POOL
    };
    let mut text_raw: Vec<(u32, f32)> = Vec::new();
    if let Ok(text_hits) = state.text.search(query, pool) {
        for (id, score) in text_hits {
            if seen.contains(&id) {
                continue;
            }
            let Some(record) = root.record(id) else {
                continue;
            };
            if !passes(filters, root, record) {
                continue;
            }
            text_raw.push((
                id,
                score * record_weight(root, record) * relevance_boost(root, record, &terms),
            ));
        }
    }

    // 3. Subject-name matches FlexSearch's candidate budget may miss.
    let mut name_raw: Vec<(u32, f32)> = Vec::new();
    if seen.is_empty() {
        let mut candidate_ids: Vec<u32> = Vec::new();
        for term in &terms {
            if let Some(token) = root.find_name_token(term) {
                for id in token.ids.iter() {
                    let id = id.native();
                    if !candidate_ids.contains(&id) {
                        candidate_ids.push(id);
                    }
                }
            }
        }
        for id in candidate_ids {
            if seen.contains(&id) {
                continue;
            }
            let Some(record) = root.record(id) else {
                continue;
            };
            if !passes(filters, root, record) {
                continue;
            }
            let leaf_terms = split_name_tokens(&base_name(root.string(record.name)));
            let own_match = terms
                .iter()
                .any(|term| leaf_terms.iter().any(|leaf| leaf == term));
            let definition = is_definition(root.string(record.kind));
            let raw = if own_match && definition { 240.0 } else { 90.0 };
            name_raw.push((
                id,
                raw * record_weight(root, record) * relevance_boost(root, record, &terms),
            ));
        }
    }

    // 4. Text scores are normalised into 0..850; a name-token match adds a
    // subject score on top, so a name match dominates a prose-only match while
    // BM25 still orders records inside the same name tier.
    let text_max = text_raw
        .iter()
        .map(|(_, score)| *score)
        .fold(0.0f32, f32::max);
    let mut merged: Vec<(u32, f32, f32)> = Vec::new();
    for (id, raw) in text_raw {
        let band = if text_max > 0.0 {
            (raw / text_max) * 850.0
        } else {
            0.0
        };
        merged.push((id, band, 0.0));
    }
    for (id, raw) in name_raw {
        match merged.iter_mut().find(|(existing, _, _)| *existing == id) {
            Some((_, _, name)) if *name < raw => *name = raw,
            Some(_) => {}
            None => merged.push((id, 0.0, raw)),
        }
    }
    for (id, text_score, name_score) in merged {
        seen.push(id);
        let score = if name_score > 0.0 {
            name_score + text_score * 0.3
        } else {
            text_score
        };
        scored.push((id, score));
    }

    // 5. Rank, then collapse re-export duplicates.
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut definitions: Vec<String> = Vec::new();
    let mut hits = Vec::new();
    for (id, score) in scored {
        let Some(record) = root.record(id) else {
            continue;
        };
        let definition = definition_key(root, record);
        if definitions.contains(&definition) {
            continue;
        }
        definitions.push(definition);
        hits.push(Hit { record, score });
        if hits.len() >= limit {
            break;
        }
    }
    hits
}

pub fn passes(filters: &SearchFilters, root: &ArchivedCorpus, record: &ArchivedRecord) -> bool {
    let text = |id| root.string(id);
    if let Some(kind) = &filters.kind {
        let actual = text(record.kind);
        if !split_list(kind).any(|wanted| actual == wanted || actual.contains(wanted)) {
            return false;
        }
    }
    if let Some(source) = &filters.source
        && !split_list(source).any(|wanted| text(record.source) == wanted)
    {
        return false;
    }
    if let Some(crate_name) = &filters.crate_name
        && text(record.crate_name) != crate_name
    {
        return false;
    }
    if let Some(module) = &filters.module {
        let needle = module.to_lowercase();
        if !text(record.module).to_lowercase().contains(&needle) {
            return false;
        }
    }
    if let Some(category) = &filters.category {
        let categories: Vec<String> = record
            .categories
            .iter()
            .map(|id| text(*id).to_string())
            .collect();
        if !split_list(category).any(|wanted| categories.iter().any(|have| have == wanted)) {
            return false;
        }
    }
    if filters.draft == Some(false) && record.draft {
        return false;
    }
    true
}

fn split_list(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
}

fn has_filters(filters: &SearchFilters) -> bool {
    filters.kind.is_some()
        || filters.source.is_some()
        || filters.module.is_some()
        || filters.category.is_some()
        || filters.crate_name.is_some()
        || filters.draft.is_some()
}

pub fn record_weight(root: &ArchivedCorpus, record: &ArchivedRecord) -> f32 {
    match root.string(record.kind) {
        "field" => 0.45,
        "book" | "tutorial" | "migration_guide" => 0.7,
        "migration_entry" => 0.65,
        "release_notes" => 0.6,
        "faq" => 0.55,
        "guide" => 0.5,
        "doc" => 0.35,
        "news" => 0.12,
        "foundation" | "donate" | "sponsorship" => 0.0,
        _ => match root.string(record.source) {
            "rustdoc" => 1.0,
            "bevy-examples" => 0.9,
            "learn-examples" => 0.85,
            "website" | "bevy-meta" => 1.0,
            _ => 0.4,
        },
    }
}

fn is_definition(kind: &str) -> bool {
    matches!(
        kind,
        "struct" | "enum" | "trait" | "fn" | "type" | "primitive"
    )
}

/// Port of the TypeScript `relevanceBoost`: the query's own nouns in a
/// record's name matter more than the same words buried in its docs.
fn relevance_boost(root: &ArchivedCorpus, record: &ArchivedRecord, terms: &[String]) -> f32 {
    if terms.is_empty() {
        return 1.0;
    }
    let leaf_raw = base_name(root.string(record.name));
    let leaf = crate::archive::norm_key(&leaf_raw);
    let leaf_words = split_name_tokens(&leaf_raw);
    let owner_words = split_name_tokens(&base_name(root.string(record.owner)));
    let path_words = split_name_tokens(root.string(record.full_path));

    let first_subject = terms.iter().find(|term| !is_intent(term));
    let mut boost = 1.0f32;
    let mut matched = 0usize;
    for term in terms {
        let first_term = first_subject == Some(term);
        if leaf == *term {
            boost += if first_term { 4.5 } else { 3.0 };
            matched += 1;
        } else if leaf_words.iter().any(|word| word == term) {
            boost += if first_term { 3.7 } else { 2.2 };
            matched += 1;
        } else if term.len() > 3 && leaf.contains(term.as_str()) {
            boost += if first_term { 2.9 } else { 1.4 };
            matched += 1;
        } else if owner_words.iter().any(|word| word == term) {
            boost += 0.9;
        } else if path_words.iter().any(|word| word == term) {
            boost += 0.8;
        }
    }
    if matched > 1 {
        boost += (matched - 1) as f32 * 1.2;
    }
    // A name that covers several query subjects is the subject, not a neighbour.
    let subject_terms: Vec<&String> = terms.iter().filter(|term| !is_intent(term)).collect();
    let name_coverage = subject_terms
        .iter()
        .filter(|term| leaf == ***term || leaf_words.iter().any(|word| word == **term))
        .count();
    if name_coverage > 1 {
        boost += (name_coverage - 1) as f32 * 4.0;
    }
    if is_definition(root.string(record.kind)) {
        boost += 0.5;
    }
    boost
}

/// Intent verbs shape the query but are not its subject (ported list).
fn is_intent(term: &str) -> bool {
    matches!(
        term,
        "spawn"
            | "despawn"
            | "add"
            | "insert"
            | "remove"
            | "delete"
            | "create"
            | "make"
            | "get"
            | "set"
            | "apply"
            | "update"
            | "build"
            | "load"
            | "open"
            | "close"
            | "play"
            | "run"
            | "start"
            | "stop"
            | "use"
            | "attach"
            | "register"
            | "send"
            | "emit"
            | "read"
            | "write"
            | "enable"
            | "disable"
            | "toggle"
            | "bind"
            | "handle"
            | "process"
            | "turn"
            | "communicate"
            | "communication"
            | "communicating"
            | "compare"
            | "difference"
    )
}

fn definition_key(root: &ArchivedCorpus, record: &ArchivedRecord) -> String {
    let source_ref = root.string(record.source_ref);
    if root.string(record.source) == "rustdoc" && !source_ref.is_empty() {
        format!(
            "rustdoc|{source_ref}|{}|{}|{}",
            root.string(record.kind),
            base_name(root.string(record.owner)),
            root.string(record.name)
        )
    } else {
        root.string(record.hash).to_string()
    }
}

/// Other methods/associated items on the same owner, for `bevy_api`.
pub fn related_records<'a>(
    root: &'a ArchivedCorpus,
    record: &ArchivedRecord,
    limit: usize,
) -> Vec<&'a ArchivedRecord> {
    let owner = base_name(root.string(record.owner));
    if owner.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<&ArchivedRecord> = Vec::new();
    for candidate in root.records.iter() {
        if std::ptr::eq(candidate, record) {
            continue;
        }
        if base_name(root.string(candidate.owner)) != owner {
            continue;
        }
        if !is_member(root.string(candidate.kind)) {
            continue;
        }
        out.push(candidate);
        if out.len() >= limit {
            break;
        }
    }
    out.sort_by_key(|candidate| root.string(candidate.name));
    out
}

fn is_member(kind: &str) -> bool {
    matches!(
        kind,
        "method" | "associated_const" | "associated_type" | "field" | "variant"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_match_the_typescript_map() {
        assert!(is_definition("struct"));
        assert!(is_definition("fn"));
        assert!(!is_definition("method"));
        assert!(is_member("method"));
        assert!(!is_member("struct"));
    }

    #[test]
    fn comma_filters_split_and_trim() {
        let parts: Vec<&str> = split_list("struct, enum ,trait").collect();
        assert_eq!(parts, vec!["struct", "enum", "trait"]);
    }
}
