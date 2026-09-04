/**
 * `plugins` subcommand: lets a host read and edit the plugin overrides file
 * without a live session (`bun src/main.ts plugins list --json`).
 *
 * Output is JSON on stdout; validation failures throw (non-zero exit) with
 * the reason on stderr — the host surfaces it verbatim.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_PRESETS,
  type HarnessPreset,
  type PluginConfigField,
  loadPluginOverrides,
  pluginRows,
  resolvePlugins,
  savePluginOverrides,
} from "./plugins.ts";

export function defaultPluginsFile(): string {
  return (
    process.env.ALWITH_DSH_PLUGINS_FILE ??
    join(homedir(), ".dsh-agent", "plugins.json")
  );
}

function configurableFields(id: string): PluginConfigField[] {
  const fields = new Map<string, PluginConfigField>();
  for (const preset of HARNESS_PRESETS) {
    const row = pluginRows({
      sessionsRoot: "/",
      workspaceRoot: "/",
      permissionMode: "workspace-write",
      preset,
    }).find((candidate) => candidate.id === id);
    for (const field of row?.configurable ?? []) fields.set(field.key, field);
  }
  if (fields.size === 0)
    throw new Error(`plugin "${id}" has no desktop-configurable fields`);
  return [...fields.values()];
}

function parseConfigPatch(
  id: string,
  raw: string,
): Record<string, unknown | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `plugin "${id}" config patch is not valid JSON: ${String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`plugin "${id}" config patch must be a JSON object`);
  }
  const fields = new Map(
    configurableFields(id).map((field) => [field.key, field]),
  );
  for (const [key, value] of Object.entries(parsed)) {
    const field = fields.get(key);
    if (field === undefined)
      throw new Error(
        `plugin "${id}" field "${key}" is not desktop-configurable`,
      );
    if (value === null) continue;
    if (field.type === "number") {
      if (
        !Number.isInteger(value) ||
        (field.minimum !== undefined && (value as number) < field.minimum)
      ) {
        throw new Error(
          `plugin "${id}" field "${key}" must be an integer >= ${field.minimum}`,
        );
      }
    } else if (typeof value !== "string" || !URL.canParse(value)) {
      throw new Error(`plugin "${id}" field "${key}" must be an absolute URL`);
    }
  }
  return parsed as Record<string, unknown | null>;
}

interface CliFlags {
  preset: HarnessPreset;
  file: string;
  positional: string[];
}

function parseFlags(argv: string[]): CliFlags {
  let preset = process.env.ALWITH_DSH_PRESET ?? "standard";
  let file = defaultPluginsFile();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--preset") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--preset requires a value");
      preset = value;
      index += 1;
    } else if (argument === "--file") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--file requires a value");
      file = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown flag ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (!(HARNESS_PRESETS as readonly string[]).includes(preset)) {
    throw new Error(
      `unsupported preset "${preset}": expected one of ${HARNESS_PRESETS.join(", ")}`,
    );
  }
  return { preset: preset as HarnessPreset, file, positional };
}

function listingFor(preset: HarnessPreset, file: string) {
  const overrides = loadPluginOverrides(file);
  // Listing does not touch the sandbox or session log; placeholder roots keep
  // the row configs representative without requiring the host's real paths.
  const rows = pluginRows({
    sessionsRoot: join(homedir(), ".dsh-agent", "sessions"),
    workspaceRoot: process.cwd(),
    permissionMode: "workspace-write",
    preset,
  });
  return { preset, file, plugins: resolvePlugins(rows, overrides).listing };
}

/** Rejects an overrides state that any preset would refuse to compose. */
function assertValidAcrossPresets(
  overrides: ReturnType<typeof loadPluginOverrides>,
): void {
  for (const preset of HARNESS_PRESETS) {
    const rows = pluginRows({
      sessionsRoot: "/",
      workspaceRoot: "/",
      permissionMode: "workspace-write",
      preset,
    });
    resolvePlugins(rows, overrides);
  }
}

export async function runPluginsCli(argv: string[]): Promise<void> {
  const { preset, file, positional } = parseFlags(argv);
  const [command, ...rest] = positional;
  if (command === "list") {
    process.stdout.write(`${JSON.stringify(listingFor(preset, file))}\n`);
    return;
  }
  if (command === "set") {
    const [id, state] = rest;
    if (id === undefined || (state !== "enabled" && state !== "disabled")) {
      throw new Error(
        "usage: plugins set <id> <enabled|disabled> [--file <path>]",
      );
    }
    const overrides = loadPluginOverrides(file);
    const disabled = new Set(overrides.disabled ?? []);
    if (state === "disabled") disabled.add(id);
    else disabled.delete(id);
    const next = { ...overrides, disabled: [...disabled].sort() };
    // Validate before touching disk: the file must never hold a state compose would refuse.
    assertValidAcrossPresets(next);
    savePluginOverrides(file, next);
    process.stdout.write(`${JSON.stringify(listingFor(preset, file))}\n`);
    return;
  }
  if (command === "configure") {
    const [id, raw] = rest;
    if (id === undefined || raw === undefined) {
      throw new Error(
        "usage: plugins configure <id> <json-patch> [--file <path>]",
      );
    }
    const patch = parseConfigPatch(id, raw);
    const overrides = loadPluginOverrides(file);
    const nextConfig = { ...overrides.config };
    const pluginConfig = { ...nextConfig[id] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete pluginConfig[key];
      else pluginConfig[key] = value;
    }
    if (Object.keys(pluginConfig).length === 0) delete nextConfig[id];
    else nextConfig[id] = pluginConfig;
    const next = { ...overrides, config: nextConfig };
    assertValidAcrossPresets(next);
    savePluginOverrides(file, next);
    process.stdout.write(`${JSON.stringify(listingFor(preset, file))}\n`);
    return;
  }
  throw new Error(
    `unknown plugins command "${command ?? ""}": expected list, set, or configure`,
  );
}
