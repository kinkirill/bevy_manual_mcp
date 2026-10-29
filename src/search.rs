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
                    * relevance_boost(root, record, &subjects, &surfaces)
                    * docs_coverage_boost(root, record, &subjects),
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

/// Concept queries benefit from records whose prose names all the subjects.
fn docs_coverage_boost(root: &ArchivedCorpus, record: &ArchivedRecord, subjects: &[String]) -> f32 {
    if subjects.is_empty() {
        return 1.0;
    }
    let docs = root.string(record.docs).to_lowercase();
    let signature = root.string(record.signature).to_lowercase();
    let matched = subjects
        .iter()
        .filter(|term| docs.contains(term.as_str()) || signature.contains(term.as_str()))
        .count();
    1.0 + matched as f32 * 0.12
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

pub(crate) fn definition_key(root: &ArchivedCorpus, record: &ArchivedRecord) -> String {
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

/// Collapse re-export aliases that point at the same documented item.
pub fn dedupe_records<'a>(
    root: &ArchivedCorpus,
    records: impl IntoIterator<Item = &'a ArchivedRecord>,
) -> Vec<&'a ArchivedRecord> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for record in records {
        let key = definition_key(root, record);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(record);
    }
    out
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

    fn reexport_record(full_path: &str) -> crate::archive::RecordInput {
        crate::archive::RecordInput {
            source: "rustdoc".into(),
            kind: "struct".into(),
            name: "ChildOf".into(),
            full_path: full_path.into(),
            crate_name: Some("bevy".into()),
            module: "bevy::ecs::hierarchy".into(),
            signature: "pub struct ChildOf(pub Entity);".into(),
            docs: "A hierarchy relationship.".into(),
            source_ref: Some("docs.rs/bevy/0.20.1/bevy_ecs/hierarchy/struct.ChildOf.html".into()),
            bevy_version: Some("0.20.1".into()),
            file: "bevy_ecs/hierarchy/struct.ChildOf.html".into(),
            ..Default::default()
        }
    }

    #[test]
    fn dedupe_collapses_reexport_aliases() {
        let dir = tempfile::tempdir().expect("temp dir");
        let out = dir.path().join("version");
        crate::archive::build(
            vec![
                reexport_record("bevy::ecs::hierarchy::ChildOf"),
                reexport_record("bevy::ecs::prelude::ChildOf"),
            ],
            &out,
            &crate::archive::BuildOptions {
                bevy_version: Some("0.20.1".into()),
                ..Default::default()
            },
        )
        .expect("build");
        let corpus = LoadedCorpus::open(&out.join(crate::archive::ARCHIVE_FILE)).expect("corpus");
        let hits = corpus.lookup("ChildOf");
        assert_eq!(hits.len(), 2);
        let unique = dedupe_records(corpus.root(), hits);
        assert_eq!(unique.len(), 1);
    }

    #[test]
    fn comma_filters_split_and_trim() {
        let parts: Vec<&str> = split_list("struct, enum ,trait").collect();
        assert_eq!(parts, vec!["struct", "enum", "trait"]);
    }
}

/// Suggestions make sense for symbol-shaped queries, not for prose questions.
pub fn looks_like_symbol(query: &str) -> bool {
    query.split_whitespace().count() == 1 || query.contains("::")
}

