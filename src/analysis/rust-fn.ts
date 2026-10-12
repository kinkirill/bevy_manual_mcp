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
function matchingClose(text: string, open: number): number {
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

/** Classify a parameter into its access pattern. */
export type ParamKind =
  | { kind: "Query"; data: string; filters?: string[] }
  | { kind: "Res"; name?: string }
  | { kind: "ResMut"; name?: string }
  | { kind: "NonSend"; name: string }
  | { kind: "NonSendMut"; name: string }
  | { kind: "Local"; name: string }
  | { kind: "Commands" }
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
    return { kind: "Query", data: parts[0] ?? "", filters: parts.slice(1).filter(Boolean) };
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
