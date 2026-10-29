//! Configuration and version detection.
//!
//! Mirrors the TypeScript configuration contract: config file, environment
//! variables, and a fast Cargo.lock-first version lookup. `cargo metadata` is
//! deliberately not used here; it belongs to `bevy_check_manifest`.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Resolved configuration.
///
/// Several fields are part of the contract but only become live in later
/// steps (`offline` and `max_results` with search, `config_path` with the
/// manifest tools).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Config {
    pub project_root: PathBuf,
    pub bevy_version: Option<String>,
    pub version_source: Option<String>,
    pub version_note: Option<String>,
    pub data_dir: PathBuf,
    pub doc_dir: Option<PathBuf>,
    pub website_dir: Option<PathBuf>,
    pub examples_dir: Option<PathBuf>,
    pub meta_dir: Option<PathBuf>,
    pub errors_dir: Option<PathBuf>,
    pub bevy_src_dir: Option<PathBuf>,
    pub offline: bool,
    pub debug: bool,
    pub max_results: usize,
    /// Plugin corpora configured under `data/corpora/`.
    pub corpora: Vec<CorpusConfig>,
    pub config_path: Option<PathBuf>,
}

/// One plugin corpus declaration from the config file.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusConfig {
    /// Plugin crate name, e.g. `bevy_egui`.
    #[serde(rename = "crate")]
    pub crate_name: String,
    #[serde(default)]
    pub version: Option<String>,
    /// Accepted for config compatibility; the version is read from the host
    /// project's lockfile when omitted.
    #[serde(default)]
    pub auto: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ConfigFile {
    project_root: Option<String>,
    bevy_version: Option<String>,
    /// Older configs spelled it `version`.
    version: Option<String>,
    data_dir: Option<String>,
    doc_dir: Option<String>,
    website_dir: Option<String>,
    examples_dir: Option<String>,
    meta_dir: Option<String>,
    errors_dir: Option<String>,
    bevy_src_dir: Option<String>,
    offline: Option<bool>,
    debug: Option<bool>,
    max_results: Option<u32>,
    corpora: Option<Vec<CorpusConfig>>,
}

#[derive(Debug, Default)]
struct Detected {
    version: Option<String>,
    source: Option<String>,
    note: Option<String>,
}

impl Config {
    /// Resolve configuration from the environment, the config file, and the
    /// nearest Cargo project. Never fails: an unusable config degrades.
    pub fn load() -> Self {
        let env_project_root = env::var("BEVY_PROJECT_ROOT").ok().filter(|v| !v.is_empty());
        let initial_root = env_project_root
            .clone()
            .or_else(|| env::var("INIT_CWD").ok())
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let initial_root = absolutize(&initial_root);

        let (config_path, file) = load_config_file(&initial_root);
        let config_dir = config_path
            .as_ref()
            .and_then(|p| p.parent())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| initial_root.clone());

        let project_root = env_project_root
            .map(|v| resolve_against(&v, &config_dir))
            .or_else(|| {
                file.project_root
                    .as_deref()
                    .map(|v| resolve_against(v, &config_dir))
            })
            .or_else(|| {
                env::var("INIT_CWD")
                    .ok()
                    .map(|v| resolve_against(&v, &config_dir))
            })
            .unwrap_or_else(|| initial_root.clone());
        let project_root = absolutize(&project_root);

        let explicit = match env::var("BEVY_VERSION") {
            Ok(v) if !v.is_empty() => Some((v, "BEVY_VERSION env var".to_string())),
            _ => match (&file.bevy_version, &file.version) {
                (Some(v), _) if !v.is_empty() => Some((v.clone(), file_source(&config_path))),
                (_, Some(v)) if !v.is_empty() => Some((v.clone(), file_source(&config_path))),
                _ => None,
            },
        };
        let detected = match explicit {
            Some((version, source)) => Detected {
                version: Some(version),
                source: Some(source),
                note: None,
            },
            None => detect_bevy_version(&project_root),
        };

