//! Rustdoc HTML ingest.
//!
//! Ported from `src/ingest/rustdoc.ts` onto a real HTML DOM (`scraper`): items,
//! fields, variants and doc examples, with impl-header owner extraction, trait
//! impl filtering and the same noise/field exclusions. This is the local-rebuild
//! path; the published corpus is still compiled from canonical NDJSON.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use scraper::{ElementRef, Html, Node, Selector};

use crate::archive::{RawExample, RecordInput};

const DOCS_CHARS: usize = 2000;

/// Auto-trait and blanket impl lists are noise.
const NOISE: &str = "#synthetic-implementations-list, #blanket-implementations-list";

const DEP_CRATES: [&str; 3] = ["glam", "bevy_reflect", "bevy_math"];

const STD_TRAITS: &[&str] = &[
    "Add",
    "AddAssign",
    "AsMut",
    "AsRef",
    "Borrow",
    "BorrowMut",
    "Clone",
    "Copy",
    "Debug",
    "Default",
    "Deref",
    "DerefMut",
    "Display",
    "Drop",
    "Eq",
    "Error",
    "From",
    "FromIterator",
    "FromStr",
    "Hash",
    "HashMap",
    "Index",
    "IndexMut",
    "Into",
    "IntoIterator",
    "Iterator",
    "Ord",
    "PartialEq",
    "PartialOrd",
    "Read",
    "Send",
    "Sync",
    "ToOwned",
    "ToString",
    "Unpin",
    "Write",
    "fmt",
    "std",
];

struct Selectors {
    h1: Selector,
    item_decl: Selector,
    top_doc: Selector,
    src_right: Selector,
    src_child: Selector,
    section: Selector,
    impl_section: Selector,
    h3_header: Selector,
    h4_header: Selector,
    struct_field: Selector,
    variant: Selector,
    examples: Selector,
    docblock: Selector,
    details: Selector,
    summary: Selector,
    where_clause: Selector,
    default_impl: Selector,
    default_fn: Selector,
    noise: Selector,
    scraped: Selector,
    scraped_title: Selector,
    code: Selector,
}

fn selectors() -> &'static Selectors {
    static SELECTORS: OnceLock<Selectors> = OnceLock::new();
    SELECTORS.get_or_init(|| {
        let parse = |css: &str| Selector::parse(css).expect("static selector");
        Selectors {
            h1: parse("h1"),
            item_decl: parse("pre.item-decl code"),
            top_doc: parse("details.top-doc .docblock"),
            src_right: parse("a.src.rightside"),
            src_child: parse("a.src"),
            section: parse("section[id]"),
            impl_section: parse("section.impl"),
            h3_header: parse("h3.code-header"),
            h4_header: parse("h4.code-header"),
            struct_field: parse("span.structfield[id^='structfield.']"),
            variant: parse("section[id^='variant.']"),
            examples: parse(
                "pre.rust-example-rendered, pre.ignore, pre.compile_fail, .example-wrap pre.rust",
            ),
            docblock: parse(".docblock"),
            details: parse("details"),
            summary: parse("summary"),
            where_clause: parse(".where"),
            default_impl: parse("section[id^='impl-Default-for-']"),
            default_fn: parse("section[id='method.default'], section[id^='method.default-']"),
            noise: parse(NOISE),
            scraped: parse(".scraped-example"),
            scraped_title: parse(".scraped-example-title"),
            code: parse("code"),
        }
    })
}

fn item_section_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^(method|tymethod|structmethod|structassocfn|associatedconstant|associatedtype|structassociatedconstant|structassociatedtype|tyassociatedconst|tyassociatedtype|assocconst|variant)\.",
        )
        .expect("item section regex")
    })
}

fn kind_file_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([a-z_]+)\.(.+?)(?:-\d+)?$").expect("kind regex"))
}

fn docs_crate_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"docs\.rs/([a-z0-9_]+)/").expect("docs.rs crate regex"))
}

fn inherited_default_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^returns the .?default value.? for a type").expect("default regex")
    })
}

fn where_rest_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)\bwhere\b.*$").expect("where regex"))
}

fn where_word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\bwhere\b").expect("where word regex"))
}

fn impl_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^impl(?:<.*?>)?\s+").expect("impl prefix regex"))
}

fn multi_newline_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\n{3,}").expect("newlines"))
}

fn spaces_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[ \t]+").expect("spaces"))
}

