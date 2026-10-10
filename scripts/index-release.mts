// Asset revisions select rebuilds without changing the indexed Bevy version.
import { z } from "zod";
import { errorMessage, stableVersion } from "./cli-utils.mjs";

export interface IndexReleaseAsset {
  name: string;
  url: string;
  sha256: string | null;
}

const releaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({
    name: z.string(),
    browser_download_url: z.string().url(),
    state: z.string().optional(),
    digest: z.string().nullable().optional(),
  })),
});

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
  if (new URL(selected.browser_download_url).protocol !== "https:") {
    throw new Error("Release index assets must use HTTPS.");
  }
  const digest = selected.digest;
  if (digest && !digest.startsWith("sha256:")) throw new Error("Unsupported release asset digest algorithm.");
  const sha256 = digest?.startsWith("sha256:") ? digest.slice(7).toLowerCase() : null;
  if (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid release asset SHA-256 digest.");
  return { name: selected.name, url: selected.browser_download_url, sha256 };
}

export async function resolveIndexAsset(repo: string, version: string, { timeoutMs = 15_000 }: {
  timeoutMs?: number;
} = {}): Promise<IndexReleaseAsset> {
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
    const release: unknown = await response.json();
    return selectIndexAsset(release, version);
  } catch (error) {
    throw new Error(`Could not resolve the current index asset: ${errorMessage(error)} Use --from <archive-url> to select an archive explicitly.`);
  }
}

export function verifyArchiveDigest(expected: string | null, actual: string): void {
  if (expected !== null && expected !== actual) throw new Error("Downloaded index archive SHA-256 does not match the GitHub release digest.");
}