        let data_dir = env::var("BEVY_MCP_DATA_DIR")
            .ok()
            .filter(|v| !v.is_empty())
            .map(|v| resolve_against(&v, &config_dir))
            .or_else(|| {
                file.data_dir
                    .as_deref()
                    .map(|v| resolve_against(v, &config_dir))
            })
            .unwrap_or_else(|| default_data_dir(&project_root, &config_dir));

        let from_file = |path: &Option<String>| {
            path.as_deref()
                .map(|value| resolve_against(value, &config_dir))
        };
        let env_dir = |key: &str| {
            env::var(key)
                .ok()
                .filter(|value| !value.is_empty())
                .map(|value| resolve_against(&value, &config_dir))
        };
        let bevy_src_dir = first_existing_dir([
            env_dir("BEVY_SRC_DIR"),
            from_file(&file.bevy_src_dir),
            detected
                .version
                .as_deref()
                .map(|version| project_root.join(format!("bevy-src-v{version}"))),
            Some(project_root.join("bevy")),
            // The published `bevy` crate ships the engine examples; cargo's
            // registry is the checkout most users already have.
            detected.version.as_deref().and_then(cargo_registry_crate),
        ]);
        let website_dir = first_existing_dir([
            env_dir("BEVY_WEBSITE_DIR"),
            from_file(&file.website_dir),
            Some(initial_root.join("vendor").join("bevy-website")),
            Some(initial_root.join("bevy-website")),
            home_dir().map(|home| home.join("bevy-website")),
        ]);
        let examples_dir = first_existing_dir([
            env_dir("BEVY_EXAMPLES_DIR"),
            from_file(&file.examples_dir),
            bevy_src_dir.as_ref().map(|dir| dir.join("examples")),
            detected
                .version
                .as_deref()
                .and_then(cargo_registry_crate)
                .map(|dir| dir.join("examples")),
        ]);
        let errors_dir = first_existing_dir([
            env_dir("BEVY_ERRORS_DIR"),
            from_file(&file.errors_dir),
            bevy_src_dir.as_ref().map(|dir| dir.join("errors")),
        ]);
        let meta_dir = first_existing_dir([
            env_dir("BEVY_META_DIR"),
            from_file(&file.meta_dir),
            Some(initial_root.join("vendor").join("bevy-meta")),
        ]);
        let doc_dir = find_doc_root(
            &project_root,
            env_dir("BEVY_DOC_DIR").or_else(|| from_file(&file.doc_dir)),
        );

        let offline = env::var("BEVY_MCP_OFFLINE")
            .ok()
            .map(|v| v == "1")
            .or(file.offline)
            .unwrap_or(false);
        let debug = env::var("BEVY_MCP_DEBUG")
            .ok()
            .map(|v| v == "1")
            .or(file.debug)
            .unwrap_or(false);
        let max_results = env::var("BEVY_MCP_MAX_RESULTS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .or(file.max_results.map(|v| v as usize))
            .filter(|v| (1..=20).contains(v))
            .unwrap_or(8);

        // `auto: true` resolves the plugin version from the host project's
        // lockfile, exactly like the TypeScript config did.
        let corpora: Vec<CorpusConfig> = file
            .corpora
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|mut corpus| {
                let missing = corpus
                    .version
                    .as_deref()
                    .is_none_or(|version| version.trim().is_empty());
                if corpus.auto == Some(true) && missing {
                    corpus.version =
                        detect_crate_version(&project_root, &corpus.crate_name).version;
                }
                corpus
            })
            .collect();

