import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveIndexAsset, selectIndexAsset, verifyArchiveDigest } from "../scripts/index-release.mjs";

const version = "0.20.0";
const digest = "a".repeat(64);
function asset(name: string, extra: Record<string, unknown> = {}) {
  return { name, browser_download_url: `https://github.com/example/docs/releases/download/v${version}/${encodeURIComponent(name)}`, state: "uploaded", ...extra };
}
function release(assets: ReturnType<typeof asset>[]) { return { tag_name: `v${version}`, assets }; }

await test("release selects the highest numeric index revision for the requested Bevy version", () => {
  const latest = asset(`bevy-index-${version}+10.tar.gz`, { digest: `sha256:${digest.toUpperCase()}` });
  const selected = selectIndexAsset(release([
    asset(`bevy-index-${version}+2.tar.gz`), latest, asset(`bevy-index-${version}.tar.gz`),
    asset("bevy-index-0.21.0+999.tar.gz"), asset(`bevy-index-${version}+11.tar.gz.sha256`),
    asset(`bevy-index-${version}+12.tar.gz`, { state: "starter" }),
  ]), version);
  assert.deepEqual(selected, { name: latest.name, url: latest.browser_download_url, sha256: digest });
});

await test("release uses the canonical asset when no numbered revision is available", () => {
  const canonical = asset(`bevy-index-${version}.tar.gz`);
  assert.deepEqual(selectIndexAsset(release([canonical, asset(`bevy-index-${version}+preview.tar.gz`)]), version),
    { name: canonical.name, url: canonical.browser_download_url, sha256: null });
});

await test("release revisions remain sortable beyond JavaScript safe integer precision", () => {
  const selected = selectIndexAsset(release([
    asset(`bevy-index-${version}+9007199254740992.tar.gz`),
    asset(`bevy-index-${version}+9007199254740993.tar.gz`),
  ]), version);
  assert.equal(selected.name, `bevy-index-${version}+9007199254740993.tar.gz`);
});

await test("release rejects a mismatched tag, missing asset and malformed SHA-256 digest", () => {
  assert.throws(() => selectIndexAsset({ tag_name: "v0.19.1", assets: [] }, version), /Release tag/);
  assert.throws(() => selectIndexAsset(release([asset("bevy-index-0.19.1.tar.gz")]), version), /no compatible index/);
  assert.throws(() => selectIndexAsset(release([asset(`bevy-index-${version}.tar.gz`, { digest: "sha256:invalid" })]), version), /Invalid release asset/);
  for (const unsupported of ["md5:abc", "SHA256:" + digest, "unknown"]) {
    assert.throws(() => selectIndexAsset(release([asset(`bevy-index-${version}.tar.gz`, { digest: unsupported })]), version), /Unsupported release asset digest/);
  }
  assert.throws(() => selectIndexAsset(release([asset(`bevy-index-${version}.tar.gz`, { browser_download_url: "http://example.com/index.tar.gz" })]), version), /HTTPS/);
});

await test("release digest verification rejects altered downloads and accepts missing legacy digests", () => {
  verifyArchiveDigest(digest, digest);
  verifyArchiveDigest(null, "b".repeat(64));
  assert.throws(() => verifyArchiveDigest(digest, "b".repeat(64)), /does not match/);
});

await test("release lookup honors the configured repository and preserves the base version", async () => {
  const previous = globalThis.fetch;
  const latest = asset(`bevy-index-${version}+1.tar.gz`, { digest: `sha256:${digest}` });
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url, `https://api.github.com/repos/example/fork/releases/tags/v${version}`);
      return new Response(JSON.stringify(release([latest])), { status: 200 });
    };
    assert.equal((await resolveIndexAsset("example/fork", version)).name, latest.name);
  } finally { globalThis.fetch = previous; }
});

await test("release lookup failures request an explicit source instead of silently selecting stale assets", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    await assert.rejects(resolveIndexAsset("example/fork", version), /not found.*--from/);
    globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
    await assert.rejects(resolveIndexAsset("example/fork", version), /timeout.*--from/);
    await assert.rejects(resolveIndexAsset("invalid/repo/extra", version), /owner\/repo/);
  } finally { globalThis.fetch = previous; }
});
