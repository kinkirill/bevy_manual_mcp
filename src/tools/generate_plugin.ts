/** `bevy_generate_plugin` tool — version-correct plugin generation scaffolds. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BevyIndex } from "../store.js";
import type { ToolContext, VersionResolution } from "./types.js";

/** Template definitions for plugin generation. */
interface PluginTemplate {
  id: string;
  title: string;
  /** Symbols that must exist in the pinned index. Diagnostic, not a compile check. */
  requires: string[];
  /** Named, allowlisted placeholders and their defaults. */
  slots: Record<string, string>;
  /** Template with `{{SLOT}}` placeholders. Every referenced type is declared here. */
  shape: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Load templates from vendored data or use built-in definitions. */
function getTemplates(): PluginTemplate[] {
  return [
    {
      id: "plugin-skeleton",
      title: "Minimal Plugin with one system and one resource",
      requires: ["App", "Plugin", "add_systems"],
      slots: {
        PLUGIN_NAME: "MyPlugin",
        RESOURCE_TYPE: "MyResource",
        SYSTEM_NAME: "my_system",
      },
      shape: `use bevy::prelude::*;

#[derive(Resource)]
pub struct {{RESOURCE_TYPE}};

pub struct {{PLUGIN_NAME}};

impl Plugin for {{PLUGIN_NAME}} {
    fn build(&self, app: &mut App) {
        app.init_resource::<{{RESOURCE_TYPE}}>()
            .add_systems(Update, {{SYSTEM_NAME}});
    }
}

fn {{SYSTEM_NAME}}(resource: Res<{{RESOURCE_TYPE}}>) {
    let _ = &resource;
}`,
    },
    {
      id: "plugin-with-systemset",
      title: "Plugin with a SystemSet for ordering",
      requires: ["App", "Plugin", "SystemSet", "add_systems"],
      slots: {
        PLUGIN_NAME: "MyPlugin",
        RESOURCE_TYPE: "MyResource",
        SYSTEM_NAME: "my_system",
        SYSTEM_SET_NAME: "MySystemSet",
      },
      shape: `use bevy::prelude::*;

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct {{SYSTEM_SET_NAME}};

#[derive(Resource)]
pub struct {{RESOURCE_TYPE}};

pub struct {{PLUGIN_NAME}};

impl Plugin for {{PLUGIN_NAME}} {
    fn build(&self, app: &mut App) {
        app.init_resource::<{{RESOURCE_TYPE}}>()
            .configure_sets(Update, {{SYSTEM_SET_NAME}})
            .add_systems(Update, {{SYSTEM_NAME}}.in_set({{SYSTEM_SET_NAME}}));
    }
}

fn {{SYSTEM_NAME}}(resource: Res<{{RESOURCE_TYPE}}>) {
    let _ = &resource;
}`,
    },
  ];
}

/** Verify required symbols exist in the index. This is a name check, not a compile. */
function verifySymbols(idx: BevyIndex, requires: string[]): boolean {
  for (const symbol of requires) {
    if (!idx.lookupSymbol(symbol).length) return false;
  }
  return true;
}

interface FillResult {
  code: string;
  ignored: string[];
  invalid: string[];
}

/**
 * Fill template slots with the user's parameters. Keys are matched against the
 * template's allowlist and values must be Rust identifiers, so an arbitrary key
 * can never become a regular expression or corrupt the output.
 */
function fillTemplate(template: PluginTemplate, params: Record<string, unknown>): FillResult {
  const values = new Map<string, string>(Object.entries(template.slots));
  const ignored: string[] = [];
  const invalid: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(params)) {
    const key = rawKey.toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(template.slots, key)) {
      ignored.push(rawKey);
      continue;
    }
    if (typeof rawValue !== "string" || !IDENTIFIER.test(rawValue)) {
      invalid.push(rawKey);
      continue;
    }
    values.set(key, rawValue);
  }

  let code = template.shape;
  for (const [slot, value] of values) {
    code = code.split(`{{${slot}}}`).join(value);
  }
  return { code, ignored, invalid };
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, resolveVersion, unavailableVersion } = ctx;

  server.registerTool(
    "bevy_generate_plugin",
    {
      title: "Generate version-correct plugin scaffolds",
      description:
        `Generates a self-contained plugin skeleton for the pinned Bevy version. Every type the ` +
        `scaffold references is declared in the output, and the required Bevy symbols are checked ` +
        `against the pinned index first; a missing symbol refuses that template. The symbol check is ` +
        `a diagnostic, not a compile: the tool reports \`compile_verified: false\` and never claims ` +
        `the scaffold was compiled. Supported parameters: PLUGIN_NAME, RESOURCE_TYPE, SYSTEM_NAME ` +
        `(and SYSTEM_SET_NAME for the SystemSet template); unknown keys are returned in ` +
        `\`ignored_params\` and malformed values are rejected.`,
      inputSchema: {
        template: z
          .string()
          .describe("Template ID: plugin-skeleton, plugin-with-systemset."),
        params: z.record(z.string(), z.unknown()).optional().describe("Optional parameters for the template."),
      },
    },
    async ({ template, params }) => {
      const res: VersionResolution = await resolveVersion();
      if (!res.known) return unavailableVersion(config.bevyVersion!);
      const idx = res.index;

      const templates = getTemplates();
      const selectedTemplate = templates.find((candidate) => candidate.id === template);

      if (!selectedTemplate) {
        return {
          isError: true,
          content: [{ type: "text", text: "Unknown template ID. Available: " + templates.map((candidate) => "`" + candidate.id + "`").join(", ") }],
        };
      }

      if (!verifySymbols(idx, selectedTemplate.requires)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Template requires symbols not found in Bevy ${config.bevyVersion}: ${selectedTemplate.requires.join(", ")}` }],
        };
      }

      const filled = fillTemplate(selectedTemplate, params ?? {});
      if (filled.invalid.length) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Malformed parameter value(s): ${filled.invalid.join(", ")}. ` +
              `Each must be a Rust identifier (letters, digits and underscores, not starting with a digit).`,
          }],
          structuredContent: { template_id: selectedTemplate.id, invalid_params: filled.invalid },
        };
      }

      const acceptedSlots = Object.keys(selectedTemplate.slots);

      return {
        content: [{ type: "text", text: "## Plugin Scaffold\n\n```rust\n" + filled.code + "\n```\n" }],
        structuredContent: {
          template_id: selectedTemplate.id,
          title: selectedTemplate.title,
          bevy_version: config.bevyVersion,
          code: filled.code,
          symbol_check: "passed",
          compile_verified: false,
          compile_note: "Bevy symbols were checked against the index; the scaffold was not compiled.",
          accepted_params: acceptedSlots,
          ignored_params: filled.ignored,
        },
      };
    },
  );
}
