/** Preset packages: a directory extending a built-in preset with its own rows, persona and skills. */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeRuntime } from "../src/compose.ts"
import { loadPresetPackage } from "../src/preset-package.ts"

const TOOL_PLUGIN = `
export default function (host) {
  return {
    name: "probe-tools",
    inject: ["tools"],
    Config: undefined,
    apply(ctx, config) {
      ctx.tools.register({
        name: config?.toolName ?? "probe",
        description: "answers with the configured word",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        async execute() { return config?.word ?? "hello" },
      })
      ctx.on("dispose", () => {})
    },
  }
}
`

function writePackage(manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-preset-"))
  writeFileSync(join(dir, "alwith-dsh-preset.json"), JSON.stringify(manifest))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

async function toolNames(dir: string): Promise<string[]> {
  const ctx = await composeRuntime({ preset: loadPresetPackage(dir) })
  try {
    return (ctx.tools as unknown as { schemas: (c: unknown) => Array<{ name: string }> })
      .schemas(ctx)
      .map(schema => schema.name)
      .sort()
  } finally {
    await ctx.fiber.dispose()
  }
}

describe("preset packages", () => {
  test("a package extends a built-in preset with its own rows, persona and disabled rows", async () => {
    const dir = writePackage(
      {
        schemaVersion: 1,
        name: "probe",
        extends: "minimal",
        personaPrefix: "You narrate.",
        plugins: [{ id: "probe-tools", module: "plugins/tools.js", config: { toolName: "probe", word: "hi" }, requires: ["tools"] }],
        disabled: ["tool-str-replace-editor"],
      },
      { "plugins/tools.js": TOOL_PLUGIN },
    )
    const pkg = loadPresetPackage(dir)
    expect(pkg.manifest.extends).toBe("minimal")
    // minimal = bash + str_replace_editor; the package drops the editor and adds its tool.
    expect(await toolNames(dir)).toEqual(["bash", "probe"])
  })

  test("skills ride the registry rows when the base preset has none", async () => {
    const dir = writePackage(
      { schemaVersion: 1, name: "skilled", extends: "standard", skillsDir: "skills", plugins: [] },
      { "skills/story-style/SKILL.md": "---\nname: story-style\ndescription: how to narrate\n---\nNarrate in scenes." },
    )
    const names = await toolNames(dir)
    expect(names).toContain("skill")
    expect(names).toContain("subagent")
  })

  test("manifest problems fail loud at load", () => {
    expect(() => loadPresetPackage("relative/dir")).toThrow(/absolute/)
    expect(() => loadPresetPackage(mkdtempSync(join(tmpdir(), "dsh-preset-empty-")))).toThrow(/alwith-dsh-preset.json/)
    expect(() => loadPresetPackage(writePackage({ schemaVersion: 1, name: "x", extends: "nope", plugins: [] }))).toThrow(/extends/)
    expect(() => loadPresetPackage(writePackage({ schemaVersion: 1, name: "x", extends: "standard", plugins: [{ id: "a", module: "../escape.js" }] }))).toThrow(/inside the package/)
    expect(() => loadPresetPackage(writePackage({ schemaVersion: 1, name: "x", extends: "standard", plugins: [{ id: "a", module: "missing.js" }] }))).toThrow(/not found/)
    expect(() => loadPresetPackage(writePackage({ schemaVersion: 1, name: "x", extends: "standard", skillsDir: "nope", plugins: [] }))).toThrow(/skillsDir/)
  })

  test("a plugin id colliding with a built-in row is refused; a core row cannot be disabled", async () => {
    const collision = writePackage(
      { schemaVersion: 1, name: "x", extends: "standard", plugins: [{ id: "tool-web", module: "p.js" }] },
      { "p.js": TOOL_PLUGIN },
    )
    await expect(composeRuntime({ preset: loadPresetPackage(collision) })).rejects.toThrow(/collides with a built-in row/)
    const core = writePackage({ schemaVersion: 1, name: "x", extends: "standard", plugins: [], disabled: ["llm"] })
    await expect(composeRuntime({ preset: loadPresetPackage(core) })).rejects.toThrow(/core row/)
  })

  test("a module without a factory default export fails at mount, naming the plugin", async () => {
    const dir = writePackage(
      { schemaVersion: 1, name: "x", extends: "minimal", plugins: [{ id: "broken", module: "broken.js" }] },
      { "broken.js": "export const nothing = 1\n" },
    )
    await expect(composeRuntime({ preset: loadPresetPackage(dir) })).rejects.toThrow(/"broken".*factory/)
  })
})
