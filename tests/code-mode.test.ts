/**
 * Code Mode (PTC) preset: the wire presents a single run_code tool backed by
 * the official worker runtime (Bun-patched); a model-written program executes
 * and its result returns through the ordinary tool pipeline.
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
import { ToolCallId, type StreamChunk } from "@deepseek-ai/dsh-llm"
import { composeRuntime } from "../src/compose.ts"
import * as Bridge from "../src/bridge.ts"
import { MockAdapter, textResponse, untilFrame, type CapturedUpdate } from "./harness.ts"

function runCodeCall(program: string): StreamChunk[] {
  const callId = ToolCallId("call-1")
  const argumentsJson = JSON.stringify({ code: program, description: "run the computation" })
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: callId, name: "run_code", argumentsDelta: argumentsJson },
    { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name: "run_code", arguments: argumentsJson } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]
}

describe("code preset (PTC)", () => {
  test("wire presents run_code only; a program executes through the pipeline", async () => {
    const adapter = new MockAdapter([
      runCodeCall("console.log(\"from program\"); return 6 * 7"),
      textResponse("done"),
    ])
    const ctx = await composeRuntime({
      preset: "code",
      sessionsRoot: mkdtempSync(join(tmpdir(), "dsh-agent-code-")),
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
    await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "compute" }] })
    await untilFrame(() => states().some(entry => (entry as { state?: string }).state === "idle"), 20000)

    // Code Mode wire: exactly one tool, run_code.
    const first = adapter.requests.at(0) as { tools?: Array<{ name: string }> }
    expect((first.tools ?? []).map(tool => tool.name)).toEqual(["run_code"])

    // The program ran in the worker: its return value and log flow back as the tool result.
    const frames = updates.filter(update => update.sessionUpdate === "tool_call_update") as Array<
      CapturedUpdate & { status?: string; content?: Array<{ content?: { text?: string } }> }
    >
    expect(frames.at(-1)?.status).toBe("completed")
    const resultText = frames
      .flatMap(frame => frame.content ?? [])
      .map(entry => entry.content?.text ?? "")
      .join(" ")
    expect(resultText).toContain("42")
    await ctx.fiber.dispose()
  }, 30000)
})
