/** Shared test harness: in-memory transport, v2 client, mock adapter. */

import {
  client as createClientApp,
  type ClientConnection,
  ndJsonStream,
  type PromptRequest,
  type RequestPermissionRequest,
  type Stream,
  type UpdateSessionNotification
} from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { Context } from "@deepseek-ai/cordis"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit"
import { type GenerateOptions, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from "@deepseek-ai/dsh-llm"
import * as JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"

import * as Bridge from "../src/bridge.ts"
import AlwithSessionPersistence from "../src/persistence/alwith.ts"

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
      { provider, id: "mock-pro", name: "Mock Pro" }
    ])
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return scriptedStream(options.signal, () => {
      this.requests.push(options)
      const entry = this.script.shift()
      if (entry === undefined) throw new Error("MockAdapter: script exhausted")
      return typeof entry === "function" ? entry(options) : entry
    })
  }
}

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    ...Array.from(text, (char): StreamChunk => ({ type: "text-delta", index: 0, text: char })),
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 5, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } }
  ]
}

export type CapturedUpdate = UpdateSessionNotification["update"] & { state?: string; stopReason?: string }

/** Await a real condition (notifications are written asynchronously; crossing the transport needs event-loop turns). */
export async function untilFrame(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("untilFrame: condition not met within timeout")
    await new Promise((resolve) => setImmediate(resolve))
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
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: "" } })
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
    }
  })

  const connection: ClientConnection = createClientApp()
    .onNotification("session/update", (context) => {
      updates.push(context.params.update as CapturedUpdate)
    })
    .onRequest("session/request_permission", (context) => {
      permissionRequests.push(context.params)
      return { outcome: { outcome: "cancelled" as const } }
    })
    .connect(clientStream)

  const states = () =>
    updates
      .filter((update) => update.sessionUpdate === "state_update")
      .map((update) => ({ state: update.state, stopReason: update.stopReason }))
  const initialize = () =>
    connection.agent.request("initialize", {
      protocolVersion: 2,
      info: { name: "test-client", version: "0.0.0" },
      capabilities: {}
    })
  const promptAndWait = async (params: PromptRequest) => {
    const start = updates.length
    const receipt = await connection.agent.request("session/prompt", params)
    await untilFrame(() => {
      const inserted = updates.findIndex(
        (update, index) =>
          index >= start &&
          (update.sessionUpdate === "user_message" || update.sessionUpdate === "user_message_chunk") &&
          update.messageId === receipt.messageId
      )
      return (
        inserted >= start &&
        updates.some(
          (update, index) => index > inserted && update.sessionUpdate === "state_update" && update.state === "idle"
        )
      )
    })
    return receipt
  }
  return {
    ctx,
    adapter,
    promptAndWait,
    agent: connection.agent,
    updates,
    states,
    permissionRequests,
    initialize,
    dispose: () => ctx.fiber.dispose()
  }
}

/** A stream of scripted chunks that, like a real adapter, starts on the first read and stops once the signal aborts. */
export function scriptedStream(
  signal: AbortSignal | undefined,
  start: () => Iterable<StreamChunk>
): AsyncIterable<StreamChunk> {
  return {
    [Symbol.asyncIterator]: () => {
      let chunks: Iterator<StreamChunk> | undefined
      return {
        next: () => {
          try {
            chunks ??= start()[Symbol.iterator]()
            const result = chunks.next()
            if (!result.done && signal?.aborted) throw new Error("aborted")
            return Promise.resolve(result)
          } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)))
          }
        }
      }
    }
  }
}
