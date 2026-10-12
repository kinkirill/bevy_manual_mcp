/** `bevy_generate_plugin` tool — version-correct plugin generation scaffolds. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hybridSearch, type BevyIndex } from "../store.js";
import type { ToolContext, VersionResolution } from "./types.js";

/** Template definitions for plugin generation. */
interface PluginTemplate {
  id: string;
  title: string;
  requires: string[];   // Symbols needed (App, Plugin, etc.)
  shape: string;        // Template with {{SLOT}} placeholders
  verify?: string[];    // Symbols to verify exist before generating
}

/** Load templates from vendored data or use built-in definitions. */
function getTemplates(): PluginTemplate[] {
  return [
    {
      id: "plugin-skeleton",
      title: "Minimal Plugin with one system and one resource",
      requires: ["App", "Plugin", "add_systems"],
      shape: `use bevy::prelude::*;

pub struct MyResource;

impl Plugin for MyPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<MyResource>()
            .add_systems(Update, my_system);
    }
}

fn my_system(resource: Res<MyResource>) {
    // TODO: implement logic
}`,
      verify: ["App", "Plugin", "add_systems"],
    },
    {
      id: "plugin-with-systemset",
      title: "Plugin with SystemSet for ordering",
      requires: ["App", "Plugin", "SystemSet", "add_systems"],
      shape: `use bevy::prelude::*;

#[system_set]
struct MySystemSet;

impl Plugin for MyPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<MyResource>()
            .configure_sets(Update, MySystemSet.before(OtherSystem))
            .add_systems(Update, my_system.in_set(MySystemSet));
    }
}

fn my_system(resource: Res<MyResource>) {
    // TODO: implement logic
}`,
      verify: ["App", "Plugin", "SystemSet", "add_systems"],
    },
  ];
}

/** Verify all required symbols exist in the index. */
function verifySymbols(idx: BevyIndex, requires: string[]): boolean {
  for (const symbol of requires) {
    const hits = idx.lookupSymbol(symbol);
    if (!hits.length) return false;
  }
  return true;
}

/** Fill template slots with the user's parameters. */
function fillTemplate(template: PluginTemplate, params: Record<string, unknown>): string {
  let result = template.shape;

  // Replace common slots
  const defaults: Record<string, string> = {
    "{{RESOURCE_TYPE}}": "MyResource",
    "{{SYSTEM_NAME}}": "my_system",
    "{{PLUGIN_NAME}}": "MyPlugin",
    "{{PARAMS}}": "resource: Res<MyResource>",
    "{{UPDATE}}": "",
  };

  for (const [key, value] of Object.entries(params)) {
    const slot = "{{" + key.toUpperCase() + "}}";
    if (typeof value === "string") {
      result = result.replace(new RegExp(slot.replace(/\*/g, "\\*").replace(/\?/g, "?"), "g"), value);
    }
  }

  // Fill any remaining default slots
  for (const [slot, defaultValue] of Object.entries(defaults)) {
    if (result.includes(slot)) {
      result = result.replace(new RegExp(slot.replace(/\*/g, "\\*").replace(/\?/g, "?"), "g"), defaultValue);
    }
  }

  return result;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, resolveVersion, unavailableVersion } = ctx;

  server.registerTool(
    "bevy_generate_plugin",
    {
      title: "Generate version-correct plugin scaffolds",
      description:
        `Generates plugin skeleton code for the pinned Bevy version. Templates are verified ` +
        `against the index before use — if a symbol is missing in this version, the tool refuses ` +
        `that template rather than emitting broken code.`,
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

      // Get templates and find the requested one
      const templates = getTemplates();
      const selectedTemplate = templates.find((t) => t.id === template);

      if (!selectedTemplate) {
        return {
          isError: true,
          content: [{ type: "text", text: "Unknown template ID. Available: " + templates.map((t) => "`" + t.id + "`").join(", ") }],
        };
      }

      // Verify all required symbols exist in this version's index
      if (selectedTemplate.verify) {
        const allExist = verifySymbols(idx, selectedTemplate.verify);
        if (!allExist) {
          return {
            isError: true,
            content: [{ type: "text", text: `Template requires symbols not found in Bevy ${config.bevyVersion}: ${selectedTemplate.requires.join(", ")}` }],
          };
        }
      }

      // Fill template with params (or use defaults)
      const code = fillTemplate(selectedTemplate, params ?? {});

      return {
        content: [{ type: "text", text: "## Plugin Scaffold\n\n```rust\n" + code + "\n```\n" }],
        structuredContent: {
          template_id: selectedTemplate.id,
          title: selectedTemplate.title,
          bevy_version: config.bevyVersion,
          code,
        },
      };
    },
  );
}
