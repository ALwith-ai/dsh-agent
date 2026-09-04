/**
 * Anchored preset: the first model request sees only the Minimal two-tool
 * surface; after promotion the full native catalog opens. Asserted on the
 * actual GenerateOptions the adapter receives — the model-visible wire truth.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  client as createClientApp,
  ndJsonStream,
  type ClientConnection,
  type Stream,
} from "@agentclientprotocol/sdk/experimental/v2"
import { composeRuntime } from "../src/compose.ts"
import * as Bridge from "../src/bridge.ts"
import { MockAdapter, textResponse, untilFrame, type CapturedUpdate } from "./harness.ts"

describe("anchored preset", () => {
  test("first request is two-tool + one-line persona; the next request has the full catalog", async () => {
    const adapter = new MockAdapter([textResponse("anchor"), textResponse("promoted")])
    const ctx = await composeRuntime({
      preset: "anchored",
      sessionsRoot: mkdtempSync(join(tmpdir(), "dsh-agent-anchored-")),
    })
    ctx.llm.registerAdapter(["mock"], adapter)

    const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
    const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
    const clientStream: Stream = ndJsonStream(clientToAgent.writable, agentToClient.readable)
    const updates: CapturedUpdate[] = []
    await ctx.plugin({
      name: Bridge.name,
      inject: [...Bridge.inject],
      apply: (inner: typeof ctx) => {
        Bridge.apply(inner, { provider: "mock", model: "mock", stream: agentStream })
      },
    })
    const connection: ClientConnection = createClientApp()
      .onNotification("session/update", context => {
        updates.push(context.params.update as CapturedUpdate)
      })
      .onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" as const } }))
      .connect(clientStream)
    const states = () => updates.filter(update => update.sessionUpdate === "state_update")

    await connection.agent.request("initialize", {
      protocolVersion: 2,
      info: { name: "test-client", version: "0.0.0" },
      capabilities: {},
    })
    const { sessionId } = await connection.agent.request("session/new", { cwd: tmpdir() })
    await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "one" }] })
    await untilFrame(() => states().filter(entry => (entry as { state?: string }).state === "idle").length >= 1)
    await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "two" }] })
    await untilFrame(() => states().filter(entry => (entry as { state?: string }).state === "idle").length >= 2)

    type Request = { tools?: Array<{ name: string }>; system?: unknown; maxTokens?: number }
    const first = adapter.requests.at(0) as Request
    const second = adapter.requests.at(1) as Request

    // Phase 1: exactly the Minimal two tools, and the capped output budget.
    expect((first.tools ?? []).map(tool => tool.name).sort()).toEqual(["bash", "str_replace_editor"])
    expect(first.maxTokens).toBe(1024)
    // Promotion (tool-less first response responded): the full native catalog, no cap solder.
    expect((second.tools ?? []).map(tool => tool.name).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "read",
      "str_replace_editor",
      "todo_write",
      "web_search",
      "write",
    ])
    expect(second.maxTokens).not.toBe(1024)
    await ctx.fiber.dispose()
  }, 20000)
})