        Self {
            project_root,
            bevy_version: detected.version,
            version_source: detected.source,
            version_note: detected.note,
            data_dir,
            doc_dir,
            website_dir,
            examples_dir,
            meta_dir,
            errors_dir,
            bevy_src_dir,
            offline,
            debug,
            max_results,
            corpora,
            config_path,
        }
    }

    pub fn log(&self, message: impl AsRef<str>) {
        eprintln!("[bevy-manual-mcp] {}", message.as_ref());
    }

    /// Metadata shipped inside a version bundle (or the checkout's vendor dir).
    ///
    /// Resolves the installed corpus first (including a same-minor corpus), then
    /// falls back to vendored metadata, exact version before same minor.
    pub fn version_metadata_dir(&self, version: &str) -> Option<PathBuf> {
        if let Some((resolved, dir)) = crate::archive::resolve_version_dir(&self.data_dir, version)
        {
            let installed = dir.join("metadata");
            if installed.is_dir() {
                return Some(installed);
            }
            if let Some(vendor) = self.meta_dir.as_ref() {
                let exact = vendor.join(&resolved);
                if exact.is_dir() {
                    return Some(exact);
                }
            }
        }
        let vendor = self.meta_dir.as_ref()?;
        let exact = vendor.join(version);
        if exact.is_dir() {
            return Some(exact);
        }
        fs::read_dir(vendor).ok()?.flatten().find_map(|entry| {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_str()?;
            (path.is_dir() && crate::versions::same_minor(name, version)).then_some(path)
        })
    }

    pub fn feature_graph_path(&self, version: &str) -> Option<PathBuf> {
        self.version_metadata_dir(version)
            .map(|dir| dir.join("features.json"))
            .filter(|path| path.is_file())
    }

    pub fn error_codes_dir(&self, version: &str) -> Option<PathBuf> {
        self.version_metadata_dir(version)
            .map(|dir| dir.join("error-codes"))
            .filter(|path| path.is_dir())
    }

    pub fn compat_path(&self) -> Option<PathBuf> {
        if let Some(version) = self.bevy_version.as_deref()
            && let Some(path) = self
                .version_metadata_dir(version)
                .map(|dir| dir.join("compat.json"))
                .filter(|path| path.is_file())
        {
            return Some(path);
        }
        crate::analysis::compat::locate(self.meta_dir.as_deref(), &self.project_root)
    }
}

fn file_source(path: &Option<PathBuf>) -> String {
    match path {
        Some(p) => format!("config file ({})", p.display()),
        None => "config file".to_string(),
    }
}

fn load_config_file(project_root: &Path) -> (Option<PathBuf>, ConfigFile) {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(path) = env::var("BEVY_MCP_CONFIG")
        && !path.is_empty()
    {
        candidates.push(PathBuf::from(path));
    }
    candidates.push(project_root.join("bevy-mcp.config.json"));
    if let Some(home) = home_dir() {
        candidates.push(home.join(".config").join("bevy-mcp").join("config.json"));
    }
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        match fs::read_to_string(&candidate)
            .map_err(|e| e.to_string())
            .and_then(|text| serde_json::from_str::<ConfigFile>(&text).map_err(|e| e.to_string()))
        {
            Ok(file) => return (Some(candidate), file),
            Err(error) => eprintln!(
                "[bevy-manual-mcp] config: ignoring {} ({error})",
                candidate.display()
            ),
        }
    }
    (None, ConfigFile::default())
}

fn default_data_dir(project_root: &Path, config_dir: &Path) -> PathBuf {
    // A checkout with a built index keeps using it, as the TypeScript server did.
    for candidate in [project_root.join("data"), config_dir.join("data")] {
        if candidate.join("registry.json").is_file() {
            return candidate;
        }
    }
    match home_dir() {
        Some(home) => home.join(".cache").join("bevy-mcp").join("data"),
        None => project_root.join(".bevy-mcp").join("data"),
    }
}

fn first_existing_dir<const N: usize>(candidates: [Option<PathBuf>; N]) -> Option<PathBuf> {
    candidates.into_iter().flatten().find(|path| path.is_dir())
}