/// Near misses for a symbol that did not resolve.
///
/// Candidates come from the prebuilt name-token index, falling back to a
/// bounded scan for typos. Ranking is token overlap, shared prefix and edit
/// distance — deliberately no kind priors: asking for a function should not
/// return a struct just because structs are common.
pub fn suggestions<'a>(
    root: &'a ArchivedCorpus,
    query: &str,
    limit: usize,
) -> Vec<&'a ArchivedRecord> {
    let leaf_raw = base_name(query);
    let leaf_norm = norm_key(&leaf_raw);
    if leaf_norm.len() < 3 {
        return Vec::new();
    }
    let query_tokens = split_name_tokens(&leaf_raw);
    let qualified = norm_key(query).contains("::");
    let module_prefix = norm_key(query)
        .rsplit_once("::")
        .map(|(prefix, _)| prefix.to_string())
        .unwrap_or_default();

    let mut candidate_ids: Vec<u32> = Vec::new();
    for term in &query_tokens {
        if let Some(token) = root.find_name_token(term) {
            for id in token.ids.iter() {
                candidate_ids.push(id.native());
            }
        }
    }
    candidate_ids.sort_unstable();
    candidate_ids.dedup();

    let mut candidates: Vec<&ArchivedRecord> = candidate_ids
        .iter()
        .filter_map(|id| root.record(*id))
        .collect();

    // No shared token: allow a bounded edit-distance scan (typos).
    if candidates.is_empty() {
        for record in root.records.iter() {
            let name = norm_key(&base_name(root.string(record.name)));
            if name.len().abs_diff(leaf_norm.len()) <= 3 && levenshtein(&name, &leaf_norm) <= 3 {
                candidates.push(record);
            }
        }
    }

    let mut scored: Vec<(i32, &ArchivedRecord)> = Vec::new();
    for record in candidates {
        let name_raw = base_name(root.string(record.name));
        let name_norm = norm_key(&name_raw);
        let name_tokens = split_name_tokens(&name_raw);
        let head = query_tokens.last();
        let head_match = head.is_some_and(|term| name_tokens.iter().any(|word| word == term));
        let mut score = 0i32;
        if head_match {
            // The head noun dominates a compound: EventReader -> MessageReader
            // is a better near miss than an unrelated string that is closer
            // by raw edit distance.
            score += 50;
        }
        for term in &query_tokens {
            if Some(term) == head {
                continue;
            }
            if name_tokens.iter().any(|word| word == term) {
                score += 12;
            }
        }
        score += 2 * common_prefix_chars(&name_norm, &leaf_norm) as i32;
        score -= levenshtein(&name_norm, &leaf_norm).min(12) as i32;
        if qualified {
            let module = norm_key(root.string(record.module));
            if module.ends_with(&module_prefix) || module_prefix.ends_with(&module) {
                score += 10;
            }
        }
        if score > 0 {
            scored.push((score, record));
        }
    }
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    // Prose can name the replacement even when edit distance cannot: migration
    // guides say "`EventReader` ... is now known as `MessageReader`".
    for (prose_score, record) in prose_candidates(root, query) {
        match scored
            .iter_mut()
            .find(|(_, existing)| std::ptr::eq(*existing, record))
        {
            Some((score, _)) if *score < prose_score => *score = prose_score,
            Some(_) => {}
            None => scored.push((prose_score, record)),
        }
    }
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    // If a strong rename match exists, drop distant lexical noise.
    let threshold = scored
        .first()
        .map(|(score, _)| score.saturating_sub(60))
        .unwrap_or(i32::MIN);

    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (score, record) in scored {
        if score < threshold {
            continue;
        }
        let key = definition_key(root, record);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(record);
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// Backticked symbol names near the query in migration guides and release
/// notes. This is the corpus-derived rename signal, with no hand-written table.
fn prose_candidates<'a>(root: &'a ArchivedCorpus, query: &str) -> Vec<(i32, &'a ArchivedRecord)> {
    let leaf = base_name(query);
    let needle = leaf.to_ascii_lowercase();
    if needle.len() < 3 {
        return Vec::new();
    }
    let head = split_name_tokens(&leaf).pop();
    let query_tokens = split_name_tokens(&leaf);
    let mut out: Vec<(i32, &ArchivedRecord, u32)> = Vec::new();

    for record in root.records.iter() {
        // Only prose records document renames; rustdoc has no "now known as".
        if root.string(record.source) != "website" {
            continue;
        }
        let docs = root.string(record.docs);
        if docs.len() < needle.len() {
            continue;
        }
        let lower = docs.to_ascii_lowercase();
        let positions: Vec<usize> = lower
            .match_indices(&needle)
            .map(|(index, _)| index)
            .collect();
        if positions.is_empty() {
            continue;
        }
        let rename_context = ["renamed", "now known as", "replaced by", "moved to"]
            .iter()
            .any(|phrase| lower.contains(phrase));

        let mut inside = false;
        let mut start = 0usize;
        for (index, ch) in docs.char_indices() {
            if ch != '`' {
                continue;
            }
            if inside {
                let segment = &docs[start..index];
                // Skip the segment holding the query itself.
                if !segment.to_ascii_lowercase().contains(&needle) {
                    for token in identifiers(segment) {
                        let token_lower = token.to_ascii_lowercase();
                        if token.len() < 3
                            || token_lower == needle
                            || query_tokens.iter().any(|part| part == &token_lower)
                        {
                            continue;
                        }
                        let Some(matched) = root.lookup(&token).into_iter().next() else {
                            continue;
                        };
                        let distance = positions
                            .iter()
                            .map(|position| start.abs_diff(*position))
                            .min()
                            .unwrap_or(usize::MAX);
                        if distance > 300 {
                            continue;
                        }
                        let mut score = 200 - (distance / 2) as i32;
                        if head.as_ref().is_some_and(|head| {
                            split_name_tokens(&token).iter().any(|part| part == head)
                        }) {
                            score += 40;
                        }
                        if is_definition(root.string(matched.kind)) {
                            score += 10;
                        }
                        if rename_context {
                            score += 30;
                        }
                        out.push((score, matched, record.dense_id.native()));
                    }
                }
            } else {
                start = index + 1;
            }
            inside = !inside;
        }
    }
    // Keep the document that produced the strongest hit; other guides mention
    // the same word in unrelated contexts.
    let best_doc = out
        .iter()
        .max_by_key(|(score, _, doc)| (*score, *doc))
        .map(|(_, _, doc)| *doc);
    out.into_iter()
        .filter(|(_, _, doc)| Some(*doc) == best_doc)
        .map(|(score, record, _)| (score, record))
        .collect()
}

