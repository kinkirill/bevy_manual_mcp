//! `syn`-based system parsing and per-parameter access extraction.
//!
//! Replaces the TypeScript bracket-stack parser (`analysis/rust-fn.ts`). A
//! real `fn` item is required, so `fn` inside a comment or string literal no
//! longer creates a phantom system (the old parser's C-04 bug). Accesses are
//! extracted from types, tuple-aware: `Query<(&mut A, &B)>` reads `B` and
//! writes `A`.

use syn::{FnArg, ImplItem, Item, ItemImpl, ItemTrait, Signature, TraitItem, Type};

use super::conflicts::{self, Access, AccessKind, Finding, ParamInfo, WorldKind};
use super::filters::{self, FilterAtom};
use super::{render_type, type_args, type_ident};

#[derive(Debug, Default)]
pub struct Analysis {
    pub systems: Vec<System>,
    pub findings: Vec<Finding>,
    pub unsupported: Vec<String>,
    pub parse_error: Option<String>,
}

impl Analysis {
    /// True when every system parsed and every parameter, query item and
    /// filter was understood. Unknown constructs make the report incomplete
    /// instead of silently clean.
    pub fn complete(&self) -> bool {
        self.parse_error.is_none() && self.unsupported.is_empty()
    }
}

#[derive(Debug)]
pub struct System {
    pub name: String,
    pub params: Vec<String>,
    pub accesses: Vec<AccessSummary>,
}

#[derive(Debug)]
pub struct AccessSummary {
    pub kind: &'static str,
    pub target: String,
    pub mutable: bool,
}

/// Parse `code` and analyze every `fn` item it contains.
///
/// A full file is parsed first; snippets are retried as inherent methods and
/// then as trait methods, so a bare signature without a body is accepted too.
pub fn analyze(code: &str) -> Analysis {
    let mut from_file = Analysis::default();
    let file_error = match syn::parse_file(code) {
        Ok(file) => {
            collect_items(&file.items, &mut from_file);
            if !from_file.systems.is_empty() {
                return from_file;
            }
            None
        }
        Err(error) => Some(error),
    };

    // A signature without a body is a valid trait method, so retry snippets as
    // inherent methods and then as trait methods.
    let wrapped = format!("impl __BevyMcpSnippet {{\n{code}\n}}");
    if let Ok(item) = syn::parse_str::<ItemImpl>(&wrapped) {
        let mut analysis = Analysis::default();
        collect_impl(&item, &mut analysis);
        if !analysis.systems.is_empty() {
            return analysis;
        }
    }
    let wrapped = format!("trait __BevyMcpSnippet {{\n{code}\n}}");
    if let Ok(item) = syn::parse_str::<ItemTrait>(&wrapped) {
        let mut analysis = Analysis::default();
        collect_trait(&item, &mut analysis);
        if !analysis.systems.is_empty() {
            return analysis;
        }
    }

    match file_error {
        Some(error) => Analysis {
            parse_error: Some(error.to_string()),
            ..Analysis::default()
        },
        None => from_file,
    }
}

fn collect_items(items: &[Item], out: &mut Analysis) {
    for item in items {
        match item {
            Item::Fn(function) => analyze_signature(&function.sig, out),
            Item::Impl(item) => collect_impl(item, out),
            Item::Trait(item) => collect_trait(item, out),
            Item::Mod(module) => {
                if let Some((_, items)) = &module.content {
                    collect_items(items, out);
                }
            }
            _ => {}
        }
    }
}

fn collect_impl(item: &ItemImpl, out: &mut Analysis) {
    for entry in &item.items {
        if let ImplItem::Fn(function) = entry {
            analyze_signature(&function.sig, out);
        }
    }
}

fn collect_trait(item: &ItemTrait, out: &mut Analysis) {
    for entry in &item.items {
        if let TraitItem::Fn(function) = entry {
            analyze_signature(&function.sig, out);
        }
    }
}

fn analyze_signature(signature: &Signature, out: &mut Analysis) {
    let name = signature.ident.to_string();
    let mut context = FnContext::default();
    for argument in &signature.inputs {
        if let FnArg::Typed(argument) = argument {
            context.classify(&argument.ty, None);
        }
    }

    out.findings
        .extend(conflicts::check(&name, &context.accesses, &context.params));
    out.systems.push(System {
        name: name.clone(),
        params: context
            .params
            .iter()
            .map(|param| param.label.clone())
            .collect(),
        accesses: context
            .accesses
            .iter()
            .map(|access| AccessSummary {
                kind: access.kind.label(),
                target: access.name.clone(),
                mutable: access.mutable,
            })
            .collect(),
    });
    for note in context.notes {
        out.unsupported.push(format!("`{name}`: {note}"));
    }
}

