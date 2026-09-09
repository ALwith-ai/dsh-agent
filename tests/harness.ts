/** Shared test harness: in-memory transport, v2 client, mock adapter. */

import { Context } from "@deepseek-ai/cordis"
import {
  client as createClientApp,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type UpdateSessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk/experimental/v2"
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from "@deepseek-ai/dsh-llm"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection"
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"
import AlwithSessionPersistence from "../src/persistence/alwith.ts"
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit"
import * as Bridge from "../src/bridge.ts"

export type ScriptEntry = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[])

export class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override listModels(provider: string) {
    return Promise.resolve([
      { provider, id: "mock", name: "Mock" },
      { provider, id: "mock-pro", name: "Mock Pro" },
    ])
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error("MockAdapter: script exhausted")
    const chunks = typeof entry === "function" ? entry(options) : entry
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error("aborted")
      yield chunk
    }
  }
}

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    ...Array.from(text, (char): StreamChunk => ({ type: "text-delta", index: 0, text: char })),
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 5, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ]
}

export type CapturedUpdate = UpdateSessionNotification["update"] & { state?: string; stopReason?: string }

/** Await a real condition (notifications are written asynchronously; crossing the transport needs event-loop turns). */
export async function untilFrame(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("untilFrame: condition not met within timeout")
    await new Promise(resolve => setImmediate(resolve))
  }
}

export interface HarnessOptions {
  /** JSONL session-log root; absent means no persistence (resume fails loud). */
  sessionsRoot?: string
  /** Mount the ALwith record provider instead of dsh's JSONL backend. */
  persistence?: { kind: "alwith"; projectsDir: string }
  /** Enables background LLM session titles (absent keeps the deterministic truncation). */
  titleModel?: string
}

export async function makeHarness(script: ScriptEntry[], options: HarnessOptions = {}) {
  const adapter = new MockAdapter(script)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: "" } })
  // agent-loop injects sessionProjections since 0.1.2; the testkit does not mount it
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.persistence !== undefined) {
    await ctx.plugin(AlwithSessionPersistence, { projectsDir: options.persistence.projectsDir, providerId: "mock" })
  } else if (options.sessionsRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, { root: options.sessionsRoot })
  }
  ctx.llm.registerAdapter(["mock"], adapter)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientToAgent.writable, agentToClient.readable)

  const updates: CapturedUpdate[] = []
  const permissionRequests: RequestPermissionRequest[] = []

  await ctx.plugin({
    name: Bridge.name,
    inject: [...Bridge.inject],
    apply: (inner: Context) => {
      Bridge.apply(inner, { provider: "mock", model: "mock", titleModel: options.titleModel, stream: agentStream })
    },
  })

  const connection: ClientConnection = createClientApp()
    .onNotification("session/update", context => {
      updates.push(context.params.update as CapturedUpdate)
    })
    .onRequest("session/request_permission", context => {
      permissionRequests.push(context.params)
      return { outcome: { outcome: "cancelled" as const } }
    })
    .connect(clientStream)

  const states = () =>
    updates.filter(update => update.sessionUpdate === "state_update").map(update => ({ state: update.state, stopReason: update.stopReason }))
  const initialize = () =>
    connection.agent.request("initialize", { protocolVersion: 2, info: { name: "test-client", version: "0.0.0" }, capabilities: {} })
  return { ctx, adapter, agent: connection.agent, updates, states, permissionRequests, initialize, dispose: () => ctx.fiber.dispose() }
}
