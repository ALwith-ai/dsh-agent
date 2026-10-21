/** Plugin manifest + overrides: listing, toggling, dependency validation, CLI round-trip. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { composeRuntime } from "../src/compose.ts"
import { runPluginsCli } from "../src/plugins-cli.ts"
import { type PluginOverrides, pluginRows, resolvePlugins } from "../src/plugins.ts"

const OPTIONS = {
  sessionsRoot: "/",
  workspaceRoot: "/",
  permissionMode: "workspace-write" as const
}

async function toolNames(overrides: PluginOverrides): Promise<string[]> {
  const ctx = await composeRuntime({ preset: "standard", overrides })
  const names = (ctx.tools as unknown as { schemas: (c: unknown) => Array<{ name: string }> })
    .schemas(ctx)
    .map((schema) => schema.name)
    .toSorted()
  await ctx.fiber.dispose()
  return names
}

describe("plugin manifest", () => {
  test("standard listing exposes every row with core protection marked", () => {
    const { listing } = resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), {})
    const byId = new Map(listing.map((row) => [row.id, row]))
    expect(byId.get("session")?.core).toBe(true)
    expect(byId.get("tool-web")?.core).toBe(false)
    expect(byId.get("tool-web")?.requires).toEqual(["web", "web-search-deepseek"])
    expect(listing.every((row) => row.enabled)).toBe(true)
    expect(listing.length).toBeGreaterThanOrEqual(20)
  })

  test("disabling the web trio removes web_search from the composed tool surface", async () => {
    expect(await toolNames({ disabled: ["tool-web", "web-search-deepseek", "web"] })).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "interrupt_agent",
      "list_agents",
      "read",
      "send_message",
      "subagent",
      "subagent_fork",
      "todo_write",
      "write"
    ])
  })

  test("disabling a core row fails loud", () => {
    expect(() =>
      resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), {
        disabled: ["session"]
      })
    ).toThrow("core row")
  })

  test("disabling a dependency of an enabled row fails loud (cordis would hang, not error)", () => {
    expect(() =>
      resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), {
        disabled: ["web"]
      })
    ).toThrow('requires "web"')
  })

  test("unknown plugin id in overrides fails loud", () => {
    expect(() =>
      resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), {
        disabled: ["not-a-plugin"]
      })
    ).toThrow("unknown plugin id")
  })

  test("config overrides shallow-merge over the row defaults", () => {
    const { listing } = resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), {
      config: { "tool-web": { searchTimeoutMs: 30000 } }
    })
    const toolWeb = listing.find((row) => row.id === "tool-web")
    expect(toolWeb?.config).toEqual({ fetch: false, searchTimeoutMs: 30000 })
    expect(toolWeb?.overrideConfig).toEqual({ searchTimeoutMs: 30000 })
  })

  test("listing exposes only the curated desktop-configurable fields", () => {
    const { listing } = resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), {})
    expect(listing.find((row) => row.id === "bash-sandbox")?.configurable).toEqual([
      { key: "timeoutMs", type: "number", minimum: 1 },
      { key: "maxOutputBytes", type: "number", minimum: 1 }
    ])
    expect(listing.find((row) => row.id === "agent-loop")?.configurable).toEqual([
      { key: "maxParallelToolCalls", type: "number", minimum: 1 }
    ])
    expect(listing.find((row) => row.id === "web-search-deepseek")?.configurable).toEqual([
      { key: "baseURL", type: "url" },
      { key: "maxUses", type: "number", minimum: 1 }
    ])
    expect(listing.find((row) => row.id === "session")?.configurable).toBeUndefined()
  })
})

describe("multi-provider seat (pi-ai)", () => {
  test("piProviders mounts the pi-ai adapter and registers its routes beside deepseek", async () => {
    const ctx = await composeRuntime({
      preset: "standard",
      piProviders: {
        openai: { apiKeyEnv: "OPENAI_API_KEY" },
        anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" }
      }
    })
    const providers = (ctx as unknown as { llm: { listProviders: () => Array<{ id: string }> } }).llm
      .listProviders()
      .map((provider) => provider.id)
    expect(providers).toContain("openai")
    expect(providers).toContain("anthropic")
    expect(providers).toContain("deepseek-official")
    await ctx.fiber.dispose()
  })

  test("absent piProviders keeps the adapter unmounted (DeepSeek-only deployment)", async () => {
    const ctx = await composeRuntime({ preset: "standard" })
    const providers = (ctx as unknown as { llm: { listProviders: () => Array<{ id: string }> } }).llm
      .listProviders()
      .map((provider) => provider.id)
    expect(providers).not.toContain("openai")
    await ctx.fiber.dispose()
  })
})

describe("cordis skill bundle", () => {
  test("cordis composes the skill toolset and the bundled authoring skill is discoverable", async () => {
    const ctx = await composeRuntime({ preset: "cordis" })
    const names = (
      ctx.tools as unknown as {
        schemas: (c: unknown) => Array<{ name: string }>
      }
    )
      .schemas(ctx)
      .map((schema) => schema.name)
    expect(names).toContain("skill")
    expect(names).toContain("cordis_inspect_list")
    expect(names).toContain("cordis_inspect_query")
    const skills = await (
      ctx as unknown as {
        skills: { list: () => Promise<Array<{ name: string }>> }
      }
    ).skills.list()
    expect(skills.map((skill) => skill.name)).toContain("cordis-plugin-development")
    await ctx.fiber.dispose()
  })
})

describe("plugins CLI", () => {
  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array) => {
      lines.push(chunk.toString())
      return true
    }
    return {
      lines,
      restore: () => {
        process.stdout.write = original
      }
    }
  }

  test("set disabled → file written → list reflects it → set enabled restores", () => {
    const file = join(mkdtempSync(join(tmpdir(), "dsh-agent-plugins-")), "plugins.json")
    const stdout = captureStdout()
    try {
      runPluginsCli(["set", "tool-web", "disabled", "--file", file, "--preset", "standard"])
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        disabled: ["tool-web"]
      })
      runPluginsCli(["list", "--file", file, "--preset", "standard"])
      const listed = JSON.parse(stdout.lines.at(-1)!) as {
        plugins: Array<{ id: string; enabled: boolean }>
      }
      expect(listed.plugins.find((row) => row.id === "tool-web")?.enabled).toBe(false)
      runPluginsCli(["set", "tool-web", "enabled", "--file", file, "--preset", "standard"])
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ disabled: [] })
    } finally {
      stdout.restore()
    }
  })

  test("set validates before writing: core row and broken dependency both leave the file untouched", () => {
    const file = join(mkdtempSync(join(tmpdir(), "dsh-agent-plugins-")), "plugins.json")
    const stdout = captureStdout()
    try {
      expect(() => runPluginsCli(["set", "session", "disabled", "--file", file])).toThrow("core row")
      // "web" alone breaks tool-web's requires in the standard preset.
      expect(() => runPluginsCli(["set", "web", "disabled", "--file", file])).toThrow('requires "web"')
      expect(() => runPluginsCli(["set", "nope", "disabled", "--file", file])).toThrow("unknown plugin id")
      expect(() => readFileSync(file, "utf8")).toThrow() // never created
    } finally {
      stdout.restore()
    }
  })

  test("configure validates and atomically patches curated fields", () => {
    const file = join(mkdtempSync(join(tmpdir(), "dsh-agent-plugins-")), "plugins.json")
    const stdout = captureStdout()
    try {
      runPluginsCli([
        "configure",
        "bash-sandbox",
        JSON.stringify({ timeoutMs: 90000, maxOutputBytes: 128000 }),
        "--file",
        file
      ])
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        config: {
          "bash-sandbox": { timeoutMs: 90000, maxOutputBytes: 128000 }
        }
      })

      runPluginsCli(["configure", "bash-sandbox", JSON.stringify({ timeoutMs: null }), "--file", file])
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        config: { "bash-sandbox": { maxOutputBytes: 128000 } }
      })

      const before = readFileSync(file, "utf8")
      expect(() =>
        runPluginsCli(["configure", "bash-sandbox", JSON.stringify({ timeoutMs: 0 }), "--file", file])
      ).toThrow("integer >= 1")
      expect(() =>
        runPluginsCli(["configure", "web-search-deepseek", JSON.stringify({ baseURL: "not-a-url" }), "--file", file])
      ).toThrow("absolute URL")
      expect(() => runPluginsCli(["configure", "session", JSON.stringify({ anything: 1 }), "--file", file])).toThrow(
        "no desktop-configurable fields"
      )
      expect(readFileSync(file, "utf8")).toBe(before)
    } finally {
      stdout.restore()
    }
  })
})
