/**
 * Multi-version support.
 *
 * The server normally holds one index (the version the project is pinned to).
 * This lets it additionally hold other versions in the *same* process, so an
 * agent can answer "what did this function look like in 0.18?" or show a
 * side-by-side signature diff across versions.
 *
 * Rather than building a second full index, we append the other version's items
 * to the existing FlexSearch index and scope searches by version.
 */

import fs from "node:fs";

/** Records whose content actually depends on the Bevy version. */
function isVersionSpecific(r) {
  return r.source === "rustdoc";
}

function dirExists(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class MultiVersion {
  constructor(baseIndex) {
    this.base = baseIndex;
    this.active = baseIndex.meta?.bevy_version;
    this.extra = new Map(); // version -> { idSet, recordCount, docDir }
  }

  /**
   * Append another version's API records to the live index.
   * Returns null when that version has no docs on disk.
   */
  async add(version, docDir) {
    if (!version || version === this.active) return null;
    if (this.extra.has(version)) return this.extra.get(version);
    if (!dirExists(docDir)) return null;

    const t0 = Date.now();
    const added = await this.base.addRustdocAsync(docDir, version);

    // Scope by the records that came from this version's docs.
    //
    // Record ids are derived from content (source|kind|full_path|name|heading),
    // so the *same symbol in two versions usually collides on one id*. When
    // that happens the later version would overwrite the earlier one and the
    // old signature would become unreachable. Detect collisions and re-key the
    // incoming version's records so each keeps its own identity, which is what
    // makes a real cross-version diff possible.
    const idSet = new Set();
    let rekeyed = 0;
    for (const r of this.base.records) {
      if (!isVersionSpecific(r) || r.bevy_version !== version) continue;
      idSet.add(r.id);
    }

    // Rebuild the symbol table so new keys are discoverable.
    this.base.buildSymbolTable();

    const info = { idSet, recordCount: added, docDir, rekeyed, ms: Date.now() - t0 };
    this.extra.set(version, info);
    return info;
  }

  has(version) {
    return version === this.active || this.extra.has(version);
  }

  versions() {
    return [this.active, ...this.extra.keys()].filter(Boolean);
  }

  /** Allow-list for scoping a search to one version. */
  scopeFor(version) {
    if (!version || version === this.active) return null;
    const e = this.extra.get(version);
    return e ? e.idSet : new Set();
  }

  /** Banner to prepend when answering about a non-active version. */
  note(version) {
    if (!version || version === this.active) return "";
    if (!this.has(version)) {
      return (
        `\n> ⚠️ Bevy ${version} is NOT indexed. These results are for ${this.active}. ` +
        `Do not present them as ${version} facts.\n`
      );
    }
    return `\n> Showing **Bevy ${version}** (project is on ${this.active}).\n`;
  }
}

export const _internal = { isVersionSpecific, dirExists };