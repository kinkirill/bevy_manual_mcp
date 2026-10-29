//! Semantic-version helpers ported from the TypeScript store.
//!
//! `cmp_version` compares the numeric core only, matching the existing
//! behaviour; `bump_between` classifies a move between two Bevy releases.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VersionParts {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub prerelease: Option<&'static str>,
}

impl VersionParts {
    pub fn parse(version: &str) -> Self {
        let clean = version.split('+').next().unwrap_or("");
        let (core, prerelease) = match clean.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (clean, None),
        };
        let mut nums = core.split('.').map(|n| n.parse::<u64>().unwrap_or(0));
        Self {
            major: nums.next().unwrap_or(0),
            minor: nums.next().unwrap_or(0),
            patch: nums.next().unwrap_or(0),
            // Kept as a flag; the TypeScript comparator ignores prerelease text.
            prerelease: prerelease.map(|_| ""),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Bump {
    pub level: &'static str,
    #[serde(rename = "breaksApi")]
    pub breaks_api: bool,
    pub direction: &'static str,
    pub label: String,
}

pub fn cmp_version(a: &str, b: &str) -> std::cmp::Ordering {
    let a = VersionParts::parse(a);
    let b = VersionParts::parse(b);
    (a.major, a.minor, a.patch).cmp(&(b.major, b.minor, b.patch))
}

pub fn bump_between(from: Option<&str>, to: Option<&str>) -> Bump {
    let (Some(from), Some(to)) = (from, to) else {
        return Bump {
            level: "unknown",
            breaks_api: true,
            direction: "unknown",
            label: "unknown".to_string(),
        };
    };
    let a = VersionParts::parse(from);
    let b = VersionParts::parse(to);
    let cmp = cmp_version(from, to);

    if cmp.is_eq() {
        return Bump {
            level: "none",
            breaks_api: false,
            direction: "same",
            label: format!("{to} is the same version as {from}"),
        };
    }

    let direction = if cmp.is_lt() { "upgrade" } else { "downgrade" };

    if cmp.is_gt() {
        return Bump {
            level: "downgrade",
            breaks_api: true,
            direction,
            label: format!("{from} -> {to} is a downgrade; the {from} APIs no longer exist."),
        };
    }

    if a.major == 0 && b.major == 0 && a.minor != b.minor {
        return Bump {
            level: "minor",
            breaks_api: true,
            direction,
            label: format!(
                "{from} -> {to} is a MINOR bump: Bevy makes sweeping breaking API changes at every minor release. Expect substantial rewrites."
            ),
        };
    }

    if a.major != b.major {
        return Bump {
            level: "major",
            breaks_api: true,
            direction,
            label: format!("{from} -> {to} is a MAJOR bump and definitely breaks the API."),
        };
    }

    if a.minor != b.minor {
        return Bump {
            level: "minor",
            breaks_api: a.major == 0,
            direction,
            label: if a.major == 0 {
                format!("{from} -> {to} is a minor bump on a 0.x version: breaking API changes.")
            } else {
                format!(
                    "{from} -> {to} is a minor bump; on a 1.x+ release this is additive, not breaking."
                )
            },
        };
    }

    Bump {
        level: "patch",
        breaks_api: false,
        direction,
        label: format!(
            "{from} -> {to} is a PATCH release: bug fixes only, no API changes. Existing code keeps working; there is nothing to migrate."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_numeric_core() {
        assert!(cmp_version("0.19.1", "0.20.0").is_lt());
        assert!(cmp_version("0.20.0", "0.20.0").is_eq());
        assert!(cmp_version("1.0.0", "0.99.0").is_gt());
    }

    #[test]
    fn zero_x_minor_is_breaking() {
        let bump = bump_between(Some("0.19.1"), Some("0.20.0"));
        assert_eq!(bump.level, "minor");
        assert!(bump.breaks_api);
        assert_eq!(bump.direction, "upgrade");
    }

    #[test]
    fn patch_is_not_breaking() {
        let bump = bump_between(Some("0.20.0"), Some("0.20.1"));
        assert_eq!(bump.level, "patch");
        assert!(!bump.breaks_api);
    }

    #[test]
    fn downgrade_breaks_api() {
        let bump = bump_between(Some("0.20.0"), Some("0.19.1"));
        assert_eq!(bump.level, "downgrade");
        assert!(bump.breaks_api);
    }

    #[test]
    fn missing_version_is_unknown() {
        assert_eq!(bump_between(None, Some("0.20.0")).level, "unknown");
    }
}
