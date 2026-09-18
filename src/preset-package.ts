/**
 * Preset packages: a directory a host points `ALWITH_DSH_PRESET` at, carrying
 * `alwith-dsh-preset.json` plus the plugin modules it names. It extends one
 * built-in preset (the roster stays deterministic: same package version, same
 * overrides ⟹ same tree) and adds rows the sidecar mounts through the same
 * core-protection / `requires` resolution as its own rows.
 *
 * Plugin modules are imported by path from the package directory and export a
 * factory `(host) => plugin`. They receive the sidecar's own copies of the
 * harness classes through `host` instead of importing `@deepseek-ai/*`
 * themselves — a preset installed next to an application has no dsh
 * dependency tree of its own, and two copies of cordis would not share
 * services anyway.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Context, Service } from "@deepseek-ai/cordis"
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic"

export const PRESET_MANIFEST = "alwith-dsh-preset.json"

export type BuiltInPreset = "standard" | "minimal" | "anchored" | "code" | "cordis"

export interface PresetPluginSpec {
  /** Row id; must not collide with a built-in row. */
  id: string
  /** Module path relative to the package directory. */
  module: string
  description?: string
  config?: Record<string, unknown>
  /** Ids of rows (built-in or from this package) whose services this row injects. */
  requires?: string[]
}

export interface PresetManifest {
  schemaVersion: 1
  name: string
  /** The built-in preset whose roster this package starts from. */
  extends: BuiltInPreset
  /** Replaces the deployment persona prefix of the system prompt. */
  personaPrefix?: string
  /** Skills directory (relative to the package) mounted through the skill registry. */
  skillsDir?: string
  plugins: PresetPluginSpec[]
  /** Built-in rows this package turns off (core rows cannot be). */
  disabled?: string[]
}

export interface PresetPackage {
  readonly dir: string
  readonly manifest: PresetManifest
}

/** What a preset plugin factory receives: the sidecar's harness classes, by reference. */
export interface PresetHost {
  readonly Context: typeof Context
  readonly Service: typeof Service
  readonly BasicCompactionEngine: typeof BasicCompactionEngine
  /** The package directory, for plugins that ship assets. */
  readonly presetDir: string
}

export type PresetPluginFactory = (host: PresetHost) => unknown

const BUILT_IN: readonly BuiltInPreset[] = ["standard", "minimal", "anchored", "code", "cordis"]
const ID_PATTERN = /^[a-z][a-z0-9-]*$/

function fail(dir: string, message: string): never {
  throw new Error(`preset package ${dir}: ${message}`)
}

