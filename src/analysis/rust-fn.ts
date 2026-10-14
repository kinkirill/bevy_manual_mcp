/** Depth-aware Rust function parser — splits parameters at top-level commas. */

/** Split a parameter list on top-level commas, respecting brackets. */
export function splitParams(paramList: string): string[] {
  let depth = 0;
  let start = 0;
  const segments: string[] = [];

  for (let i = 0; i < paramList.length; i++) {
    const ch = paramList[i]!;
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;

    if (depth !== 0) continue;

    if (ch === ",") {
      const seg = paramList.slice(start, i).trim();
      if (seg.length > 0) segments.push(seg);
      start = i + 1;
    }
  }

  const lastSeg = paramList.slice(start).trim();
  if (lastSeg.length > 0) segments.push(lastSeg);

  return segments;
}

/** Index of the closer matching the opener at `open`, or -1 when unbalanced. */
export function matchingClose(text: string, open: number): number {
  const opening = text[open];
  const closer = opening === "(" ? ")" : opening === "<" ? ">" : opening === "[" ? "]" : null;
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

/** Index of the top-level `:` separating a binding from its type, or -1. */
function bindingColon(param: string): number {
  let depth = 0;
  for (let i = 0; i < param.length; i++) {
    const ch = param[i]!;
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    else if (ch === ":" && depth === 0) {
      // Skip the `::` path separator inside a type.
      if (param[i + 1] === ":") { i++; continue; }
      return i;
    }
  }
  return -1;
}

/** Reduce a parameter to its type expression: drop `name:`, `mut` and `pub`. */
export function stripParamAttrs(param: string): string {
  const s = param.trim();
  const colon = bindingColon(s);
  if (colon !== -1) return s.slice(colon + 1).trim();
  return s.replace(/^(?:pub\s+)?mut\s+/, "").trim();
}

/** One component access within a `Query` data expression. */
export interface QueryAccess {
  /** Normalized type path, e.g. "Transform" or "bevy::prelude::Transform". */
  type: string;
  /** Last path segment, for display. */
  name: string;
  mutable: boolean;
  optional: boolean;
}

/** Classify a parameter into its access pattern. */
export type ParamKind =
  | { kind: "Query"; accesses: QueryAccess[]; filters?: string[]; unparsed?: string[] }
  | { kind: "Res"; name?: string }
  | { kind: "ResMut"; name?: string }
  | { kind: "NonSend"; name: string }
  | { kind: "NonSendMut"; name: string }
  | { kind: "Local"; name: string }
  | { kind: "Commands" }
  | { kind: "Entity" }
  | { kind: "WorldRef" }
  | { kind: "WorldMutRef" }
  | { kind: "SystemParamSet"; params?: string[] }
  | { kind: "ParamSet"; params?: string[] }
  | { kind: "EventReader"; name: string }
  | { kind: "EventWriter"; name: string }
  | { kind: "MessageReader"; name: string }
  | { kind: "MessageWriter"; name: string }
  | { kind: "Other" };

/** Return the text inside `Prefix<...>`, or null when `text` is not that generic. */
function genericArg(text: string, prefix: string): string | null {
  if (!text.startsWith(prefix)) return null;
  const open = prefix.length - 1; // the '<'
  const close = matchingClose(text, open);
  return close === -1 ? null : text.slice(open + 1, close).trim();
}

export function classifyParam(param: string): ParamKind {
  const trimmed = stripParamAttrs(param);
  if (!trimmed) return { kind: "Other" };

  const query = genericArg(trimmed, "Query<");
  if (query !== null) {
    const parts = splitParams(query);
    const { accesses, unparsed } = parseQueryData(parts[0] ?? "");
    return { kind: "Query", accesses, filters: parts.slice(1).filter(Boolean), unparsed };
  }

  const resMut = genericArg(trimmed, "ResMut<");
  if (resMut !== null) return { kind: "ResMut", name: resMut };
  const res = genericArg(trimmed, "Res<");
  if (res !== null) return { kind: "Res", name: res };

  const nonSendMut = genericArg(trimmed, "NonSendMut<");
  if (nonSendMut !== null) return { kind: "NonSendMut", name: nonSendMut };
  const nonSend = genericArg(trimmed, "NonSend<");
  if (nonSend !== null) return { kind: "NonSend", name: nonSend };

  const local = genericArg(trimmed, "Local<");
  if (local !== null) return { kind: "Local", name: local };

  if (trimmed === "Commands") return { kind: "Commands" };
  if (trimmed === "Entity") return { kind: "Entity" };
  if (/^&?\s*mut\s+World$/.test(trimmed)) return { kind: "WorldMutRef" };
  if (/^&\s*World$/.test(trimmed)) return { kind: "WorldRef" };

  const systemParamSet = genericArg(trimmed, "SystemParamSet<");
  if (systemParamSet !== null) return { kind: "SystemParamSet", params: splitParams(stripOuterParens(systemParamSet)) };
  const paramSet = genericArg(trimmed, "ParamSet<");
  if (paramSet !== null) return { kind: "ParamSet", params: splitParams(stripOuterParens(paramSet)) };

  for (const kind of ["MessageReader", "EventReader", "MessageWriter", "EventWriter"] as const) {
    const arg = genericArg(trimmed, `${kind}<`);
    if (arg !== null) return { kind, name: arg };
  }

  return { kind: "Other" };
}

function stripOuterParens(text: string): string {
  const s = text.trim();
  return s.startsWith("(") && matchingClose(s, 0) === s.length - 1 ? s.slice(1, -1) : s;
}

function lastSegment(typePath: string): string {
  const segment = typePath.split("::").pop() ?? typePath;
  return segment.replace(/<.*$/, "").trim() || segment;
}

/**
 * Parse a `Query` data expression into independent component accesses. Each
 * tuple member keeps its own read/write mode, and wrappers such as `Option`,
 * `AnyOf` and `Ref` are unwrapped. Expressions outside the supported subset are
 * returned in `unparsed` so the caller can report a bounded result.
 */
export function parseQueryData(data: string): { accesses: QueryAccess[]; unparsed: string[] } {
  const accesses: QueryAccess[] = [];
  const unparsed: string[] = [];

  const add = (typePath: string, mutable: boolean, optional: boolean): void => {
    const normalized = typePath.replace(/\s+/g, " ").replace(/,/g, ", ").trim();
    if (!normalized) return;
    accesses.push({ type: normalized, name: lastSegment(normalized), mutable, optional });
  };

  const visit = (expression: string, optional: boolean): void => {
    let text = expression.trim();
    while (text.startsWith("(") && matchingClose(text, 0) === text.length - 1) text = text.slice(1, -1).trim();
    if (!text) return;

    const parts = splitParams(text);
    if (parts.length > 1) { for (const part of parts) visit(part, optional); return; }

    const option = genericArg(text, "Option<");
    if (option !== null) { visit(option, true); return; }
    const anyOf = genericArg(text, "AnyOf<");
    if (anyOf !== null) { visit(anyOf, true); return; }

    // Filters used in data position, and entity handles, carry no component borrow.
    if (/^(?:Has|With|Without|Added|Changed)</.test(text)) return;
    if (/^(?:Entity|EntityLocation|EntityHash)$/.test(text)) return;

    const mut = text.match(/^&\s*mut\s+([\s\S]+)$/);
    if (mut) { add(mut[1]!, true, optional); return; }
    const read = text.match(/^&\s*([\s\S]+)$/);
    if (read) { add(read[1]!, false, optional); return; }
    const ref = genericArg(text, "Ref<");
    if (ref !== null) {
      const args = splitParams(ref);
      add(args[args.length - 1] ?? ref, false, optional);
      return;
    }
    if (/^[A-Za-z_][A-Za-z0-9_:<>, \t]*$/.test(text)) { add(text, false, optional); return; }
    unparsed.push(text);
  };

  visit(data, false);

  // Duplicate accesses on the same type merge and keep the most permissive mode.
  const merged = new Map<string, QueryAccess>();
  for (const access of accesses) {
    const existing = merged.get(access.type);
    if (!existing) { merged.set(access.type, access); continue; }
    existing.mutable = existing.mutable || access.mutable;
    existing.optional = existing.optional && access.optional;
  }
  return { accesses: [...merged.values()], unparsed };
}

function detectStringStart(code: string, index: number): { start: number; hashes: number } | null {
  let cursor = index;
  if (code[cursor] === "b") cursor++;
  if (code[cursor] === "r") {
    cursor++;
    let hashes = 0;
    while (code[cursor] === "#") { hashes++; cursor++; }
    return code[cursor] === '"' ? { start: cursor, hashes } : null;
  }
  return code[cursor] === '"' ? { start: cursor, hashes: 0 } : null;
}

function findStringEnd(code: string, startQuote: number, hashes: number): number {
  if (hashes > 0) {
    const closer = '"' + "#".repeat(hashes);
    const end = code.indexOf(closer, startQuote + 1);
    return end === -1 ? code.length : end + closer.length;
  }
  let cursor = startQuote + 1;
  while (cursor < code.length) {
    if (code[cursor] === "\\") { cursor += 2; continue; }
    if (code[cursor] === '"') return cursor + 1;
    cursor++;
  }
  return code.length;
}

/**
 * Replace comments and string literals with spaces while preserving offsets and
 * newlines, so a `fn` scan cannot match text inside a comment or a literal.
 */
export function stripRustTrivia(code: string): string {
  const out = code.split("");
  const length = code.length;
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < length; index++) if (out[index] !== "\n") out[index] = " ";
  };
  let index = 0;
  while (index < length) {
    const ch = code[index]!;
    const next = code[index + 1];
    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", index);
      blank(index, end === -1 ? length : end);
      index = end === -1 ? length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < length && depth > 0) {
        if (code[cursor] === "/" && code[cursor + 1] === "*") { depth++; cursor += 2; continue; }
        if (code[cursor] === "*" && code[cursor + 1] === "/") { depth--; cursor += 2; continue; }
        cursor++;
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }
    const stringStart = detectStringStart(code, index);
    if (stringStart) {
      const end = findStringEnd(code, stringStart.start, stringStart.hashes);
      blank(index, end);
      index = end;
      continue;
    }
    index++;
  }
  return out.join("");
}

/** Analyze a full function signature into its parameters. */
export interface SystemAnalysis {
  params: ParamKind[];
  rawParams: string[];
}

export function analyzeSystem(code: string): SystemAnalysis | null {
  const fnMatch = /\bfn\s+[A-Za-z0-9_]+\s*(?:<[^<>]*>)?/.exec(code);
  if (!fnMatch) return null;
  const open = code.indexOf("(", fnMatch.index + fnMatch[0].length);
  if (open === -1) return null;
  const close = matchingClose(code, open);
  if (close === -1) return null;

  const paramStr = code.slice(open + 1, close);
  if (!paramStr.trim()) return { params: [], rawParams: [] };

  const rawParams = splitParams(paramStr);
  return { params: rawParams.map(classifyParam), rawParams };
}
