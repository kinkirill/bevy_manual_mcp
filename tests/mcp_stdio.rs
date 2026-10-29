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
        let mut command = base_command(dir);
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

    fn call_tool(&mut self, name: &str) -> Value {
        self.request("tools/call", json!({ "name": name, "arguments": {} }))
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

    let response = server.call_tool("bevy_index_status");
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

    let response = server.call_tool("bevy_indexed_versions");
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
