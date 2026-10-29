//! Fetch the bevy-website prose with a sparse git checkout.
//!
//! Port of `scripts/fetch-website.mts`: blobs are filtered, only prose and
//! example sources are checked out, and the result is swapped in atomically.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

const DEFAULT_UPSTREAM: &str = "https://github.com/bevyengine/bevy-website.git";

const SPARSE_PATTERNS: [&str; 5] = [
    "/content/**/*.md",
    "/release-content/**/*.md",
    "/release-content/**/*.rs",
    "/learning-code-examples/**/*.rs",
    "/LICENSE",
];

fn git(args: &[&str], cwd: Option<&Path>) -> Result<()> {
    let mut command = Command::new("git");
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .context("git is not available or could not be started")?;
    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

fn copy_prose(from: &Path, to: &Path) -> Result<(usize, u64)> {
    let mut count = 0usize;
    let mut bytes = 0u64;
    let mut stack = vec![from.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name == ".git" {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !(name.ends_with(".md") || name.ends_with(".rs") || name == "LICENSE") {
                continue;
            }
            let relative = path.strip_prefix(from).unwrap_or(&path);
            let destination = to.join(relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("cannot create {}", parent.display()))?;
            }
            fs::copy(&path, &destination).with_context(|| {
                format!(
                    "cannot copy {} to {}",
                    path.display(),
                    destination.display()
                )
            })?;
            count += 1;
            bytes += fs::metadata(&destination).map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok((count, bytes))
}

/// Fetch the website prose into `out`. `reference` is a branch or tag.
pub fn fetch_website(out: &Path, reference: &str) -> Result<()> {
    let upstream =
        std::env::var("BEVY_WEBSITE_REPO").unwrap_or_else(|_| DEFAULT_UPSTREAM.to_string());
    let out = std::path::absolute(out).unwrap_or_else(|_| PathBuf::from(out));
    let parent = out
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent).with_context(|| format!("cannot create {}", parent.display()))?;

    let suffix = format!("{}-{}", std::process::id(), now_millis());
    let checkout = parent.join(format!(".bevy-website-checkout-{suffix}"));
    let staging = parent.join(format!(".bevy-website-stage-{suffix}"));
    let backup = parent.join(format!(".bevy-website-previous-{suffix}"));

    println!("Fetching bevy-website ({reference}) — prose only, no media");
    let result = (|| -> Result<(usize, u64)> {
        if checkout.exists() {
            fs::remove_dir_all(&checkout).ok();
        }
        git(
            &[
                "clone",
                "--depth",
                "1",
                "--filter=blob:none",
                "--sparse",
                "--branch",
                reference,
                &upstream,
                checkout.to_str().unwrap_or("checkout"),
            ],
            None,
        )?;
        let mut sparse = vec!["sparse-checkout", "set", "--no-cone"];
        sparse.extend(SPARSE_PATTERNS);
        git(&sparse, Some(&checkout))?;

        fs::create_dir_all(&staging)
            .with_context(|| format!("cannot create {}", staging.display()))?;
        let copied = copy_prose(&checkout, &staging)?;
        if copied.0 == 0 {
            bail!("No prose files found; existing website was preserved.");
        }
        if out.exists() {
            if backup.exists() {
                fs::remove_dir_all(&backup).ok();
            }
            fs::rename(&out, &backup)
                .with_context(|| format!("cannot move {} aside", out.display()))?;
        }
        match fs::rename(&staging, &out) {
            Ok(()) => {
                if backup.exists() {
                    fs::remove_dir_all(&backup).ok();
                }
                Ok(copied)
            }
            Err(error) => {
                if backup.exists() {
                    let _ = fs::rename(&backup, &out);
                }
                Err(error).with_context(|| format!("cannot install {}", out.display()))
            }
        }
    })();

    let _ = fs::remove_dir_all(&checkout);
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&backup);
    let (count, bytes) = result?;
    println!(
        "\nWrote {count} files ({:.2} MB) to {}",
        bytes as f64 / 1_048_576.0,
        out.display()
    );
    Ok(())
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prose_is_copied_without_media_or_git() {
        let dir = tempfile::tempdir().expect("temp dir");
        let from = dir.path().join("checkout");
        fs::create_dir_all(from.join("content").join("learn")).expect("content");
        fs::create_dir_all(from.join("content").join("media")).expect("media");
        fs::create_dir_all(from.join(".git")).expect("git");
        fs::write(from.join("content/learn/book.md"), "# Book").expect("book");
        fs::write(from.join("content/learn/example.rs"), "fn main() {}").expect("rs");
        fs::write(from.join("content/media/big.png"), b"png").expect("png");
        fs::write(from.join(".git/HEAD"), "ref").expect("head");
        fs::write(from.join("LICENSE"), "MIT").expect("license");

        let to = dir.path().join("out");
        let (count, bytes) = copy_prose(&from, &to).expect("copy");
        assert_eq!(count, 3, "markdown, rust and LICENSE only");
        assert!(bytes > 0);
        assert!(to.join("content/learn/book.md").is_file());
        assert!(to.join("content/learn/example.rs").is_file());
        assert!(to.join("LICENSE").is_file());
        assert!(!to.join("content/media/big.png").exists());
        assert!(!to.join(".git").exists());
    }
}
