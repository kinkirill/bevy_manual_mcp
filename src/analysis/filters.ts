/** Filter disjointness solver for Query filters. */

export interface FilterAtom {
  type: "With" | "Without" | "Or" | "Added" | "Changed";
  entity?: string;         // The entity/type this filter applies to
  branches?: FilterAtom[]; // For Or<>
}

/** Parse Query filters (including tuples and `Or<(...)>`) into atoms. */
export function parseFilters(filters: string[]): FilterAtom[] {
  const atoms: FilterAtom[] = [];
  for (const filter of filters) atoms.push(...parseFilterExpr(filter));
  return atoms;
}

/** Split text on top-level commas, respecting `<>`, `()` and `[]`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (depth === 0 && ch === ",") {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

/** Index of the closer matching the opener at `open`, or -1. */
function closerIndex(text: string, open: number): number {
  const closer = text[open] === "(" ? ")" : text[open] === "<" ? ">" : text[open] === "[" ? "]" : null;
  if (!closer) return -1;
  const stack: string[] = [closer];
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(") stack.push(")");
    else if (ch === "<") stack.push(">");
    else if (ch === "[") stack.push("]");
    else if (ch === ")" || ch === ">" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Unwrap a filter expression, flattening tuples into individual atoms. */
function parseFilterExpr(expr: string): FilterAtom[] {
  let s = expr.trim();
  while (s.startsWith("(") && closerIndex(s, 0) === s.length - 1) s = s.slice(1, -1).trim();
  if (!s) return [];

  const parts = splitTopLevel(s);
  if (parts.length > 1) return parts.flatMap(parseFilterExpr);

  const orMatch = s.match(/^Or<\(([\s\S]*)\)>$/);
  if (orMatch) {
    const branches = splitTopLevel(orMatch[1]!).flatMap(parseFilterExpr);
    return branches.length ? [{ type: "Or", branches }] : [];
  }

  const atom = s.match(/^(With|Without|Added|Changed)<([^<>]*(?:<[^<>]*>[^<>]*)*)>/);
  if (atom && atom[2]) {
    return [{ type: atom[1] as "With" | "Without" | "Added" | "Changed", entity: atom[2].trim() }];
  }

  // Unknown filter — conservative: contributes no disjointness.
  return [];
}

/**
 * Two filter sets are disjoint when no entity can satisfy both. `With<A>` and
 * `Without<A>` on opposite sides establish disjointness; `Or` is disjoint only
 * when every branch is.
 */
function disjoint(a: FilterAtom[], b: FilterAtom[]): boolean {
  for (const atom of a) {
    if (atom.type === "Or" && atom.branches?.length && atom.branches.every((branch) => disjoint([branch], b))) {
      return true;
    }
  }
  for (const atom of b) {
    if (atom.type === "Or" && atom.branches?.length && atom.branches.every((branch) => disjoint(a, [branch]))) {
      return true;
    }
  }

  const withA = entities(a, "With");
  const withoutA = entities(a, "Without");
  const withB = entities(b, "With");
  const withoutB = entities(b, "Without");
  for (const entity of withA) if (withoutB.has(entity)) return true;
  for (const entity of withoutA) if (withB.has(entity)) return true;
  return false;
}

function entities(atoms: FilterAtom[], type: "With" | "Without"): Set<string> {
  const set = new Set<string>();
  for (const atom of atoms) if (atom.type === type && atom.entity) set.add(atom.entity);
  return set;
}

/** Check whether two raw filter lists provide disjointness for the same entity. */
export function checkFilterDisjointness(filtersA: string[], filtersB: string[]): boolean {
  return disjoint(parseFilters(filtersA), parseFilters(filtersB));
}
