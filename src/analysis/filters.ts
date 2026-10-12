/** Filter disjointness solver for Query filters. */

export interface FilterAtom {
  type: "With" | "Without" | "Or" | "Added" | "Changed";
  entity?: string;     // The entity/type this filter applies to
  branches?: FilterAtom[]; // For Or<>
}

/** Parse Query filters into atoms for disjointness checking. */
export function parseFilters(filters: string[]): FilterAtom[] {
  const atoms: FilterAtom[] = [];

  for (const f of filters) {
    const trimmed = f.trim();
    const withMatch = trimmed.match(/^With<([^>]+)>/);
    if (withMatch) {
      atoms.push({ type: "With", entity: withMatch[1]!.trim() });
      continue;
    }

    const withoutMatch = trimmed.match(/^Without<([^>]+)>/);
    if (withoutMatch) {
      atoms.push({ type: "Without", entity: withoutMatch[1]!.trim() });
      continue;
    }

    const addedMatch = trimmed.match(/^Added<([^>]+)>/);
    if (addedMatch) {
      atoms.push({ type: "Added", entity: addedMatch[1]!.trim() });
      continue;
    }

    const changedMatch = trimmed.match(/^Changed<([^>]+)>/);
    if (changedMatch) {
      atoms.push({ type: "Changed", entity: changedMatch[1]!.trim() });
      continue;
    }

    // Or<(X, Y)> — extract branches
    const orMatch = trimmed.match(/^Or<\(([^>]+)\)>/);
    if (orMatch && orMatch[1]) {
      const inner = orMatch[1];
      const branchAtoms: FilterAtom[] = [];
      const parts = splitOrBranches(inner);
      for (const part of parts) {
        const subMatches = parseFilters([part.trim()]);
        branchAtoms.push(...subMatches);
      }
      atoms.push({ type: "Or", entity: undefined, branches: branchAtoms });
    }

    // Unknown filter — conservative: don't claim disjointness
  }

  return atoms;
}

/** Split Or<(X, Y)> into individual branches. */
function splitOrBranches(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "<" || ch === "(") depth++;
    else if (ch === ">" || ch === ")") depth--;

    if (depth === 0 && ch === ",") {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }

  const last = inner.slice(start).trim();
  if (last) parts.push(last);

  return parts;
}

/** Check two filter sets for disjointness. */
export function isDisjoint(fromA: FilterAtom[], fromB: FilterAtom[]): boolean {
  // For each With/Without in A, check against B
  const withInA = new Map<string, true>();
  const withoutInA = new Map<string, true>();

  for (const atom of fromA) {
    if (!atom.entity) continue;
    switch (atom.type) {
      case "With": withInA.set(atom.entity!, true); break;
      case "Without": withoutInA.set(atom.entity!, true); break;
      // Added/Changed don't create disjointness per plan
    }

    // Or branches: conservative — treat as non-disjoint unless every branch is disjoint
    if (atom.type === "Or" && atom.branches) {
      const allBranchesDisjoint = atom.branches.every((branch) => {
        if (!branch.entity) return false;
        switch (branch.type) {
          case "With": return withInA.has(branch.entity);
          case "Without": return withoutInA.has(branch.entity);
          default: return false;
        }
      });
      // If all branches are disjoint, the Or is disjoint too
      if (!allBranchesDisjoint) return false;
    }
  }

  for (const atom of fromB) {
    if (!atom.entity) continue;
    switch (atom.type) {
      case "With":
        // With<B> conflicts with Without<B> from A
        if (withoutInA.has(atom.entity)) return true;
        break;
      case "Without":
        // Without<B> conflicts with With<B> from A
        if (withInA.has(atom.entity)) return true;
        break;
    }

    // Or branches: conservative
    if (atom.type === "Or" && atom.branches) {
      const allBranchesDisjoint = atom.branches.every((branch) => {
        if (!branch.entity) return false;
        switch (branch.type) {
          case "With": return withoutInA.has(branch.entity);
          case "Without": return withInA.has(branch.entity);
          default: return false;
        }
      });
      if (!allBranchesDisjoint) return false;
    }
  }

  // Check for mutual With/Without (e.g., A has With<X> and B has Without<X>)
  // We need to check in both directions
  let foundConflict = false;
  for (const [entity] of withInA) {
    if (withoutInA.has(entity)) {
      // Same query has With<X> and Without<X> — not a conflict between queries
      continue;
    }
  }

  return false; // No disjointness established by default
}

/** Check whether filters provide disjointness for the same entity. */
export function checkFilterDisjointness(filtersA: string[], filtersB: string[]): boolean {
  const atomsA = parseFilters(filtersA);
  const atomsB = parseFilters(filtersB);

  // Build entity sets
  const withEntitiesA = new Set<string>();
  const withoutEntitiesA = new Set<string>();
  const withEntitiesB = new Set<string>();
  const withoutEntitiesB = new Set<string>();

  for (const atom of atomsA) {
    if (!atom.entity) continue;
    switch (atom.type) {
      case "With": withEntitiesA.add(atom.entity); break;
      case "Without": withoutEntitiesA.add(atom.entity); break;
    }
  }

  for (const atom of atomsB) {
    if (!atom.entity) continue;
    switch (atom.type) {
      case "With": withEntitiesB.add(atom.entity); break;
      case "Without": withoutEntitiesB.add(atom.entity); break;
    }
  }

  // Check disjointness: With<A] vs Without[A], and vice versa
  for (const entity of withEntitiesA) {
    if (withoutEntitiesB.has(entity)) return true;
  }
  for (const entity of withoutEntitiesA) {
    if (withEntitiesB.has(entity)) return true;
  }

  return false;
}