fn identifiers(segment: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in segment.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch);
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out.into_iter()
        .filter(|token| {
            token
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
        })
        .collect()
}

fn common_prefix_chars(a: &str, b: &str) -> usize {
    a.chars()
        .zip(b.chars())
        .take_while(|(left, right)| left == right)
        .count()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0usize; b.len() + 1];
    for (i, left) in a.iter().enumerate() {
        current[0] = i + 1;
        for (j, right) in b.iter().enumerate() {
            let cost = usize::from(left != right);
            current[j + 1] = (previous[j + 1] + 1)
                .min(current[j] + 1)
                .min(previous[j] + cost);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}

#[cfg(test)]
mod suggestion_tests {
    use super::*;

    #[test]
    fn edit_distance_is_standard() {
        assert_eq!(levenshtein("eventreader", "eventreader"), 0);
        assert_eq!(levenshtein("commandz", "command"), 1);
        assert_eq!(levenshtein("", "abc"), 3);
        assert_eq!(levenshtein("kitten", "sitting"), 3);
    }

    #[test]
    fn shared_prefix_is_counted() {
        assert_eq!(common_prefix_chars("command", "commands"), 7);
        assert_eq!(common_prefix_chars("event", "message"), 0);
    }
}

/// Migration material for a version pair (or a single target version).
/// Ported from `findMigrations`: guides weighing more than per-PR entries.
pub fn find_migrations<'a>(
    root: &'a ArchivedCorpus,
    from: Option<&str>,
    to: Option<&str>,
    topic: Option<&str>,
    per_doc: usize,
) -> Vec<(&'a ArchivedRecord, i32)> {
    let from_core = from.map(major_minor);
    let to_core = to.map(major_minor);
    let topic = topic.map(str::to_lowercase);
    let topic_terms = topic.as_deref().map(topic_terms).unwrap_or_default();

    let mut scored: Vec<(i32, i32, &ArchivedRecord)> = Vec::new();
    for record in root.records.iter() {
        let topic_score = match &topic {
            Some(topic) => topic_relevance(root, record, topic, &topic_terms),
            None => 0,
        };
        if topic.is_some() && topic_score == 0 {
            continue;
        }
        let kind = root.string(record.kind);
        let base = match kind {
            "migration_guide" => {
                let guide_from = major_minor(root.string(record.from_version));
                let guide_to = major_minor(root.string(record.to_version));
                let from_match = from_core.is_some_and(|value| guide_from == value);
                let to_match = to_core.is_some_and(|value| guide_to == value);
                if from_match && to_match {
                    100
                } else if to_match {
                    70
                } else if from_match {
                    60
                } else {
                    continue;
                }
            }
            "migration_entry" => {
                if to_core.is_some_and(|to| major_minor(root.string(record.version)) == to) {
                    50
                } else {
                    continue;
                }
            }
            "release_notes" => {
                if to_core.is_some_and(|to| major_minor(root.string(record.version)) == to) {
                    45
                } else {
                    continue;
                }
            }
            _ => continue,
        };
        scored.push((base, topic_score, record));
    }

    // If a section actually names the topic, drop documents that only mention
    // it somewhere in their prose.
    if topic.is_some() {
        let best_topic = scored
            .iter()
            .map(|(_, topic_score, _)| *topic_score)
            .max()
            .unwrap_or(0);
        if best_topic >= 20 {
            scored.retain(|(_, topic_score, _)| *topic_score >= 20);
        }
    }

    // At most `per_doc` chunks per source document, then rank globally.
    let mut by_doc: Vec<(String, Vec<(i32, &ArchivedRecord)>)> = Vec::new();
    for (base, topic_score, record) in scored {
        let score = base + topic_score;
        let key = root.string(record.full_path).to_string();
        match by_doc.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, entries)) => entries.push((score, record)),
            None => by_doc.push((key, vec![(score, record)])),
        }
    }
    let mut out: Vec<(i32, &ArchivedRecord)> = Vec::new();
    for (_, mut entries) in by_doc {
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.0));
        out.extend(entries.into_iter().take(per_doc));
    }
    out.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    out.into_iter()
        .map(|(score, record)| (record, score))
        .collect()
}

