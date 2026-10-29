//! Shared HTTP helper for the maintenance harvesters.
//!
//! Serialises requests (shared throttle), retries transient failures with
//! backoff, treats 404 as "absent", and keeps hard timeouts so a stuck host
//! cannot hang the CLI forever.

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Fetcher {
    agent: ureq::Agent,
    interval: Duration,
    last: Mutex<Option<Instant>>,
}

impl Fetcher {
    pub fn new(interval_ms: u64) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .timeout_connect(Some(Duration::from_secs(5)))
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
            interval: Duration::from_millis(interval_ms),
            last: Mutex::new(None),
        }
    }

    fn throttle(&self) {
        let mut last = self.last.lock().expect("throttle lock");
        if let Some(previous) = *last {
            let elapsed = previous.elapsed();
            if elapsed < self.interval {
                std::thread::sleep(self.interval - elapsed);
            }
        }
        *last = Some(Instant::now());
    }

    /// Fetch a URL as UTF-8. `Ok(None)` means the server returned 404.
    pub fn text(&self, url: &str, tries: u32) -> Result<Option<String>, String> {
        let bytes = self.bytes(url, tries)?;
        let Some(bytes) = bytes else {
            return Ok(None);
        };
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|error| format!("{url} is not UTF-8: {error}"))
    }

    /// Fetch a URL as bytes. `Ok(None)` means the server returned 404.
    pub fn bytes(&self, url: &str, tries: u32) -> Result<Option<Vec<u8>>, String> {
        let tries = tries.max(1);
        for attempt in 1..=tries {
            self.throttle();
            match self
                .agent
                .get(url)
                .header(
                    "User-Agent",
                    concat!(
                        "bevy-manual-mcp/",
                        env!("CARGO_PKG_VERSION"),
                        " (harvest; https://github.com/kinkirill/bevy_manual_mcp)"
                    ),
                )
                .call()
            {
                Ok(mut response) => {
                    return response
                        .body_mut()
                        .read_to_vec()
                        .map(Some)
                        .map_err(|error| format!("cannot read {url}: {error}"));
                }
                Err(ureq::Error::StatusCode(404)) => return Ok(None),
                Err(ureq::Error::StatusCode(code)) if code == 429 || code >= 500 => {
                    if attempt == tries {
                        return Err(format!("{url}: HTTP {code} after {tries} attempts"));
                    }
                    let backoff = 500u64.saturating_mul(1 << (attempt - 1).min(6));
                    eprintln!("  ~ HTTP {code} for {url}; retrying in {backoff} ms");
                    std::thread::sleep(Duration::from_millis(backoff.min(30_000)));
                }
                Err(ureq::Error::StatusCode(code)) => {
                    return Err(format!("{url}: HTTP {code}"));
                }
                Err(error) => {
                    if attempt == tries {
                        return Err(format!("{url}: {error}"));
                    }
                    let backoff = 500u64.saturating_mul(1 << (attempt - 1).min(6));
                    std::thread::sleep(Duration::from_millis(backoff.min(30_000)));
                }
            }
        }
        unreachable!("retry loop returns")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetcher_is_constructible_without_network() {
        let fetcher = Fetcher::new(0);
        assert_eq!(fetcher.interval, Duration::ZERO);
    }
}
