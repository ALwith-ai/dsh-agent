/**
 * Tool-surface integration tests over the REAL composition (composeRuntime):
 * bash execution with one-shot approvals bridged over ACP, tool_call_update
 * streaming, and todo_write → plan_update. Only the model is mocked.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  client as createClientApp,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type Stream,
} from "@agentclientprotocol/sdk/experimental/v2"
import { ToolCallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from "@deepseek-ai/dsh-llm"
import { composeRuntime } from "../src/compose.ts"
import * as Bridge from "../src/bridge.ts"
import { textResponse, untilFrame, type CapturedUpdate } from "./harness.ts"

class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error("MockAdapter: script exhausted")
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error("aborted")
      yield chunk
    }
  }
}

function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name, arguments: argumentsJson } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]
}

async function makeFullHarness(
  script: StreamChunk[][],
  options: { permissionMode?: "read-only" | "workspace-write"; workspaceRoot?: string } = {},
) {
  const adapter = new MockAdapter(script)
  const ctx = await composeRuntime({ sessionsRoot: mkdtempSync(join(tmpdir(), "dsh-agent-tools-")), ...options })
  ctx.llm.registerAdapter(["mock"], adapter)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientToAgent.writable, agentToClient.readable)

  const updates: CapturedUpdate[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const harness = {
    onPermission: (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" as const } }),
  }

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
    .onRequest("session/request_permission", context => {
      permissionRequests.push(context.params)
      return harness.onPermission()
    })
    .connect(clientStream)

  const states = () =>
    updates.filter(update => update.sessionUpdate === "state_update").map(update => ({ state: update.state, stopReason: update.stopReason }))
  const toolFrames = () =>
    updates.filter(update => update.sessionUpdate === "tool_call_update") as Array<
      CapturedUpdate & { toolCallId: string; status?: string; name?: string; content?: Array<{ type: string; content?: { type: string; text?: string } }> }
    >
  const initialize = () =>
    connection.agent.request("initialize", { protocolVersion: 2, info: { name: "test-client", version: "0.0.0" }, capabilities: {} })
  return { ctx, adapter, agent: connection.agent, updates, states, toolFrames, permissionRequests, harness, initialize, dispose: () => ctx.fiber.dispose() }
}

describe("tool surface over the real composition", () => {
  test("in-workspace bash runs sandboxed without asking; tool_call_update streams in_progress then completed", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-agent-ws-"))
    const h = await makeFullHarness(
      [
        toolCallResponse("call-1", "bash", { command: "printf dsh-tools-ok > marker.txt && cat marker.txt", description: "write then read a marker" }),
        textResponse("done"),
      ],
      { permissionMode: "workspace-write", workspaceRoot },
    )
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: workspaceRoot })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run it" }] })
    await untilFrame(() => h.states().at(-1)?.state === "idle", 15000)

    // Writes inside the workspace are the sandbox's own business: no approval.
    expect(h.permissionRequests.length).toBe(0)

    const frames = h.toolFrames()
    expect(frames.at(0)?.name).toBe("bash")
    expect(frames.at(0)?.status).toBe("in_progress")
    expect(frames.at(-1)?.status).toBe("completed")
    const resultText = frames
      .flatMap(frame => frame.content ?? [])
      .map(entry => entry.content?.text ?? "")
      .join("")
    expect(resultText).toContain("dsh-tools-ok")
    await h.dispose()
  }, 20000)

  test("sandbox denial -> model escalates with sandbox_permissions -> one-shot approval allows the retry", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-agent-ws-"))
    const command = "printf escalated-ok > marker.txt && cat marker.txt"
    const h = await makeFullHarness(
      [
        // Read-only mode denies the write; the model retries the exact command
        // with the narrowest wider mode plus a justification (dsh's sanctioned
        // escalation path), which raises the approval prompt.
        toolCallResponse("call-1", "bash", { command, description: "write a marker" }),
        toolCallResponse("call-2", "bash", {
          command,
          description: "write a marker",
          sandbox_permissions: "workspace-write",
          justification: "the marker file must be written inside the workspace",
        }),
        textResponse("done"),
      ],
      { permissionMode: "read-only", workspaceRoot },
    )
    h.harness.onPermission = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } })
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: workspaceRoot })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "write it" }] })
    await untilFrame(() => h.states().at(-1)?.state === "idle", 15000)

    // Exactly one approval, v2 subject scheme, requires_action while pending.
    expect(h.permissionRequests.length).toBe(1)
    expect(h.permissionRequests[0]?.subject?.type).toBe("tool_call")
    expect(h.states().map(entry => entry.state)).toContain("requires_action")

    // The escalated retry completed and produced the output.
    const frames = h.toolFrames()
    expect(frames.at(-1)?.status).toBe("completed")
    const resultText = frames
      .flatMap(frame => frame.content ?? [])
      .map(entry => entry.content?.text ?? "")
      .join("")
    expect(resultText).toContain("escalated-ok")
    await h.dispose()
  }, 20000)

  test("a rejected escalation fails the retry without killing the turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-agent-ws-"))
    const command = "printf nope > marker.txt"
    const h = await makeFullHarness(
      [
        toolCallResponse("call-1", "bash", { command, description: "write a marker" }),
        toolCallResponse("call-2", "bash", {
          command,
          description: "write a marker",
          sandbox_permissions: "workspace-write",
          justification: "needs to write the marker",
        }),
        textResponse("acknowledged"),
      ],
      { permissionMode: "read-only", workspaceRoot },
    )
    h.harness.onPermission = () => ({ outcome: { outcome: "selected", optionId: "reject-once" } })
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: workspaceRoot })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "write it" }] })
    await untilFrame(() => h.states().at(-1)?.state === "idle", 15000)

    expect(h.permissionRequests.length).toBe(1)
    const frames = h.toolFrames()
    expect(frames.at(-1)?.status).toBe("failed")
    // The turn still settled normally after the refusal.
    expect(h.states().at(-1)?.stopReason).toBe("end_turn")
    await h.dispose()
  }, 20000)

  test("todo_write becomes a plan_update with item-based content", async () => {
    const h = await makeFullHarness([
      toolCallResponse("call-1", "todo_write", {
        todos: [
          { content: "first task", status: "in_progress" },
          { content: "second task", status: "pending" },
        ],
      }),
      textResponse("planned"),
    ])
    h.harness.onPermission = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } })
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: tmpdir() })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "plan it" }] })
    await untilFrame(() => h.states().at(-1)?.state === "idle", 15000)

    const plans = h.updates.filter(update => update.sessionUpdate === "plan_update") as Array<
      CapturedUpdate & { plan: { type: string; entries: Array<{ content: string; status: string }> } }
    >
    expect(plans.length).toBeGreaterThan(0)
    const entries = plans.at(-1)?.plan.entries ?? []
    expect(entries.map(entry => entry.content)).toEqual(["first task", "second task"])
    expect(entries.map(entry => entry.status)).toEqual(["in_progress", "pending"])
    await h.dispose()
  }, 20000)
})
