//! Hybrid search: exact symbols, name tokens and tantivy BM25.
//!
//! Mirrors the TypeScript ranking shape: an exact symbol outranks everything,
//! name subject matches outrank prose, and text scores are normalised into a
//! band below them. Records that only differ by re-export collapse.

use crate::archive::{
    ArchivedCorpus, ArchivedRecord, LoadedCorpus, MaybeNativeId, base_name, norm_key,
    singular_term, split_name_tokens,
};
use crate::text::{QUERY_STOPWORDS, TextIndex, query_terms};

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
    let subjects = canonical_subjects(&terms);
    let surfaces = query_surfaces(query);
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
                score
                    * record_weight(root, record)
                    * relevance_boost(root, record, &subjects, &surfaces),
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
            let coverage = name_coverage(root, record, &subjects);
            let definition = is_definition(root.string(record.kind));
            // A record that names every subject in the query is the concept even
            // when it is a constant or a field.
            let names_the_concept = coverage > 0 && (definition || coverage == subjects.len());
            let raw = if names_the_concept {
                240.0
            } else if coverage > 0 {
                90.0
            } else {
                0.0
            };
            if raw == 0.0 {
                continue;
            }
            name_raw.push((
                id,
                raw * record_weight(root, record)
                    * relevance_boost(root, record, &subjects, &surfaces),
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

/// Words the user actually typed, for exact surface-name matches.
pub fn query_surfaces(query: &str) -> Vec<String> {
    let mut surfaces: Vec<String> = Vec::new();
    for word in query
        .to_lowercase()
        .split(|ch: char| !(ch.is_alphanumeric() || ch == '_'))
    {
        if word.len() < 2 || QUERY_STOPWORDS.contains(&word) {
            continue;
        }
        if !surfaces.iter().any(|existing| existing == word) {
            surfaces.push(word.to_string());
        }
    }
    surfaces
}

/// Canonical query subjects: singular, de-duplicated, intent verbs removed.
fn canonical_subjects(terms: &[String]) -> Vec<String> {
    let mut subjects: Vec<String> = Vec::new();
    for term in terms {
        if is_intent(term) {
            continue;
        }
        let singular = singular_term(term);
        if !subjects.iter().any(|existing| existing == &singular) {
            subjects.push(singular);
        }
    }
    subjects
}

/// How many of `subjects` appear in a record's name or owner.
fn name_coverage(root: &ArchivedCorpus, record: &ArchivedRecord, subjects: &[String]) -> usize {
    let leaf = base_name(root.string(record.name));
    let leaf_singular = singular_term(&crate::archive::norm_key(&leaf));
    let leaf_words = split_name_tokens(&leaf);
    subjects
        .iter()
        .filter(|term| {
            leaf_singular == ***term
                || leaf_words
                    .iter()
                    .any(|word| word == *term || singular_term(word) == ***term)
        })
        .count()
}

/// Port of the TypeScript `relevanceBoost`: the query's own nouns in a
/// record's name matter more than the same words buried in its docs.
fn relevance_boost(
    root: &ArchivedCorpus,
    record: &ArchivedRecord,
    subjects: &[String],
    surfaces: &[String],
) -> f32 {
    if subjects.is_empty() {
        return 1.0;
    }
    let leaf_raw = base_name(root.string(record.name));
    let leaf = crate::archive::norm_key(&leaf_raw);
    let leaf_singular = singular_term(&leaf);
    let leaf_words = split_name_tokens(&leaf_raw);
    let owner_words = split_name_tokens(&base_name(root.string(record.owner)));
    let path_words = split_name_tokens(root.string(record.full_path));
    let module_words = split_name_tokens(root.string(record.module));

    let first_subject = subjects.first().cloned();
    let exact_surface = surfaces
        .iter()
        .any(|surface| surface == &leaf_raw.to_lowercase());
    let mut boost = 1.0f32;
    let mut matched = 0usize;
    let mut coverage = 0usize;
    if exact_surface && !is_intent(&leaf_raw.to_lowercase()) {
        // The user typed this exact name: the strongest signal available.
        let first = first_subject
            .as_deref()
            .is_some_and(|term| term == leaf_singular);
        boost += if first { 10.5 } else { 8.0 };
        matched += 1;
        coverage += 1;
    }
    for term in subjects {
        let first_term = first_subject.as_deref() == Some(term.as_str());
        if exact_surface && leaf_singular == *term {
            continue;
        } else if leaf_singular == *term {
            // The record is the named concept, not merely a word that contains it.
            boost += if first_term { 6.5 } else { 4.0 };
            matched += 1;
            coverage += 1;
        } else if leaf_words
            .iter()
            .any(|word| word == term || singular_term(word) == *term)
        {
            boost += if first_term { 3.7 } else { 2.2 };
            matched += 1;
            coverage += 1;
        } else if term.len() > 3 && leaf.contains(term.as_str()) {
            boost += if first_term { 2.9 } else { 1.4 };
            matched += 1;
            coverage += 1;
        } else if owner_words.iter().any(|word| word == term) {
            boost += 0.9;
        } else if path_words.iter().any(|word| word == term) {
            boost += 0.8;
        }
    }
    if matched > 1 {
        boost += (matched - 1) as f32 * 1.2;
    }
    // A name covering every subject is the concept itself; partial coverage is
    // just a name that happens to share words.
    if subjects.len() > 1 && coverage == subjects.len() {
        boost += 3.0;
    }
    // Matching the module the query names ("ecs", "camera", "ui") is evidence.
    let module_coverage = subjects
        .iter()
        .filter(|term| {
            module_words
                .iter()
                .any(|word| word == *term || singular_term(word) == ***term)
        })
        .count()
        .min(2);
    boost += module_coverage as f32 * 1.5;
    if is_definition(root.string(record.kind)) {
        boost += 0.5;
    }
    boost
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