fn find_doc_root(project_root: &Path, override_dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut candidates = vec![override_dir, Some(project_root.join("target").join("doc"))];
    if let Ok(entries) = fs::read_dir(project_root.join("target")) {
        for entry in entries.flatten() {
            if entry.file_name() != "doc" && entry.path().is_dir() {
                candidates.push(Some(entry.path().join("doc")));
            }
        }
    }
    candidates.into_iter().flatten().find(|path| {
        path.is_dir()
            && fs::read_dir(path)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false)
    })
}

/// `$CARGO_HOME/registry/src/<index>/bevy-<version>`, when cargo has fetched it.
fn cargo_registry_crate(version: &str) -> Option<PathBuf> {
    let cargo_home = env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".cargo")))?;
    let sources = cargo_home.join("registry").join("src");
    let entries = fs::read_dir(&sources).ok()?;
    for index in entries.flatten() {
        let candidate = index.path().join(format!("bevy-{version}"));
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

fn absolutize(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

fn resolve_against(value: &str, base: &Path) -> PathBuf {
    let expanded = match value.strip_prefix('~') {
        Some(rest) => match home_dir() {
            Some(home) => home.join(rest.trim_start_matches(['/', '\\'])),
            None => PathBuf::from(value),
        },
        None => PathBuf::from(value),
    };
    if expanded.is_absolute() {
        expanded
    } else {
        base.join(expanded)
    }
}

#[derive(Debug, Clone)]
struct VersionCandidate {
    name: String,
    version: String,
}

/// Official Bevy engine crates used when a project depends on sub-crates
/// directly and has no umbrella `bevy` package in its lockfile.
const BEVY_ENGINE_CRATES: &[&str] = &[
    "bevy_a11y",
    "bevy_animation",
    "bevy_anti_alias",
    "bevy_app",
    "bevy_asset",
    "bevy_audio",
    "bevy_camera",
    "bevy_color",
    "bevy_core",
    "bevy_core_pipeline",
    "bevy_derive",
    "bevy_dev_tools",
    "bevy_diagnostic",
    "bevy_dynamic_plugin",
    "bevy_ecs",
    "bevy_encase_derive",
    "bevy_gilrs",
    "bevy_gizmos",
    "bevy_gltf",
    "bevy_hierarchy",
    "bevy_image",
    "bevy_input",
    "bevy_internal",
    "bevy_light",
    "bevy_log",
    "bevy_macro_utils",
    "bevy_math",
    "bevy_material",
    "bevy_mesh",
    "bevy_pbr",
    "bevy_picking",
    "bevy_platform",
    "bevy_post_process",
    "bevy_ptr",
    "bevy_reflect",
    "bevy_render",
    "bevy_scene",
    "bevy_shader",
    "bevy_sprite",
    "bevy_state",
    "bevy_tasks",
    "bevy_text",
    "bevy_time",
    "bevy_transform",
    "bevy_ui",
    "bevy_utils",
    "bevy_viewport",
    "bevy_window",
    "bevy_winit",
    "bevy_world_serialization",
];

fn is_bevy_engine_crate(name: &str) -> bool {
    let name = name.replace('-', "_");
    BEVY_ENGINE_CRATES.contains(&name.as_str())
        || (name.starts_with("bevy_") && (name.ends_with("_derive") || name.ends_with("_macros")))
}

/// Cargo workspaces keep their lockfile at the workspace root, so walk up.
fn detect_bevy_version(project_root: &Path) -> Detected {
    let mut directory = project_root.to_path_buf();
    loop {
        let lock_path = directory.join("Cargo.lock");
        if lock_path.is_file()
            && let Ok(text) = fs::read_to_string(&lock_path)
        {
            if let Some(version) = version_from_lock(&text, "bevy") {
                return Detected {
                    version: Some(version),
                    source: Some(lock_path.display().to_string()),
                    note: None,
                };
            }
            let candidates = lock_candidates(&text, is_bevy_engine_crate);
            if let Some(detected) =
                detected_from_candidates(candidates, lock_path.display().to_string())
            {
                return detected;
            }
        }
        let Some(parent) = directory.parent() else {
            break;
        };
        if parent == directory {
            break;
        }
        directory = parent.to_path_buf();
    }

    let mut directory = project_root.to_path_buf();
    loop {
        let manifest = directory.join("Cargo.toml");
        if manifest.is_file()
            && let Ok(text) = fs::read_to_string(&manifest)
        {
            if let Some(version) = version_from_manifest(&text, "bevy") {
                return Detected {
                    version: Some(version),
                    source: Some(format!("{} (requested range)", manifest.display())),
                    note: None,
                };
            }
            let candidates = manifest_candidates(&text, is_bevy_engine_crate);
            if let Some(detected) = detected_from_candidates(
                candidates,
                format!("{} (requested range)", manifest.display()),
            ) {
                return detected;
            }
        }
        let Some(parent) = directory.parent() else {
            break;
        };
        if parent == directory {
            break;
        }
        directory = parent.to_path_buf();
    }

    Detected {
        version: None,
        source: None,
        note: Some(
            "Could not determine the Bevy version. Set BEVY_VERSION, or point BEVY_PROJECT_ROOT at a Cargo project."
                .to_string(),
        ),
    }
}

fn detected_from_candidates(
    mut candidates: Vec<VersionCandidate>,
    source: String,
) -> Option<Detected> {
    candidates.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| crate::versions::cmp_version(&a.version, &b.version))
    });
    candidates.dedup_by(|a, b| a.name == b.name && a.version == b.version);
    if candidates.is_empty() {
        return None;
    }

    let mut versions: Vec<String> = Vec::new();
    for candidate in &candidates {
        if !versions.contains(&candidate.version) {
            versions.push(candidate.version.clone());
        }
    }
    versions.sort_by(|a, b| crate::versions::cmp_version(a, b));

    if versions.len() == 1 {
        let crates = candidates
            .iter()
            .map(|candidate| format!("{} {}", candidate.name, candidate.version))
            .collect::<Vec<_>>()
            .join(", ");
        return Some(Detected {
            version: Some(versions[0].clone()),
            source: Some(format!("{source} ({crates})")),
            note: None,
        });
    }

    let details = candidates
        .iter()
        .map(|candidate| format!("{} {}", candidate.name, candidate.version))
        .collect::<Vec<_>>()
        .join(", ");
    Some(Detected {
        version: None,
        source: Some(source),
        note: Some(format!(
            "Could not determine the Bevy version: the modular Bevy crates resolve to multiple versions ({details}). Set BEVY_VERSION to choose one."
        )),
    })
}