fn normalize_space(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn block_to_text(element: &ElementRef<'_>) -> String {
    let raw: String = element.text().collect();
    let text = raw.replace('\r', "");
    let text = multi_newline_re().replace_all(&text, "\n\n");
    let text = spaces_re().replace_all(&text, " ");
    text.trim().to_string()
}

fn clip(text: &str) -> String {
    if text.chars().count() <= DOCS_CHARS {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(DOCS_CHARS).collect();
    clipped = clipped.trim_end().to_string();
    clipped.push_str(" …");
    clipped
}

fn element_name<'a>(element: &ElementRef<'a>) -> &'a str {
    element.value().name()
}

fn has_class(element: &ElementRef<'_>, class: &str) -> bool {
    element
        .value()
        .has_class(class, scraper::CaseSensitivity::CaseSensitive)
}

fn prev_element_siblings<'a>(element: &ElementRef<'a>) -> impl Iterator<Item = ElementRef<'a>> {
    element.prev_siblings().filter_map(ElementRef::wrap)
}

fn ancestor_matches(element: &ElementRef<'_>, selector: &Selector) -> bool {
    selector.matches(element)
        || element
            .ancestors()
            .filter_map(ElementRef::wrap)
            .any(|ancestor| selector.matches(&ancestor))
}

fn text_without(element: &ElementRef<'_>, exclude: &Selector) -> String {
    let root = element.id();
    let mut out = String::new();
    for node in element.descendants() {
        if let Node::Text(text) = node.value() {
            let mut inside = None;
            let mut current = node.parent();
            while let Some(parent) = current {
                if parent.id() == root {
                    break;
                }
                if let Some(element) = ElementRef::wrap(parent)
                    && exclude.matches(&element)
                {
                    inside = Some(());
                    break;
                }
                current = parent.parent();
            }
            if inside.is_none() {
                out.push_str(&text.text);
            }
        }
    }
    out
}

/// Text that skips nodes inside an element with `data-nosnippet` (rustdoc's
/// line numbers).
fn text_without_nosnippet(element: &ElementRef<'_>) -> String {
    let root = element.id();
    let mut out = String::new();
    for node in element.descendants() {
        if let Node::Text(text) = node.value() {
            let mut skip = false;
            let mut current = node.parent();
            while let Some(parent) = current {
                if parent.id() == root {
                    break;
                }
                if let Some(element) = ElementRef::wrap(parent)
                    && element.attr("data-nosnippet").is_some()
                {
                    skip = true;
                    break;
                }
                current = parent.parent();
            }
            if !skip {
                out.push_str(&text.text);
            }
        }
    }
    out
}

fn is_noise(element: &ElementRef<'_>, selectors: &Selectors) -> bool {
    ancestor_matches(element, &selectors.noise)
}

/// The closest enclosing `<section class="impl">`, or a preceding one.
fn enclosing_impl<'a>(element: &ElementRef<'a>, selectors: &Selectors) -> Option<ElementRef<'a>> {
    for ancestor in element.ancestors().filter_map(ElementRef::wrap) {
        if selectors.impl_section.matches(&ancestor) {
            return Some(ancestor);
        }
        if element_name(&ancestor) == "section" && ancestor.value().id() == Some("main-content") {
            break;
        }
    }
    let mut node = **element;
    for _ in 0..7 {
        for sibling in node.prev_siblings().filter_map(ElementRef::wrap) {
            if selectors.impl_section.matches(&sibling) {
                return Some(sibling);
            }
            // The impl header lives inside the previous sibling's <summary>.
            if let Some(nested) = sibling.select(&selectors.impl_section).next() {
                return Some(nested);
            }
        }
        node = node.parent()?;
        let current = ElementRef::wrap(node)?;
        if element_name(&current) == "section" && current.value().id() == Some("main-content") {
            break;
        }
    }
    None
}

fn impl_header<'a>(element: &ElementRef<'a>, selectors: &Selectors) -> Option<ElementRef<'a>> {
    let section = enclosing_impl(element, selectors)?;
    section
        .child_elements()
        .find(|child| selectors.h3_header.matches(child))
}

fn owner_from_impl(element: &ElementRef<'_>, selectors: &Selectors) -> Option<String> {
    let header = impl_header(element, selectors)?;
    let text = text_without(&header, &selectors.where_clause);
    owner_from_impl_text(&text)
}

