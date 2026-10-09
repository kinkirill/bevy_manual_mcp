/**
 * Resource URI scheme for the Bevy API.
 *
 * This is the layer that makes every indexed item reachable *by identity*
 * rather than by search, which is what lets the server hold far more data
 * than it can full-text index. An item that is never full-text indexed is
 * still fully readable through its URI.
 *
 *   bevy://api/{version}/{path}          one item by full path
 *   bevy://path/{version}/{path}          alias, for callers that prefer it
 *   bevy://kind/{version}/{kind}           every item of a kind (paginated)
 *   bevy://module/{version}/{module}       every item in a module
 *   bevy://crate/{version}/{crate}         every item in a sub-crate
 *   bevy://owner/{version}/{owner}         every method on one type
 *   bevy://doc/{file}                      a source file's items
 *   bevy://index/versions                 what is indexed
 *
 * Paths use `::` for Rust modules and are percent-encoded for transport, so a
 * path containing `/` (module `gltf` under `bevy::gltf`) stays unambiguous.
 */

const SCHEME = "bevy";

export function apiUri(version, fullPath) {
  return `${SCHEME}://api/${encodeURIComponent(version)}/${encodeURIComponent(
    fullPath,
  )}`;
}

export function kindUri(version, kind) {
  return `${SCHEME}://kind/${encodeURIComponent(version)}/${encodeURIComponent(kind)}`;
}

export function moduleUri(version, module) {
  return `${SCHEME}://module/${encodeURIComponent(version)}/${encodeURIComponent(
    module,
  )}`;
}

export function crateUri(version, crateName) {
  return `${SCHEME}://crate/${encodeURIComponent(version)}/${encodeURIComponent(
    crateName,
  )}`;
}

export function ownerUri(version, owner) {
  return `${SCHEME}://owner/${encodeURIComponent(version)}/${encodeURIComponent(
    owner,
  )}`;
}

export function fileUri(version, file) {
  return `${SCHEME}://doc/${encodeURIComponent(version)}/${encodeURIComponent(
    file,
  )}`;
}

export const indexUri = `${SCHEME}://index/versions`;

/** Is this a URI this server handles? */
export function isBevyUri(uri) {
  return typeof uri === "string" && uri.startsWith(`${SCHEME}://`);
}

/**
 * Parse a bevy:// URI into a query descriptor.
 * Returns null when the URI is not one of ours or is malformed.
 */
export function parseUri(uri) {
  if (!isBevyUri(uri)) return null;
  let rest;
  try {
    rest = new URL(uri);
  } catch {
    return null;
  }
  // `new URL` puts bevy in host and the path in pathname.
  const kind = rest.hostname;
  const segs = rest.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));

  switch (kind) {
    case "api":
    case "path":
      if (segs.length < 2) return null;
      return { type: "api", version: segs[0], path: segs.slice(1).join("/") };
    case "kind":
      if (segs.length < 2) return null;
      return { type: "kind", version: segs[0], kind: segs[1] };
    case "module":
      if (segs.length < 2) return null;
      return { type: "module", version: segs[0], module: segs.slice(1).join("/") };
    case "crate":
      if (segs.length < 2) return null;
      return { type: "crate", version: segs[0], crate: segs[1] };
    case "owner":
      if (segs.length < 2) return null;
      return { type: "owner", version: segs[0], owner: segs[1] };
    case "doc":
      if (segs.length < 2) return null;
      return { type: "doc", version: segs[0], file: segs.slice(1).join("/") };
    case "index":
      return { type: "index" };
    default:
      return null;
  }
}

/**
 * Resource templates advertised via resources/templates/list.
 *
 * `kind`, `module` and `crate` are deliberately exposed as templates rather than
 * one concrete resource per crate: with 265k items, enumerating them would be
 * absurd, and pagination alone does not solve discovery. Templates let a client
 * ask for the shape it wants.
 */
export function templates(activeVersion) {
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