#[derive(Default)]
struct FnContext {
    params: Vec<ParamInfo>,
    accesses: Vec<Access>,
    notes: Vec<String>,
    next_group: usize,
}

impl FnContext {
    fn classify(&mut self, ty: &Type, group: Option<usize>) {
        let label = render_type(ty);
        let owner = self.params.len();
        self.params.push(ParamInfo {
            label: label.clone(),
            world: world_kind(ty),
        });
        self.classify_into(ty, group, owner, &label);
    }

    fn classify_into(&mut self, ty: &Type, group: Option<usize>, owner: usize, label: &str) {
        match ty {
            Type::Paren(paren) => self.classify_into(&paren.elem, group, owner, label),
            Type::Group(wrapped) => self.classify_into(&wrapped.elem, group, owner, label),
            Type::Tuple(tuple) => {
                for element in &tuple.elems {
                    self.classify_into(element, group, owner, label);
                }
            }
            Type::Reference(reference)
                if type_ident(&reference.elem).as_deref() == Some("World") =>
            {
                let mutable = reference.mutability.is_some();
                self.accesses.push(Access {
                    kind: if mutable {
                        AccessKind::WorldMut
                    } else {
                        AccessKind::WorldRef
                    },
                    name: "World".to_string(),
                    mutable,
                    filters: Vec::new(),
                    group,
                    owner,
                    param: label.to_string(),
                });
            }
            Type::Path(_) => {
                let Some(ident) = type_ident(ty) else {
                    return;
                };
                match ident.as_str() {
                    "Query" => self.query(ty, group, owner, label),
                    "Single" | "Populated" => {
                        // Same data/filter shape as Query, with at most one item.
                        self.query(ty, group, owner, label);
                    }
                    "ParamSet" | "SystemParamSet" => {
                        self.next_group += 1;
                        let nested_group = Some(self.next_group);
                        match type_args(ty).first() {
                            Some(inner) => {
                                self.classify_into(inner, nested_group, owner, label);
                            }
                            None => self.note(label, "has no parameters"),
                        }
                    }
                    "Res" => self.resource(ty, false, false, group, owner, label),
                    "ResMut" => self.resource(ty, true, false, group, owner, label),
                    "NonSend" => self.resource(ty, false, true, group, owner, label),
                    "NonSendMut" => self.resource(ty, true, true, group, owner, label),
                    "Local" | "Commands" | "Deferred" | "In" | "EventReader" | "EventWriter"
                    | "MessageReader" | "MessageWriter" | "RemovedComponents" => {}
                    "World" => self.note(
                        label,
                        "is a bare `World`; only `&World` and `&mut World` are modelled",
                    ),
                    _ => self.note(
                        label,
                        "is not a built-in system parameter; accesses inside it are unknown",
                    ),
                }
            }
            _ => self.note(
                label,
                "is not a system parameter type the analyzer understands",
            ),
        }
    }

    fn query(&mut self, ty: &Type, group: Option<usize>, owner: usize, label: &str) {
        let arguments = type_args(ty);
        let Some(data) = arguments.first() else {
            self.note(label, "has no query data argument");
            return;
        };
        let (atoms, notes) = filters::parse(&arguments[1..]);
        self.notes.extend(notes);
        self.collect_query_data(data, &atoms, group, owner, label);
    }

