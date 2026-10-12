/** Access pattern extraction from system parameters. */
import type { ParamKind } from "./rust-fn.js";

export interface AccessPattern {
  resourceType?: string;    // e.g., "Transform", "Assets<Mesh>", "Camera"
  isMutable: boolean;       // true for &mut, ResMut, Mut<T> etc.
  paramKind: ParamKind["kind"];
}

/** Extract access patterns from classified parameters. */
export function extractAccessPatterns(params: ParamKind[]): AccessPattern[] {
  const results: AccessPattern[] = [];

  for (const p of params) {
    switch (p.kind) {
      case "Query": {
        // Query<T> — the data part tells us what we access
        const isMut = /&mut\s+/.test(p.data) || /\bmut\s+\w+/.test(p.data);
        results.push({ resourceType: extractResourceType(p.data), isMutable: isMut, paramKind: "Query" });
        break;
      }
      case "Res": {
        const inner = p.kind === "Res" ? undefined : undefined; // Res has no name property
        results.push({ resourceType: extractResourceType("Res"), isMutable: false, paramKind: "Res" });
        break;
      }
      case "ResMut": {
        results.push({ resourceType: extractResourceType("ResMut"), isMutable: true, paramKind: "ResMut" });
        break;
      }
      case "NonSend": {
        results.push({ resourceType: p.name, isMutable: false, paramKind: "NonSend" });
        break;
      }
      case "NonSendMut": {
        results.push({ resourceType: p.name, isMutable: true, paramKind: "NonSendMut" });
        break;
      }
      case "Local": {
        // Local doesn't have mutable access conflicts in the same way
        results.push({ resourceType: p.name, isMutable: false, paramKind: "Local" });
        break;
      }
      case "Commands": {
        results.push({ resourceType: "Commands", isMutable: true, paramKind: "Commands" });
        break;
      }
      case "WorldMutRef": {
        results.push({ resourceType: "World", isMutable: true, paramKind: "WorldMutRef" });
        break;
      }
      case "WorldRef": {
        results.push({ resourceType: "World", isMutable: false, paramKind: "WorldRef" });
        break;
      }
      default: {
        // Event readers/writers don't cause access conflicts
        break;
      }
    }
  }

  return results;
}

/** Extract the resource type from a Query data part. */
function extractResourceType(dataPart: string): string | undefined {
  const trimmed = dataPart.trim();
  // Match &T, &mut T, Entity, etc.
  const match = trimmed.match(/&(?:mut\s+)?(\w+)/);
  return match?.[1];
}
