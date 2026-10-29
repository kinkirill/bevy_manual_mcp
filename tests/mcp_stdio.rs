//! Black-box tests: spawn the real binary and speak MCP over stdio.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_bevy-mcp");
const TIMEOUT: Duration = Duration::from_secs(20);
const CLEAR_ENV: [&str; 12] = [
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
        let mut child = command.spawn().expect("spawn bevy-mcp");
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
                "clientInfo": { "name": "bevy-mcp-rust-tests", "version": "0.0.0" }
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

    assert_eq!(result["serverInfo"]["name"], "bevy-mcp");
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
    assert!(text.contains("| 9.9.9 | **yes** |"), "versions: {text}");
    assert!(text.contains("9.8.0"), "versions: {text}");

    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["active"], "9.9.9");
    let versions = structured["versions"].as_array().expect("versions array");
    assert_eq!(versions.len(), 2);

    let older = versions
        .iter()
        .find(|row| row["version"] == "9.8.0")
        .expect("9.8.0 row");
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
    assert!(stdout.contains("# bevy-mcp index status"), "{stdout}");
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
