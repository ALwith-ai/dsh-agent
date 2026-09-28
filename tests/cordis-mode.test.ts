/** Cordis inspection tools expose the live Bun runtime through ACP. */

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
import { ToolCallId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm"
import { composeRuntime } from "../src/compose.ts"
import * as Bridge from "../src/bridge.ts"
import { MockAdapter, textResponse, untilFrame, type CapturedUpdate, type ScriptEntry } from "./harness.ts"

function toolCall(id: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(id)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name, arguments: argumentsJson } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]
}

/** Pull the latest tool-result text out of the derived history the mock receives. */
function lastToolResultText(options: GenerateOptions): string {
  const texts: string[] = []
  for (const message of options.messages ?? []) {
    if (message.role !== "tool") continue
    for (const block of message.content) {
      if (block.type === "text") texts.push(block.text)
    }
  }
  return texts.at(-1) ?? ""
}

describe("cordis preset (creator)", () => {
  test("lists runtime providers and queries the active agent tool catalog", async () => {
    const script: ScriptEntry[] = [
      toolCall("call-1", "cordis_inspect_list", {}),
      options => {
        const receipt = JSON.parse(lastToolResultText(options))
        expect(receipt.providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "Tool" })]))
        return toolCall("call-2", "cordis_inspect_query", { platform: "host", provider: "Tool", method: "listTools" })
      },
      options => {
        const receipt = JSON.parse(lastToolResultText(options))
        expect(receipt.data.tools).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "cordis_inspect_list" }),
          expect.objectContaining({ name: "read" }),
        ]))
        return textResponse("inspected")
      },
    ]
    const adapter = new MockAdapter(script)
    const ctx = await composeRuntime({
      preset: "cordis",
      sessionsRoot: mkdtempSync(join(tmpdir(), "dsh-agent-cordis-")),
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
      .onRequest("session/request_permission", () => ({ outcome: { outcome: "selected" as const, optionId: "allow-once" } }))
      .connect(clientStream)
    const states = () => updates.filter(update => (update as { sessionUpdate?: string }).sessionUpdate === "state_update")

    await connection.agent.request("initialize", {
      protocolVersion: 2,
      info: { name: "test-client", version: "0.0.0" },
      capabilities: {},
    })
    const { sessionId } = await connection.agent.request("session/new", { cwd: tmpdir() })
    await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "inspect the runtime" }] })
    await untilFrame(() => states().some(entry => (entry as { state?: string }).state === "idle"), 20000)

    const frames = updates.filter(update => update.sessionUpdate === "tool_call_update") as Array<
      CapturedUpdate & { name?: string; status?: string; content?: Array<{ content?: { text?: string } }> }
    >
    expect(frames.at(0)?.name).toBe("cordis_inspect_list")
    const statuses = frames.map(frame => frame.status).filter(Boolean)
    // Both read-only tool calls must complete successfully.
    const texts = frames
      .flatMap(frame => frame.content ?? [])
      .map(entry => entry.content?.text ?? "")
      .join(" | ")
    expect(statuses.filter(status => status === "completed").length).toBeGreaterThanOrEqual(2)
    expect(texts).not.toContain("invalid arguments")
    await ctx.fiber.dispose()
  }, 30000)
})
