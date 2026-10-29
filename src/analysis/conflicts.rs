//! Conflict rules R1–R5 for Bevy system parameters.
//!
//! Ported from `src/analysis/conflicts.ts`, extended to independent tuple
//! members (`Query<(&mut A, &B)>`) and ParamSet groups. These rules describe
//! Bevy's *runtime* access checks: a clean report means "no B0001/B0002
//! pattern matched", never "this compiles".

use std::collections::BTreeSet;

use super::filters;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AccessKind {
    Component,
    Resource,
    NonSend,
    WorldRef,
    WorldMut,
}

impl AccessKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Component => "component",
            Self::Resource => "resource",
            Self::NonSend => "non-send",
            Self::WorldRef => "world (read)",
            Self::WorldMut => "world (write)",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Access {
    pub kind: AccessKind,
    /// Component or resource type as rendered from the source.
    pub name: String,
    pub mutable: bool,
    /// Filters of the query that owns this access; empty for resources.
    pub filters: Vec<filters::FilterAtom>,
    /// Set for parameters inside a `ParamSet`, whose members may conflict.
    pub group: Option<usize>,
    /// Index of the owning top-level parameter.
    pub owner: usize,
    /// Rendered parameter type, used in findings.
    pub param: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorldKind {
    Read,
    Write,
}

#[derive(Debug, Clone)]
pub struct ParamInfo {
    pub label: String,
    pub world: Option<WorldKind>,
}

#[derive(Debug)]
pub struct Finding {
    pub rule: &'static str,
    pub severity: &'static str,
    pub resource_type: String,
    pub param_a: String,
    pub param_b: Option<String>,
    pub description: String,
    pub error_code: Option<&'static str>,
    pub system: String,
}

/// Run R1–R5 against one system's extracted accesses.
pub fn check(system: &str, accesses: &[Access], params: &[ParamInfo]) -> Vec<Finding> {
    let mut findings = Vec::new();
    let mut seen: BTreeSet<(&'static str, usize, usize, String)> = BTreeSet::new();

    for (index, a) in accesses.iter().enumerate() {
        for b in &accesses[index + 1..] {
            if a.group.is_some() && a.group == b.group {
                // ParamSet members are borrowed one at a time.
                continue;
            }
            if a.owner == b.owner && !matches!(a.kind, AccessKind::Component) {
                continue;
            }
            let rule = match (a.kind, b.kind) {
                (AccessKind::Component, AccessKind::Component) => {
                    if a.name != b.name || !(a.mutable || b.mutable) {
                        continue;
                    }
                    if filters::disjoint(&a.filters, &b.filters) {
                        continue;
                    }
                    if a.mutable && b.mutable { "R2" } else { "R1" }
                }
                (AccessKind::Resource, AccessKind::Resource) => "R3",
                (AccessKind::NonSend, AccessKind::NonSend) => "R4",
                _ => continue,
            };
            if !matches!(a.kind, AccessKind::Component) && a.name != b.name {
                continue;
            }
            if !matches!(a.kind, AccessKind::Component) && !(a.mutable || b.mutable) {
                continue;
            }
            if !seen.insert((rule, a.owner, b.owner, a.name.clone())) {
                continue;
            }

            let (description, error_code) = match rule {
                "R2" => (
                    format!(
                        "`{}` and `{}` both mutably access `{}` without disjoint filters — B0001 panic",
                        a.param, b.param, a.name
                    ),
                    "B0001",
                ),
                "R1" => (
                    format!(
                        "`{}` and `{}` touch `{}` mutably and immutably without disjoint filters — B0001 panic",
                        a.param, b.param, a.name
                    ),
                    "B0001",
                ),
                "R3" => (
                    format!(
                        "`{}` alongside `{}` for resource `{}` — B0002 panic (conflicting resource borrows)",
                        a.param, b.param, a.name
                    ),
                    "B0002",
                ),
                _ => (
                    format!(
                        "`{}` alongside `{}` for non-send resource `{}` — B0002 panic",
                        a.param, b.param, a.name
                    ),
                    "B0002",
                ),
            };
            findings.push(Finding {
                rule,
                severity: "panic",
                resource_type: a.name.clone(),
                param_a: a.param.clone(),
                param_b: Some(b.param.clone()),
                description,
                error_code: Some(error_code),
                system: system.to_string(),
            });
        }
    }

    // R5 — `&mut World` is exclusive and cannot share a system with anything.
    if let Some(world_index) = params
        .iter()
        .position(|param| param.world == Some(WorldKind::Write))
        && params.len() > 1
    {
        let others: Vec<String> = params
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != world_index)
            .map(|(_, param)| param.label.clone())
            .collect();
        findings.push(Finding {
            rule: "R5",
            severity: "panic",
            resource_type: "World".to_string(),
            param_a: "&mut World".to_string(),
            param_b: Some(others.join(", ")),
            description:
                "`&mut World` is exclusive and cannot share a system with other parameters — B0002 family panic"
                    .to_string(),
            error_code: Some("B0002"),
            system: system.to_string(),
        });
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access(owner: usize, name: &str, mutable: bool) -> Access {
        Access {
            kind: AccessKind::Component,
            name: name.to_string(),
            mutable,
            filters: Vec::new(),
            group: None,
            owner,
            param: format!("Query<&{}{name}>", if mutable { "mut " } else { "" }),
        }
    }

    fn param(label: &str) -> ParamInfo {
        ParamInfo {
            label: label.to_string(),
            world: None,
        }
    }

    #[test]
    fn two_mutable_queries_are_r2() {
        let findings = check(
            "sys",
            &[access(0, "Transform", true), access(1, "Transform", true)],
            &[param("a"), param("b")],
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "R2");
    }

    #[test]
    fn mutable_plus_immutable_is_r1() {
        let findings = check(
            "sys",
            &[access(0, "Transform", true), access(1, "Transform", false)],
            &[param("a"), param("b")],
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "R1");
    }

    #[test]
    fn same_param_component_conflicts_are_reported() {
        let same = check(
            "sys",
            &[access(0, "A", true), access(0, "A", false)],
            &[param("a")],
        );
        assert_eq!(same.len(), 1);
        assert_eq!(same[0].rule, "R1");
    }

    #[test]
    fn param_set_members_are_exempt() {
        let mut first = access(0, "A", true);
        let mut second = access(0, "A", true);
        first.group = Some(1);
        second.group = Some(1);
        let grouped = check("sys", &[first, second], &[param("ParamSet<...>")]);
        assert!(grouped.is_empty());
    }

    #[test]
    fn resources_need_a_mutable_side() {
        let read_only = check(
            "sys",
            &[
                Access {
                    kind: AccessKind::Resource,
                    name: "Time".into(),
                    mutable: false,
                    filters: Vec::new(),
                    group: None,
                    owner: 0,
                    param: "Res<Time>".into(),
                },
                Access {
                    kind: AccessKind::Resource,
                    name: "Time".into(),
                    mutable: false,
                    filters: Vec::new(),
                    group: None,
                    owner: 1,
                    param: "Res<Time>".into(),
                },
            ],
            &[param("a"), param("b")],
        );
        assert!(read_only.is_empty());
    }
}