fn trait_from_impl(element: &ElementRef<'_>, selectors: &Selectors) -> Option<String> {
    let header = impl_header(element, selectors)?;
    let text = text_without(&header, &selectors.where_clause);
    trait_from_impl_text(&text)
}

/// Find the docblock belonging to an item section, including a following
/// sibling docblock wrapped in a sibling element.
fn docblock_for<'a>(element: &ElementRef<'a>, selectors: &Selectors) -> Option<ElementRef<'a>> {
    if let Some(inside) = element.select(&selectors.docblock).next() {
        return Some(inside);
    }
    let mut node = **element;
    for _ in 0..6 {
        for sibling in node.next_siblings().filter_map(ElementRef::wrap) {
            if selectors.docblock.matches(&sibling) {
                return Some(sibling);
            }
        }
        if let Some(first) = node.next_siblings().filter_map(ElementRef::wrap).next()
            && let Some(child) = first
                .child_elements()
                .find(|child| selectors.docblock.matches(child))
        {
            return Some(child);
        }
        node = node.parent()?;
        if let Some(parent) = ElementRef::wrap(node)
            && selectors.noise.matches(&parent)
        {
            return None;
        }
    }
    None
}

fn code_header_of(element: &ElementRef<'_>, selectors: &Selectors) -> String {
    if let Some(own) = element
        .child_elements()
        .find(|child| selectors.h4_header.matches(child))
    {
        return normalize_space(&own.text().collect::<String>());
    }
    element
        .select(&selectors.h4_header)
        .next()
        .map(|header| normalize_space(&header.text().collect::<String>()))
        .unwrap_or_default()
}

fn section_name(id: &str) -> Option<&str> {
    id.split_once('.')
        .map(|(_, name)| name)
        .filter(|name| !name.is_empty())
}

fn item_kind_from_section_id(id: &str) -> String {
    let prefix = id.split('.').next().unwrap_or("");
    match prefix {
        "method" | "tymethod" | "structmethod" | "structassocfn" => "method".to_string(),
        "associatedconstant" | "structassociatedconstant" | "tyassociatedconst" | "assocconst" => {
            "associated_const".to_string()
        }
        "associatedtype" | "structassociatedtype" | "tyassociatedtype" => {
            "associated_type".to_string()
        }
        "field" => "field".to_string(),
        "variant" => "variant".to_string(),
        other => other.to_string(),
    }
}

fn trait_is_local(trait_name: Option<&str>, crate_name: &str) -> bool {
    let Some(trait_name) = trait_name else {
        return false;
    };
    if STD_TRAITS.contains(&trait_name) {
        return false;
    }
    if let Some((head, _)) = trait_name.split_once("::") {
        return head == crate_name || head.starts_with("bevy");
    }
    true
}

fn default_impl_doc(html: &Html, selectors: &Selectors) -> String {
    let Some(default_impl) = html.select(&selectors.default_impl).next() else {
        return String::new();
    };
    let target = default_impl
        .select(&selectors.default_fn)
        .next()
        .unwrap_or(default_impl);
    let Some(doc) = docblock_for(&target, selectors) else {
        return String::new();
    };
    let text = normalize_space(&block_to_text(&doc));
    if text.is_empty() || inherited_default_re().is_match(&text) {
        return String::new();
    }
    text
}

fn dep_crate_of_page(source_link: Option<&str>) -> Option<String> {
    let reference = source_link.unwrap_or("");
    if reference.contains("rust-lang.org") {
        return Some("std".to_string());
    }
    docs_crate_re()
        .captures(reference)
        .and_then(|captures| captures.get(1))
        .map(|crate_name| crate_name.as_str().to_string())
}

fn kind_from_filename(file: &Path) -> (Option<String>, Option<String>) {
    let Some(base) = file.file_stem().and_then(|stem| stem.to_str()) else {
        return (None, None);
    };
    if base == "index" || base == "all" {
        return (Some("module".to_string()), None);
    }
    if base == "fnindex" || base == "traitindex" {
        return (None, None);
    }
    let Some(captures) = kind_file_re().captures(base) else {
        return (None, None);
    };
    (
        captures.get(1).map(|value| value.as_str().to_string()),
        captures.get(2).map(|value| value.as_str().to_string()),
    )
}

