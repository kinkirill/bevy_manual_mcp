//! Parsing pasted Bevy panic/warning text.
//!
//! Ported from `src/tools/explain_error.ts` without a regex dependency: the
//! shapes are small (`error[B0001]`, `ResMut<Assets<Mesh>>`, `in system
//! move_system`), so they are scanned directly. The uncoded path stays an
//! honest tier-3 refusal; no panic-site matching is attempted.

use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
pub struct Extracted {
    pub code: Option<String>,
    pub severity: Option<&'static str>,
    pub system_name: Option<String>,
    pub resource_type: Option<String>,
    pub access_list: Vec<String>,
}

/// Extract the error code, severity, system name, resource type and access
/// patterns from a pasted Bevy message.
pub fn extract(message: &str) -> Extracted {
    let mut extracted = Extracted::default();
    let (severity, code) = find_code(message);
    let Some(code) = code else {
        return extracted;
    };
    extracted.severity = Some(severity);
    extracted.code = Some(code);
    extracted.system_name = find_system_name(message);

    if let Some(inner) = generic_argument(message, "ResMut") {
        extracted.resource_type = Some(inner);
        extracted.access_list.push("ResMut".to_string());
    } else if let Some(inner) = generic_argument(message, "Res") {
        extracted.resource_type = Some(inner);
        extracted.access_list.push("Res".to_string());
    }

    if message.contains("&mut") {
        extracted.access_list.push("&mut".to_string());
    } else if message.contains('&') {
        extracted.access_list.push("&".to_string());
    }
    extracted
}

/// `error[B0001]:` or `warning[B0004]:` -> (panic|warning, code).
fn find_code(message: &str) -> (&'static str, Option<String>) {
    for (needle, severity) in [("error[", "panic"), ("warning[", "warning")] {
        let mut from = 0;
        while let Some(offset) = message[from..].find(needle) {
            let start = from + offset;
            let boundary = message[..start]
                .chars()
                .last()
                .is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_');
            if !boundary {
                from = start + needle.len();
                continue;
            }
            let after = start + needle.len();
            let rest = &message[after..];
            let mut chars = rest.chars();
            let is_code = chars.next() == Some('B')
                && chars.clone().take(4).all(|ch| ch.is_ascii_digit())
                && rest.chars().nth(5) == Some(']');
            if is_code {
                let code: String = rest.chars().take(5).collect();
                return (severity, Some(code));
            }
            from = after;
        }
    }
    ("panic", None)
}

