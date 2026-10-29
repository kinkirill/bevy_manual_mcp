//! Mirror docs.rs rustdoc HTML for local rebuilds.
//!
//! Port of `scripts/fetch-docs.mts`: discover pages from `all.html`, cache the
//! list, resume missing pages, and fetch with a shared throttle. The crate
//! facade is the only crate mirrored; the re-exported crates link back to their
//! own docs pages, which is what the TypeScript line did.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use serde_json::{Value, json};

use super::http::Fetcher;

const CRATE: &str = "bevy";

fn pages_from_all_html(html: &str) -> Vec<String> {
    let regex = Regex::new(r##"href="([^"#?]+\.html)""##).expect("href regex");
    let mut pages = BTreeSet::new();
    for captures in regex.captures_iter(html) {
        let Some(href) = captures.get(1) else {
            continue;
        };
        let href = href.as_str();
        if href.starts_with("http")
            || href.starts_with('/')
            || href.starts_with("..")
            || href == "all.html"
            || href == "index.html"
        {
            continue;
        }
        pages.insert(href.to_string());
    }
    pages.into_iter().collect()
}

fn read_manifest(out: &Path, version: &str) -> Result<()> {
    let path = out.join(".bevy-mcp-docversion.json");
    if !path.is_file() {
        return Ok(());
    }
    let text =
        fs::read_to_string(&path).with_context(|| format!("cannot read {}", path.display()))?;
    let manifest: Value =
        serde_json::from_str(&text).with_context(|| format!("invalid {}", path.display()))?;
    match manifest["version"].as_str() {
        Some(existing) if existing == version => Ok(()),
        _ => bail!(
            "The mirror at {} belongs to a different or unknown Bevy version. Choose a fresh --out directory.",
            out.display()
        ),
    }
}

fn write_manifest(out: &Path, version: &str, total_pages: Option<usize>) -> Result<()> {
    fs::create_dir_all(out).with_context(|| format!("cannot create {}", out.display()))?;
    let path = out.join(".bevy-mcp-docversion.json");
    let manifest = json!({
        "crate": CRATE,
        "version": version,
        "source": "docs.rs",
        "docs_rs_url": format!("https://docs.rs/{CRATE}/{version}/{CRATE}/"),
        "fetched_at": chrono::Utc::now().to_rfc3339(),
        "total_pages": total_pages,
    });
    fs::write(&path, serde_json::to_string_pretty(&manifest)? + "\n")
        .with_context(|| format!("cannot write {}", path.display()))
}

fn load_page_list(out: &Path, version: &str) -> Option<Vec<String>> {
    let path = out.join(format!("pages-{version}.json"));
    let text = fs::read_to_string(path).ok()?;
    let pages: Vec<String> = serde_json::from_str(&text).ok()?;
    (!pages.is_empty()).then_some(pages)
}

fn save_page_list(out: &Path, version: &str, pages: &[String]) {
    let path = out.join(format!("pages-{version}.json"));
    if let Ok(text) = serde_json::to_string(pages) {
        let _ = fs::write(path, text);
    }
}

/// Mirror rustdoc for `version` into `out`.
pub fn fetch_docs(version: &str, out: &Path) -> Result<()> {
    let concurrency: usize = std::env::var("FETCH_CONCURRENCY")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value: &usize| *value > 0)
        .unwrap_or(4);
    let interval_ms: u64 = std::env::var("FETCH_MIN_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(120);

    read_manifest(out, version)?;
    write_manifest(out, version, None)?;
    let crate_dir = out.join(CRATE);
    fs::create_dir_all(&crate_dir)
        .with_context(|| format!("cannot create {}", crate_dir.display()))?;

    let base = format!("https://docs.rs/{CRATE}/{version}/{CRATE}");
    let fetcher = Fetcher::new(interval_ms);
    println!("Mirroring docs.rs rustdoc for {CRATE} {version}");
    println!("  source: {base}");
    println!("  target: {}\n", crate_dir.display());

    let pages = match load_page_list(out, version) {
        Some(pages) => {
            println!("Using cached page list ({} pages)", pages.len());
            pages
        }
        None => {
            println!("Fetching all.html (page index)…");
            let all = fetcher
                .text(&format!("{base}/all.html"), 10)
                .map_err(|error| anyhow!(error))?;
            let Some(all) = all else {
                bail!(
                    "Could not read {base}/all.html.\n\
                     docs.rs may be rate-limiting (HTTP 429). Wait a few minutes and re-run the same command — it resumes.\n\
                     Alternatively run `cargo doc -p bevy` in a Bevy project, which needs no network."
                );
            };
            let pages = pages_from_all_html(&all);
            if pages.is_empty() {
                bail!("all.html contained no item pages");
            }
            save_page_list(out, version, &pages);
            println!("Found {} item pages (list cached).", pages.len());
            pages
        }
    };

    let missing: Vec<String> = pages
        .iter()
        .filter(|rel| {
            fs::metadata(crate_dir.join(rel))
                .map(|metadata| metadata.len() == 0)
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    println!(
        "{} of {} pages still missing.\n",
        missing.len(),
        pages.len()
    );
    write_manifest(out, version, Some(pages.len()))?;

    let queue = Arc::new(Mutex::new(missing.into_iter().collect::<Vec<_>>()));
    let failures = Arc::new(Mutex::new(Vec::<String>::new()));
    let done = Arc::new(AtomicUsize::new(0));
    let fetcher = Arc::new(fetcher);
    let base = Arc::new(base);

    let mut handles = Vec::new();
    for _ in 0..concurrency {
        let queue = Arc::clone(&queue);
        let failures = Arc::clone(&failures);
        let done = Arc::clone(&done);
        let fetcher = Arc::clone(&fetcher);
        let base = Arc::clone(&base);
        let crate_dir = crate_dir.clone();
        handles.push(std::thread::spawn(move || {
            loop {
                let next = queue.lock().expect("queue lock").pop();
                let Some(relative) = next else {
                    break;
                };
                let target = crate_dir.join(&relative);
                if let Some(parent) = target.parent()
                    && let Err(error) = fs::create_dir_all(parent)
                {
                    failures
                        .lock()
                        .expect("failure lock")
                        .push(format!("{relative}: {error}"));
                    continue;
                }
                match fetcher.text(&format!("{base}/{relative}"), 5) {
                    Ok(Some(html)) => {
                        if let Err(error) = fs::write(&target, html) {
                            failures
                                .lock()
                                .expect("failure lock")
                                .push(format!("{relative}: {error}"));
                        } else {
                            let count = done.fetch_add(1, Ordering::Relaxed) + 1;
                            if count.is_multiple_of(500) {
                                eprintln!("  downloaded {count}");
                            }
                        }
                    }
                    Ok(None) => failures
                        .lock()
                        .expect("failure lock")
                        .push(format!("{relative}: 404")),
                    Err(error) => failures
                        .lock()
                        .expect("failure lock")
                        .push(format!("{relative}: {error}")),
                }
            }
        }));
    }
    for handle in handles {
        let _ = handle.join();
    }

    // all.html omits the crate root.
    let root = crate_dir.join("index.html");
    if !root.is_file() || root.metadata().map(|m| m.len() == 0).unwrap_or(true) {
        match fetcher.text(&format!("{base}/index.html"), 5) {
            Ok(Some(html)) => {
                fs::write(&root, html)
                    .with_context(|| format!("cannot write {}", root.display()))?;
                done.fetch_add(1, Ordering::Relaxed);
            }
            Ok(None) => failures
                .lock()
                .expect("failure lock")
                .push("index.html: 404".to_string()),
            Err(error) => failures
                .lock()
                .expect("failure lock")
                .push(format!("index.html: {error}")),
        }
    }

    let failures = failures.lock().expect("failure lock");
    println!("Done.");
    println!("  downloaded: {}", done.load(Ordering::Relaxed));
    println!("  failed: {}", failures.len());
    println!(
        "\nPoint the MCP server at it with:\n  export BEVY_DOC_DIR={}\n",
        out.display()
    );
    if !failures.is_empty() {
        println!("Re-run the same command to retry only the missing pages.");
        for failure in failures.iter().take(5) {
            println!("  - {failure}");
        }
        bail!("{} page(s) failed", failures.len());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_html_yields_relative_pages_only() {
        let html = r#"
            <a href="struct.Query.html">Query</a>
            <a href="ecs/struct.World.html">World</a>
            <a href="all.html">all</a>
            <a href="index.html">index</a>
            <a href="https://docs.rs/other">external</a>
            <a href="../parent.html">parent</a>
            <a href="struct.Query.html#method.iter">anchor</a>
        "#;
        assert_eq!(
            pages_from_all_html(html),
            vec!["ecs/struct.World.html", "struct.Query.html"]
        );
    }

    #[test]
    fn a_wrong_manifest_is_rejected() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            dir.path().join(".bevy-mcp-docversion.json"),
            r#"{"version":"0.19.0"}"#,
        )
        .expect("manifest");
        let error = read_manifest(dir.path(), "0.20.0").expect_err("version mismatch");
        assert!(error.to_string().contains("different"), "{error}");
    }
}
