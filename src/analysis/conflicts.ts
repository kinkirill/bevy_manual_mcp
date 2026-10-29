/** Conflict rules R1–R5 for Bevy system parameter validation. */
import type { ParamKind, QueryAccess } from "./rust-fn.js";
import { checkFilterDisjointness } from "./filters.js";

export interface Finding {
  rule: string;    // e.g., "R1", "R3"
  severity: "panic" | "compile-error" | "warning";
  resourceType?: string;
  paramA?: string;
  paramB?: string;
  description: string;
  errorCode?: string;
}

export interface ValidationResult {
  findings: Finding[];
  systemsChecked: number;
  systemsClean: number;
}

/** Run all conflict rules against extracted access patterns. */
export function checkConflicts(params: ParamKind[]): Finding[] {
  const findings: Finding[] = [];

  // R1 / R2 — conflicting Query component access (B0001), unless filters are
  // provably disjoint. Tuple members are compared individually.
  const queries: { accesses: QueryAccess[]; filters: string[] }[] = [];
  for (const p of params) {
    if (p.kind !== "Query" || !p.accesses.length) continue;
    queries.push({ accesses: p.accesses, filters: p.filters ?? [] });
  }
  for (let i = 0; i < queries.length; i++) {
    for (let j = i + 1; j < queries.length; j++) {
      const a = queries[i]!;
      const b = queries[j]!;
      if (checkFilterDisjointness(a.filters, b.filters)) continue;
      const reported = new Set<string>();
      for (const accessA of a.accesses) {
        for (const accessB of b.accesses) {
          if (accessA.type !== accessB.type) continue;
          if (!(accessA.mutable || accessB.mutable)) continue;
          if (reported.has(accessA.type)) continue;
          reported.add(accessA.type);
          const bothMutable = accessA.mutable && accessB.mutable;
          findings.push({
            rule: bothMutable ? "R2" : "R1",
            severity: "panic",
            resourceType: accessA.name,
            paramA: `Query<${accessA.mutable ? "&mut " : "&"}${accessA.type}>`,
            paramB: `Query<${accessB.mutable ? "&mut " : "&"}${accessB.type}>`,
            description: bothMutable
              ? `Two Query<&mut ${accessA.name}> without disjoint filters — B0001 panic`
              : `Query<&mut ${accessA.name}> and Query<&${accessA.name}> without disjoint filters — B0001 panic`,
            errorCode: "B0001",
          });
        }
      }
    }
  }

  // R3 — Res<T> alongside ResMut<T> for the same resource (B0002).
  const resources = new Map<string, { read: boolean; write: boolean }>();
  for (const p of params) {
    if (p.kind !== "Res" && p.kind !== "ResMut") continue;
    const type = p.name ?? "?";
    const entry = resources.get(type) ?? { read: false, write: false };
    if (p.kind === "ResMut") entry.write = true;
    else entry.read = true;
    resources.set(type, entry);
  }
  for (const [type, entry] of resources) {
    if (entry.read && entry.write) {
      findings.push({
        rule: "R3",
        severity: "panic",
        resourceType: type,
        paramA: `ResMut<${type}>`,
        paramB: `Res<${type}>`,
        description: `Res<${type}> alongside ResMut<${type}> — B0002 panic (mutable + immutable borrow)`,
        errorCode: "B0002",
      });
    }
  }

  // R4 — NonSend<T> alongside NonSendMut<T> for the same resource (B0002).
  const nonSend = new Map<string, { read: boolean; write: boolean }>();
  for (const p of params) {
    if (p.kind !== "NonSend" && p.kind !== "NonSendMut") continue;
    const entry = nonSend.get(p.name) ?? { read: false, write: false };
    if (p.kind === "NonSendMut") entry.write = true;
    else entry.read = true;
    nonSend.set(p.name, entry);
  }
  for (const [type, entry] of nonSend) {
    if (entry.read && entry.write) {
      findings.push({
        rule: "R4",
        severity: "panic",
        resourceType: type,
        paramA: `NonSendMut<${type}>`,
        paramB: `NonSend<${type}>`,
        description: `NonSend<${type}> alongside NonSendMut<${type}> — B0002 panic`,
        errorCode: "B0002",
      });
    }
  }

  // R5 — `&mut World` is exclusive and cannot share a system with other params.
  if (params.some((p) => p.kind === "WorldMutRef")) {
    const companion = params.find(
      (p) => p.kind !== "WorldMutRef" && p.kind !== "WorldRef" && p.kind !== "Other",
    );
    if (companion) {
      findings.push({
        rule: "R5",
        severity: "panic",
        resourceType: "World",
        paramA: "&mut World",
        description: "&mut World alongside other system parameters — B0002 family panic",
        errorCode: "B0002",
      });
    }
  }

  return findings;
}