fn module_from_path(doc_root: &Path, file: &Path) -> (String, String) {
    let relative = file.strip_prefix(doc_root).unwrap_or(file);
    let relative = relative.to_string_lossy().replace('\\', "/");
    let mut segments: Vec<&str> = relative.split('/').collect();
    let crate_name = segments.first().copied().unwrap_or("").to_string();
    let rest = segments.split_off(1.min(segments.len()));
    let mut rest = rest;
    if rest.last().is_some_and(|last| last.ends_with(".html")) {
        rest.pop();
    }
    let module = std::iter::once(crate_name.as_str())
        .chain(rest)
        .collect::<Vec<_>>()
        .join("::");
    (crate_name, module)
}

fn parse_impl_header(header: &str) -> (Option<String>, Option<String>) {
    let mut text = normalize_space(&header.replace('§', ""));
    if text.is_empty() {
        return (None, None);
    }
    text = where_rest_re().replace(&text, "").trim().to_string();
    text = impl_prefix_re().replace(&text, "").trim().to_string();

    let Some(for_index) = text.rfind(" for ") else {
        return (None, strip_generics_and_bounds(&text));
    };
    let lhs = &text[..for_index];
    let rhs = &text[for_index + 5..];
    (
        strip_generics_and_bounds(lhs),
        strip_generics_and_bounds(rhs),
    )
}