fn lock_candidates(text: &str, predicate: impl Fn(&str) -> bool) -> Vec<VersionCandidate> {
    let mut candidates = Vec::new();
    let Some(parsed) = toml::from_str::<toml::Value>(text).ok() else {
        return candidates;
    };
    let Some(packages) = parsed.get("package").and_then(toml::Value::as_array) else {
        return candidates;
    };
    for package in packages {
        let Some(name) = package.get("name").and_then(toml::Value::as_str) else {
            continue;
        };
        if !predicate(name) {
            continue;
        }
        let Some(version) = package.get("version").and_then(toml::Value::as_str) else {
            continue;
        };
        candidates.push(VersionCandidate {
            name: name.to_string(),
            version: version.to_string(),
        });
    }
    candidates
}

fn manifest_candidates(text: &str, predicate: impl Fn(&str) -> bool) -> Vec<VersionCandidate> {
    let mut candidates = Vec::new();
    let Some(parsed) = toml::from_str::<toml::Value>(text).ok() else {
        return candidates;
    };
    let workspace_deps = parsed.get("workspace").and_then(|w| w.get("dependencies"));

    let mut tables: Vec<&toml::Value> = Vec::new();
    for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(table) = parsed.get(key) {
            tables.push(table);
        }
    }
    if let Some(targets) = parsed.get("target").and_then(toml::Value::as_table) {
        for target in targets.values() {
            for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
                if let Some(table) = target.get(key) {
                    tables.push(table);
                }
            }
        }
    }
    if let Some(deps) = workspace_deps {
        tables.push(deps);
    }

    for table in tables {
        let Some(entries) = table.as_table() else {
            continue;
        };
        for (name, entry) in entries {
            let effective = entry
                .get("package")
                .and_then(toml::Value::as_str)
                .unwrap_or(name);
            if !predicate(effective) {
                continue;
            }
            let mut version = entry.as_str().map(str::to_string).or_else(|| {
                entry
                    .get("version")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string)
            });
            if version.is_none()
                && entry.get("workspace").and_then(toml::Value::as_bool) == Some(true)
                && let Some(inherited) = workspace_deps.and_then(|d| d.get(name))
            {
                version = inherited.as_str().map(str::to_string).or_else(|| {
                    inherited
                        .get("version")
                        .and_then(toml::Value::as_str)
                        .map(str::to_string)
                });
            }
            if let Some(version) = version {
                candidates.push(VersionCandidate {
                    name: effective.to_string(),
                    version,
                });
            }
        }
    }
    candidates
}