function insidePackage(dir: string, target: string): boolean {
  const rel = relative(dir, target)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/** Load and validate a preset package. Every problem fails loud at spawn, never at first use. */
export function loadPresetPackage(dir: string): PresetPackage {
  if (!isAbsolute(dir)) throw new Error(`preset package path must be absolute: ${dir}`)
  const root = resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`preset package directory not found: ${root}`)
  const manifestPath = join(root, PRESET_MANIFEST)
  if (!existsSync(manifestPath)) fail(root, `no ${PRESET_MANIFEST}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    fail(root, `${PRESET_MANIFEST} is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail(root, `${PRESET_MANIFEST} must be a JSON object`)
  const manifest = parsed as Record<string, unknown>
  if (manifest.schemaVersion !== 1) fail(root, `schemaVersion must be 1, got ${JSON.stringify(manifest.schemaVersion)}`)
  if (typeof manifest.name !== "string" || !ID_PATTERN.test(manifest.name)) fail(root, `name must match ${ID_PATTERN}`)
  if (typeof manifest.extends !== "string" || !(BUILT_IN as readonly string[]).includes(manifest.extends)) {
    fail(root, `extends must be one of ${BUILT_IN.join(", ")}`)
  }
  if (manifest.personaPrefix !== undefined && typeof manifest.personaPrefix !== "string") fail(root, "personaPrefix must be a string")
  let skillsDir: string | undefined
  if (manifest.skillsDir !== undefined) {
    if (typeof manifest.skillsDir !== "string") fail(root, "skillsDir must be a string")
    skillsDir = resolve(root, manifest.skillsDir)
    if (!insidePackage(root, skillsDir) && skillsDir !== root) fail(root, `skillsDir must stay inside the package: ${manifest.skillsDir}`)
    if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) fail(root, `skillsDir not found: ${manifest.skillsDir}`)
  }
  if (!Array.isArray(manifest.plugins)) fail(root, "plugins must be an array")
  const ids = new Set<string>()
  const plugins: PresetPluginSpec[] = manifest.plugins.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(root, `plugins[${index}] must be an object`)
    const spec = raw as Record<string, unknown>
    if (typeof spec.id !== "string" || !ID_PATTERN.test(spec.id)) fail(root, `plugins[${index}].id must match ${ID_PATTERN}`)
    if (ids.has(spec.id)) fail(root, `duplicate plugin id "${spec.id}"`)
    ids.add(spec.id)
    if (typeof spec.module !== "string") fail(root, `plugins[${index}].module must be a path`)
    const modulePath = resolve(root, spec.module)
    if (!insidePackage(root, modulePath)) fail(root, `plugins[${index}].module must stay inside the package: ${spec.module}`)
    if (!existsSync(modulePath)) fail(root, `plugins[${index}].module not found: ${spec.module}`)
    if (spec.description !== undefined && typeof spec.description !== "string") fail(root, `plugins[${index}].description must be a string`)
    if (spec.config !== undefined && (typeof spec.config !== "object" || spec.config === null || Array.isArray(spec.config))) {
      fail(root, `plugins[${index}].config must be an object`)
    }
    if (spec.requires !== undefined && !(Array.isArray(spec.requires) && spec.requires.every(id => typeof id === "string"))) {
      fail(root, `plugins[${index}].requires must be an array of ids`)
    }
    return {
      id: spec.id,
      module: spec.module,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      ...(spec.config === undefined ? {} : { config: spec.config as Record<string, unknown> }),
      ...(spec.requires === undefined ? {} : { requires: spec.requires as string[] }),
    }
  })
  if (manifest.disabled !== undefined && !(Array.isArray(manifest.disabled) && manifest.disabled.every(id => typeof id === "string"))) {
    fail(root, "disabled must be an array of ids")
  }
  return {
    dir: root,
    manifest: {
      schemaVersion: 1,
      name: manifest.name,
      extends: manifest.extends as BuiltInPreset,
      ...(manifest.personaPrefix === undefined ? {} : { personaPrefix: manifest.personaPrefix }),
      ...(skillsDir === undefined ? {} : { skillsDir }),
      plugins,
      ...(manifest.disabled === undefined ? {} : { disabled: manifest.disabled as string[] }),
    },
  }
}

export function presetHost(presetDir: string): PresetHost {
  return { Context, Service, BasicCompactionEngine, presetDir }
}

/** Import one plugin module from the package and build its plugin through the factory. */
export async function loadPresetPlugin(pkg: PresetPackage, spec: PresetPluginSpec): Promise<unknown> {
  const modulePath = resolve(pkg.dir, spec.module)
  const imported = (await import(pathToFileURL(modulePath).href)) as { default?: unknown }
  const factory = imported.default
  if (typeof factory !== "function") {
    throw new Error(`preset package ${pkg.dir}: plugin "${spec.id}" (${spec.module}) must default-export a factory (host) => plugin`)
  }
  const plugin = (factory as PresetPluginFactory)(presetHost(pkg.dir))
  if (typeof plugin !== "object" && typeof plugin !== "function") {
    throw new Error(`preset package ${pkg.dir}: plugin "${spec.id}" factory returned ${typeof plugin}, expected a cordis plugin`)
  }
  return plugin
}
