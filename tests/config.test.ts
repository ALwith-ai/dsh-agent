/** Session config options: model downlink and in-session model switching. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHarness, textResponse, untilFrame } from "./harness.ts"

type ModelOption = {
  id: string
  category: string
  type: string
  currentValue: string
  options: Array<{ value: string; name: string }>
}

function modelOption(configOptions: unknown): ModelOption {
  const options = configOptions as ModelOption[]
  const entry = options.find(option => option.category === "model")
  if (entry === undefined) throw new Error("no model config option downlinked")
  return entry
}

describe("session config options", () => {
  test("session/new downlinks the model select from the adapter catalog", async () => {
    const h = await makeHarness([])
    await h.initialize()
    const response = await h.agent.request("session/new", { cwd: "/tmp" })
    const entry = modelOption(response.configOptions)
    expect(entry.type).toBe("select")
    expect(entry.currentValue).toBe("mock")
    expect(entry.options.map(option => option.value)).toEqual(["mock", "mock-pro"])
    await h.dispose()
  })

  test("set_config_option(model) switches the live session; the next request runs on the new model", async () => {
    const h = await makeHarness([textResponse("before"), textResponse("after")], {
      sessionsRoot: mkdtempSync(join(tmpdir(), "dsh-agent-config-")),
    })
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "one" }] })
    await untilFrame(() => h.states().filter(entry => entry.state === "idle").length >= 1)

    // Schema shape: a select option is set with `type: "id"` (ALwith Desktop sends exactly this).
    const switched = await h.agent.request("session/set_config_option", {
      sessionId,
      configId: "model",
      type: "id",
      value: "mock-pro",
    })
    expect(modelOption(switched.configOptions).currentValue).toBe("mock-pro")
    const echo = h.updates.filter(update => update.sessionUpdate === "config_option_update")
    expect(echo.length).toBe(1)

    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "two" }] })
    await untilFrame(() => h.states().filter(entry => entry.state === "idle").length >= 2)
    // The switched agent derives history from the same log and runs on the new model.
    const last = h.adapter.requests.at(-1) as { model?: string } | undefined
    expect(last?.model).toBe("mock-pro")
    expect(JSON.stringify(h.adapter.requests.at(-1))).toContain("one")
    await h.dispose()
  })

  test("switching to an unknown config option is invalid params", async () => {
    const h = await makeHarness([])
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await expect(
      h.agent.request("session/set_config_option", { sessionId, configId: "mode", type: "id", value: "x" }),
    ).rejects.toThrow()
    await h.dispose()
  })
})
