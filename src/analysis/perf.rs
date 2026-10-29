//! Performance advice topics.
//!
//! The TypeScript tool loaded `vendor/bevy-meta/<version>/perf.json` and, when
//! that file was absent, fell back to three built-in topics. No `perf.json` is
//! vendored yet, so the built-in set is what answers today and the report says
//! `source: "builtin"` instead of pretending to be version-derived.

use std::fs;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct PerfTopic {
    pub topic: String,
    #[serde(default)]
    pub symptoms: Vec<String>,
    #[serde(default)]
    pub recommend: Vec<String>,
    #[serde(default)]
    pub avoid: Vec<String>,
    #[serde(default)]
    pub rationale: Option<String>,
}

#[derive(Debug)]
pub struct AntiPattern {
    pub pattern: String,
    pub suggestion: String,
}

/// Load `perf.json` from a version metadata directory, if one exists.
pub fn load_vendored(metadata_dir: Option<&Path>) -> Vec<PerfTopic> {
    let Some(metadata_dir) = metadata_dir else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(metadata_dir.join("perf.json")) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// The three topics that shipped as built-in defaults in the TypeScript line.
pub fn builtin_topics() -> Vec<PerfTopic> {
    vec![
        PerfTopic {
            topic: "change-detection".to_string(),
            symptoms: vec![
                "iterating all entities every frame".to_string(),
                "manual is_changed checks".to_string(),
            ],
            recommend: vec![
                "Changed<T>".to_string(),
                "Added<T>".to_string(),
                "Ref<T>".to_string(),
                "Mut<T>".to_string(),
                "With<T>".to_string(),
            ],
            avoid: vec!["is_changed()".to_string(), "is_added()".to_string()],
            rationale: Some(
                "Change ticks are stored per-archetype. Changed<T> and Added<T> filters let the \
query planner push these down to archetype iteration, avoiding per-entity tick comparisons."
                    .to_string(),
            ),
        },
        PerfTopic {
            topic: "archetypes".to_string(),
            symptoms: vec!["mid-iteration component additions causing archetype moves".to_string()],
            recommend: vec!["Commands".to_string(), "despawn_many".to_string()],
            avoid: vec![
                "World::remove_component".to_string(),
                "direct entity removal in systems".to_string(),
            ],
            rationale: Some(
                "Component additions mid-iteration cause archetype moves. Use Commands for \
deferred changes."
                    .to_string(),
            ),
        },
        PerfTopic {
            topic: "scheduling".to_string(),
            symptoms: vec![
                ".chain() overuse".to_string(),
                "missing SystemSet ordering".to_string(),
            ],
            recommend: vec![
                "SystemSet".to_string(),
                ".before()".to_string(),
                ".after()".to_string(),
                ".chain()".to_string(),
            ],
            avoid: vec!["manual order tracking".to_string()],
            rationale: Some(
                "Use SystemSets for deterministic ordering. .chain() is useful but don't overuse \
it."
                .to_string(),
            ),
        },
    ]
}

/// Anti-patterns the TypeScript tool detected from code, ported as-is.
///
/// Only `change-detection` has detectors today; other topics return nothing
/// rather than guessing.
pub fn detect(topic: Option<&str>, code: &str) -> Vec<AntiPattern> {
    let mut findings = Vec::new();
    if topic.unwrap_or("change-detection") != "change-detection" {
        return findings;
    }
    if code.contains("is_changed") {
        findings.push(AntiPattern {
            pattern: "is_changed()".to_string(),
            suggestion: "Use a Changed<T> filter instead — the query planner pushes this down to \
archetype iteration"
                .to_string(),
        });
    }
    if code.contains("is_added") {
        findings.push(AntiPattern {
            pattern: "is_added()".to_string(),
            suggestion: "Use an Added<T> filter instead — the query planner handles this \
efficiently"
                .to_string(),
        });
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_topics_cover_the_ported_set() {
        let topics = builtin_topics();
        let names: Vec<&str> = topics.iter().map(|topic| topic.topic.as_str()).collect();
        assert_eq!(names, vec!["change-detection", "archetypes", "scheduling"]);
        assert!(
            topics
                .iter()
                .all(|topic| topic.rationale.is_some() && !topic.recommend.is_empty())
        );
    }

    #[test]
    fn change_detection_anti_patterns_are_detected() {
        let findings = detect(
            Some("change-detection"),
            "if q.get(e).is_changed() && q.get(e).is_added() {}",
        );
        let patterns: Vec<&str> = findings
            .iter()
            .map(|finding| finding.pattern.as_str())
            .collect();
        assert_eq!(patterns, vec!["is_changed()", "is_added()"]);
        assert!(detect(None, "is_changed()").len() == 1);
        assert!(detect(Some("scheduling"), "is_changed()").is_empty());
    }
}
