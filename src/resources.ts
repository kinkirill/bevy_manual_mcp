/**
 * Identity-based access includes items omitted from full-text search. Rust
 * paths are percent-encoded to preserve embedded slashes during transport.
 */

import type { ResourceQuery } from "./types.js";

const SCHEME = "bevy";

export function apiUri(version: string | null | undefined, fullPath: string) {
  return `${SCHEME}://api/${encodeURIComponent(version ?? "unknown")}/${encodeURIComponent(
    fullPath,
  )}`;
}

export function kindUri(version: string | null | undefined, kind: string) {
  return `${SCHEME}://kind/${encodeURIComponent(version ?? "unknown")}/${encodeURIComponent(kind)}`;
}

export function moduleUri(version: string | null | undefined, module: string) {
  return `${SCHEME}://module/${encodeURIComponent(version ?? "unknown")}/${encodeURIComponent(
    module,
  )}`;
}

export function crateUri(version: string | null | undefined, crateName: string) {
  return `${SCHEME}://crate/${encodeURIComponent(version ?? "unknown")}/${encodeURIComponent(
    crateName,
  )}`;
}

export function ownerUri(version: string | null | undefined, owner: string) {
  return `${SCHEME}://owner/${encodeURIComponent(version ?? "unknown")}/${encodeURIComponent(
    owner,
  )}`;
}

export function fileUri(version: string | null | undefined, file: string) {
  return `${SCHEME}://doc/${encodeURIComponent(version ?? "unknown")}/${encodeURIComponent(
    file,
  )}`;
}

export const indexUri = `${SCHEME}://index/versions`;

export function isBevyUri(uri: unknown): uri is string {
  return typeof uri === "string" && uri.startsWith(`${SCHEME}://`);
}

/** Return a resource query, or null for an unsupported or malformed URI. */
export function parseUri(uri: unknown): ResourceQuery | null {
  if (!isBevyUri(uri)) return null;
  let rest: URL;
  let segs: string[];
  try {
    rest = new URL(uri);
    segs = rest.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  const kind = rest.hostname;
  const version = segs[0];
  if (kind !== "index" && !version) return null;

  switch (kind) {
    case "api":
    case "path":
      if (segs.length < 2) return null;
      return { type: "api", version: version!, path: segs.slice(1).join("/") };
    case "kind":
      if (segs.length !== 2 || !segs[1]) return null;
      return { type: "kind", version: version!, kind: segs[1] };
    case "module":
      if (segs.length < 2) return null;
      return { type: "module", version: version!, module: segs.slice(1).join("/") };
    case "crate":
      if (segs.length !== 2 || !segs[1]) return null;
      return { type: "crate", version: version!, crate: segs[1] };
    case "owner":
      if (segs.length !== 2 || !segs[1]) return null;
      return { type: "owner", version: version!, owner: segs[1] };
    case "doc":
      if (segs.length < 2) return null;
      return { type: "doc", version: version!, file: segs.slice(1).join("/") };
    case "index":
      return segs.length === 1 && segs[0] === "versions" ? { type: "index" } : null;
    default:
      return null;
  }
}

/**
 * Templates let clients discover resources without enumerating the entire
 * corpus in resources/list.
 */
export function templates(activeVersion: string | null) {
  const v = encodeURIComponent(activeVersion || "unknown");
  return [
    {
      uriTemplate: `${SCHEME}://api/{version}/{path}`,
      name: "bevy-api-item",
      title: "Bevy API item by full path",
      description:
        "One API item (struct, enum, trait, fn, method) by its Rust path, e.g. " +
        "bevy::camera::primitives::Sphere. Works for items that are not full-text indexed.",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: `${SCHEME}://kind/{version}/{kind}`,
      name: "bevy-items-by-kind",
      title: "All Bevy API items of one kind",
      description:
        "Paginated list of items with the given kind: struct, enum, trait, fn, method.",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: `${SCHEME}://module/{version}/{module}`,
      name: "bevy-items-by-module",
      title: "All Bevy API items in a module",
      description:
        "Paginated list of items in a module path, e.g. bevy::render::render::graph.",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: `${SCHEME}://crate/{version}/{crate}`,
      name: "bevy-items-by-crate",
      title: "All Bevy API items in a sub-crate",
      description:
        "Paginated list of items defined in one Bevy sub-crate, e.g. bevy_render, bevy_ecs.",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: `${SCHEME}://owner/{version}/{owner}`,
      name: "bevy-items-by-type",
      title: "All methods and associated items on one type",
      description:
        "Paginated list of everything attached to a type, e.g. all methods on Camera.",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: `${SCHEME}://doc/{version}/{file}`,
      name: "bevy-items-by-source-file",
      title: "Items documented on one rustdoc page",
      description: "All items parsed from a single rustdoc HTML page.",
      mimeType: "text/markdown",
    },
  ];
}

export const _internal = { parseUri, isBevyUri, SCHEME, defaultVersionRef: "unknown" };