fn topic_terms(topic: &str) -> Vec<String> {
    topic
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|term| term.len() > 1)
        .map(str::to_string)
        .collect()
}

fn topic_relevance(
    root: &ArchivedCorpus,
    record: &ArchivedRecord,
    topic: &str,
    terms: &[String],
) -> i32 {
    let mut high = String::new();
    for id in [
        record.name,
        record.title,
        record.heading,
        record.full_path,
        record.module,
    ] {
        high.push_str(root.string(id));
        high.push(' ');
    }
    for breadcrumb in record.breadcrumb.iter() {
        high.push_str(root.string(*breadcrumb));
        high.push(' ');
    }
    let high = high.to_lowercase();
    let docs = root.string(record.docs).to_lowercase();

    let mut score = 0;
    if high.contains(topic) {
        score += 40;
    } else if !terms.is_empty() && terms.iter().all(|term| high.contains(term)) {
        score += 30;
    } else {
        score += terms
            .iter()
            .filter(|term| high.contains(term.as_str()))
            .count() as i32
            * 8;
    }
    if docs.contains(topic) {
        score += 4;
    } else {
        score += terms
            .iter()
            .filter(|term| docs.contains(term.as_str()))
            .count() as i32;
    }
    score
}

fn major_minor(version: &str) -> &str {
    let version = version.trim();
    match version.match_indices('.').nth(1) {
        Some((index, _)) => &version[..index],
        None => version,
    }
}
