/** Opaque, query-bound cursors for resource listings. */
import { createHash } from "node:crypto";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { isObject, parseJson } from "./types.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decode(cursor: string): unknown {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(cursor)) return null;
    return parseJson(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch { return null; }
}
function fingerprint(query: unknown): string {
  const fields = isObject(query) ? query : {};
  const ordered = Object.keys(fields).sort().map((key) => [key, fields[key]]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
export interface Page<T> { items: T[]; nextCursor?: string; pageSize: number; total: number }
export function paginate<T>(
  items: readonly T[], query: unknown, cursor?: string, opts: { pageSize?: number } = {},
): Page<T> {
  const requestedSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(Number.isFinite(requestedSize) ? Math.floor(requestedSize) : DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const qid = fingerprint(query);
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decode(cursor);
    if (!isObject(decoded) || typeof decoded.o !== "number" || !Number.isSafeInteger(decoded.o) || decoded.o < 0 || decoded.o > items.length) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid cursor");
    }
    if (decoded.q !== qid) {
      throw new McpError(ErrorCode.InvalidParams, "Cursor does not belong to this query; restart the listing without a cursor.");
    }
    offset = decoded.o;
  }
  const slice = items.slice(offset, offset + pageSize);
  const nextOffset = offset + slice.length;
  return { items: slice, nextCursor: nextOffset < items.length ? encode({ o: nextOffset, q: qid }) : undefined,
    pageSize, total: items.length };
}
export function completionResult(values: string[], total?: number): { values: string[]; total: number; hasMore: boolean } {
  const capped = values.slice(0, 100);
  return { values: capped, total: total ?? values.length, hasMore: (total ?? values.length) > capped.length };
}
export const _internal = { encode, decode, fingerprint, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };
