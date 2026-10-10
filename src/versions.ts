/** Crates.io version discovery, isolated from startup and cached for six hours. */
import { z } from "zod";
import { errorMessage, parseJson } from "./types.js";

const API = "https://crates.io/api/v1/crates/bevy";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface VersionInfo {
  ok: true;
  checked_at: number;
  newest_overall?: string;
  newest_stable: string;
  preview: string | null;
  recent: string[];
  error?: never;
  stale?: never;
}

export interface VersionFailure {
  ok: false;
  error: string;
  offline?: boolean;
  stale?: VersionInfo | null;
}

export type VersionCheckResult = VersionInfo | VersionFailure;
const responseSchema = z.object({
  crate: z.object({ newest_version: z.string().optional(), max_stable_version: z.string().optional() }).optional(),
  versions: z.array(z.object({ num: z.string(), yanked: z.boolean().optional().default(false) })),
});

export async function fetchVersionInfo({ timeoutMs = 8000 }: { timeoutMs?: number } = {}): Promise<VersionCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API}?per_page=20`, {
      signal: controller.signal,
      headers: {
        "User-Agent": "bevy-mcp/0.20 (MCP server for Bevy docs)",
        Accept: "application/json",
      },
    });
    if (!response.ok) return { ok: false, error: `crates.io returned HTTP ${response.status}` };
    const payload = responseSchema.parse(parseJson(await response.text()));
    const available = payload.versions.filter((version) => !version.yanked);
    const stable = available.filter((version) => !version.num.includes("-"));
    const preview = available.find((version) => version.num.includes("-"));
    const first = stable[0];
    if (!first) return { ok: false, error: "no stable versions returned" };
    const preferred = stable.find((version) => version.num === payload.crate?.max_stable_version);
    return {
      ok: true,
      checked_at: Date.now(),
      newest_overall: payload.crate?.newest_version,
      newest_stable: preferred?.num ?? first.num,
      preview: preview?.num ?? null,
      recent: stable.slice(0, 6).map((version) => version.num),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "AbortError"
      ? "crates.io timed out" : errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function createVersionChecker({ ttlMs = CACHE_TTL_MS, offline = false }: {
  ttlMs?: number; offline?: boolean;
} = {}): (options?: { refresh?: boolean }) => Promise<VersionCheckResult> {
  let cached: VersionInfo | null = null;
  let fetchedAt = 0;
  let pending: Promise<VersionCheckResult> | null = null;

  return async ({ refresh = false } = {}) => {
    if (offline) return { ok: false, offline: true, error: "offline mode (BEVY_MCP_OFFLINE=1): not contacting crates.io" };
    if (cached && Date.now() - fetchedAt < ttlMs && !refresh) return cached;
    if (pending) return pending;
    pending = fetchVersionInfo().then((info): VersionCheckResult => {
      if (info.ok) {
        cached = info;
        fetchedAt = Date.now();
        return info;
      }
      return { ...info, stale: cached };
    });
    try { return await pending; } finally { pending = null; }
  };
}
