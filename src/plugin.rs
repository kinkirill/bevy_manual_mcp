//! Plugin scaffold templates.
//!
//! Templates are self-contained (the TypeScript SystemSet template referenced
//! an undefined `OtherSystem` and a non-existent `#[system_set]` attribute) and
//! every rendered snippet is parsed with `syn` before it is returned. Symbol
//! checks against the corpus stay diagnostics; `compile_verified` is always
//! false because no compiler runs here.

use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct Template {
    pub id: &'static str,
    pub title: &'static str,
    pub requires: &'static [&'static str],
    body: &'static str,
}

#[derive(Debug)]
pub struct Rendered {
    pub code: String,
    pub ignored_params: Vec<String>,
}

const SKELETON: &str = r#"use bevy::prelude::*;

#[derive(Resource, Default)]
pub struct {{RESOURCE_TYPE}};

pub struct {{PLUGIN_NAME}};

impl Plugin for {{PLUGIN_NAME}} {
    fn build(&self, app: &mut App) {
        app.init_resource::<{{RESOURCE_TYPE}}>()
            .add_systems({{UPDATE}}, {{SYSTEM_NAME}});
    }
}

fn {{SYSTEM_NAME}}(resource: Res<{{RESOURCE_TYPE}}>) {
    // TODO: implement logic
}
"#;

const WITH_SYSTEM_SET: &str = r#"use bevy::prelude::*;

#[derive(Resource, Default)]
pub struct {{RESOURCE_TYPE}};

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct {{SYSTEM_SET}};

pub struct {{PLUGIN_NAME}};

impl Plugin for {{PLUGIN_NAME}} {
    fn build(&self, app: &mut App) {
        app.init_resource::<{{RESOURCE_TYPE}}>()
            .configure_sets({{UPDATE}}, {{SYSTEM_SET}})
            .add_systems({{UPDATE}}, {{SYSTEM_NAME}}.in_set({{SYSTEM_SET}}));
    }
}

fn {{SYSTEM_NAME}}(resource: Res<{{RESOURCE_TYPE}}>) {
    // TODO: implement logic
}
"#;

pub fn templates() -> Vec<Template> {
    vec![
        Template {
            id: "plugin-skeleton",
            title: "Minimal Plugin with one system and one resource",
            requires: &["App", "Plugin", "add_systems"],
            body: SKELETON,
        },
        Template {
            id: "plugin-with-systemset",
            title: "Plugin with SystemSet for ordering",
            requires: &["App", "Plugin", "SystemSet", "add_systems"],
            body: WITH_SYSTEM_SET,
        },
    ]
}

pub fn find(id: &str) -> Option<Template> {
    templates().into_iter().find(|template| template.id == id)
}

/// Fill a template's slots. Unknown keys are returned instead of silently
/// dropped, and values that would not parse as Rust identifiers are rejected.
pub fn render(template: &Template, params: &BTreeMap<String, String>) -> Result<Rendered, String> {
    let mut values: BTreeMap<&'static str, String> = BTreeMap::from([
        ("PLUGIN_NAME", "MyPlugin".to_string()),
        ("RESOURCE_TYPE", "MyResource".to_string()),
        ("SYSTEM_NAME", "my_system".to_string()),
        ("SYSTEM_SET", "MySystemSet".to_string()),
        ("UPDATE", "Update".to_string()),
    ]);
    let mut ignored_params = Vec::new();
    for (key, value) in params {
        let slot = key.trim().to_ascii_uppercase();
        let Some(known) = values.keys().copied().find(|known| *known == slot) else {
            ignored_params.push(key.clone());
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            return Err(format!("parameter `{key}` has an empty value"));
        }
        if known == "UPDATE" {
            syn::parse_str::<syn::Path>(value).map_err(|_| {
                format!("parameter `{key}` is not a valid schedule path: `{value}`")
            })?;
        } else {
            syn::parse_str::<syn::Ident>(value).map_err(|_| {
                format!("parameter `{key}` is not a valid Rust identifier: `{value}`")
            })?;
        }
        values.insert(known, value.to_string());
    }

    let mut code = template.body.to_string();
    for (slot, value) in values {
        code = code.replace(&format!("{{{{{slot}}}}}"), &value);
    }
    if code.contains("{{") {
        return Err(format!("template `{}` has an unfilled slot", template.id));
    }
    syn::parse_file(&code).map_err(|error| {
        format!(
            "generated code for `{}` does not parse: {error}",
            template.id
        )
    })?;

    Ok(Rendered {
        code,
        ignored_params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn the_system_set_template_is_self_contained() {
        let template = find("plugin-with-systemset").expect("template");
        let rendered = render(&template, &BTreeMap::new()).expect("render");
        assert!(!rendered.code.contains("OtherSystem"));
        assert!(rendered.code.contains("#[derive(SystemSet"));
        assert!(rendered.code.contains("#[derive(Resource, Default)]"));
        assert!(rendered.code.contains("MyPlugin"));
        syn::parse_file(&rendered.code).expect("parses");
    }

    #[test]
    fn parameters_change_the_emitted_identifiers() {
        let template = find("plugin-skeleton").expect("template");
        let rendered = render(
            &template,
            &params(&[
                ("PLUGIN_NAME", "FooPlugin"),
                ("RESOURCE_TYPE", "FooState"),
                ("SYSTEM_NAME", "tick_foo"),
                ("UPDATE", "FixedUpdate"),
            ]),
        )
        .expect("render");
        assert!(rendered.code.contains("pub struct FooPlugin;"));
        assert!(rendered.code.contains("init_resource::<FooState>"));
        assert!(rendered.code.contains("add_systems(FixedUpdate, tick_foo)"));
        assert!(rendered.ignored_params.is_empty());
    }

    #[test]
    fn unknown_and_malformed_parameters_are_reported_not_thrown() {
        let template = find("plugin-skeleton").expect("template");
        let rendered =
            render(&template, &params(&[("NOT_A_SLOT", "x"), ("a(", "x")])).expect("render");
        assert_eq!(rendered.ignored_params, vec!["NOT_A_SLOT", "a("]);

        let rejected = render(&template, &params(&[("PLUGIN_NAME", "1 bad")])).expect_err("reject");
        assert!(
            rejected.contains("not a valid Rust identifier"),
            "{rejected}"
        );
    }
}
