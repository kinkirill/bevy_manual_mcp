/** Depth-aware Rust function parser — splits parameters at top-level commas. */

/** Split a parameter list on top-level commas, respecting angle brackets. */
export function splitParams(paramList: string): string[] {
  let depth = 0;
  let start = 0;
  const segments: string[] = [];

  for (let i = 0; i < paramList.length; i++) {
    const ch = paramList[i]!;
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;

    if (depth !== 0) continue;

    // Check for comma at top level
    if (ch === ",") {
      const seg = paramList.slice(start, i).trim();
      if (seg.length > 0) segments.push(seg);
      start = i + 1;
    }
  }

  // Push remaining segment
  const lastSeg = paramList.slice(start).trim();
  if (lastSeg.length > 0) segments.push(lastSeg);

  return segments;
}

/** Strip `mut`, `&`, lifetimes, `pub` from a parameter string. */
export function stripParamAttrs(param: string): string {
  let s = param.trim();
  // Remove leading mut references: &mut T or just mut
  s = s.replace(/^&mut\s+/, "");
  s = s.replace(/^&\s+/, "");
  s = s.replace(/^mut\s+/, "");
  s = s.replace(/^pub\s+/, "");
  return s.trim();
}

/** Classify a parameter into its access pattern. */
export type ParamKind =
  | { kind: "Query"; data: string; filters?: string[] }
  | { kind: "Res" }
  | { kind: "ResMut" }
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

export function classifyParam(param: string): ParamKind {
  const cleaned = stripParamAttrs(param);
  const trimmed = cleaned.trim();

  // Query<D, F>
  if (trimmed.startsWith("Query<")) {
    const params = splitParams(trimmed.slice(6, -1)); // strip "Query<" and ">"
    const dataPart = params[0] ?? "";
    const filterParts: string[] = [];
    for (let i = 1; i < params.length; i++) {
      const f = params[i]!;
      if (f) filterParts.push(f);
    }
    return { kind: "Query", data: dataPart, filters: filterParts };
  }

  // ResMut<T>
  if (/^ResMut</.test(trimmed)) {
    const inner = trimmed.match(/^ResMut<([^>]+)>/)?.[1];
    return { kind: "ResMut" };
  }

  // Res<T> (but not ResMut)
  if (/^Res</.test(trimmed)) {
    return { kind: "Res" };
  }

  // NonSendMut<T>
  const nonSendMut = trimmed.match(/^NonSendMut<([^>]+)>/);
  if (nonSendMut) return { kind: "NonSendMut", name: nonSendMut[1]! };

  // NonSend<T>
  const nonSend = trimmed.match(/^NonSend<([^>]+)>/);
  if (nonSend) return { kind: "NonSend", name: nonSend[1]! };

  // Local<T>
  const local = trimmed.match(/^Local<([^>]+)>/);
  if (local) return { kind: "Local", name: local[1]! };

  // Commands
  if (trimmed === "Commands") return { kind: "Commands" };

  // &mut World / mut World / WorldMut
  if (/^(?:&\s+)?mut\s+World$/.test(trimmed) || trimmed.match(/^&?\s*mut\s*World$/)) {
    return { kind: "WorldMutRef" };
  }
  if (/^&\s+(?!mut\s+)(World|world)$/.test(trimmed)) {
    return { kind: "WorldRef" };
  }

  // SystemParamSet<(…)> / ParamSet<(…)>
  const paramSet = trimmed.match(/^(SystemParamSet|ParamSet)<((?:[^()>]|<[^>]*>)*)>/);
  if (paramSet && paramSet[2]) {
    return { kind: paramSet[1] === "SystemParamSet" ? "SystemParamSet" : "ParamSet", params: splitParams(paramSet[2]) };
  }

  // EventReader<T> / MessageReader<T>
  const reader = trimmed.match(/^(EventReader|MessageReader)<([^>]+)>/);
  if (reader) return { kind: `Event${reader[1] === "Event" ? "Reader" : "Reader"}`, name: reader[2] ?? "unknown" };

  // EventWriter<T> / MessageWriter<T>
  const writer = trimmed.match(/^(EventWriter|MessageWriter)<([^>]+)>/);
  if (writer) return { kind: `Event${writer[1] === "Event" ? "Writer" : "Writer"}`, name: writer[2] ?? "unknown" };

  return { kind: "Other" };
}

/** Analyze a full function signature into its parameters. */
export interface SystemAnalysis {
  params: ParamKind[];
  rawParams: string[];
}

export function analyzeSystem(code: string): SystemAnalysis | null {
  // Find the fn keyword and extract parameter list
  const fnMatch = code.match(/fn\s+(\w+)\s*\(([^)]*)\)/);
  if (!fnMatch) return null;

  const paramStr = fnMatch[2];
  if (!paramStr || !paramStr.trim()) {
    // Empty params — still valid but no analysis needed
    return { params: [], rawParams: [] };
  }

  // Split on top-level commas
  const rawParams = splitParams(paramStr);
  const params = rawParams.map((p) => classifyParam(p));

  return { params, rawParams };
}