    fn collect_query_data(
        &mut self,
        ty: &Type,
        filters: &[FilterAtom],
        group: Option<usize>,
        owner: usize,
        label: &str,
    ) {
        match ty {
            Type::Paren(paren) => {
                self.collect_query_data(&paren.elem, filters, group, owner, label)
            }
            Type::Group(wrapped) => {
                self.collect_query_data(&wrapped.elem, filters, group, owner, label)
            }
            Type::Tuple(tuple) => {
                for element in &tuple.elems {
                    self.collect_query_data(element, filters, group, owner, label);
                }
            }
            Type::Reference(reference) => match type_ident(&reference.elem) {
                Some(name) => self.accesses.push(Access {
                    kind: AccessKind::Component,
                    name,
                    mutable: reference.mutability.is_some(),
                    filters: filters.to_vec(),
                    group,
                    owner,
                    param: label.to_string(),
                }),
                None => self.notes.push(format!(
                    "`{label}` contains a query item (`{}`) that is not a component borrow",
                    render_type(ty)
                )),
            },
            Type::Path(_) => {
                let Some(ident) = type_ident(ty) else {
                    return;
                };
                let arguments = type_args(ty);
                match ident.as_str() {
                    "Option" | "AnyOf" => match arguments.first() {
                        Some(inner) => {
                            self.collect_query_data(inner, filters, group, owner, label)
                        }
                        None => self.notes.push(format!(
                            "`{label}` has a `{ident}` without an inner type"
                        )),
                    },
                    "Ref" | "Mut" => match arguments.last() {
                        Some(inner) => self.accesses.push(Access {
                            kind: AccessKind::Component,
                            name: type_ident(inner).unwrap_or_else(|| render_type(inner)),
                            mutable: ident == "Mut",
                            filters: filters.to_vec(),
                            group,
                            owner,
                            param: label.to_string(),
                        }),
                        None => self.notes.push(format!(
                            "`{label}` has a `{ident}` without a component type"
                        )),
                    },
                    // `Entity` and `Has<T>` are query data without a borrow.
                    "Entity" | "Has" => {}
                    _ => self.notes.push(format!(
                        "`{label}` uses query data `{}` that is not a borrow; its accesses are unknown",
                        render_type(ty)
                    )),
                }
            }
            _ => self.notes.push(format!(
                "`{label}` contains a query item the analyzer does not understand (`{}`)",
                render_type(ty)
            )),
        }
    }

    fn resource(
        &mut self,
        ty: &Type,
        mutable: bool,
        non_send: bool,
        group: Option<usize>,
        owner: usize,
        label: &str,
    ) {
        let arguments = type_args(ty);
        let Some(inner) = arguments.first() else {
            self.note(label, "has no resource type argument");
            return;
        };
        self.accesses.push(Access {
            kind: if non_send {
                AccessKind::NonSend
            } else {
                AccessKind::Resource
            },
            name: render_type(inner),
            mutable,
            filters: Vec::new(),
            group,
            owner,
            param: label.to_string(),
        });
    }

    fn note(&mut self, label: &str, reason: &str) {
        self.notes.push(format!("`{label}` {reason}"));
    }
}

