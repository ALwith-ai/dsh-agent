/** Preset compositions: each preset yields exactly its documented tool surface. */

import { describe, expect, test } from "bun:test"
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic"
import SubagentRuntime from "@deepseek-ai/dsh-subagent"
import { composeRuntime } from "../src/compose.ts"

async function toolNames(preset: "standard" | "minimal"): Promise<string[]> {
  const ctx = await composeRuntime({ preset })
  const names = (ctx.tools as unknown as { schemas: (c: unknown) => Array<{ name: string }> })
    .schemas(ctx)
    .map(schema => schema.name)
    .sort()
  await ctx.fiber.dispose()
  return names
}

describe("harness presets", () => {
  test("standard composes the coding-agent tool surface", async () => {
    expect(await toolNames("standard")).toEqual([
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
      "web_search",
      "write",
    ])
  })

  test("minimal composes exactly the two-tool agent (persistent bash + str_replace_editor)", async () => {
    expect(await toolNames("minimal")).toEqual(["bash", "str_replace_editor"])
  })

  test("every preset mounts the compaction engine and the subagent registry on the host plane", async () => {
    for (const preset of ["standard", "minimal", "anchored", "code", "cordis"] as const) {
      const ctx = await composeRuntime({ preset })
      try {
        expect(ctx.get("compaction")).toBeInstanceOf(BasicCompactionEngine)
        expect(ctx.get("subagents")).toBeInstanceOf(SubagentRuntime)
        expect(ctx.get("tokenMeter")).toBeDefined()
        expect(ctx.get("commands")).toBeDefined()
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })
})
