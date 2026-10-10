/** Extract stable type and trait names from rustdoc impl headers. */

/** Strip generic arguments and any trailing `where ...` clause. */
function stripGenericsAndBounds(text: string) {
  let out = text;
  const whereIdx = out.search(/\bwhere\b/);
  if (whereIdx !== -1) out = out.slice(0, whereIdx);
  const ltIdx = out.indexOf("<");
  if (ltIdx !== -1) out = out.slice(0, ltIdx);
  return out.trim();
}

/** Parse trait and type names; inherent impls have no trait name. */
export function parseImplHeader(headerText: string | null | undefined) {
  let text = String(headerText || "")
    .replace(/\s+/g, " ")
    .replace(/§/g, "")
    .trim();
  if (!text) return { traitName: null, typeName: null };

  // Plain-text callers may still contain bounds removed by the DOM parser.
  text = text.replace(/\bwhere\b[\s\S]*$/i, "");

  text = text.replace(/^impl(?:<.*?>)?\s+/, "").trim();

  // Use the final separator because generic bounds may also contain `for`.
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

/** Return the owning type for an inherent or trait impl. */
export function ownerFromImplText(headerText: string | null | undefined) {
  const { traitName, typeName } = parseImplHeader(headerText);
  if (traitName) return typeName;
  return typeName;
}

/** Return the implemented trait, or null for an inherent impl. */
export function traitFromImplText(headerText: string | null | undefined) {
  return parseImplHeader(headerText).traitName;
}

export const _internal = { stripGenericsAndBounds };
