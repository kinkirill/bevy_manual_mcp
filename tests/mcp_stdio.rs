//! Black-box tests: spawn the real binary and speak MCP over stdio.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_bevy-manual-mcp");
const TIMEOUT: Duration = Duration::from_secs(20);
const CLEAR_ENV: [&str; 14] = [
    "BEVY_VERSION",
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
    "BEVY_MCP_COMPAT_PATH",
    "BEVY_MCP_INDEX_BASE_URL",
    "INIT_CWD",
];

fn fixture() -> TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::create_dir_all(dir.path().join("versions/9.9.9")).expect("version dir");
    std::fs::write(
        dir.path().join("registry.json"),
        serde_json::to_string_pretty(&json!({
            "cache_version": 5,
            "versions": {
                "9.9.9": {
                    "version": "9.9.9",
                    "cache_version": 5,
                    "built_at": "2026-01-02T00:00:00Z",
                    "records": 42,
                    "symbols": 7,
                    "by_kind": { "method": 40, "struct": 2 }
                },
                "9.8.0": {
                    "version": "9.8.0",
                    "cache_version": 5,
                    "built_at": "2025-12-01T00:00:00Z",
                    "records": 40,
                    "symbols": 6
                }
            }
        }))
        .expect("registry json"),
    )
    .expect("write registry");
    std::fs::write(
        dir.path().join("versions/9.9.9/meta.json"),
        serde_json::to_string_pretty(&json!({
            "bevy_version": "9.9.9",
            "cache_version": 5,
            "api_records": 42,
            "symbols": 7,
            "built_at": "2026-01-02T00:00:00Z",
            "doc_dir": "/tmp/bevy-doc",
            "website_dir": "/tmp/bevy-website",
            "examples_dir": "/tmp/bevy-examples"
        }))
        .expect("meta json"),
    )
    .expect("write meta");
    dir
}

fn base_command(dir: &Path) -> Command {
    let mut command = Command::new(BIN);
    for key in CLEAR_ENV {
        command.env_remove(key);
    }
    command
        .env("BEVY_MCP_DATA_DIR", dir)
        .env("BEVY_VERSION", "9.9.9")
        .env("BEVY_PROJECT_ROOT", dir)
        .env("BEVY_MCP_OFFLINE", "1");
    command
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next_id: u64,
}

impl Server {
    /// Spawn the bare command: no `serve` argument, exactly how MCP clients do.
    fn spawn(dir: &Path) -> Self {
        Self::spawn_with_env(dir, &[])
    }

