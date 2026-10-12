/** Conflict rules R1–R7 for Bevy system parameter validation. */
import type { AccessPattern } from "./access.js";
import type { ParamKind } from "./rust-fn.js";
import { checkFilterDisjointness, parseFilters } from "./filters.js";

export interface Finding {
  rule: string;    // e.g., "R1", "B0001"
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
export function checkConflicts(
  params: ParamKind[],
  filtersA?: string[],
  filtersB?: string[],
): Finding[] {
  const findings: Finding[] = [];

  // Collect mutable and immutable accesses by resource type
  const mutableByType = new Map<string, boolean>(); // resourceType -> has mut access
  const immutableByType = new Map<string, boolean>(); // resourceType -> has immut access

  for (const p of params) {
    switch (p.kind) {
      case "Query": {
        const isMut = /&mut\s+/.test(p.data) || /\bmut\s+\w+/.test(p.data);
        const resourceType = extractResourceType(p.data);
        if (resourceType) {
          if (isMut) mutableByType.set(resourceType, true);
          else immutableByType.set(resourceType, true);

          // R1: Query<&mut T> + Query<&T> without disjoint filters
          if (mutableByType.has(resourceType) && immutableByType.has(resourceType)) {
            const hasDisjointFilters = checkFilterDisjointness(filtersA ?? [], filtersB ?? []);
            if (!hasDisjointFilters && p.filters?.length) {
              // Check if this query's own filters provide disjointness
              const selfHasWithout = parseFilters(p.filters).some((f) => f.type === "Without");
              if (!selfHasWithout) {
                findings.push({
                  rule: "R1",
                  severity: "panic",
                  resourceType,
                  description: `Query<&mut ${resourceType}> and Query<&${resourceType}> without disjoint filters — B0001 panic`,
                  errorCode: "B0001",
                });
              }
            }
          }
        }

        // Check for conflicting Query filters within the same query
        if (p.filters) {
          const withEntities = new Set<string>();
          const withoutEntities = new Set<string>();
          for (const f of parseFilters(p.filters)) {
            if (!f.entity) continue;
            switch (f.type) {
              case "With": withEntities.add(f.entity); break;
              case "Without": withoutEntities.add(f.entity); break;
            }
          }

          // Self-check: With<X> and Without[X] in same query is fine (disjointed by design)
        }
        break;
      }
      case "ResMut": {
        mutableByType.set("ResMut", true);
        break;
      }
      case "Res": {
        // R3: Res<T> + ResMut<T>
        if (mutableByType.has("ResMut")) {
          findings.push({
            rule: "R3",
            severity: "panic",
            resourceType: undefined,
            paramA: "ResMut",
            paramB: "Res",
            description: "Res<T> alongside ResMut<T> — B0002 panic (mutable + immutable borrow)",
            errorCode: "B0002",
          });
        }
        break;
      }
      case "NonSendMut": {
        mutableByType.set(p.name, true);
        break;
      }
      case "NonSend": {
        // R4: NonSend<T> + NonSendMut<T>
        if (mutableByType.has(p.name)) {
          findings.push({
            rule: "R4",
            severity: "panic",
            resourceType: p.name,
            paramA: "NonSendMut",
            paramB: "NonSend",
            description: `NonSend<${p.name}> alongside NonSendMut<${p.name}> — B0002 panic`,
            errorCode: "B0002",
          });
        }
        break;
      }
      case "WorldMutRef": {
        // R5: &mut World + any other resource-bearing param
        const hasOtherParams = params.some((p) =>
          p.kind !== "WorldMutRef" && p.kind !== "WorldRef");
        if (hasOtherParams) {
          findings.push({
            rule: "R5",
            severity: "panic",
            resourceType: "World",
            paramA: "&mut World",
            description: "&mut World alongside other resources — B0002 family panic",
            errorCode: "B0002",
          });
        }
        break;
      }
    }
  }

  // R2: Two Query<&mut T> on the same T (already handled in above)
  // Count mutable accesses per type
  const mutCountByType = new Map<string, number>();
  for (const p of params) {
    if (p.kind === "Query") {
      const isMut = /&mut\s+/.test(p.data);
      const resourceType = extractResourceType(p.data);
      if (isMut && resourceType) {
        mutCountByType.set(resourceType, (mutCountByType.get(resourceType) ?? 0) + 1);
      }
    }
  }

  for (const [resourceType, count] of mutCountByType) {
    if (count > 1) {
      findings.push({
        rule: "R2",
        severity: "panic",
        resourceType,
        description: `Two Query<&mut ${resourceType}> — B0001 panic`,
        errorCode: "B0001",
      });
    }
  }

  return findings;
}

/** Extract the resource type from a Query data part. */
function extractResourceType(dataPart: string): string | undefined {
  const trimmed = dataPart.trim();
  const match = trimmed.match(/&(?:mut\s+)?(\w+)/);
  return match?.[1];
}
