// Asset revisions select rebuilds without changing the indexed Bevy version.
import { z } from "zod";
import { errorMessage, stableVersion } from "./cli-utils.mjs";

export interface IndexReleaseAsset {
  name: string;
  url: string;
  sha256: string | null;
}

/**
 * Published as `index-manifest.json` on each release. It is the authoritative
 * pointer to the current bundle, so `fetch-index` can tell a user whether their
 * installed revision is behind instead of relying on `--force`.
 */
export interface IndexManifest {
  manifest_version: 1;
  bevy_version: string;
  asset: string;
  revision: number;
  sha256: string;
  cache_version: number;
  size?: number;
  api_records?: number;
  text_indexed?: number;
  built_at?: string;
  generated_at?: string;
}

export interface IndexRelease {
  asset: IndexReleaseAsset;
  manifest: IndexManifest | null;
}

export const INDEX_MANIFEST_ASSET = "index-manifest.json";

const releaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({
    name: z.string(),
    browser_download_url: z.string().url(),
    state: z.string().optional(),
    digest: z.string().nullable().optional(),
  })),
});

const manifestSchema = z.object({
  manifest_version: z.literal(1),
  bevy_version: z.string(),
  asset: z.string().min(1),
  revision: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  cache_version: z.number().int(),
  size: z.number().int().nonnegative().optional(),
  api_records: z.number().int().nonnegative().optional(),
  text_indexed: z.number().int().nonnegative().optional(),
  built_at: z.string().optional(),
  generated_at: z.string().optional(),
});

export function parseIndexManifest(value: unknown, version: string): IndexManifest {
  const manifest = manifestSchema.parse(value);
  if (manifest.bevy_version !== version) {
    throw new Error(`Index manifest describes Bevy ${manifest.bevy_version}, expected ${version}.`);
  }
  return manifest;
}

function assetSha256(digest: string | null | undefined): string | null {
  if (!digest) return null;
  if (!digest.startsWith("sha256:")) throw new Error("Unsupported release asset digest algorithm.");
  const sha256 = digest.slice(7).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid release asset SHA-256 digest.");
  return sha256;
}

function requireHttps(url: string): string {
  if (new URL(url).protocol !== "https:") throw new Error("Release index assets must use HTTPS.");
  return url;
}

/** Choose the uploaded asset with the highest numeric revision (canonical = -1). */
export function selectIndexAsset(release: unknown, version: string): IndexReleaseAsset {
  stableVersion(version);
  const parsed = releaseSchema.parse(release);
  if (parsed.tag_name !== `v${version}`) throw new Error(`Release tag must be v${version}.`);
  const canonical = `bevy-index-${version}.tar.gz`;
  const revisionPrefix = `bevy-index-${version}+`;
  let selected: (typeof parsed.assets)[number] | undefined;
  let highestRevision = -1n;
  for (const asset of parsed.assets) {
    if (asset.state !== undefined && asset.state !== "uploaded") continue;
    let revision: bigint;
    if (asset.name === canonical) revision = -1n;
    else {
      if (!asset.name.startsWith(revisionPrefix)) continue;
      const suffix = asset.name.slice(revisionPrefix.length).match(/^(\d+)\.tar\.gz$/);
      if (!suffix?.[1]) continue;
      revision = BigInt(suffix[1]);
    }
    if (!selected || revision > highestRevision) {
      selected = asset;
      highestRevision = revision;
    }
  }
  if (!selected) throw new Error(`Release v${version} has no compatible index asset.`);
  return { name: selected.name, url: requireHttps(selected.browser_download_url), sha256: assetSha256(selected.digest) };
}

async function fetchRelease(repo: string, version: string, timeoutMs: number): Promise<unknown> {
  stableVersion(version);
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) throw new Error("BEVY_MCP_REPO must be owner/repo.");
  const url = `https://api.github.com/repos/${repo}/releases/tags/v${version}`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "bevy-mcp/fetch-index", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 404 ? `Release v${version} was not found in ${repo}.` : `GitHub release lookup returned HTTP ${response.status}.`);
    }
    return await response.json();
  } catch (error) {
    throw new Error(`Could not resolve the current index asset: ${errorMessage(error)} Use --from <archive-url> to select an archive explicitly.`);
  }
}