/// `&World` reads, `&mut World` is exclusive.
fn world_kind(ty: &Type) -> Option<WorldKind> {
    match ty {
        Type::Reference(reference) if type_ident(&reference.elem).as_deref() == Some("World") => {
            Some(if reference.mutability.is_some() {
                WorldKind::Write
            } else {
                WorldKind::Read
            })
        }
        Type::Paren(paren) => world_kind(&paren.elem),
        Type::Group(group) => world_kind(&group.elem),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn systems(code: &str) -> Analysis {
        let analysis = analyze(code);
        assert!(
            analysis.parse_error.is_none(),
            "parse error: {:?}",
            analysis.parse_error
        );
        analysis
    }

    fn component(analysis: &Analysis, system: &str, target: &str) -> bool {
        analysis
            .systems
            .iter()
            .find(|entry| entry.name == system)
            .map(|entry| entry.accesses.iter().any(|access| access.target == target))
            .unwrap_or(false)
    }

    #[test]
    fn tuple_queries_yield_independent_accesses() {
        let analysis = systems(
            r#"
            fn drive(q: Query<(&mut Transform, &Velocity, &mut Health)>, time: Res<Time>) {}
            "#,
        );
        let system = &analysis.systems[0];
        assert_eq!(system.name, "drive");
        assert!(component(&analysis, "drive", "Transform"));
        assert!(component(&analysis, "drive", "Velocity"));
        assert!(component(&analysis, "drive", "Health"));
        assert!(component(&analysis, "drive", "Time"));

        let transform = system
            .accesses
            .iter()
            .find(|access| access.target == "Transform")
            .expect("Transform access");
        assert!(transform.mutable);
        let velocity = system
            .accesses
            .iter()
            .find(|access| access.target == "Velocity")
            .expect("Velocity access");
        assert!(!velocity.mutable);
    }

    #[test]
    fn filters_are_not_treated_as_accesses() {
        let analysis = systems(
            r#"
            fn filtered(q: Query<&Transform, (With<Player>, Without<Frozen>)>) {}
            "#,
        );
        let system = &analysis.systems[0];
        let targets: Vec<&str> = system
            .accesses
            .iter()
            .map(|access| access.target.as_str())
            .collect();
        assert_eq!(targets, vec!["Transform"], "targets: {targets:?}");
    }

    #[test]
    fn disjoint_filters_suppress_the_conflict() {
        let analysis = systems(
            r#"
            fn split(
                left: Query<&mut Transform, With<Player>>,
                right: Query<&Transform, Without<Player>>,
            ) {}
            "#,
        );
        assert!(analysis.findings.is_empty(), "{:?}", analysis.findings);
        assert!(analysis.complete());
    }

    #[test]
    fn missing_disjointness_is_a_b0001_finding() {
        let analysis = systems(
            r#"
            fn bad(
                left: Query<&mut Transform>,
                right: Query<&Transform>,
            ) {}
            "#,
        );
        assert_eq!(analysis.findings.len(), 1, "{:?}", analysis.findings);
        let finding = &analysis.findings[0];
        assert_eq!(finding.rule, "R1");
        assert_eq!(finding.error_code, Some("B0001"));
        assert_eq!(finding.system, "bad");
    }

    #[test]
    fn param_sets_may_hold_conflicting_queries() {
        let analysis = systems(
            r#"
            fn set(mut params: ParamSet<(Query<&mut Health>, Query<&Health>)>) {}
            "#,
        );
        assert!(analysis.findings.is_empty(), "{:?}", analysis.findings);
    }

    #[test]
    fn resource_and_non_send_conflicts_are_reported() {
        let analysis = systems(
            r#"
            fn resources(mut time: ResMut<Time>, also: Res<Time>) {}
            fn locals(a: NonSend<FrameCounter>, b: NonSendMut<FrameCounter>) {}
            "#,
        );
        assert_eq!(analysis.findings.len(), 2, "{:?}", analysis.findings);
        assert_eq!(analysis.findings[0].rule, "R3");
        assert_eq!(analysis.findings[0].error_code, Some("B0002"));
        assert_eq!(analysis.findings[1].rule, "R4");
    }

    #[test]
    fn exclusive_world_cannot_share_a_system() {
        let analysis = systems(
            r#"
            fn exclusive(world: &mut World, q: Query<&Transform>) {}
            "#,
        );
        assert_eq!(analysis.findings.len(), 1, "{:?}", analysis.findings);
        assert_eq!(analysis.findings[0].rule, "R5");
    }

    #[test]
    fn fn_in_a_comment_or_string_is_not_a_system() {
        let analysis = systems(
            r#"
            // fn ghost(a: Query<&mut Transform>, b: Query<&Transform>) {}
            const NOTE: &str = "fn phantom(q: Query<&mut A>) {}";
            fn real(q: Query<&A>) {}
            "#,
        );
        let names: Vec<&str> = analysis
            .systems
            .iter()
            .map(|system| system.name.as_str())
            .collect();
        assert_eq!(names, vec!["real"], "systems: {names:?}");
        assert!(analysis.findings.is_empty());
    }

    #[test]
    fn signature_only_snippets_are_accepted() {
        let analysis = systems("fn only_signature(q: Query<&mut A>, r: Query<&A>);");
        assert_eq!(analysis.systems.len(), 1);
        assert_eq!(analysis.findings.len(), 1);
    }

    #[test]
    fn unsupported_parameters_mark_the_analysis_incomplete() {
        let analysis = systems("fn custom(thing: MyCustomParam, q: Query<&mut A>) {}");
        assert!(!analysis.complete(), "{:?}", analysis.unsupported);
        assert!(
            analysis
                .unsupported
                .iter()
                .any(|note| note.contains("MyCustomParam")),
            "{:?}",
            analysis.unsupported
        );
    }

    #[test]
    fn unsupported_syntax_reports_a_parse_error() {
        let analysis = analyze("fn broken(q: Query<&mut A> {");
        assert!(analysis.parse_error.is_some());
        assert!(!analysis.complete());
        assert!(analysis.systems.is_empty());
    }
}
