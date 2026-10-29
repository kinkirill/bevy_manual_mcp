//! Query-filter parsing and disjointness.
//!
//! Ported from `src/analysis/filters.ts`, but driven by `syn` types instead of
//! a regex over the filter text. Filter-only types (`With`, `Without`, `Or`,
//! `Added`, `Changed`, tuples) never become component accesses; they only
//! decide whether two queries can touch the same entity.

use std::collections::BTreeSet;

use syn::Type;

use super::{render_type, type_args, type_ident};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FilterKind {
    With,
    Without,
    Added,
    Changed,
}

impl FilterKind {
    fn from_ident(ident: &str) -> Option<Self> {
        match ident {
            "With" => Some(Self::With),
            "Without" => Some(Self::Without),
            "Added" => Some(Self::Added),
            "Changed" => Some(Self::Changed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterAtom {
    Type { kind: FilterKind, entity: String },
    Or(Vec<FilterAtom>),
}

/// Parse the non-data arguments of a `Query<...>`.
///
/// Returns the atoms, prose notes, and the rendered types of filters the
/// analyzer does not understand; an unknown filter means disjointness cannot
/// be proven, so the caller reports the analysis as incomplete.
pub fn parse(types: &[&Type]) -> (Vec<FilterAtom>, Vec<String>, Vec<String>) {
    let mut atoms = Vec::new();
    let mut notes = Vec::new();
    let mut unsupported = Vec::new();
    for ty in types {
        if !parse_type(ty, &mut atoms) {
            let rendered = render_type(ty);
            notes.push(format!(
                "filter `{rendered}` is not a known Bevy query filter; disjointness cannot be proven"
            ));
            unsupported.push(rendered);
        }
    }
    (atoms, notes, unsupported)
}

fn parse_type(ty: &Type, atoms: &mut Vec<FilterAtom>) -> bool {
    match ty {
        Type::Paren(paren) => parse_type(&paren.elem, atoms),
        Type::Group(group) => parse_type(&group.elem, atoms),
        Type::Tuple(tuple) => {
            let mut understood = true;
            for element in &tuple.elems {
                understood &= parse_type(element, atoms);
            }
            understood
        }
        Type::Path(_) => {
            let Some(ident) = type_ident(ty) else {
                return false;
            };
            let arguments = type_args(ty);
            if let Some(kind) = FilterKind::from_ident(&ident) {
                let Some(inner) = arguments.first() else {
                    return false;
                };
                atoms.push(FilterAtom::Type {
                    kind,
                    entity: render_type(inner),
                });
                return true;
            }
            if ident == "Or" {
                let Some(inner) = arguments.first() else {
                    return false;
                };
                let mut branches = Vec::new();
                if !parse_type(inner, &mut branches) || branches.is_empty() {
                    return false;
                }
                atoms.push(FilterAtom::Or(branches));
                return true;
            }
            // Unknown filter types are reported rather than guessed: Bevy's
            // filter vocabulary is small (With, Without, Added, Changed, Or,
            // tuples), and a miss here would silently lose disjointness.
            false
        }
        _ => false,
    }
}

/// Two filter sets are disjoint when no entity can satisfy both.
///
/// `With<A>` against `Without<A>` establishes disjointness; `Or` is disjoint
/// only when every branch is. Unknown filters contribute nothing, which makes
/// the caller conservative (it may report a conflict that filters would have
/// prevented) rather than silently missing one.
pub fn disjoint(a: &[FilterAtom], b: &[FilterAtom]) -> bool {
    for atom in a {
        if let FilterAtom::Or(branches) = atom
            && !branches.is_empty()
            && branches
                .iter()
                .all(|branch| disjoint(std::slice::from_ref(branch), b))
        {
            return true;
        }
    }
    for atom in b {
        if let FilterAtom::Or(branches) = atom
            && !branches.is_empty()
            && branches
                .iter()
                .all(|branch| disjoint(a, std::slice::from_ref(branch)))
        {
            return true;
        }
    }

    let with_a = entities(a, FilterKind::With);
    let without_a = entities(a, FilterKind::Without);
    let with_b = entities(b, FilterKind::With);
    let without_b = entities(b, FilterKind::Without);
    with_a.intersection(&without_b).next().is_some()
        || without_a.intersection(&with_b).next().is_some()
}

fn entities(atoms: &[FilterAtom], kind: FilterKind) -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    for atom in atoms {
        if let FilterAtom::Type {
            kind: atom_kind,
            entity,
        } = atom
            && *atom_kind == kind
        {
            set.insert(entity.clone());
        }
    }
    set
}

#[cfg(test)]
mod tests {
    use super::*;
    use syn::Type;

    fn filter_types(source: &str) -> Vec<Type> {
        match syn::parse_str::<Type>(source).expect("type") {
            Type::Tuple(tuple) => tuple.elems.into_iter().collect(),
            other => vec![other],
        }
    }

    fn atoms(source: &str) -> Vec<FilterAtom> {
        let types = filter_types(source);
        let refs: Vec<&Type> = types.iter().collect();
        let (atoms, notes, unsupported) = parse(&refs);
        assert!(notes.is_empty(), "notes: {notes:?}");
        assert!(unsupported.is_empty(), "unsupported: {unsupported:?}");
        atoms
    }

    #[test]
    fn with_and_without_are_disjoint() {
        assert!(disjoint(
            &atoms("(With<Player>)"),
            &atoms("(Without<Player>)")
        ));
        assert!(disjoint(
            &atoms("(Without<Player>)"),
            &atoms("(With<Player>)")
        ));
        assert!(!disjoint(
            &atoms("(With<Player>)"),
            &atoms("(With<Player>)")
        ));
        assert!(!disjoint(
            &atoms("(With<Enemy>)"),
            &atoms("(Without<Player>)")
        ));
    }

    #[test]
    fn tuples_and_or_branches_are_flattened() {
        let parsed = atoms("((With<A>, With<B>))");
        assert_eq!(parsed.len(), 2);

        // Or is disjoint only when every branch is.
        assert!(disjoint(
            &atoms("(Or<(With<A>, With<B>)>)"),
            &atoms("(Without<A>, Without<B>)")
        ));
        assert!(!disjoint(
            &atoms("(Or<(With<A>, With<B>)>)"),
            &atoms("(Without<A>)")
        ));
    }

    #[test]
    fn added_and_changed_do_not_establish_disjointness() {
        assert!(!disjoint(
            &atoms("(Added<Player>)"),
            &atoms("(Without<Player>)")
        ));
        assert!(!disjoint(
            &atoms("(Changed<Player>)"),
            &atoms("(With<Player>)")
        ));
    }

    #[test]
    fn unknown_filters_are_reported() {
        let types = filter_types("(MyFilter<Player>)");
        let refs: Vec<&Type> = types.iter().collect();
        let (atoms, notes, unsupported) = parse(&refs);
        assert!(atoms.is_empty());
        assert_eq!(notes.len(), 1, "notes: {notes:?}");
        assert_eq!(unsupported, vec!["(MyFilter<Player>)"]);
    }
}
