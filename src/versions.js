/**
 * Crates.io client: discover the newest published Bevy version.
 *
 * Used by the renewal flow so the server can notice a new release without
 * being told. Deliberately dependency-free (global fetch) and heavily cached,
 * because it runs on the MCP client's schedule.
 */

const API = "https://crates.io/api/v1/crates/bevy";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Stable versions only.
 *
 * Bevy publishes `-rc.N` pre-releases for the upcoming minor (currently
 * 0.20.0-rc.2). Telling an agent to "update to 0.20.0-rc.2" because it is
 * numerically newest would be actively harmful, so pre-releases are excluded
 * from the recommendation and reported separately as a preview.
 */
export async function fetchVersionInfo({ timeoutMs = 8000 } = {}) {
  const url = `${API}?per_page=20`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        // crates.io requires a descriptive User-Agent and rejects generic ones.
        "User-Agent": "bevy-mcp/1.0 (MCP server for Bevy docs; contact: local)",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return { ok: false, error: `crates.io returned HTTP ${res.status}` };
    }
    const j = await res.json();
    const versions = (j.versions || []).map((v) => ({
      num: v.num,
      yanked: !!v.yanked,
      created_at: v.created_at,
      prerelease: /-/.test(v.num),
    }));
    const stable = versions.filter((v) => !v.prerelease && !v.yanked);
    const prerelease = versions.filter((v) => v.prerelease && !v.yanked);
    if (!stable.length) return { ok: false, error: "no stable versions returned" };

    // Prefer the newest `max_stable`/`newest_version` the API reports.
    const newest = j.crate?.newest_version;
    const maxStable = j.crate?.max_stable_version;
    const resolvedStable =
      (maxStable && stable.find((v) => v.num === maxStable)?.num) || stable[0].num;

    return {
      ok: true,
      checked_at: Date.now(),
      newest_overall: newest,
      newest_stable: resolvedStable,
      preview: prerelease.length ? prerelease[0].num : null,
      recent: stable.slice(0, 6).map((v) => v.num),
    };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "crates.io timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Cache the crates.io answer in memory for TTL_MS to respect rate limits. */
export function createVersionChecker({ ttlMs = CACHE_TTL_MS, offline = false } = {}) {
  let cached = null;
  let fetchedAt = 0;

  return async function check({ refresh = false } = {}) {
    if (offline) {
      return {
        ok: false,
        offline: true,
        error: "offline mode (BEVY_MCP_OFFLINE=1): not contacting crates.io",
        ...(cached || {}),
      };
    }
    const fresh = cached && Date.now() - fetchedAt < ttlMs;
    if (fresh && !refresh) return cached;

    const info = await fetchVersionInfo();
    if (info.ok) {
      cached = info;
      fetchedAt = Date.now();
    }
    // On failure, keep serving stale data rather than failing the tool call.
    return info.ok ? cached : { ...info, stale: cached || null };
  };
}