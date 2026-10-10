import { z } from "zod";

export type RecordSource = "rustdoc" | "website" | "bevy-examples" | "learn-examples";

export interface DocExample {
  lang: string;
  code: string;
  compile_fail: boolean;
  ignored: boolean;
  scraped: boolean;
  source_file: string | null;
}

interface RecordBase {
  id?: string;
  kind: string;
  name: string;
  full_path: string;
  docs: string;
  signature: string;
  module: string;
  file: string;
  owner?: string | null;
  crate?: string | null;
  source_ref?: string | null;
  bevy_version?: string | null;
  title?: string;
  defaults?: string;
  examples?: DocExample[];
  heading?: string | null;
  breadcrumb?: string[];
  line_start?: number;
  draft?: boolean;
  version?: string | null;
  from_version?: string | null;
  to_version?: string | null;
  pr?: number | null;
  description?: string;
  code?: string;
  file_abs?: string;
  line_count?: number;
  categories?: string[];
  required_features?: string[];
}

export interface RustdocRecord extends RecordBase { source: "rustdoc" }
export interface WebsiteRecord extends RecordBase { source: "website" }
export interface CodeExampleRecord extends RecordBase { source: "bevy-examples" | "learn-examples" }
export type BevyRecord = RustdocRecord | WebsiteRecord | CodeExampleRecord;
export type DocumentationRecord = BevyRecord;
export type IndexedRecord = BevyRecord & { id: string };
export interface SearchHit { record: IndexedRecord; score: number }
export interface SearchFilters {
  kind?: string;
  source?: string;
  module?: string;
  category?: string;
  crate?: string;
  draft?: boolean;
}

export interface IndexConfig {
  projectRoot: string;
  bevyVersion: string | null;
  versionSource: string | null;
  docDir: string | null;
  websiteDir: string | null;
  examplesDir: string | null;
  dataDir: string;
}
export interface ResolvedConfig extends IndexConfig {
  versionNote?: string;
  configPath: string | null;
  docVersion: string | null;
  docVersionSource: string | null;
  bevySrcDir: string | null;
  errorsDir: string | null;
  mirrorDir: string;
  env: { offline: boolean; maxResults: number; debug: boolean };
}
export interface IndexMetadata {
  bevy_version: string | null;
  cache_version?: number;
  fingerprint?: string;
  supplemental_fingerprint?: string;
  version_source?: string | null;
  doc_dir?: string | null;
  website_dir?: string | null;
  examples_dir?: string | null;
  project_root?: string;
  built_at?: string;
  build_ms?: number;
  symbols?: number;
  api_records?: number;
  text_indexed?: number;
}
export interface IndexStats {
  total: number;
  by_source: Record<string, number>;
  by_kind: Record<string, number>;
}

export type ResourceQuery =
  | { type: "index" }
  | { type: "api"; version: string; path: string }
  | { type: "kind"; version: string; kind: string }
  | { type: "module"; version: string; module: string }
  | { type: "crate"; version: string; crate: string }
  | { type: "owner"; version: string; owner: string }
  | { type: "doc"; version: string; file: string };

export interface VersionParts { major: number; minor: number; patch: number; raw: string; prerelease: string | null }
export interface VersionBump {
  level: "unknown" | "none" | "major" | "minor" | "patch" | "downgrade";
  breaksApi: boolean;
  direction: "unknown" | "same" | "upgrade" | "downgrade";
  label: string;
  from?: VersionParts | null;
  to?: VersionParts | null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseJson(text: string): unknown { return JSON.parse(text) as unknown; }

const nullableString = z.string().nullable().optional();
const recordSchema = z.object({
  id: z.string().optional(),
  source: z.enum(["rustdoc", "website", "bevy-examples", "learn-examples"]),
  kind: z.string(), name: z.string(), full_path: z.string(), docs: z.string(),
  signature: z.string(), module: z.string(), file: z.string(),
  owner: nullableString, crate: nullableString, source_ref: nullableString,
  bevy_version: nullableString, title: z.string().optional(), defaults: z.string().optional(),
  examples: z.array(z.object({
    lang: z.string(), code: z.string(), compile_fail: z.boolean(), ignored: z.boolean(),
    scraped: z.boolean(), source_file: z.string().nullable(),
  })).optional(),
  heading: nullableString, breadcrumb: z.array(z.string()).optional(), line_start: z.number().optional(),
  draft: z.boolean().optional(), version: nullableString, from_version: nullableString,
  to_version: nullableString, pr: z.number().nullable().optional(), description: z.string().optional(),
  code: z.string().optional(), file_abs: z.string().optional(), line_count: z.number().optional(),
  categories: z.array(z.string()).optional(), required_features: z.array(z.string()).optional(),
});
export function parseRecord(value: unknown): BevyRecord { return recordSchema.parse(value); }

const metadataSchema = z.object({
  bevy_version: z.string().nullable(), cache_version: z.number().int().optional(),
  fingerprint: z.string().optional(), supplemental_fingerprint: z.string().optional(),
  version_source: nullableString, doc_dir: nullableString, website_dir: nullableString,
  examples_dir: nullableString, project_root: z.string().optional(), built_at: z.string().optional(),
  build_ms: z.number().optional(), symbols: z.number().optional(), api_records: z.number().optional(),
  text_indexed: z.number().optional(),
});
export function parseMetadata(value: unknown): IndexMetadata { return metadataSchema.parse(value); }
