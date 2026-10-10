/**
 * Extract a clean type name from a rustdoc impl header.
 *
 * rustdoc renders impl headers as prose, which means they can carry generic
 * bounds and `where` clauses:
 *
 *   impl Sphere                                  -> "Sphere"
 *   impl<T> Rect<T>                             -> "Rect"
 *   impl Add for Vec3                            -> trait "Add", type "Vec3"
 *   impl<T> Trait<T> for Foo<T> where T: Bar     -> trait "Trait", type "Foo"
 *   impl Sphere where Sphere: Send + Sync + 'static  -> "Sphere"   <-- the bug
 *
 * A naive `replace(/<.*$/, "")` stops at the first `<` and leaves the rest
 * glued on, producing paths like
 * `Spherewhere Sphere: Send + Sync + 'static`, which corrupts the symbol table
 * (the same owner yields a different key per bound set).
 */

/** Strip generic arguments and any trailing `where ...` clause. */
function stripGenericsAndBounds(text: string) {
  let out = text;
  // Drop a where clause first: it can appear after the generics.
  const whereIdx = out.search(/\bwhere\b/);
  if (whereIdx !== -1) out = out.slice(0, whereIdx);
  // Then take the head before any `<`.
  const ltIdx = out.indexOf("<");
  if (ltIdx !== -1) out = out.slice(0, ltIdx);
  return out.trim();
}

/**
 * Parse an impl header.
 * Returns { traitName, typeName } where either may be null.
 * For an inherent impl (`impl Foo`) only typeName is set.
 */
export function parseImplHeader(headerText: string | null | undefined) {
  let text = String(headerText || "")
    .replace(/\s+/g, " ")
    .replace(/§/g, "")
    .trim();
  if (!text) return { traitName: null, typeName: null };

  // A rustdoc `where` clause is a nested <div class="where">, not inline text.
  // Without stripping it, its contents ("Sphere: Send + Sync + 'static,") get
  // glued onto the type name. The DOM-aware caller removes it first; this
  // fallback covers plain-text callers.
  text = text.replace(/\bwhere\b[\s\S]*$/i, "");

  // Remove the leading `impl` keyword and any `unsafe`/`const` markers.
  text = text.replace(/^impl(?:<.*?>)?\s+/, "").trim();

  // Split on the LAST top-level ` for `, since generics may contain `for`.
  // `where` clauses are removed by stripGenericsAndBounds below, so search for
  // the final occurrence.
  const forIdx = text.lastIndexOf(" for ");
  if (forIdx === -1) {
    return { traitName: null, typeName: stripGenericsAndBounds(text) || null };
  }

  const lhs = text.slice(0, forIdx);
  const rhs = text.slice(forIdx + 5);
  return {
    traitName: stripGenericsAndBounds(lhs) || null,
    typeName: stripGenericsAndBounds(rhs) || null,
  };
}

/**
 * The owning type for a method, from the impl header text.
 * Null for an inherent impl, since the caller falls back to the page's item.
 */
export function ownerFromImplText(headerText: string | null | undefined) {
  const { traitName, typeName } = parseImplHeader(headerText);
  // An inherent `impl Foo` gives typeName with no trait; a trait impl gives
  // both. Either way the owner is the type after `for`.
  if (traitName) return typeName;
  return typeName;
}

/**
 * The trait name for a trait impl, or null for an inherent impl.
 * Used to decide whether a method is real API or trait boilerplate.
 */
export function traitFromImplText(headerText: string | null | undefined) {
  return parseImplHeader(headerText).traitName;
}

export const _internal = { stripGenericsAndBounds };
