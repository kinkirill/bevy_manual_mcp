//! End-to-end archive tests: compile NDJSON, mmap it back, reject corruption.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_bevy-mcp");
const CLEAR_ENV: [&str; 11] = [
    "BEVY_PROJECT_ROOT",
    "BEVY_MCP_DATA_DIR",
    "BEVY_MCP_CONFIG",
    "BEVY_MCP_OFFLINE",
    "BEVY_MCP_MAX_RESULTS",
    "BEVY_MCP_DEBUG",
    "BEVY_WEBSITE_DIR",
    "BEVY_EXAMPLES_DIR",
    "BEVY_META_DIR",
    "BEVY_ERRORS_DIR",
    "INIT_CWD",
];

fn command(data_dir: &Path) -> Command {
    let empty = data_dir.join("no-sources");
    let _ = fs::create_dir_all(&empty);
    let mut command = Command::new(BIN);
    for key in CLEAR_ENV {
        command.env_remove(key);
    }
    command
        .env("BEVY_VERSION", "9.9.9")
        .env("BEVY_MCP_DATA_DIR", data_dir)
        .env("BEVY_MCP_OFFLINE", "1")
        // Keep the host checkout's vendor sources out of the fixture build.
        .env("BEVY_WEBSITE_DIR", &empty)
        .env("BEVY_EXAMPLES_DIR", &empty)
        .env("BEVY_META_DIR", &empty)
        .env("BEVY_ERRORS_DIR", &empty);
    command
}

fn fixture_records() -> String {
    let records = [
        serde_json::json!({
            "source": "rustdoc",
            "kind": "struct",
            "name": "Widget",
            "full_path": "demo::Widget",
            "owner": null,
            "crate": "demo",
            "module": "demo",
            "signature": "pub struct Widget;",
            "docs": "A widget.",
            "file": "demo/struct.Widget.html",
            "source_ref": null,
            "bevy_version": "9.9.9"
        }),
        serde_json::json!({
            "source": "rustdoc",
            "kind": "method",
            "name": "new",
            "full_path": "demo::Widget::new",
            "owner": "Widget",
            "crate": "demo",
            "module": "demo",
            "signature": "pub fn new() -> Widget",
            "docs": "Creates a widget.",
            "file": "demo/struct.Widget.html",
            "source_ref": null,
            "bevy_version": "9.9.9"
        }),
        // Same identity as the previous record: must merge, not duplicate.
        serde_json::json!({
            "source": "rustdoc",
            "kind": "method",
            "name": "new",
            "full_path": "demo::Widget::new",
            "owner": "Widget",
            "crate": "demo",
            "module": "demo",
            "signature": "",
            "docs": "Creates a widget with a longer explanation.",
            "file": "demo/struct.Widget.html",
            "source_ref": null,
            "bevy_version": "9.9.9"
        }),
        // Legacy tuple-field row: dropped at compile time.
        serde_json::json!({
            "source": "rustdoc",
            "kind": "field",
            "name": "0",
            "full_path": "demo::Widget::0",
            "crate": "demo",
            "module": "demo",
            "signature": "",
            "docs": "",
            "file": "demo/struct.Widget.html"
        }),
        serde_json::json!({
            "source": "website",
            "kind": "book",
            "name": "Widgets",
            "full_path": "learn/widgets",
            "module": "learn",
            "signature": "",
            "docs": "How widgets work.",
            "file": "learn/widgets.md",
            "bevy_version": "9.9.9",
            "heading": "Widgets"
        }),
        serde_json::json!({
            "source": "bevy-examples",
            "kind": "code_example",
            "name": "widget",
            "full_path": "examples/widget",
            "module": "examples",
            "signature": "",
            "docs": "Widget example.",
            "file": "examples/widget.rs",
            "bevy_version": "9.9.9",
            "examples": [{
                "lang": "rust",
                "code": "fn main() { let _ = Widget; }",
                "compile_fail": false,
                "ignored": false,
                "scraped": true,
                "source_file": "examples/widget.rs"
            }]
        }),
    ];
    records
        .iter()
        .map(|record| serde_json::to_string(record).expect("record json"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_fixture() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    let data_dir = dir.path().join("data");
    let out_dir = data_dir.join("versions/9.9.9");
    fs::create_dir_all(&out_dir).expect("out dir");
    let records_path = out_dir.join("records.ndjson");
    fs::write(&records_path, fixture_records()).expect("records");

    let output = command(&data_dir)
        .args(["build", "--records"])
        .arg(&records_path)
        .arg("--out")
        .arg(&out_dir)
        .output()
        .expect("run build");
    assert!(
        output.status.success(),
        "build failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("# corpus built"), "{stdout}");
    assert!(stdout.contains("- records: 4"), "{stdout}");
    assert!(stdout.contains("- merged duplicates: 1"), "{stdout}");

    (dir, data_dir)
}

#[test]
fn build_writes_a_valid_archive_and_manifest() {
    let (_dir, data_dir) = build_fixture();
    let version_dir = data_dir.join("versions/9.9.9");

    let archive = version_dir.join("corpus.rkyv");
    let manifest = version_dir.join("corpus.manifest.json");
    assert!(archive.is_file(), "archive missing");
    assert!(manifest.is_file(), "manifest missing");

    let manifest: Value = serde_json::from_str(&fs::read_to_string(&manifest).expect("manifest"))
        .expect("manifest json");
    assert_eq!(manifest["format_version"], 1);
    assert_eq!(manifest["records"], 4);
    assert_eq!(manifest["bevy_version"], "9.9.9");
    assert_eq!(
        manifest["size"].as_u64().expect("size"),
        fs::metadata(&archive).expect("archive metadata").len()
    );
    let sha = manifest["sha256"].as_str().expect("sha256");
    assert_eq!(sha.len(), 64);
}

#[test]
fn lookup_reads_records_through_the_mmap() {
    let (_dir, data_dir) = build_fixture();

    let output = command(&data_dir)
        .args(["lookup", "Widget::new", "--json"])
        .output()
        .expect("run lookup");
    assert!(
        output.status.success(),
        "lookup failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: Value = serde_json::from_slice(&output.stdout).expect("lookup json");
    let rows = rows.as_array().expect("rows");
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["full_path"], "demo::Widget::new");
    assert_eq!(rows[0]["signature"], "pub fn new() -> Widget");
    // The duplicate merge kept the longer documentation.
    assert_eq!(
        rows[0]["docs"],
        "Creates a widget with a longer explanation."
    );

    // Bare name: matches the struct, not its method.
    let output = command(&data_dir)
        .args(["lookup", "Widget", "--json"])
        .output()
        .expect("run bare lookup");
    let rows: Value = serde_json::from_slice(&output.stdout).expect("lookup json");
    let rows = rows.as_array().expect("rows");
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["kind"], "struct");
}

#[test]
fn status_reports_the_loaded_corpus() {
    let (_dir, data_dir) = build_fixture();

    let output = command(&data_dir)
        .arg("status")
        .output()
        .expect("run status");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("# bevy-mcp index status"), "{stdout}");
    assert!(stdout.contains("- **Records:** 4"), "{stdout}");
    assert!(stdout.contains("- **Corpus:** corpus.rkyv v1"), "{stdout}");
    assert!(stdout.contains("loaded in"), "{stdout}");
}

#[test]
fn truncated_archive_is_rejected_instead_of_read() {
    let (_dir, data_dir) = build_fixture();
    let version_dir = data_dir.join("versions/9.9.9");
    let archive = version_dir.join("corpus.rkyv");

    let bytes = fs::read(&archive).expect("read archive");
    fs::write(&archive, &bytes[..bytes.len() - 32]).expect("truncate archive");

    let output = command(&data_dir)
        .args(["lookup", "Widget", "--json"])
        .output()
        .expect("run lookup");
    assert!(!output.status.success(), "corrupted archive was accepted");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("failed validation") || stderr.contains("validation"),
        "{stderr}"
    );
}