    fn spawn_with_env(dir: &Path, envs: &[(&str, &str)]) -> Self {
        let mut command = base_command(dir);
        for (key, value) in envs {
            command.env(key, value);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("spawn bevy-manual-mcp");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = child.stdout.take().expect("child stdout");
        let (sender, lines) = channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });
        Self {
            child,
            stdin,
            lines,
            next_id: 1,
        }
    }

    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").expect("write request");
        self.stdin.flush().expect("flush request");
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        loop {
            let line = self
                .lines
                .recv_timeout(TIMEOUT)
                .unwrap_or_else(|_| panic!("timed out waiting for {method}"));
            let value: Value = serde_json::from_str(&line).expect("JSON response");
            if value.get("id") == Some(&json!(id)) {
                return value;
            }
        }
    }

    fn notify(&mut self, method: &str) {
        self.send(json!({ "jsonrpc": "2.0", "method": method }));
    }

    fn initialize(&mut self) -> Value {
        let response = self.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "bevy-manual-mcp-rust-tests", "version": "0.0.0" }
            }),
        );
        self.notify("notifications/initialized");
        response
    }

    fn call_tool(&mut self, name: &str, arguments: Value) -> Value {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn tool_text(result: &Value) -> &str {
    result["result"]["content"][0]["text"]
        .as_str()
        .expect("text content")
}

#[test]
fn handshake_reports_server_identity_and_tools() {
    let dir = fixture();
    let mut server = Server::spawn(dir.path());
    let response = server.initialize();
    let result = &response["result"];

    assert_eq!(result["serverInfo"]["name"], "bevy-manual-mcp");
    assert_eq!(result["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
    assert!(
        result["capabilities"]["tools"].is_object(),
        "tools capability must be advertised: {result}"
    );
    assert_eq!(result["protocolVersion"], "2025-06-18");

    let response = server.request("tools/list", json!({}));
    let tools = response["result"]["tools"].as_array().expect("tools array");
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(names.contains(&"bevy_index_status"), "tools: {names:?}");
    assert!(names.contains(&"bevy_indexed_versions"), "tools: {names:?}");
    for name in [
        "bevy_validate_systems",
        "bevy_check_manifest",
        "bevy_perf_advisor",
        "bevy_explain_error",
        "bevy_ecosystem_search",
        "bevy_ecosystem_compat",
        "bevy_generate_plugin",
        "bevy_mcp_check_release_index",
    ] {
        assert!(names.contains(&name), "missing {name}: {names:?}");
    }
}

#[test]
fn index_status_reports_registry_metadata() {
    let dir = fixture();
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let response = server.call_tool("bevy_index_status", json!({}));
    assert_eq!(response["result"]["isError"], false);
    let text = tool_text(&response);
    assert!(text.contains("9.9.9"), "status: {text}");
    assert!(text.contains("42"), "status: {text}");

    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["bevy_version"], "9.9.9");
    assert_eq!(structured["stats"]["total"], 42);
    assert_eq!(structured["symbols"], 7);
    assert_eq!(structured["stats"]["by_kind"]["method"], 40);
    assert_eq!(structured["has_api_index"], true);
    assert_eq!(structured["doc_dir"], "/tmp/bevy-doc");
}

#[test]
fn indexed_versions_marks_the_active_version() {
    let dir = fixture();
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let response = server.call_tool("bevy_indexed_versions", json!({}));
    assert_eq!(response["result"]["isError"], false);
    let text = tool_text(&response);
    assert!(
        text.contains("| 9.9.9 | **yes** | no |"),
        "versions: {text}"
    );
    assert!(text.contains("9.8.0"), "versions: {text}");

    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["active"], "9.9.9");
    let versions = structured["versions"].as_array().expect("versions array");
    assert_eq!(versions.len(), 2);

    let older = versions
        .iter()
        .find(|row| row["version"] == "9.8.0")
        .expect("9.8.0 row");
    assert_eq!(older["compiled"], false);
    assert_eq!(older["relative_to_active"]["level"], "downgrade");
    assert_eq!(older["relative_to_active"]["breaksApi"], true);
}

#[test]
fn cli_help_and_status_work_without_a_transport() {
    let dir = fixture();

    let help = Command::new(BIN)
        .arg("--help")
        .output()
        .expect("run --help");
    assert!(help.status.success());
    let stdout = String::from_utf8_lossy(&help.stdout);
    for verb in [
        "serve",
        "status",
        "fetch-index",
        "fetch-docs",
        "fetch-website",
        "harvest-meta",
        "harvest-compat",
        "build",
        "search",
        "lookup",
    ] {
        assert!(stdout.contains(verb), "--help missing {verb}: {stdout}");
    }

    let status = base_command(dir.path())
        .arg("status")
        .output()
        .expect("run status");
    assert!(status.status.success());
    let stdout = String::from_utf8_lossy(&status.stdout);
    assert!(
        stdout.contains("# bevy-manual-mcp index status"),
        "{stdout}"
    );
    assert!(stdout.contains("9.9.9"), "{stdout}");

    let version = Command::new(BIN)
        .arg("--version")
        .output()
        .expect("run --version");
    assert!(version.status.success());
    assert!(
        String::from_utf8_lossy(&version.stdout).contains(env!("CARGO_PKG_VERSION")),
        "version output: {}",
        String::from_utf8_lossy(&version.stdout)
    );
}

fn build_corpus(dir: &Path) {
    let out = dir.join("versions/9.9.9");
    std::fs::create_dir_all(&out).expect("version dir");
    let mut records = vec![
        json!({
            "source": "rustdoc",
            "kind": "struct",
            "name": "Widget",
            "full_path": "demo::Widget",
            "crate": "demo",
            "module": "demo",
            "signature": "pub struct Widget;",
            "docs": "A widget you can build.",
            "file": "demo/struct.Widget.html",
            "bevy_version": "9.9.9"
        }),
        json!({
            "source": "bevy-examples",
            "kind": "code_example",
            "name": "camera",
            "full_path": "bevy-examples:camera",
            "module": "examples",
            "signature": "",
            "docs": "2D camera example.\n\n```rust\nfn main() { spawn_camera(); }\n```",
            "code": "fn main() { spawn_camera(); }",
            "file": "examples/camera.rs",
            "categories": ["2d", "render"],
            "bevy_version": "9.9.9",
            "title": "camera"
        }),
        json!({
            "source": "website",
            "kind": "migration_guide",
            "name": "Migration guide 9.8 -> 9.9",
            "full_path": "migration_guide:content/learn/migration-guides/9.8-to-9.9.md",
            "module": "content::learn::migration-guides",
            "signature": "",
            "docs": "Widget was renamed to Gadget.",
            "file": "content/learn/migration-guides/9.8-to-9.9.md",
            "bevy_version": "9.9.9",
            "from_version": "9.8",
            "to_version": "9.9",
            "heading": "Widget rename"
        }),
        json!({
            "source": "website",
            "kind": "migration_guide",
            "name": "Event trait split",
            "full_path": "migration_guide:content/learn/migration-guides/0.16-to-0.17.md",
            "module": "content::learn::migration-guides",
            "signature": "",
            "docs": "\"Buffered events\" are now known as messages. `EventWriter`, `EventReader`, and `Events<E>`, are now known as `MessageWriter`, `MessageReader`, and `Messages<M>`.",
            "file": "content/learn/migration-guides/0.16-to-0.17.md",
            "bevy_version": "9.9.9",
            "heading": "`Event` trait split / Rename"
        }),
        json!({
            "source": "rustdoc",
            "kind": "struct",
            "name": "MessageReader",
            "full_path": "demo::MessageReader",
            "crate": "demo",
            "module": "demo",
            "signature": "pub struct MessageReader;",
            "docs": "Reads messages of a type in order.",
            "file": "demo/struct.MessageReader.html",
            "bevy_version": "9.9.9"
        }),
        json!({
            "source": "rustdoc",
            "kind": "method",
            "name": "new",
            "full_path": "demo::Widget::new",
            "owner": "Widget",
            "crate": "demo",
            "module": "demo",
            "signature": "pub fn new() -> Widget",
            "docs": "Creates a widget with the default configuration.",
            "file": "demo/struct.Widget.html",
            "bevy_version": "9.9.9"
        }),
    ];
    for index in 0..55 {
        records.push(serde_json::json!({
            "source": "rustdoc",
            "kind": "struct",
            "name": format!("Grid{index:02}"),
            "full_path": format!("demo::Grid{index:02}"),
            "crate": "demo",
            "module": "demo",
            "signature": format!("pub struct Grid{index:02};"),
            "docs": format!("Grid helper {index}."),
            "file": "demo/grid.html",
            "bevy_version": "9.9.9"
        }));
    }
    let records = records
        .iter()
        .map(|record| serde_json::to_string(record).expect("record json"))
        .collect::<Vec<_>>()
        .join("\n");
    let records_path = out.join("records.ndjson");
    std::fs::write(&records_path, records).expect("records");

    let empty = dir.join("no-sources");
    std::fs::create_dir_all(&empty).expect("empty dir");
    let output = base_command(dir)
        .env("BEVY_WEBSITE_DIR", &empty)
        .env("BEVY_EXAMPLES_DIR", &empty)
        .env("BEVY_META_DIR", &empty)
        .env("BEVY_ERRORS_DIR", &empty)
        .args(["build", "--records"])
        .arg(&records_path)
        .arg("--out")
        .arg(&out)
        .output()
        .expect("run build");
    assert!(
        output.status.success(),
        "build failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn search_and_api_tools_answer_over_stdio() {
    let dir = fixture();
    build_corpus(dir.path());
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let response = server.call_tool("bevy_search", json!({ "query": "widget" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("demo::Widget"), "{text}");
    let results = response["result"]["structuredContent"]["results"]
        .as_array()
        .expect("results");
    assert!(!results.is_empty());

    let response = server.call_tool("bevy_api", json!({ "symbol": "Widget::new" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("pub fn new"), "{text}");
    assert!(
        text.contains("Creates a widget"),
        "documentation missing: {text}"
    );
}

#[test]
fn same_minor_fallback_reports_both_versions() {
    let dir = fixture();
    build_corpus(dir.path());
    let mut server = Server::spawn_with_env(dir.path(), &[("BEVY_VERSION", "9.9.8")]);
    server.initialize();

    let response = server.call_tool("bevy_index_status", json!({}));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["project_version"], "9.9.8", "{response}");
    assert_eq!(structured["corpus_version"], "9.9.9", "{response}");
    assert_eq!(structured["version_fallback"], true, "{response}");

    let response = server.call_tool("bevy_search", json!({ "query": "widget" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["requested_version"], "9.9.8");
    assert_eq!(structured["queried_version"], "9.9.9");
    assert_eq!(structured["project_version"], "9.9.8");
    assert_eq!(structured["corpus_version"], "9.9.9");
    assert_eq!(structured["version_fallback"], true);

    let response = server.request(
        "resources/read",
        json!({ "uri": "bevy://api/9.9.8/demo::Widget" }),
    );
    let text = response["result"]["contents"][0]["text"]
        .as_str()
        .expect("api text");
    assert!(text.contains("Bevy 9.9.9"), "{text}");
}

#[test]
fn missing_symbol_returns_suggestions_over_stdio() {
    let dir = fixture();
    build_corpus(dir.path());
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let response = server.call_tool("bevy_api", json!({ "symbol": "EventReader" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("No API symbol matched"), "{text}");
    assert!(text.contains("MessageReader"), "{text}");

    let suggestions = response["result"]["structuredContent"]["suggestions"]
        .as_array()
        .expect("suggestions");
    assert!(
        suggestions
            .iter()
            .any(|row| row["full_path"] == "demo::MessageReader"),
        "{suggestions:?}"
    );
}

fn build_old_corpus(dir: &Path) {
    let out = dir.join("versions/9.8.0");
    std::fs::create_dir_all(&out).expect("version dir");
    let records = serde_json::json!({
        "source": "rustdoc",
        "kind": "struct",
        "name": "Widget",
        "full_path": "demo::Widget",
        "crate": "demo",
        "module": "demo",
        "signature": "pub struct WidgetV1;",
        "docs": "The old widget.",
        "file": "demo/struct.Widget.html",
        "bevy_version": "9.8.0"
    })
    .to_string();
    let records_path = out.join("records.ndjson");
    std::fs::write(&records_path, records).expect("records");

    let empty = dir.join("no-sources");
    std::fs::create_dir_all(&empty).expect("empty dir");
    let output = base_command(dir)
        .env("BEVY_VERSION", "9.8.0")
        .env("BEVY_WEBSITE_DIR", &empty)
        .env("BEVY_EXAMPLES_DIR", &empty)
        .env("BEVY_META_DIR", &empty)
        .env("BEVY_ERRORS_DIR", &empty)
        .args(["build", "--records"])
        .arg(&records_path)
        .arg("--out")
        .arg(&out)
        .output()
        .expect("run build");
    assert!(
        output.status.success(),
        "build failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn examples_and_migration_tools_answer() {
    let dir = fixture();
    build_corpus(dir.path());
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let response = server.call_tool("bevy_examples", json!({ "task": "camera" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("2D camera example"), "{text}");
    assert!(text.contains("spawn_camera"), "{text}");
    let results = response["result"]["structuredContent"]["results"]
        .as_array()
        .expect("results");
    assert!(!results.is_empty());

    let response = server.call_tool(
        "bevy_migration",
        json!({ "from_version": "9.8", "to_version": "9.9" }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("Widget was renamed"), "{text}");
}

#[test]
fn api_diff_compares_installed_versions() {
    let dir = fixture();
    build_corpus(dir.path());
    build_old_corpus(dir.path());
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let response = server.call_tool(
        "bevy_api_diff",
        json!({ "symbol": "Widget", "versions": "9.8.0,9.9.9" }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("9.8.0"), "{text}");
    assert!(text.contains("changed"), "{text}");
    let versions = response["result"]["structuredContent"]["versions"]
        .as_array()
        .expect("versions");
    assert_eq!(versions.len(), 2);
}

#[test]
fn check_version_reads_the_crates_response() {
    let dir = fixture();
    let api = dir.path().join("crates.json");
    std::fs::write(
        &api,
        r#"{"crate":{"max_stable_version":"9.10.0","max_version":"9.11.0-rc.1"}}"#,
    )
    .expect("crates json");
    let mut server = Server::spawn_with_env(
        dir.path(),
        &[
            ("BEVY_MCP_CRATES_API", api.to_str().expect("path")),
            ("BEVY_MCP_OFFLINE", "0"),
        ],
    );
    server.initialize();

    let response = server.call_tool("bevy_check_version", json!({}));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("9.10.0"), "{text}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["newest_stable"], "9.10.0");
    assert_eq!(structured["preview"], "9.11.0-rc.1");
}

#[test]
fn cargo_registry_examples_are_auto_detected() {
    let dir = fixture();
    // build_corpus writes records.ndjson and an initial archive.
    build_corpus(dir.path());

    let cargo_home = dir.path().join("cargo-home");
    let examples = cargo_home.join("registry/src/index/bevy-9.9.9/examples/ecs");
    std::fs::create_dir_all(&examples).expect("fake registry");
    std::fs::write(
        examples.join("events.rs"),
        "//! An event example from the engine.\nfn main() {}\n",
    )
    .expect("example");

    let out = dir.path().join("versions/9.9.9");
    let empty = dir.path().join("no-sources");
    std::fs::create_dir_all(&empty).expect("empty");
    let output = base_command(dir.path())
        .env_remove("BEVY_EXAMPLES_DIR")
        .env("CARGO_HOME", &cargo_home)
        .env("BEVY_WEBSITE_DIR", &empty)
        .env("BEVY_META_DIR", &empty)
        .env("BEVY_ERRORS_DIR", &empty)
        .args(["build", "--records"])
        .arg(out.join("records.ndjson"))
        .arg("--out")
        .arg(&out)
        .output()
        .expect("run build");
    assert!(
        output.status.success(),
        "build failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("examples=1"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let mut server = Server::spawn(dir.path());
    server.initialize();
    let response = server.call_tool("bevy_examples", json!({ "task": "event" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("An event example from the engine"), "{text}");
}

#[test]
fn resources_templates_and_completions_work() {
    let dir = fixture();
    build_corpus(dir.path());
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let list = server.request("resources/list", json!({}));
    let resources = list["result"]["resources"].as_array().expect("resources");
    assert!(
        resources
            .iter()
            .any(|resource| resource["uri"] == "bevy://index/versions"),
        "{list}"
    );

    let templates = server.request("resources/templates/list", json!({}));
    let templates = templates["result"]["resourceTemplates"]
        .as_array()
        .expect("templates");
    assert_eq!(templates.len(), 6, "{templates:?}");

    let index = server.request("resources/read", json!({ "uri": "bevy://index/versions" }));
    let text = index["result"]["contents"][0]["text"]
        .as_str()
        .expect("index text");
    assert!(text.contains("9.9.9"), "{text}");

    let api = server.request(
        "resources/read",
        json!({ "uri": "bevy://api/9.9.9/demo::Widget" }),
    );
    let text = api["result"]["contents"][0]["text"]
        .as_str()
        .expect("api text");
    assert!(text.contains("A widget"), "{text}");

    let owner = server.request(
        "resources/read",
        json!({ "uri": "bevy://owner/9.9.9/Widget" }),
    );
    let text = owner["result"]["contents"][0]["text"]
        .as_str()
        .expect("owner text");
    assert!(text.contains("new"), "{text}");

    // 57 structs -> first page of 50 carries a continuation URI.
    let first = server.request(
        "resources/read",
        json!({ "uri": "bevy://kind/9.9.9/struct" }),
    );
    let content = &first["result"]["contents"][0];
    let text = content["text"].as_str().expect("listing text");
    assert!(text.contains("Paged"), "{text}");
    let next_uri = content["uri"].as_str().expect("next uri");
    assert!(next_uri.contains("cursor="), "{next_uri}");

    let second = server.request("resources/read", json!({ "uri": next_uri }));
    let text = second["result"]["contents"][0]["text"]
        .as_str()
        .expect("second page");
    assert!(text.contains("showing 7"), "{text}");
    assert!(
        second["result"]["_meta"].get("nextCursor").is_none(),
        "second page should be the last: {}",
        second["result"]["_meta"]
    );

    let completion = server.request(
        "completion/complete",
        json!({
            "ref": { "type": "ref/resource", "uri": "bevy://kind/{version}/{kind}" },
            "argument": { "name": "version", "value": "9" }
        }),
    );
    let values = completion["result"]["completion"]["values"]
        .as_array()
        .expect("completion values");
    assert!(values.iter().any(|value| value == "9.9.9"), "{completion}");
}

fn write_feature_graph(meta: &Path) {
    let dir = meta.join("9.9.9");
    std::fs::create_dir_all(&dir).expect("meta dir");
    std::fs::write(
        dir.join("features.json"),
        serde_json::to_string_pretty(&json!({
            "bevy_version": "9.9.9",
            "features": {
                "bevy_ui": ["bevy_ui"],
                "bevy_render": ["bevy_render"],
                "default": ["bevy_render"]
            },
            "closure": {
                "bevy_ui": ["bevy_ui"],
                "bevy_render": ["bevy_render"],
                "default": ["bevy_render"]
            },
            "default_features": ["bevy_render"],
            "plugin_gates": [
                { "plugin": "UiPlugin", "requires_feature": "bevy_ui" }
            ]
        }))
        .expect("features json"),
    )
    .expect("write features");
}

/// A Cargo.toml without `src/` cannot resolve with `cargo metadata`, which is
/// exactly the fallback path the tool must handle.
fn write_project(root: &Path) -> std::path::PathBuf {
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project dir");
    std::fs::write(
        project.join("Cargo.toml"),
        r#"
[package]
name = "fixture-game"
version = "0.1.0"
edition = "2021"

[dependencies]
bevy = { version = "9.9.9", default-features = false, features = ["bevy_ui"] }
"#,
    )
    .expect("write manifest");
    project
}

/// A path dependency named `bevy` gives `cargo metadata` something it can
/// resolve offline, so the authoritative path is exercised, not the fallback.
fn write_resolvable_project(root: &Path) -> std::path::PathBuf {
    let fake = root.join("fake-bevy");
    std::fs::create_dir_all(fake.join("src")).expect("fake bevy src");
    std::fs::write(
        fake.join("Cargo.toml"),
        r#"
[package]
name = "bevy"
version = "9.9.9"
edition = "2021"

[features]
default = ["bevy_render"]
bevy_render = []
bevy_ui = []
"#,
    )
    .expect("write fake bevy manifest");
    std::fs::write(fake.join("src/lib.rs"), "").expect("write fake bevy lib");

    let project = root.join("resolvable-project");
    std::fs::create_dir_all(project.join("src")).expect("project src");
    std::fs::write(
        project.join("Cargo.toml"),
        r#"
[package]
name = "fixture-game"
version = "0.1.0"
edition = "2021"

[dependencies]
b = { package = "bevy", path = "../fake-bevy", default-features = false, features = ["bevy_ui"] }
"#,
    )
    .expect("write resolvable manifest");
    std::fs::write(project.join("src/main.rs"), "fn main() {}\n").expect("write main.rs");

    let status = Command::new("cargo")
        .args(["generate-lockfile", "--offline"])
        .current_dir(&project)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run cargo generate-lockfile");
    assert!(status.success(), "cargo generate-lockfile failed");
    project
}

#[test]
fn check_manifest_falls_back_to_the_manifest_and_reports_gates() {
    let dir = fixture();
    let project = write_project(dir.path());
    let meta = dir.path().join("meta");
    write_feature_graph(&meta);
    let mut server = Server::spawn_with_env(
        dir.path(),
        &[
            ("BEVY_META_DIR", meta.to_str().expect("meta path")),
            ("BEVY_PROJECT_ROOT", project.to_str().expect("project path")),
        ],
    );
    server.initialize();

    let response = server.call_tool("bevy_check_manifest", json!({}));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("Feature Report"), "{text}");
    assert!(text.contains("bevy_ui"), "{text}");
    assert!(text.contains("UiPlugin"), "{text}");

    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["bevy_version"], "9.9.9");
    assert_eq!(structured["source"], "Cargo.toml");
    assert_eq!(structured["no_manifest"], false);
    assert_eq!(structured["default_features_enabled"], false);
    assert_eq!(structured["explicit"], json!(["bevy_ui"]));
    let transitive = structured["transitive"].as_array().expect("transitive");
    assert!(transitive.contains(&json!("bevy_ui")), "{transitive:?}");
    assert!(
        !transitive.contains(&json!("bevy_render")),
        "{transitive:?}"
    );
    let disabled = structured["disabled"].as_array().expect("disabled");
    assert!(disabled.contains(&json!("bevy_render")), "{disabled:?}");

    let response = server.call_tool(
        "bevy_check_manifest",
        json!({ "check": "bevy::render::Mesh" }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["available"], false);
    assert_eq!(structured["gating_feature"], "bevy_render");

    let response = server.call_tool("bevy_check_manifest", json!({ "check": "UiPlugin" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(response["result"]["structuredContent"]["available"], true);
}

#[test]
fn check_manifest_prefers_cargo_metadata_when_the_project_resolves() {
    let dir = fixture();
    let project = write_resolvable_project(dir.path());
    let meta = dir.path().join("meta");
    write_feature_graph(&meta);
    let mut server = Server::spawn_with_env(
        dir.path(),
        &[
            ("BEVY_META_DIR", meta.to_str().expect("meta path")),
            ("BEVY_PROJECT_ROOT", project.to_str().expect("project path")),
        ],
    );
    server.initialize();

    let response = server.call_tool("bevy_check_manifest", json!({}));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["source"], "cargo metadata");
    assert_eq!(structured["no_manifest"], false);
    assert_eq!(structured["explicit"], json!(["bevy_ui"]));
    assert_eq!(structured["default_features_enabled"], false);
    let transitive = structured["transitive"].as_array().expect("transitive");
    assert!(transitive.contains(&json!("bevy_ui")), "{transitive:?}");
    assert!(
        !transitive.contains(&json!("bevy_render")),
        "{transitive:?}"
    );
    assert!(!transitive.contains(&json!("default")), "{transitive:?}");

    let response = server.call_tool("bevy_check_manifest", json!({ "check": "UiPlugin" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(response["result"]["structuredContent"]["available"], true);
    assert_eq!(
        response["result"]["structuredContent"]["source"],
        "cargo metadata"
    );
}

#[test]
fn check_manifest_reports_a_missing_manifest() {
    let dir = fixture();
    let meta = dir.path().join("meta");
    write_feature_graph(&meta);
    let empty = dir.path().join("empty-project");
    std::fs::create_dir_all(&empty).expect("empty project");
    let mut server = Server::spawn_with_env(
        dir.path(),
        &[
            ("BEVY_META_DIR", meta.to_str().expect("meta path")),
            ("BEVY_PROJECT_ROOT", empty.to_str().expect("empty path")),
        ],
    );
    server.initialize();

    let response = server.call_tool("bevy_check_manifest", json!({}));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["no_manifest"], true);
    assert_eq!(structured["source"], "none");
    assert_eq!(structured["explicit"], json!([]));
    assert_eq!(
        structured["disabled"].as_array().expect("disabled").len(),
        3
    );
}

#[test]
fn validate_systems_checks_tuple_accesses_and_ignores_phantoms() {
    let dir = fixture();
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let code = r#"
        fn bad(left: Query<&mut Transform>, right: Query<&Transform>) {}

        fn good(
            left: Query<(&mut Transform, &Velocity), With<Local>>,
            right: Query<&Transform, Without<Local>>,
        ) {}

        // fn ghost(q: Query<&A>, r: Query<&mut A>) {}
        const NOTE: &str = "fn phantom(q: Query<&mut B>) {}";
    "#;
    let response = server.call_tool("bevy_validate_systems", json!({ "code": code }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("Transform"), "{text}");
    assert!(text.contains("does not type-check"), "{text}");

    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["systems_checked"], 2);
    assert_eq!(structured["findings_count"], 1);
    assert_eq!(structured["analysis_complete"], true);
    assert_eq!(structured["type_checked"], false);
    let findings = structured["findings"].as_array().expect("findings");
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0]["rule"], "R1");
    assert_eq!(findings[0]["error_code"], "B0001");
    assert_eq!(findings[0]["system"], "bad");

    let response = server.call_tool(
        "bevy_validate_systems",
        json!({ "code": "fn custom(p: MyCustomParam) {}" }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["analysis_complete"], false);
    assert_eq!(structured["unanalyzed"], json!(["MyCustomParam"]));
}

#[test]
fn validate_systems_rejects_unparsable_code() {
    let dir = fixture();
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let response = server.call_tool(
        "bevy_validate_systems",
        json!({ "code": "fn broken(q: Query<&mut A> {" }),
    );
    assert_eq!(response["result"]["isError"], true, "{response}");
    assert!(
        tool_text(&response).contains("Could not parse"),
        "{}",
        tool_text(&response)
    );
}

#[test]
fn perf_advisor_reports_builtin_topics_and_anti_patterns() {
    let dir = fixture();
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let response = server.call_tool(
        "bevy_perf_advisor",
        json!({
            "topic": "change-detection",
            "code": "if q.get(entity).is_changed() { }"
        }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("Changed<T>"), "{text}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["source"], "builtin");
    assert_eq!(structured["found"], true);
    let anti_patterns = structured["anti_patterns"]
        .as_array()
        .expect("anti patterns");
    assert!(
        anti_patterns
            .iter()
            .any(|finding| finding["pattern"] == "is_changed()"),
        "{anti_patterns:?}"
    );

    let response = server.call_tool("bevy_perf_advisor", json!({}));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["source"], "builtin");
    let topics = structured["topics"].as_array().expect("topics");
    let names: Vec<&str> = topics
        .iter()
        .filter_map(|topic| topic["topic"].as_str())
        .collect();
    assert_eq!(names, vec!["change-detection", "archetypes", "scheduling"]);
}

fn write_compat_fixture(root: &Path) -> std::path::PathBuf {
    let dir = root.join("ecosystem");
    std::fs::create_dir_all(&dir).expect("ecosystem dir");
    let path = dir.join("compat.json");
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&json!({
            "meta": {
                "harvested_at": "2026-01-02T00:00:00Z",
                "source": "fixture",
                "version_count": 4,
                "plugin_count": 2,
                "complete": true
            },
            "plugins": {
                "bevy_egui": [
                    { "plugin": "bevy_egui", "plugin_version": "0.43.1", "requires_bevy": "^0.20.0" },
                    { "plugin": "bevy_egui", "plugin_version": "0.42.0", "requires_bevy": "^0.19" },
                    { "plugin": "bevy_egui", "plugin_version": "0.0.1", "requires_bevy": "^0.0.3" }
                ],
                "edge_plugin": [
                    { "plugin": "edge_plugin", "plugin_version": "1.0.0", "requires_bevy": ">=0.20.0" }
                ]
            }
        }))
        .expect("compat json"),
    )
    .expect("write compat");
    path
}

fn write_error_codes(meta: &Path) {
    let dir = meta.join("9.9.9/error-codes");
    std::fs::create_dir_all(&dir).expect("error codes dir");
    std::fs::write(
        dir.join("B0001.md"),
        "# B0001\n\nBevy cannot prove these queries are disjoint.\n\n```rust\nfn bad(a: Query<&mut Transform>, b: Query<&Transform>) {}\n```\n\n## Fix\n\nUse `Without<T>` to prove the queries are disjoint, or combine them in a `ParamSet<(…)>`.\n",
    )
    .expect("B0001");
    std::fs::write(
        dir.join("B0002.md"),
        "# B0002\n\nResMut and Res conflict.\n\n## Fix\n\nUse a `ParamSet` or defer one access.\n",
    )
    .expect("B0002");
}

fn build_plugin_corpus(dir: &Path) {
    let out = dir.join("corpora/bevy_egui/0.43.1");
    std::fs::create_dir_all(&out).expect("plugin corpus dir");
    let records = [
        json!({
            "source": "rustdoc",
            "kind": "struct",
            "name": "EguiContexts",
            "full_path": "bevy_egui::EguiContexts",
            "module": "bevy_egui",
            "signature": "pub struct EguiContexts<'w, 's> { .. }",
            "docs": "The main access point for egui contexts in Bevy systems.",
            "file": "struct.EguiContexts.html",
            "crate": "bevy_egui",
            "bevy_version": "9.9.9"
        }),
        json!({
            "source": "rustdoc",
            "kind": "struct",
            "name": "Button",
            "full_path": "bevy_egui::Button",
            "module": "bevy_egui",
            "signature": "pub struct Button { .. }",
            "docs": "An egui button widget newtype.",
            "file": "struct.Button.html",
            "crate": "bevy_egui",
            "bevy_version": "9.9.9"
        }),
    ]
    .iter()
    .map(|record| record.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    let records_path = dir.join("plugin-records.ndjson");
    std::fs::write(&records_path, records).expect("plugin records");

    let empty = dir.join("no-sources");
    std::fs::create_dir_all(&empty).expect("empty dir");
    let output = base_command(dir)
        .env("BEVY_WEBSITE_DIR", &empty)
        .env("BEVY_EXAMPLES_DIR", &empty)
        .env("BEVY_META_DIR", &empty)
        .env("BEVY_ERRORS_DIR", &empty)
        .args(["build", "--records"])
        .arg(&records_path)
        .arg("--out")
        .arg(&out)
        .output()
        .expect("run plugin build");
    assert!(
        output.status.success(),
        "plugin build failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn ecosystem_search_fans_out_and_labels_corpora() {
    let dir = fixture();
    build_corpus(dir.path());
    build_plugin_corpus(dir.path());
    std::fs::write(
        dir.path().join("bevy-mcp.config.json"),
        serde_json::to_string(&json!({
            "corpora": [{ "crate": "bevy_egui", "version": "0.43.1" }]
        }))
        .expect("config json"),
    )
    .expect("write config");

    let mut server = Server::spawn(dir.path());
    server.initialize();

    let response = server.call_tool("bevy_ecosystem_search", json!({ "query": "Button" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("bevy_egui@0.43.1"), "{text}");
    assert!(text.contains("Button"), "{text}");
    let structured = &response["result"]["structuredContent"];
    let searched = structured["corpora_searched"]
        .as_array()
        .expect("corpora searched");
    assert!(searched.contains(&json!("bevy@9.9.9")), "{searched:?}");
    assert!(
        searched.contains(&json!("bevy_egui@0.43.1")),
        "{searched:?}"
    );
    assert!(
        structured["total_hits"].as_u64().expect("total hits") >= 1,
        "{structured}"
    );

    let response = server.call_tool(
        "bevy_ecosystem_search",
        json!({ "query": "Button", "crate": "bevy_egui" }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["corpora_searched"],
        json!(["bevy_egui@0.43.1"])
    );

    let response = server.call_tool(
        "bevy_ecosystem_search",
        json!({ "query": "zzzznomatchzzz" }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert!(
        tool_text(&response).contains("No matching symbols"),
        "{}",
        tool_text(&response)
    );
    assert_eq!(
        response["result"]["structuredContent"]["total_hits"],
        json!(0)
    );
}

#[test]
fn ecosystem_compat_reports_candidates_provenance_and_unknowns() {
    let dir = fixture();
    let compat = write_compat_fixture(dir.path());
    let compat = compat.to_str().expect("compat path");

    let mut server = Server::spawn_with_env(
        dir.path(),
        &[("BEVY_VERSION", "0.20.0"), ("BEVY_MCP_COMPAT_PATH", compat)],
    );
    server.initialize();

    let response = server.call_tool("bevy_ecosystem_compat", json!({ "crate": "bevy_egui" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    let text = tool_text(&response);
    assert!(text.contains("compatible"), "{text}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["compatible"], true);
    assert_eq!(structured["matching_versions"], json!(["0.43.1"]));
    assert_eq!(structured["provenance"]["version_count"], 4);
    assert_eq!(
        structured["provenance"]["harvested_at"],
        "2026-01-02T00:00:00Z"
    );

    let response = server.call_tool("bevy_ecosystem_compat", json!({}));
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["plugins"]
            .as_array()
            .expect("plugins")
            .len(),
        2
    );

    let response = server.call_tool(
        "bevy_ecosystem_compat",
        json!({ "crate": "missing_plugin" }),
    );
    assert_eq!(response["result"]["isError"], true, "{response}");
    assert!(
        tool_text(&response).contains("No compat data"),
        "{response}"
    );

    let mut server = Server::spawn_with_env(
        dir.path(),
        &[("BEVY_VERSION", "0.1.0"), ("BEVY_MCP_COMPAT_PATH", compat)],
    );
    server.initialize();
    let response = server.call_tool("bevy_ecosystem_compat", json!({ "crate": "bevy_egui" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(response["result"]["structuredContent"]["compatible"], false);
    assert!(
        tool_text(&response).contains("^0.20.0"),
        "{}",
        tool_text(&response)
    );

    let mut server = Server::spawn_with_env(
        dir.path(),
        &[("BEVY_VERSION", "0.21.0"), ("BEVY_MCP_COMPAT_PATH", compat)],
    );
    server.initialize();
    let response = server.call_tool("bevy_ecosystem_compat", json!({ "crate": "edge_plugin" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["compatible"],
        "unknown"
    );
}

#[test]
fn ecosystem_compat_without_a_pinned_version_is_unknown() {
    let dir = fixture();
    let compat = write_compat_fixture(dir.path());
    let mut server = Server::spawn_with_env(
        dir.path(),
        &[
            ("BEVY_VERSION", ""),
            (
                "BEVY_MCP_COMPAT_PATH",
                compat.to_str().expect("compat path"),
            ),
        ],
    );
    server.initialize();

    let response = server.call_tool("bevy_ecosystem_compat", json!({ "crate": "bevy_egui" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["compatible"],
        "unknown"
    );
}

#[test]
fn generate_plugin_templates_are_self_contained_and_validated() {
    let dir = fixture();
    let mut server = Server::spawn(dir.path());
    server.initialize();

    let response = server.call_tool(
        "bevy_generate_plugin",
        json!({ "template": "does-not-exist" }),
    );
    assert_eq!(response["result"]["isError"], true, "{response}");
    assert!(
        tool_text(&response).contains("Unknown template"),
        "{response}"
    );

    let response = server.call_tool(
        "bevy_generate_plugin",
        json!({ "template": "plugin-with-systemset" }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    let code = structured["code"].as_str().expect("code");
    assert!(!code.contains("OtherSystem"), "{code}");
    assert!(code.contains("#[derive("), "{code}");
    assert!(code.contains("SystemSet"), "{code}");
    assert_eq!(structured["compile_verified"], false);

    let response = server.call_tool(
        "bevy_generate_plugin",
        json!({
            "template": "plugin-skeleton",
            "params": { "PLUGIN_NAME": "FooPlugin", "NOT_A_SLOT": "x", "a(": "x" }
        }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    let code = structured["code"].as_str().expect("code");
    assert!(code.contains("pub struct FooPlugin;"), "{code}");
    let ignored = structured["ignored_params"].as_array().expect("ignored");
    assert!(ignored.contains(&json!("NOT_A_SLOT")), "{ignored:?}");
    assert!(ignored.contains(&json!("a(")), "{ignored:?}");
    assert_eq!(structured["compile_verified"], false);
}

#[test]
fn explain_error_is_version_checked_and_refuses_uncoded_panics() {
    let dir = fixture();
    let meta = dir.path().join("meta");
    write_error_codes(&meta);
    let mut server = Server::spawn_with_env(
        dir.path(),
        &[("BEVY_META_DIR", meta.to_str().expect("meta path"))],
    );
    server.initialize();

    let response = server.call_tool(
        "bevy_explain_error",
        json!({
            "message": "error[B0002]: ResMut<Assets<StandardMaterial>> conflicts with Res<Assets<StandardMaterial>>"
        }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["code"], "B0002");
    assert_eq!(structured["severity"], "panic");
    assert_eq!(structured["resource_type"], "Assets<StandardMaterial>");
    assert_eq!(structured["version_indexed"], true);
    assert_eq!(structured["does_not_exist_in_version"], false);

    let response = server.call_tool(
        "bevy_explain_error",
        json!({ "message": "error[B0007]: something" }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["does_not_exist_in_version"],
        true
    );

    let short = server.call_tool(
        "bevy_explain_error",
        json!({ "message": "error[B0001]: x" }),
    );
    let full = server.call_tool(
        "bevy_explain_error",
        json!({ "message": "error[B0001]: x", "full": true }),
    );
    assert!(
        tool_text(&short).contains("Without"),
        "{}",
        tool_text(&short)
    );
    assert!(
        tool_text(&full).len() > tool_text(&short).len(),
        "full should include more of the guide"
    );

    let response = server.call_tool(
        "bevy_explain_error",
        json!({ "message": "thread 'main' panicked at 'something unknown happened'" }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["tier"], 3);
    assert_eq!(structured["no_error_code_found"], true);
}

fn wait_for_index(server: &mut Server) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let response = server.call_tool("bevy_index_status", json!({}));
        if response["result"]["structuredContent"]["corpus"].is_object() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "background fetch did not become available: {response}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn clean_install_fetches_in_the_background_and_serves_metadata() {
    let dir = fixture();
    build_corpus(dir.path());
    let out = dir.path().join("versions/9.9.9");
    let metadata = out.join("metadata");
    std::fs::create_dir_all(metadata.join("error-codes")).expect("metadata dir");
    std::fs::write(
        metadata.join("features.json"),
        serde_json::to_string(&json!({
            "bevy_version": "9.9.9",
            "features": { "bevy_ui": ["bevy_ui"], "default": ["bevy_ui"] },
            "closure": { "bevy_ui": ["bevy_ui"], "default": ["bevy_ui"] },
            "default_features": ["bevy_ui"],
            "plugin_gates": [{ "plugin": "UiPlugin", "requires_feature": "bevy_ui" }]
        }))
        .expect("features json"),
    )
    .expect("write features");
    std::fs::write(
        metadata.join("compat.json"),
        serde_json::to_string(&json!({
            "meta": { "harvested_at": "2026-01-02T00:00:00Z", "source": "fixture", "version_count": 1, "plugin_count": 1, "complete": true },
            "plugins": {
                "bevy_egui": [
                    { "plugin": "bevy_egui", "plugin_version": "0.43.1", "requires_bevy": "^9.9.0" }
                ]
            }
        }))
        .expect("compat json"),
    )
    .expect("write compat");
    std::fs::write(
        metadata.join("error-codes/B0001.md"),
        "# B0001\n\n## Fix\n\nUse `Without<T>`.\n",
    )
    .expect("write error code");

    let release = dir.path().join("releases/v9.9.9");
    std::fs::create_dir_all(&release).expect("release dir");
    let asset = release.join("bevy-9.9.9-fmt1.tar.zst");
    let manifest = release.join("index-manifest.json");
    let empty = dir.path().join("no-sources");
    std::fs::create_dir_all(&empty).expect("empty dir");
    let records = out.join("records.ndjson");
    let output = base_command(dir.path())
        .env("BEVY_WEBSITE_DIR", &empty)
        .env("BEVY_EXAMPLES_DIR", &empty)
        .env("BEVY_META_DIR", &empty)
        .env("BEVY_ERRORS_DIR", &empty)
        .args(["build", "--records"])
        .arg(&records)
        .arg("--out")
        .arg(&out)
        .arg("--pack")
        .arg(&asset)
        .arg("--manifest")
        .arg(&manifest)
        .output()
        .expect("repack the fixture");
    assert!(
        output.status.success(),
        "repack failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let fresh = dir.path().join("fresh-data");
    let project = dir.path().join("auto-project");
    std::fs::create_dir_all(&project).expect("project dir");
    std::fs::write(
        project.join("Cargo.toml"),
        "[package]\nname = \"auto-project\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nbevy = { version = \"9.9.9\", default-features = false, features = [\"bevy_ui\"] }\n",
    )
    .expect("project manifest");
    let empty_meta = dir.path().join("empty-meta");
    std::fs::create_dir_all(&empty_meta).expect("empty meta");

    let mut server = Server::spawn_with_env(
        dir.path(),
        &[
            ("BEVY_MCP_DATA_DIR", fresh.to_str().expect("fresh path")),
            (
                "BEVY_MCP_INDEX_BASE_URL",
                release
                    .parent()
                    .expect("release parent")
                    .to_str()
                    .expect("release path"),
            ),
            ("BEVY_MCP_OFFLINE", "0"),
            ("BEVY_META_DIR", empty_meta.to_str().expect("meta path")),
            ("BEVY_PROJECT_ROOT", project.to_str().expect("project path")),
        ],
    );
    server.initialize();
    wait_for_index(&mut server);

    assert!(
        fresh.join("versions/9.9.9/corpus.rkyv").is_file(),
        "background fetch did not install the corpus"
    );
    assert!(
        fresh
            .join("versions/9.9.9/metadata/features.json")
            .is_file(),
        "background fetch did not install the metadata"
    );

    let response = server.call_tool("bevy_search", json!({ "query": "Widget" }));
    assert_eq!(response["result"]["isError"], false, "{response}");

    let response = server.call_tool("bevy_check_manifest", json!({ "check": "bevy_ui" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["available"], true,
        "{response}"
    );

    let response = server.call_tool(
        "bevy_explain_error",
        json!({ "message": "error[B0001]: Query<&mut Transform>" }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["guide_available"], true,
        "{response}"
    );

    let response = server.call_tool("bevy_ecosystem_compat", json!({ "crate": "bevy_egui" }));
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["compatible"], true,
        "{response}"
    );

    let response = server.call_tool(
        "bevy_mcp_check_release_index",
        json!({ "check_latest": false }),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["network_checked"], true, "{response}");
    assert_eq!(structured["update_available"], false, "{response}");
    assert_eq!(structured["installed"]["version"], "9.9.9", "{response}");
    assert_eq!(structured["installed"]["revision"], 1, "{response}");
    assert_eq!(structured["available"]["revision"], 1, "{response}");
}