fn detect_crate_version(project_root: &Path, crate_name: &str) -> Detected {
    let mut directory = project_root.to_path_buf();
    loop {
        let lock_path = directory.join("Cargo.lock");
        if lock_path.is_file()
            && let Ok(text) = fs::read_to_string(&lock_path)
            && let Some(version) = version_from_lock(&text, crate_name)
        {
            return Detected {
                version: Some(version),
                source: Some(lock_path.display().to_string()),
                note: None,
            };
        }
        let Some(parent) = directory.parent() else {
            break;
        };
        if parent == directory {
            break;
        }
        directory = parent.to_path_buf();
    }

    let mut directory = project_root.to_path_buf();
    loop {
        let manifest = directory.join("Cargo.toml");
        if manifest.is_file()
            && let Ok(text) = fs::read_to_string(&manifest)
            && let Some(version) = version_from_manifest(&text, crate_name)
        {
            return Detected {
                version: Some(version),
                source: Some(format!("{} (requested range)", manifest.display())),
                note: None,
            };
        }
        let Some(parent) = directory.parent() else {
            break;
        };
        if parent == directory {
            break;
        }
        directory = parent.to_path_buf();
    }

    Detected {
        version: None,
        source: None,
        note: Some(
            "Could not determine the Bevy version. Set BEVY_VERSION, or point BEVY_PROJECT_ROOT at a Cargo project."
                .to_string(),
        ),
    }
}

fn version_from_lock(text: &str, crate_name: &str) -> Option<String> {
    let parsed: toml::Value = toml::from_str(text).ok()?;
    let packages = parsed.get("package")?.as_array()?;
    let normalized = crate_name.replace('-', "_");
    for package in packages {
        let name = package.get("name").and_then(toml::Value::as_str)?;
        if name == crate_name || name == normalized {
            return package
                .get("version")
                .and_then(toml::Value::as_str)
                .map(str::to_string);
        }
    }
    None
}