/**
 * Resolve the bundle to download. When the release carries an
 * `index-manifest.json`, it is authoritative (it names the bundle and its
 * digest); otherwise fall back to selecting the highest asset revision so
 * releases published before manifests keep working. A manifest that cannot be
 * fetched or parsed is reported and ignored rather than failing the install.
 */
export async function resolveIndexRelease(repo: string, version: string, { timeoutMs = 15_000 }: {
  timeoutMs?: number;
} = {}): Promise<IndexRelease> {
  const release = await fetchRelease(repo, version, timeoutMs);
  const parsed = releaseSchema.parse(release);
  if (parsed.tag_name !== `v${version}`) throw new Error(`Release tag must be v${version}.`);
  const manifestAsset = parsed.assets.find((asset) =>
    asset.name === INDEX_MANIFEST_ASSET && (asset.state === undefined || asset.state === "uploaded"));
  if (manifestAsset) {
    try {
      const response = await fetch(requireHttps(manifestAsset.browser_download_url), {
        headers: { "User-Agent": "bevy-mcp/fetch-index", Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = parseIndexManifest(await response.json(), version);
      const bundle = parsed.assets.find((asset) =>
        asset.name === manifest.asset && (asset.state === undefined || asset.state === "uploaded"));
      if (!bundle) throw new Error(`Manifest names ${manifest.asset}, which is not attached to v${version}.`);
      return { asset: { name: bundle.name, url: requireHttps(bundle.browser_download_url), sha256: manifest.sha256 }, manifest };
    } catch (error) {
      console.error(`[bevy-mcp] ignoring unreadable index manifest on v${version}: ${errorMessage(error)}`);
    }
  }
  return { asset: selectIndexAsset(release, version), manifest: null };
}

export async function resolveIndexAsset(repo: string, version: string, options: { timeoutMs?: number } = {}): Promise<IndexReleaseAsset> {
  return (await resolveIndexRelease(repo, version, options)).asset;
}

export function verifyArchiveDigest(expected: string | null, actual: string): void {
  if (expected !== null && expected !== actual) throw new Error("Downloaded index archive SHA-256 does not match the GitHub release digest.");
}

export type IndexFetchReason =
  | "missing" | "forced" | "stale-format" | "unknown-format" | "damaged" | "newer-revision"
  | "no-recheck" | "up-to-date" | "cannot-check";

export type IndexFetchAction =
  | { action: "download"; reason: "missing" | "forced" | "stale-format" | "unknown-format" | "damaged" | "newer-revision" }
  | { action: "skip"; reason: "no-recheck" | "up-to-date" | "cannot-check" };

/**
 * Decide whether `fetch-index` should download.
 *
 * A known-stale format always updates, even with `--no-recheck`; `--no-recheck`
 * only keeps an unknown-format or current install. When a manifest revision is
 * newer than the recorded one (or none is recorded, as for installs predating
 * manifests) it updates. Without a manifest the check is inconclusive, so the
 * existing install is kept rather than re-downloaded blindly. A files-present
 * but unhealthy install still self-heals.
 */
export function planIndexFetch(input: {
  installed: boolean;
  valid: boolean;
  formatKnown: boolean;
  formatCurrent: boolean;
  force: boolean;
  noRecheck: boolean;
  manifestRevision: number | null;
  installedRevision: number | null;
}): IndexFetchAction {
  if (!input.installed) return { action: "download", reason: "missing" };
  if (input.force) return { action: "download", reason: "forced" };
  if (input.formatKnown && !input.formatCurrent) return { action: "download", reason: "stale-format" };
  if (input.valid) {
    if (input.noRecheck) return { action: "skip", reason: "no-recheck" };
    if (input.manifestRevision === null) return { action: "skip", reason: "cannot-check" };
    if (input.installedRevision === null || input.manifestRevision > input.installedRevision) {
      return { action: "download", reason: "newer-revision" };
    }
    return { action: "skip", reason: "up-to-date" };
  }
  if (input.noRecheck && !input.formatKnown) return { action: "skip", reason: "no-recheck" };
  if (!input.formatKnown) return { action: "download", reason: "unknown-format" };
  return { action: "download", reason: "damaged" };
}
