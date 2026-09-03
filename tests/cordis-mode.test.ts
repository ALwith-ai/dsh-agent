/**
 * Creator (cordis) preset: the agent defines a model-written plugin and runs
 * it against the live runtime through the self-referential toolset — the
 * node:vm host realm working under Bun is the point of this test.
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
    for (const block of (message as { content?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }).content ?? []) {
      if (block.type === "tool-result") {
        for (const inner of block.content ?? []) if (inner.type === "text" && inner.text) texts.push(inner.text)
      }
    }
  }
  return texts.at(-1) ?? ""
}

describe("cordis preset (creator)", () => {
  test("cordis_define then cordis_run executes a model-written plugin in the vm realm", async () => {
    const script: ScriptEntry[] = [
      toolCall("call-1", "cordis_define", {
        plugin: { kind: "new", idPrefix: "probe" },
        name: "probe",
        purpose: "prove the dynamic runner works",
        // A plain JavaScript function body returning the Host-half plugin.
        code: { host: 'return { name: "probe", apply(ctx) { console.log("dynamic plugin alive") } }' },
      }),
      options => {
        const receipt = lastToolResultText(options)
        // Receipt reads: `Defined <pluginId>/<packageId> (<name>); ...`
        const minted = receipt.match(/Defined ([\w-]+)\/([\w-]+)/)
        const pluginId = minted?.[1]
        const packageId = minted?.[2]
        if (!pluginId || !packageId) {
          throw new Error(`define receipt did not carry ids: ${receipt.slice(0, 300)}`)
        }
        return toolCall("call-2", "cordis_run", { pluginId, packageId, mode: "run" })
      },
      textResponse("mounted"),
    ]
    const adapter = new MockAdapter(script)
    const ctx = await composeRuntime({
      preset: "cordis",
      sessionsRoot: mkdtempSync(join(tmpdir(), "alwith-dsh-cordis-")),
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
    await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "author a plugin" }] })
    await untilFrame(() => states().some(entry => (entry as { state?: string }).state === "idle"), 20000)

    const frames = updates.filter(update => update.sessionUpdate === "tool_call_update") as Array<
      CapturedUpdate & { name?: string; status?: string; content?: Array<{ content?: { text?: string } }> }
    >
    const define = frames.filter(frame => frame.name === "cordis_define" || frames.indexOf(frame) < 2)
    expect(frames.at(0)?.name).toBe("cordis_define")
    const statuses = frames.map(frame => frame.status).filter(Boolean)
    // Both tool calls settled; the run either completed or reported a precise
    // failure — the assertion below requires full success.
    const texts = frames
      .flatMap(frame => frame.content ?? [])
      .map(entry => entry.content?.text ?? "")
      .join(" | ")
    expect(statuses.filter(status => status === "completed").length).toBeGreaterThanOrEqual(2)
    expect(texts).not.toContain("invalid arguments")
    await ctx.fiber.dispose()
  }, 30000)
})
