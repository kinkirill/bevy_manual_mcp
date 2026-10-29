//! Syntax-level analysis for the manifest and system tools.
//!
//! Step 4 replaces the two hand-rolled string parsers of the TypeScript line:
//! `syn` finds real `fn` items (a `fn` inside a comment or string literal is
//! not one), and access extraction works on types instead of regexes. This is
//! still a syntax-level linter: it does not type-check, resolve aliases or
//! prove lifetimes, and B0001/B0002 are Bevy *runtime* panics.

pub mod conflicts;
pub mod filters;
pub mod perf;
pub mod report;
pub mod systems;

use quote::ToTokens;
use syn::{PathArguments, Type};

/// Render a type the way a user would read it (`Assets<Mesh>`, not `Assets < Mesh >`).
pub(crate) fn render_type(ty: &Type) -> String {
    compact(&ty.to_token_stream().to_string())
}

/// Remove the spacing `TokenStream::to_string` inserts around punctuation.
fn compact(tokens: &str) -> String {
    const TIGHT: [char; 13] = [
        '<', '>', '(', ')', '[', ']', ',', '&', '*', ':', ';', '+', '=',
    ];
    let mut out = String::with_capacity(tokens.len());
    let mut pending_space = false;
    for ch in tokens.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if TIGHT.contains(&ch) {
            while out.ends_with(' ') {
                out.pop();
            }
            out.push(ch);
        } else {
            if pending_space && !out.is_empty() && !out.ends_with(TIGHT) {
                out.push(' ');
            }
            out.push(ch);
        }
        pending_space = false;
    }
    let mut spaced = out.replace(',', ", ");
    for closer in [')', '>', ']'] {
        spaced = spaced.replace(&format!(", {closer}"), &closer.to_string());
    }
    spaced
}

/// The type arguments of a path's last segment.
pub(crate) fn type_args(ty: &Type) -> Vec<&Type> {
    let Type::Path(path) = ty else {
        return Vec::new();
    };
    let Some(segment) = path.path.segments.last() else {
        return Vec::new();
    };
    let PathArguments::AngleBracketed(arguments) = &segment.arguments else {
        return Vec::new();
    };
    arguments
        .args
        .iter()
        .filter_map(|argument| match argument {
            syn::GenericArgument::Type(ty) => Some(ty),
            _ => None,
        })
        .collect()
}

/// The last path segment's identifier, e.g. `Query` in `bevy::prelude::Query`.
pub(crate) fn type_ident(ty: &Type) -> Option<String> {
    let Type::Path(path) = ty else {
        return None;
    };
    path.path
        .segments
        .last()
        .map(|segment| segment.ident.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered(source: &str) -> String {
        render_type(&syn::parse_str::<Type>(source).expect("type"))
    }

    #[test]
    fn types_render_without_token_spacing() {
        assert_eq!(rendered("Assets < Mesh >"), "Assets<Mesh>");
        assert_eq!(rendered("& 'a mut Transform"), "&'a mut Transform");
        assert_eq!(rendered("( & A , & mut B )"), "(&A, &mut B)");
        assert_eq!(
            rendered("bevy :: prelude :: Query < & Transform >"),
            "bevy::prelude::Query<&Transform>"
        );
    }
}