/// The inside of `Name<...>` with balanced angle brackets.
fn generic_argument(message: &str, name: &str) -> Option<String> {
    let needle = format!("{name}<");
    let mut from = 0;
    while let Some(offset) = message[from..].find(&needle) {
        let start = from + offset;
        let boundary = message[..start]
            .chars()
            .last()
            .is_none_or(|ch| !ch.is_alphanumeric() && ch != '_' && ch != ':');
        if !boundary {
            from = start + needle.len();
            continue;
        }
        let open = start + needle.len() - 1;
        let mut depth = 0usize;
        for (offset, ch) in message[open..].char_indices() {
            match ch {
                '<' => depth += 1,
                '>' => {
                    depth -= 1;
                    if depth == 0 {
                        let inner = message[open + 1..open + offset].trim();
                        if !inner.is_empty() {
                            return Some(inner.to_string());
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
        from = start + needle.len();
    }
    None
}

/// A best-effort system name: `in system move_system`, `system 'name',` or
/// `system "name":`.
fn find_system_name(message: &str) -> Option<String> {
    let mut from = 0;
    while let Some(offset) = message[from..].find("system") {
        let start = from + offset;
        let before_ok = message[..start]
            .chars()
            .last()
            .is_none_or(|ch| !ch.is_alphanumeric() && ch != '_');
        let mut rest = &message[start + "system".len()..];
        if !before_ok || !rest.starts_with(|ch: char| ch.is_whitespace()) {
            from = start + "system".len();
            continue;
        }
        rest = rest.trim_start();
        let first = rest.chars().next()?;
        if first == '\'' || first == '"' {
            let quote = first;
            let inner = &rest[first.len_utf8()..];
            if let Some(end) = inner.find(quote) {
                let name = inner[..end].trim();
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
            return None;
        }
        let name: String = rest
            .chars()
            .take_while(|ch| !ch.is_whitespace() && !matches!(ch, ',' | ':' | ';'))
            .collect();
        if !name.is_empty() {
            return Some(name);
        }
        from = start + "system".len();
    }
    None
}

/// Path to a vendored error-code guide.
pub fn guide_path(error_codes_dir: &Path, code: &str) -> PathBuf {
    error_codes_dir.join(format!("{code}.md"))
}

/// The short presentation: a section whose heading mentions a fix/solution,
/// otherwise the first 2000 characters of the guide.
pub fn short_guide(guide: &str) -> String {
    if let Some(fix) = fix_section(guide) {
        return fix;
    }
    const LIMIT: usize = 2000;
    if guide.chars().count() <= LIMIT {
        return guide.trim().to_string();
    }
    let truncated: String = guide.chars().take(LIMIT).collect();
    format!("{}\n...(truncated)", truncated.trim_end())
}

fn fix_section(guide: &str) -> Option<String> {
    let mut lines = guide.lines().peekable();
    while let Some(line) = lines.next() {
        let Some(title) = line.strip_prefix("## ") else {
            continue;
        };
        let lower = title.to_ascii_lowercase();
        if !(lower.contains("fix") || lower.contains("solution")) {
            continue;
        }
        let mut body = Vec::new();
        for line in lines.by_ref() {
            if line.starts_with("## ") || line.starts_with("# ") {
                break;
            }
            body.push(line);
        }
        let body = body.join("\n").trim().to_string();
        if !body.is_empty() {
            return Some(body);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_and_resource_are_extracted() {
        let extracted = extract(
            "thread 'main' panicked at error[B0002]: ResMut<Assets<StandardMaterial>> conflicts with Res<Assets<StandardMaterial>>",
        );
        assert_eq!(extracted.code.as_deref(), Some("B0002"));
        assert_eq!(extracted.severity, Some("panic"));
        assert_eq!(
            extracted.resource_type.as_deref(),
            Some("Assets<StandardMaterial>")
        );
        assert!(extracted.access_list.contains(&"ResMut".to_string()));
        assert!(!extracted.access_list.contains(&"&".to_string()));
    }

    #[test]
    fn nested_generics_are_balanced() {
        let extracted = extract("error[B0002]: Res<Assets<Mesh>> and &mut Transform");
        assert_eq!(extracted.resource_type.as_deref(), Some("Assets<Mesh>"));
        assert!(extracted.access_list.contains(&"&mut".to_string()));
    }

    #[test]
    fn system_names_are_extracted_from_common_shapes() {
        let in_system =
            extract("error[B0002]: ResMut<Time> in system tick_world conflicts with Res<Time>");
        assert_eq!(in_system.system_name.as_deref(), Some("tick_world"));
        let quoted = extract("warning[B0004]: system 'render_ui', is slow");
        assert_eq!(quoted.severity, Some("warning"));
        assert_eq!(quoted.system_name.as_deref(), Some("render_ui"));
    }

    #[test]
    fn uncoded_messages_have_no_code() {
        let extracted = extract("thread 'main' panicked at 'something unknown happened'");
        assert!(extracted.code.is_none());
        assert!(extracted.severity.is_none());
    }

    #[test]
    fn fix_sections_and_truncation() {
        let guide = "# B0001\n\nintro\n\n## Fix\n\nUse `Without<T>`.\n\n## Note\n\nmore";
        assert_eq!(short_guide(guide), "Use `Without<T>`.");
        let long = format!("# B0001\n\n{}", "word ".repeat(800));
        let short = short_guide(&long);
        assert!(short.ends_with("...(truncated)"));
        assert!(short.chars().count() < long.chars().count());
    }
}