fn strip_generics_and_bounds(text: &str) -> Option<String> {
    let mut out = text;
    if let Some(where_index) = where_word_re().find(out) {
        out = &out[..where_index.start()];
    }
    if let Some(generic_index) = out.find('<') {
        out = &out[..generic_index];
    }
    let trimmed = out.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn owner_from_impl_text(text: &str) -> Option<String> {
    parse_impl_header(text).1
}

fn trait_from_impl_text(text: &str) -> Option<String> {
    parse_impl_header(text).0
}

fn item_for_example(
    element: &ElementRef<'_>,
    selectors: &Selectors,
) -> Option<(Option<String>, String)> {
    let mut node = **element;
    for _ in 0..8 {
        let current = ElementRef::wrap(node);
        let details = current
            .filter(|current| element_name(current) == "details")
            .or_else(|| {
                node.ancestors()
                    .filter_map(ElementRef::wrap)
                    .find(|ancestor| element_name(ancestor) == "details")
            });
        if let Some(details) = details
            && let Some(summary) = details
                .child_elements()
                .find(|child| selectors.summary.matches(child))
            && let Some(section) = summary.select(&selectors.section).find(|section| {
                section
                    .value()
                    .id()
                    .is_some_and(|id| item_section_re().is_match(id))
            })
            && let Some(id) = section.value().id()
            && let Some(name) = section_name(id)
        {
            let owner = owner_from_impl(&section, selectors).or_else(|| {
                section
                    .ancestors()
                    .filter_map(ElementRef::wrap)
                    .find(|ancestor| selectors.details.matches(ancestor))
                    .and_then(|details| {
                        prev_element_siblings(&details)
                            .find(|sibling| selectors.impl_section.matches(sibling))
                    })
                    .and_then(|implementation| {
                        implementation
                            .child_elements()
                            .find(|child| selectors.h3_header.matches(child))
                    })
                    .map(|header| text_without(&header, &selectors.where_clause))
                    .and_then(|text| owner_from_impl_text(&text))
            });
            return Some((owner, name.to_string()));
        }
        node = node.parent()?;
        if let Some(parent) = ElementRef::wrap(node)
            && element_name(&parent) == "section"
            && parent.value().id() == Some("main-content")
        {
            break;
        }
    }
    None
}

fn blank_record(
    kind: &str,
    name: &str,
    full_path: String,
    module: &str,
    crate_name: &str,
    file: &str,
    version: Option<&str>,
) -> RecordInput {
    RecordInput {
        source: "rustdoc".to_string(),
        kind: kind.to_string(),
        name: name.to_string(),
        full_path,
        module: module.to_string(),
        file: file.to_string(),
        crate_name: Some(crate_name.to_string()),
        bevy_version: version.map(str::to_string),
        ..RecordInput::default()
    }
}

fn parse_page(
    html_text: &str,
    file: &Path,
    doc_root: &Path,
    bevy_version: Option<&str>,
) -> Vec<RecordInput> {
    let selectors = selectors();
    let html = Html::parse_document(html_text);
    let (crate_name, module) = module_from_path(doc_root, file);
    let (file_kind, file_name) = kind_from_filename(file);
    let relative = file.strip_prefix(doc_root).unwrap_or(file);
    let rel_file = relative.to_string_lossy().replace('\\', "/");

    let mut records: Vec<RecordInput> = Vec::new();

    if let Some(file_kind) = file_kind.as_deref()
        && file_kind != "module"
        && let Some(file_name) = file_name.as_deref()
    {
        let title = html
            .select(&selectors.h1)
            .next()
            .map(|heading| normalize_space(&heading.text().collect::<String>()))
            .map(|text| text.trim_end_matches('§').trim_end().to_string())
            .unwrap_or_default();
        let declaration = html
            .select(&selectors.item_decl)
            .next()
            .map(|code| normalize_space(&code.text().collect::<String>()))
            .unwrap_or_default();
        let docs = html
            .select(&selectors.top_doc)
            .next()
            .map(|doc| clip(&block_to_text(&doc)))
            .unwrap_or_default();
        let source_ref = html
            .select(&selectors.src_right)
            .next()
            .and_then(|link| link.attr("href"))
            .map(str::to_string);
        let defaults = default_impl_doc(&html, selectors);

        let mut record = blank_record(
            file_kind,
            file_name,
            format!("{module}::{file_name}"),
            &module,
            &crate_name,
            &rel_file,
            bevy_version,
        );
        record.signature = if declaration.is_empty() {
            title.clone()
        } else {
            declaration
        };
        record.docs = docs;
        record.defaults = (!defaults.is_empty()).then_some(defaults);
        record.source_ref = source_ref;
        record.title = Some(title);
        records.push(record);
    }

    for section in html.select(&selectors.section) {
        let Some(id) = section.value().id() else {
            continue;
        };
        if !item_section_re().is_match(id) || is_noise(&section, selectors) {
            continue;
        }
        if has_class(&section, "trait-impl") {
            let trait_name = trait_from_impl(&section, selectors);
            if !trait_is_local(trait_name.as_deref(), &crate_name) {
                continue;
            }
        }
        let Some(name) = section_name(id) else {
            continue;
        };
        let kind = item_kind_from_section_id(id);
        let signature = code_header_of(&section, selectors);
        let docs = docblock_for(&section, selectors)
            .map(|doc| clip(&block_to_text(&doc)))
            .unwrap_or_default();
        let owner = owner_from_impl(&section, selectors).or_else(|| file_name.clone());
        let source_ref = section
            .child_elements()
            .find(|child| selectors.src_child.matches(child))
            .and_then(|link| link.attr("href"))
            .map(str::to_string);
        let full_path = match owner.as_deref() {
            Some(owner) if owner != "?" => format!("{module}::{owner}::{name}"),
            _ => format!("{module}::{name}"),
        };
        let mut record = blank_record(
            &kind,
            name,
            full_path,
            &module,
            &crate_name,
            &rel_file,
            bevy_version,
        );
        record.owner = owner;
        record.signature = signature;
        record.docs = docs;
        record.source_ref = source_ref;
        records.push(record);
    }

    // Facade pages re-export dependency types; the source link decides whether
    // their fields belong to this crate.
    let page_source_ref = html
        .select(&selectors.src_right)
        .next()
        .and_then(|link| link.attr("href"))
        .map(str::to_string);
    let page_dep = dep_crate_of_page(page_source_ref.as_deref());
    if !page_dep.is_some_and(|dep| DEP_CRATES.contains(&dep.as_str())) {
        for span in html.select(&selectors.struct_field) {
            let Some(id) = span.value().id() else {
                continue;
            };
            let Some(name) = id.strip_prefix("structfield.") else {
                continue;
            };
            if name.is_empty() || name.chars().all(|ch| ch.is_ascii_digit()) {
                continue;
            }
            let Some(code) = span
                .child_elements()
                .find(|child| selectors.code.matches(child))
            else {
                continue;
            };
            let declaration = normalize_space(&code.text().collect::<String>());
            if !declaration.contains(':') {
                continue;
            }
            let docs = docblock_for(&span, selectors)
                .map(|doc| normalize_space(&block_to_text(&doc)))
                .unwrap_or_default();
            let owner = file_name.clone();
            let full_path = match owner.as_deref() {
                Some(owner) if owner != "?" => format!("{module}::{owner}::{name}"),
                _ => format!("{module}::{name}"),
            };
            let mut record = blank_record(
                "field",
                name,
                full_path,
                &module,
                &crate_name,
                &rel_file,
                bevy_version,
            );
            record.owner = owner;
            record.signature = declaration;
            record.docs = docs;
            record.source_ref = page_source_ref.clone();
            records.push(record);
        }
    }

    for section in html.select(&selectors.variant) {
        let Some(id) = section.value().id() else {
            continue;
        };
        let Some(name) = section_name(id) else {
            continue;
        };
        let docs = section
            .select(&selectors.docblock)
            .next()
            .map(|doc| clip(&block_to_text(&doc)))
            .unwrap_or_default();
        let owner = file_name.clone();
        let full_path = match owner.as_deref() {
            Some(owner) if owner != "?" => format!("{module}::{owner}::{name}"),
            _ => format!("{module}::{name}"),
        };
        let mut record = blank_record(
            "variant",
            name,
            full_path,
            &module,
            &crate_name,
            &rel_file,
            bevy_version,
        );
        record.owner = owner;
        record.docs = docs;
        records.push(record);
    }

    // Examples are attached to their owning item; type-level examples fall
    // back to the page's first record.
    let mut attached: Vec<(RawExample, Option<String>)> = Vec::new();
    for pre in html.select(&selectors.examples) {
        let code_element = pre
            .child_elements()
            .find(|child| selectors.code.matches(child))
            .unwrap_or(pre);
        let source = text_without_nosnippet(&code_element).replace('\r', "");
        if source.trim().is_empty() {
            continue;
        }
        let scraped = ancestor_matches(&pre, &selectors.scraped);
        let source_file = if scraped {
            pre.select(&selectors.scraped_title)
                .next()
                .map(|title| title.text().collect::<String>().trim().to_string())
                .filter(|title| !title.is_empty())
        } else {
            None
        };
        let example = RawExample {
            lang: "rust".to_string(),
            compile_fail: has_class(&pre, "compile_fail"),
            ignored: has_class(&pre, "ignore"),
            scraped,
            source_file,
            code: source.trim_end_matches('\n').to_string(),
        };
        let target = item_for_example(&pre, selectors).map(|(owner, name)| match owner {
            Some(owner) if owner != "?" => format!("{module}::{owner}::{name}"),
            _ => format!("{module}::{name}"),
        });
        attached.push((example, target));
    }
    if !attached.is_empty() {
        let by_path: HashMap<String, usize> = records
            .iter()
            .enumerate()
            .map(|(index, record)| (record.full_path.clone(), index))
            .collect();
        for (example, target) in attached {
            let index = target
                .as_ref()
                .and_then(|path| by_path.get(path).copied())
                .unwrap_or(0);
            if let Some(record) = records.get_mut(index) {
                record.examples.get_or_insert_with(Vec::new).push(example);
            }
        }
    }

    records
}

/// Recursively collect `.html` files, skipping rustdoc's `src/` mirror.
pub fn walk_html(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    for path in paths {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if name == "src" || name == ".lock" {
                continue;
            }
            walk_html(&path, out);
        } else if name.ends_with(".html") {
            out.push(path);
        }
    }
}