#[test]
fn build_ingests_website_examples_and_error_codes() {
    let dir = tempfile::tempdir().expect("temp dir");
    let data_dir = dir.path().join("data");
    let out_dir = data_dir.join("versions/9.9.9");
    fs::create_dir_all(&out_dir).expect("out dir");
    fs::write(
        out_dir.join("records.ndjson"),
        serde_json::json!({
            "source": "rustdoc",
            "kind": "struct",
            "name": "Widget",
            "full_path": "demo::Widget",
            "crate": "demo",
            "module": "demo",
            "signature": "pub struct Widget;",
            "docs": "A widget.",
            "file": "demo/struct.Widget.html"
        })
        .to_string(),
    )
    .expect("records");

    let site = dir.path().join("site");
    fs::create_dir_all(site.join("content/learn/book")).expect("book dir");
    fs::write(
        site.join("content/learn/book/intro.md"),
        "+++\ntitle = \"Introduction\"\n+++\nThe Book introduction body.",
    )
    .expect("book page");
    fs::create_dir_all(site.join("content/foundation")).expect("foundation dir");
    fs::write(
        site.join("content/foundation/team.md"),
        "+++\ntitle = \"Team\"\n+++\nFoundation prose is weighted out.",
    )
    .expect("foundation page");
    fs::create_dir_all(site.join("learning-code-examples/examples")).expect("examples dir");
    fs::write(
        site.join("learning-code-examples/examples/demo.rs"),
        "//! A learning example.\nfn main() {}\n",
    )
    .expect("example");

    let meta = dir.path().join("meta");
    fs::create_dir_all(meta.join("9.9.9/error-codes")).expect("meta dir");
    fs::write(meta.join("9.9.9/error-codes/B0001.md"), "B0001 guide").expect("error code");

    let output = command(&data_dir)
        .env("BEVY_WEBSITE_DIR", &site)
        .env("BEVY_META_DIR", &meta)
        .args(["build", "--records"])
        .arg(out_dir.join("records.ndjson"))
        .arg("--out")
        .arg(&out_dir)
        .output()
        .expect("run build");
    assert!(
        output.status.success(),
        "build failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("website=1"), "{stderr}");
    assert!(stderr.contains("examples=1"), "{stderr}");
    assert!(stderr.contains("error_codes=1"), "{stderr}");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("- records: 4"), "{stdout}");

    let status = command(&data_dir)
        .arg("status")
        .output()
        .expect("run status");
    let stdout = String::from_utf8_lossy(&status.stdout);
    assert!(stdout.contains("`website`: 1"), "{stdout}");
    assert!(stdout.contains("`learn-examples`: 1"), "{stdout}");
    assert!(stdout.contains("`bevy-meta`: 1"), "{stdout}");
    assert!(
        !stdout.contains("foundation"),
        "foundation record leaked: {stdout}"
    );
}
