import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function versionArgs(argv: string[], options: Record<string, { type: "string" | "boolean" }>) {
  const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  if (parsed.positionals.length > 1) throw new Error("Expected at most one Bevy version.");
  return { version: parsed.positionals[0], values: parsed.values };
}

export function stableVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid Bevy version "${version}"; use a stable version such as 0.20.0.`);
  }
  return version;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringOption(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function canonicalPath(target: string): string {
  let existing = path.resolve(target);
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

export function validateOutputTarget(target: string, protectedRoots: string[]): string {
  const resolved = canonicalPath(target);
  for (const root of [path.parse(resolved).root, os.homedir(), ...protectedRoots]) {
    const relative = path.relative(resolved, canonicalPath(root));
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error(`Refusing to replace protected directory ${target}. Choose a dedicated output directory.`);
    }
  }
  if (fs.existsSync(path.join(resolved, ".git"))) throw new Error(`Refusing to replace a Git checkout: ${target}.`);
  return resolved;
}