fn is_indexable_page(file: &Path, size: u64) -> bool {
    let Some(base) = file.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if matches!(base, "all.html" | "help.html" | "settings.html") {
        return false;
    }
    if base == "index.html" && size > 400 * 1024 {
        return false;
    }
    true
}

/// Ingest every rustdoc item page under `doc_dir`.
pub fn ingest_rustdoc(doc_dir: Option<&Path>, bevy_version: Option<&str>) -> Vec<RecordInput> {
    let Some(doc_dir) = doc_dir else {
        return Vec::new();
    };
    if !doc_dir.is_dir() {
        return Vec::new();
    }
    let mut files = Vec::new();
    walk_html(doc_dir, &mut files);
    let mut records = Vec::new();
    for file in files {
        let Ok(metadata) = fs::metadata(&file) else {
            continue;
        };
        if !is_indexable_page(&file, metadata.len()) {
            continue;
        }
        let Ok(html) = fs::read_to_string(&file) else {
            continue;
        };
        records.extend(parse_page(&html, &file, doc_dir, bevy_version));
    }
    records
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_html() -> String {
        r#"<!DOCTYPE html><html><body>
        <section id="main-content">
        <h1>Widget <button class="copy-path">§</button></h1>
        <pre class="item-decl"><code>pub struct Widget { pub id: u32 }</code></pre>
        <details class="top-doc"><summary><div class="docblock"><p>A widget resource.</p></div></summary></details>
        <a class="src rightside" href="../../src/demo/lib.rs.html">source</a>

        <span class="structfield" id="structfield.id"><code>pub id: u32</code></span>
        <div class="docblock"><p>The widget id.</p></div>
        <span class="structfield" id="structfield.0"><code>pub u32</code></span>

        <section id="impl-Widget" class="impl">
          <h3 class="code-header">impl Widget</h3>
          <details class="toggle method-toggle" open>
            <summary><section id="method.new" class="method"><h4 class="code-header">pub fn new(id: u32) -> Self</h4></section></summary>
            <div class="docblock"><p>Creates a widget.</p><div class="example-wrap"><pre class="rust rust-example-rendered"><code><span class="kw">let</span> w = Widget::new(7);</code></pre></div></div>
          </details>

          <details class="toggle method-toggle" open>
            <summary><section id="method.clone" class="method trait-impl"><h4 class="code-header">fn clone(&amp;self) -> Widget</h4></section></summary>
          </details>
        </section>

        <section id="impl-LocalTrait-for-Widget" class="impl">
          <h3 class="code-header">impl LocalTrait for Widget</h3>
          <details class="toggle method-toggle" open>
            <summary><section id="method.local" class="method trait-impl"><h4 class="code-header">fn local(&amp;self)</h4></section></summary>
            <div class="docblock"><p>A local trait method.</p></div>
          </details>
        </section>
        </section>
        </body></html>"#
            .to_string()
    }

    #[test]
    fn parses_items_fields_trait_impls_and_examples() {
        let root = Path::new("/docs");
        let file = root.join("bevy/struct.Widget.html");
        let records = parse_page(&fixture_html(), &file, root, Some("9.9.9"));
        let by_path: HashMap<&str, &RecordInput> = records
            .iter()
            .map(|record| (record.full_path.as_str(), record))
            .collect();

        let widget = by_path.get("bevy::Widget").expect("Widget record");
        assert_eq!(widget.kind, "struct");
        assert_eq!(widget.signature, "pub struct Widget { pub id: u32 }");
        assert!(widget.docs.contains("A widget resource"));

        let field = by_path.get("bevy::Widget::id").expect("field");
        assert_eq!(field.kind, "field");
        assert_eq!(field.signature, "pub id: u32");
        assert!(field.docs.contains("widget id"));
        assert!(!by_path.contains_key("bevy::Widget::0"), "tuple field");

        let method = by_path.get("bevy::Widget::new").expect("method");
        assert_eq!(method.kind, "method");
        assert!(method.docs.contains("Creates a widget"));
        let examples = method.examples.as_ref().expect("examples");
        assert_eq!(examples.len(), 1);
        assert!(examples[0].code.contains("Widget::new(7)"));

        assert!(
            by_path.contains_key("bevy::Widget::local"),
            "local trait method kept"
        );
        assert!(
            !by_path.contains_key("bevy::Widget::clone"),
            "std trait method filtered"
        );
    }

    #[test]
    fn impl_headers_resolve_owners_and_traits() {
        assert_eq!(
            owner_from_impl_text("impl<T: Component> Plugin for Wrapper<T>"),
            Some("Wrapper".to_string())
        );
        assert_eq!(
            trait_from_impl_text("impl<T: Component> Plugin for Wrapper<T>"),
            Some("Plugin".to_string())
        );
        assert_eq!(
            owner_from_impl_text("impl Wrapper"),
            Some("Wrapper".to_string())
        );
        assert_eq!(trait_from_impl_text("impl Wrapper"), None);
    }

    #[test]
    fn filenames_map_to_kind_and_name() {
        assert_eq!(
            kind_from_filename(Path::new("bevy/struct.Query-1.html")),
            (Some("struct".to_string()), Some("Query".to_string()))
        );
        assert_eq!(
            kind_from_filename(Path::new("bevy/index.html")),
            (Some("module".to_string()), None)
        );
        assert_eq!(
            kind_from_filename(Path::new("bevy/fnindex.html")),
            (None, None)
        );
    }

    #[test]
    fn modules_come_from_the_page_path() {
        let (crate_name, module) = module_from_path(
            Path::new("/docs"),
            Path::new("/docs/bevy/ecs/query/struct.Query.html"),
        );
        assert_eq!(crate_name, "bevy");
        assert_eq!(module, "bevy::ecs::query");
    }
}