fn version_from_manifest(text: &str, crate_name: &str) -> Option<String> {
    let parsed: toml::Value = toml::from_str(text).ok()?;
    let workspace_deps = parsed.get("workspace").and_then(|w| w.get("dependencies"));

    let mut tables: Vec<&toml::Value> = Vec::new();
    for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(table) = parsed.get(key) {
            tables.push(table);
        }
    }
    if let Some(targets) = parsed.get("target").and_then(toml::Value::as_table) {
        for target in targets.values() {
            for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
                if let Some(table) = target.get(key) {
                    tables.push(table);
                }
            }
        }
    }
    if let Some(deps) = workspace_deps {
        tables.push(deps);
    }

    for table in tables {
        let Some(entries) = table.as_table() else {
            continue;
        };
        for (name, entry) in entries {
            let is_target = name == crate_name
                || entry.get("package").and_then(toml::Value::as_str) == Some(crate_name);
            if !is_target {
                continue;
            }
            if let Some(version) = entry.as_str() {
                return Some(version.to_string());
            }
            if let Some(version) = entry.get("version").and_then(toml::Value::as_str) {
                return Some(version.to_string());
            }
            if entry.get("workspace").and_then(toml::Value::as_bool) == Some(true)
                && let Some(inherited) = workspace_deps.and_then(|d| d.get(name))
            {
                if let Some(version) = inherited.as_str() {
                    return Some(version.to_string());
                }
                if let Some(version) = inherited.get("version").and_then(toml::Value::as_str) {
                    return Some(version.to_string());
                }
            }
        }
    }

    let entry = workspace_deps?.get(crate_name)?;
    entry.as_str().map(str::to_string).or_else(|| {
        entry
            .get("version")
            .and_then(toml::Value::as_str)
            .map(str::to_string)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        for (name, contents) in files {
            let path = dir.path().join(name);
            fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
            fs::write(path, contents).expect("write fixture");
        }
        dir
    }

    #[test]
    fn detects_an_umbrella_bevy_lockfile() {
        let dir = project_with(&[(
            "Cargo.lock",
            r#"
[[package]]
name = "bevy"
version = "0.20.1"

[[package]]
name = "bevy_ecs"
version = "0.20.1"
"#,
        )]);
        let detected = detect_bevy_version(dir.path());
        assert_eq!(detected.version.as_deref(), Some("0.20.1"));
        assert!(detected.note.is_none());
    }

    #[test]
    fn falls_back_to_modular_engine_crates() {
        let dir = project_with(&[(
            "Cargo.lock",
            r#"
[[package]]
name = "bevy_ecs"
version = "0.20.1"

[[package]]
name = "bevy_app"
version = "0.20.1"
"#,
        )]);
        let detected = detect_bevy_version(dir.path());
        assert_eq!(detected.version.as_deref(), Some("0.20.1"));
        assert!(
            detected
                .source
                .as_deref()
                .is_some_and(|source| source.contains("bevy_ecs")),
            "{detected:?}"
        );
    }

    #[test]
    fn ambiguous_modular_versions_are_reported_not_guessed() {
        let dir = project_with(&[(
            "Cargo.lock",
            r#"
[[package]]
name = "bevy_ecs"
version = "0.20.1"

[[package]]
name = "bevy_app"
version = "0.20.0"
"#,
        )]);
        let detected = detect_bevy_version(dir.path());
        assert_eq!(detected.version, None);
        let note = detected.note.expect("ambiguity note");
        assert!(note.contains("multiple versions"), "{note}");
        assert!(note.contains("bevy_ecs 0.20.1"), "{note}");
        assert!(note.contains("bevy_app 0.20.0"), "{note}");
    }

    #[test]
    fn this_crate_is_not_treated_as_a_bevy_engine_crate() {
        let dir = project_with(&[(
            "Cargo.lock",
            r#"
[[package]]
name = "bevy-manual-mcp"
version = "0.5.0"
"#,
        )]);
        let detected = detect_bevy_version(dir.path());
        assert_eq!(detected.version, None);
    }

    #[test]
    fn falls_back_to_modular_crates_in_the_manifest() {
        let dir = project_with(&[(
            "Cargo.toml",
            r#"
[package]
name = "modular-game"
version = "0.1.0"

[dependencies]
bevy_ecs = "0.20.1"
bevy_app = "0.20.1"
"#,
        )]);
        let detected = detect_bevy_version(dir.path());
        assert_eq!(detected.version.as_deref(), Some("0.20.1"));
    }
}
