/**
 * Interactive ACP v2 bridge for DeepSeek Harness: exposes a harness agent as a
 * chat backend consumable by ACP v2 hosts such as ALwith Desktop.
 *
 * Built on the SDK's `experimental/v2` runtime (typed method router and typed
 * `session/update` notifications — `state_update` is a first-class frame).
 * The dsh-facing half (agent creation, prompt settlement, approval waterfall,
 * quiescing) adapts @deepseek-ai/dsh-acp (MIT, the automation-only v1 bridge).
 *
 * v2 contract notes:
 * - turn completion is announced by an `idle` state frame carrying
 *   `stopReason`; the `session/prompt` response body is `_meta`-only;
 * - reporting discipline mirrors alwith-cli, the authoritative v2
 *   implementation: `running` when the turn starts, `requires_action` while a
 *   client answer is pending, closing `idle` at settlement;
 * - permission requests use the v2 `subject` scheme with a required `title`.
 *
 * Session resume uses v2's renamed session/load surface and a client-driven
 * replayFrom cursor — omitted means context-only restore, { type: "start" }
 * means replay the whole conversation as session/update frames.
 */

import type { Context } from "@deepseek-ai/cordis"
import packageJson from "../package.json" with { type: "json" }
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { Readable, Writable } from "node:stream"
import Schema from "@deepseek-ai/schemastery"
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm"
import {
  RequestError,
  agent as createAgentApp,
  ndJsonStream,
  type AgentConnection,
  type AgentContext,
  type CancelSessionNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type CompactionId,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type MessageId,
  type PlanId,
  type ToolCallContent,
  type ToolCallId,
  type UpdateSessionNotification,
  type StopReason,
  type Stream,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { Agent } from "@deepseek-ai/dsh-agent"
import { SessionId, type SessionEvent, type TurnEndReason } from "@deepseek-ai/dsh-session"
// Side-effect type imports: declaration-merge the approval/request waterfall
// types and the ctx.sessionPersistence key.
import type {} from "@deepseek-ai/dsh-user-approval"
// Event-map augmentation: the compaction/* session events this bridge maps.
import type {} from "@deepseek-ai/dsh-compaction"
import type {} from "@deepseek-ai/dsh-session-persistence"
import type { ContentBlock as DshContentBlock } from "@deepseek-ai/dsh-llm"
import { acpPromptToText, promptHasUnsupportedContent, turnEndToStopReason } from "./codec.ts"

export const name = "dsh-agent"
/** The bridge creates and owns agents (llm serves background session titling); every other concern is carried by the composition. */
export const inject = ["agents", "sessions", "llm"]

/** Wire protocol version; moves in lockstep with the ALwith Desktop client. */
export const ACP_PROTOCOL_VERSION = 2

/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  provider?: string
  model?: string
  /** Host-facing provider identity stamped into `_meta.alwith` turn metadata; defaults to `provider`. */
  providerId?: string
  /**
   * Model for background LLM session titles (a short one-shot after the first
   * turn settles). Absent means titles stay the deterministic first-prompt
   * truncation — tests rely on that default.
   */
  titleModel?: string
  /** Test-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  providerId: Schema.string(),
  titleModel: Schema.string(),
})

/** Per-session protocol state. */
interface SessionRecord {
  agent: Agent
  dispose: () => Promise<void>
  /** In-flight prompt and its captured turn number for exact settlement. */
  inflight: {
    resolve: () => void
    reject: (error: Error) => void
    messageId: string
    turn: number | undefined
    endReason: TurnEndReason | undefined
    cancelled: boolean
  } | undefined
  /** Pending permission requests; while > 0 the reported state is requires_action. */
  pendingPermissions: number
  /** Last emitted state_update value, deduplicating consecutive identical frames. */
  lastState: "running" | "idle" | "requires_action" | undefined
  /** Whether a session_info_update title was already emitted (first prompt names the session). */
  titled: boolean
  /** Cancels background title work when this record loses ownership. */
  titleAbort: AbortController
  /** The model this session currently runs on (config default, then set_config_option switches). */
  model: string
  /** In-flight model switch; prompts await it so they never drive a retiring agent. */
  switching: Promise<void> | undefined
}

/** Brand a string as a v2 MessageId (the schema type is a branded string). */
function MessageId(id: string): MessageId {
  return id as MessageId
}

/** Brand a string as a v2 ToolCallId. */
function ToolCallId(id: string): ToolCallId {
  return id as ToolCallId
}

/** Brand a string as a v2 PlanId. */
function PlanId(id: string): PlanId {
  return id as PlanId
}

/** Parse tool-call arguments for rawInput; malformed JSON stays a string rather than crashing the stream. */
function parseRawInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson)
  } catch {
    return argumentsJson
  }
}

function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/**
 * Mount the ACP v2 server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - provider/model selection and optional test transport.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  const agents = ctx.agents
  const logger = ctx.logger
  const sessions = new Map<SessionId, SessionRecord>()
  /** In-flight resume acquisitions by id: a second prepare while the first is publishing would hit the live gate. */
  const resumes = new Map<SessionId, Promise<SessionRecord>>()
  let closed = false
  let client: AgentContext

  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError("the ACP bridge has been disposed")
  }

  const requireSession = (sessionId: string): SessionRecord => {
    const record = sessions.get(SessionId(sessionId))
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  const notify = (notification: UpdateSessionNotification): void => {
    void client.notify("session/update", notification).catch((error: unknown) => {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    })
  }

  // Reporting discipline mirrors alwith-cli: running when the turn starts,
  // requires_action while any client answer is pending (flipping back to
  // running when the last one settles, deduplicated); idle only at settlement,
  // always sent, carrying stopReason.
  const notifyState = (record: SessionRecord, state: "running" | "requires_action"): void => {
    if (record.lastState === state) return
    record.lastState = state
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: "state_update", state },
    })
  }

  /**
   * ACP v2: once a prompt is accepted the agent reports where the user message
   * landed in session history. The dsh message id is the id replay reports
   * the same message under (`user_message_chunk` keyed by message.id).
   */
  const reportUserMessage = (record: SessionRecord, messageId: string, text: string): void => {
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: "user_message", messageId: MessageId(messageId), content: [{ type: "text", text }] },
    })
  }

  const reportIdle = (record: SessionRecord, stopReason: StopReason): void => {
    record.lastState = "idle"
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: "state_update", state: "idle", stopReason },
    })
  }

  /**
   * Background LLM titling: after the first turn settles, one short generate
   * upgrades the deterministic first-prompt title. Best-effort by design —
   * the deterministic title is already on the wire, so a failed upgrade is
   * logged and the session keeps working (this is the "expected-failure
   * best-effort" category, not a swallowed error).
   */
  const refineTitle = async (record: SessionRecord, firstPrompt: string): Promise<void> => {
    if (config.titleModel === undefined || config.provider === undefined) return
    const signal = record.titleAbort.signal
    if (signal.aborted || closed || ownedRecord(record.agent) !== record) return
    try {
      const message = createUserMessage({ content: [{ type: "text", text: firstPrompt }], source: { kind: "user" } })
      // Reasoning models burn budget on reasoning before any text, so the cap
      // is generous and the effort drops to the model's own "low" when it
      // advertises one (efforts are adapter-owned; an invented id is rejected).
      const modelInfo = await ctx.llm.resolveModelInfo(config.provider, config.titleModel).catch(() => undefined)
      if (signal.aborted) return
      const lowEffort = modelInfo?.reasoning?.efforts.find(effort => String(effort.id) === "low")?.id
      let title = ""
      for await (const chunk of ctx.llm.stream({
        provider: config.provider,
        model: config.titleModel,
        ...(lowEffort !== undefined ? { reasoningEffort: lowEffort } : {}),
        system:
          "Name this conversation from the user's first message, in the same language as that message. " +
          "Reply with the title only: at most six words, no quotes, no trailing punctuation.",
        messages: [message],
        maxTokens: 128,
        signal,
      })) {
        if (chunk.type === "text-delta") title += chunk.text
        if (chunk.type === "finish" && chunk.reason.kind !== "stop" && chunk.reason.kind !== "max-tokens") {
          throw new Error(`title generation finished with ${chunk.reason.kind}`)
        }
      }
      title = title
        .trim()
        .replace(/\s+/g, " ")
        .replace(/^["'“”‘’「『]+|["'“”‘’」』.。!?]+$/g, "")
        .slice(0, 60)
      if (title.length === 0) return
      // The session may have closed while the title was generating.
      if (sessions.get(record.agent.session.id) !== record) return
      notify({
        sessionId: record.agent.session.id,
        update: { sessionUpdate: "session_info_update", title },
      })
    } catch (error: unknown) {
      if (signal.aborted) return
      logger.warn(`acp: llm session title failed: ${String(error)}`)
    }
  }

  /** Map a tool result's model-facing blocks to v2 tool-call content (text verbatim, images as placeholders). */
  const toolResultContent = (blocks: readonly DshContentBlock[]): ToolCallContent[] => {
    const content: ToolCallContent[] = []
    for (const block of blocks) {
      if (block.type === "text" && block.text.length > 0) {
        content.push({ type: "content", content: { type: "text", text: block.text } })
      } else if (block.type === "image") {
        content.push({ type: "content", content: { type: "text", text: `[image attachment ${block.attachment.attachmentId}]` } })
      }
    }
    return content
  }

  // Share catalog lookups per model; sessions can switch models independently.
  const contextWindows = new Map<string, Promise<number | undefined>>()
  const resolveContextWindow = (model: string): Promise<number | undefined> => {
    const cached = contextWindows.get(model)
    if (cached !== undefined) return cached
    const pending = (async () => {
      const llm = ctx.get("llm")
      if (llm === undefined || config.provider === undefined || model.length === 0) return undefined
      try {
        const info = await llm.resolveModelInfo(config.provider, model)
        return info.context?.contextWindow
      } catch (error: unknown) {
        logger.warn(`acp: resolveModel failed, usage_update disabled: ${String(error)}`)
        return undefined
      }
    })()
    contextWindows.set(model, pending)
    return pending
  }

  const emitUsage = (record: SessionRecord, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined): void => {
    if (usage === undefined) return
    const agent = record.agent
    const model = record.model
    void resolveContextWindow(model).then(size => {
      if (size === undefined || closed || ownedRecord(agent) !== record || record.model !== model) return
      notify({
        sessionId: record.agent.session.id,
        update: {
          sessionUpdate: "usage_update",
          used: usage.inputTokens + (usage.cacheReadTokens ?? 0) + usage.outputTokens,
          size,
        },
      })
    })
  }

  /**
   * `_meta.alwith` turn metadata the ALwith Desktop client reads off assistant
   * and tool frames (turn_provider / turn_model / turn_timestamp); a turn
   * without an assistant providerId fails the client's envelope refresh.
   */
  const turnMeta = (record: SessionRecord): { alwith: { providerId: string; model: string; timestamp: string } } => ({
    alwith: {
      providerId: config.providerId ?? config.provider ?? "dsh",
      model: record.model,
      timestamp: new Date().toISOString(),
    },
  })

  /** Build the downlinked model config option from the adapter catalog; empty catalog downlinks nothing. */
  const modelConfigOptions = async (record: SessionRecord): Promise<SessionConfigOption[]> => {
    const llm = ctx.get("llm")
    if (llm === undefined || config.provider === undefined) return []
    const models = await llm.listModels(config.provider)
    if (models.length === 0) return []
    // v2 shape (`configId`, not v1's `id`): the SDK validates outgoing frames since 1.4
    // and drops an option that does not parse — the host would see no model select.
    return [
      {
        configId: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: record.model,
        options: models.map(model => ({ value: model.id, name: model.name })),
      },
    ]
  }

  const settlePrompt = (record: SessionRecord): void => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve()
  }

  /** Live-first session acquisition for resume: reuse a bridge-owned live agent, else cold-resume from persistence. */
  const acquireSession = async (sessionId: SessionId, cwd: string): Promise<SessionRecord> => {
    const live = sessions.get(sessionId)
    if (live !== undefined) {
      const storedCwd = live.agent.session.header.cwd
      if (storedCwd !== undefined && storedCwd !== cwd) {
        throw invalidParams(`cwd mismatch: session was created in ${storedCwd}`)
      }
      return live
    }
    if (ctx.agents.get(sessionId) !== undefined) {
      // In the sidecar composition every agent is bridge-owned; an unowned live
      // agent means another frontend shares this context — refuse rather than
      // adopt an agent this bridge cannot dispose.
      throw internalError(`session ${sessionId} is live outside the bridge`)
    }
    const persistence = ctx.get("sessionPersistence")
    if (persistence === undefined) {
      throw internalError("session persistence is not configured; session/resume is unavailable")
    }
    let inspection: Awaited<ReturnType<typeof persistence.inspect>>
    try {
      inspection = await persistence.inspect(sessionId)
    } catch (error: unknown) {
      throw invalidParams(`unknown session: ${sessionId} (${errorChain(error)})`)
    }
    if (inspection.meta.cwd !== undefined && inspection.meta.cwd !== cwd) {
      throw invalidParams(`cwd mismatch: session was created in ${inspection.meta.cwd}`)
    }
    const handle = await agents.resume({ resumeSessionId: sessionId, agentOptions: agentOptions(config) })
    if (closed) {
      await handle.dispose()
      throw internalError("connection closed during session/resume")
    }
    const record: SessionRecord = {
      agent: handle.agent,
      dispose: () => handle.dispose(),
      inflight: undefined,
      pendingPermissions: 0,
      lastState: undefined,
      titled: true, // a resumed session already carries its name on the client
      titleAbort: new AbortController(),
      model: config.model ?? "",
      switching: undefined,
    }
    sessions.set(sessionId, record)
    return record
  }

  /**
   * Replay the whole conversation as session/update frames (the replayFrom
   * { type: "start" } cursor). Committed messages only: user text as
   * user_message_chunk, assistant text/reasoning as message/thought chunks,
   * images as placeholders — mirroring the live-stream vocabulary.
   */
  const replayHistory = (record: SessionRecord): void => {
    const sessionId = record.agent.session.id
    for (const event of record.agent.session.snapshotEvents()) {
      if (event.type === "user/message") {
        const message = event.data
        for (const block of message.content) {
          if (block.type === "text" && block.text.length > 0) {
            notify({
              sessionId,
              update: { sessionUpdate: "user_message_chunk", messageId: MessageId(message.id), content: { type: "text", text: block.text } },
            })
          }
        }
      } else if (event.type === "assistant/message") {
        const message = event.data.message
        for (const block of message.content) {
          if (block.type === "text" && block.text.length > 0) {
            notify({
              sessionId,
              update: { sessionUpdate: "agent_message_chunk", messageId: MessageId(message.id), content: { type: "text", text: block.text }, _meta: turnMeta(record) },
            })
          } else if (block.type === "reasoning" && block.text.length > 0) {
            notify({
              sessionId,
              update: {
                sessionUpdate: "agent_thought_chunk",
                messageId: MessageId(`${message.id}/thought`),
                content: { type: "text", text: block.text },
              },
            })
          } else if (block.type === "image") {
            notify({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: MessageId(message.id),
                content: { type: "text", text: `[image attachment ${block.attachment.attachmentId}]` },
              },
            })
          }
        }
      }
    }
  }

  // Token-level streaming: text-delta → agent_message_chunk, reasoning-delta →
  // agent_thought_chunk. Committed assistant/message text is NOT re-emitted
  // (only image placeholders), or the client would render it twice.
  // Note: chunks of a retried model request have already streamed out — the
  // same live-stream behavior CLI frontends exhibit.
  ctx.on("session/event", (session, event: SessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      if (event.type === "assistant/chunk") {
        const chunk = event.data.chunk
        // v2 ContentChunk requires messageId (chunks of one message share it; a
        // change starts a new message). One dsh step is one model response, so
        // a session/turn/step composite is a stable per-message identity.
        const messageId = MessageId(`${record.agent.session.id}/${event.data.turn}/${event.data.step}`)
        if (chunk.type === "text-delta" && chunk.text.length > 0) {
          notify({
            sessionId: record.agent.session.id,
            update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: chunk.text }, _meta: turnMeta(record) },
          })
        } else if (chunk.type === "reasoning-delta" && chunk.text.length > 0) {
          notify({
            sessionId: record.agent.session.id,
            update: {
              sessionUpdate: "agent_thought_chunk",
              messageId: MessageId(`${messageId}/thought`),
              content: { type: "text", text: chunk.text },
              _meta: turnMeta(record),
            },
          })
        }
      } else if (event.type === "assistant/message") {
        for (const block of event.data.message.content) {
          if (block.type === "image") {
            notify({
              sessionId: record.agent.session.id,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: MessageId(event.data.message.id),
                content: { type: "text", text: `[image attachment ${block.attachment.attachmentId}]` },
                _meta: turnMeta(record),
              },
            })
          }
        }
        emitUsage(record, event.data.usage)
      } else if (event.type === "tool/call") {
        // First frame with a standard name creates the client-side card
        // (v2 dropped the tool_call variant; creation and patch share
        // tool_call_update).
        notify({
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: ToolCallId(event.data.callId),
            name: event.data.name,
            title: event.data.name,
            status: "in_progress",
            rawInput: parseRawInput(event.data.arguments),
            _meta: turnMeta(record),
          },
        })
      } else if (event.type === "tool/result") {
        const result = event.data.message.content[0]
        notify({
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: ToolCallId(result.toolCallId),
            status: event.data.error !== undefined || result.isError === true ? "failed" : "completed",
            content: toolResultContent(result.content),
            _meta: turnMeta(record),
          },
        })
      } else if (event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "compaction/end") {
        for (const update of compactionUpdates(event)) notify({ sessionId: record.agent.session.id, update })
      } else if (event.type === "todo/write") {
        // Whole-list snapshot; v2 item-based plans are replaced per update, so
        // the shapes align one to one.
        notify({
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: "plan_update",
            plan: {
              type: "items",
              planId: PlanId(record.agent.session.id),
              entries: event.data.todos.map(todo => ({ content: todo.content, status: todo.status, priority: "medium" as const })),
            },
          },
        })
      }
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === "turn/end" && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
      }
    }
  })

  ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on("agent/error", ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || inflight.turn === turn) return
    record.inflight = undefined
    reportIdle(record, "_error")
    inflight.reject(internalError(`turn failed: ${errorChain(error)}`))
  })

  // One-shot permission decisions via the v2 subject scheme (required title);
  // requires_action is reported while awaiting the client answer.
  ctx.on("approval/request", (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const callId = request.callId
    record.pendingPermissions += 1
    if (record.pendingPermissions === 1) notifyState(record, "requires_action")
    const response = client.request("session/request_permission", {
        sessionId: record.agent.session.id,
        title: request.reason ?? `Allow ${request.toolName}?`,
        subject: { type: "tool_call", toolCall: { toolCallId: callId } },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      }, { cancellationSignal: request.signal })
    // SDK cancellation is cooperative; release local state even if the peer answers late.
    const signal = request.signal
    let onAbort: (() => void) | undefined
    const aborted = new Promise<{ outcome: { outcome: "cancelled" } }>(resolve => {
      onAbort = () => resolve({ outcome: { outcome: "cancelled" } })
      if (signal?.aborted) onAbort()
      else signal?.addEventListener("abort", onAbort, { once: true })
    })
    return Promise.race([response, aborted])
      .then(({ outcome }) => {
        if (outcome.outcome === "cancelled") return "cancelled" as const
        return outcome.outcome === "selected" && outcome.optionId === "allow-once"
          ? ("allowed-once" as const)
          : ("rejected" as const)
      })
      .finally(() => {
        if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort)
        record.pendingPermissions -= 1
        if (record.pendingPermissions === 0 && record.inflight !== undefined && !record.inflight.cancelled
          && ownedRecord(request.agent) === record && !closed) notifyState(record, "running")
      })
  })

  const app = createAgentApp()
    .onConnect(connected => {
      client = connected.client
    })
    .onRequest("initialize", (): InitializeResponse => {
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        info: { name: "dsh-agent", title: "ALwith dsh bridge", version: packageJson.version },
        authMethods: [],
        capabilities: {
          session: { prompt: {} },
          // seedHistory: a host that keeps its own transcript can continue it here —
          // `session/new` with `_meta.dsh.seedHistory: [{role, text}]` injects it as
          // model-facing context (agent.inject) before the first turn.
          _meta: { dsh: { seedHistory: true } },
        },
      }
    })
    .onRequest("session/new", async (context): Promise<NewSessionResponse> => {
      assertOpen()
      const params: NewSessionRequest = context.params
      validateSessionParams(params)
      const seed = seedHistoryOf(params._meta)
      const sessionId = SessionId(randomUUID())
      const handle = await agents.create({
        sessionId,
        meta: { cwd: params.cwd },
        agentOptions: agentOptions(config),
      })
      if (closed) {
        await handle.dispose()
        throw internalError("connection closed during session/new")
      }
      sessions.set(sessionId, {
        agent: handle.agent,
        dispose: () => handle.dispose(),
        inflight: undefined,
        pendingPermissions: 0,
        lastState: undefined,
        titled: false,
        titleAbort: new AbortController(),
        model: config.model ?? "",
        switching: undefined,
      })
      const record = sessions.get(sessionId)
      if (record === undefined) throw internalError("session record vanished during session/new")
      try {
        if (seed.length > 0) {
          record.agent.inject(
            createUserMessage({ content: [{ type: "text", text: seedTranscript(seed) }], source: { kind: "user" } }),
          )
        }
        const configOptions = await modelConfigOptions(record)
        assertOpen()
        return { sessionId, configOptions }
      } catch (error: unknown) {
        sessions.delete(sessionId)
        record.titleAbort.abort()
        await record.dispose()
        throw error
      }
    })
    // v2 baseline: session/list is part of the `session: {}` surface, no capability key.
    // Headers come from dsh's own persistence (the on-disk format stays private to it);
    // `cwd` narrows to sessions started in that workspace, like the cli.
    .onRequest("session/list", async (context): Promise<ListSessionsResponse> => {
      assertOpen()
      const params: ListSessionsRequest = context.params
      const persistence = ctx.get("sessionPersistence")
      if (persistence === undefined) throw internalError("session persistence is not mounted")
      const headers = await persistence.list()
      const sessions = headers
        .filter(header => params.cwd === undefined || params.cwd === null || header.cwd === params.cwd)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(header => {
          // Every bridge session is created with meta.cwd; a header without one is a
          // persistence anomaly, not a session the host could resume.
          if (header.cwd === undefined) throw internalError(`persisted session ${header.id} has no cwd`)
          return { sessionId: header.id, cwd: header.cwd, updatedAt: new Date(header.createdAt).toISOString() }
        })
      return { sessions, nextCursor: null }
    })
    .onRequest("session/resume", async (context): Promise<ResumeSessionResponse> => {
      assertOpen()
      const params: ResumeSessionRequest = context.params
      if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      const sessionId = SessionId(params.sessionId)
      let pending = resumes.get(sessionId)
      if (pending === undefined) {
        pending = acquireSession(sessionId, params.cwd)
        resumes.set(sessionId, pending)
        void pending.catch(() => {}).finally(() => resumes.delete(sessionId))
      }
      const acquired = await pending
      // Each waiter must validate its own cwd, even when acquisition is shared.
      const storedCwd = acquired.agent.session.header.cwd
      if (storedCwd !== undefined && storedCwd !== params.cwd) {
        throw invalidParams(`cwd mismatch: session was created in ${storedCwd}`)
      }
      // Replay is client-driven: an omitted/null cursor means context-only
      // restore (the client already has the history); { type: "start" } means
      // replay the whole conversation.
      if (params.replayFrom !== undefined && params.replayFrom !== null) {
        if (params.replayFrom.type !== "start") {
          throw invalidParams(`unsupported replayFrom cursor: ${params.replayFrom.type}`)
        }
        replayHistory(acquired)
      }
      return { configOptions: await modelConfigOptions(acquired) }
    })
    .onRequest("session/set_config_option", async (context): Promise<SetSessionConfigOptionResponse> => {
        assertOpen()
        const params: SetSessionConfigOptionRequest = context.params
        const { sessionId, configId } = params
        const record = requireSession(sessionId)
        if (configId !== "model") throw invalidParams(`unsupported config option: ${configId}`)
        // The schema keeps an open `{ type: string; value: unknown }` branch for future
        // value kinds, so the discriminant alone does not narrow `value`.
        const value = params.type === "id" && typeof params.value === "string" ? params.value : undefined
        if (value === undefined || value.length === 0) throw invalidParams("model is a select option: send { type: \"id\", value: <model id> }")
        if (record.inflight !== undefined) throw invalidParams("cannot switch model while a prompt is in flight")
        if (record.switching !== undefined) throw invalidParams("a model switch is already in progress")
        if (record.model !== value) {
          // Handle disposal durably clears the inbox; retain unconsumed seed/input.
          if (record.agent.inbox.hasPending) throw invalidParams("cannot switch model while input is pending; send a prompt first")
          // In-place options are immutable on a live dsh agent; the sanctioned
          // switch is dispose + resume with new agentOptions — same machinery
          // as session/resume, so history and turn numbering carry over.
          const persistence = ctx.get("sessionPersistence")
          if (persistence === undefined) {
            throw internalError("session persistence is not configured; model switching is unavailable")
          }
          const previous = record.agent
          const id = previous.session.id
          const empty = previous.session.snapshotEvents().length === 0
          record.switching = (async () => {
            const options = { ...(config.provider !== undefined ? { provider: config.provider } : {}), model: value }
            await ctx.sessions.flush(record.agent.session)
            await record.dispose()
            if (closed || sessions.get(id) !== record) throw internalError("session closed during model switch")
            // JSONL persistence is event-driven: an untouched session has no log to resume.
            const handle = empty
              ? await agents.create({ sessionId: id, meta: { cwd: previous.session.header.cwd }, agentOptions: options })
              : await agents.resume({ resumeSessionId: id, agentOptions: options })
            if (closed || sessions.get(id) !== record) {
              await handle.dispose()
              throw internalError("session closed during model switch")
            }
            record.agent = handle.agent
            record.dispose = () => handle.dispose()
            record.model = value
          })()
          try {
            await record.switching
          } catch (error: unknown) {
            // A failed replacement must not leave a retired agent addressable.
            if (sessions.get(id) === record) sessions.delete(id)
            record.titleAbort.abort()
            await record.dispose()
            if (empty) throw internalError(`model switch failed; empty session is no longer resumable, create a new session: ${errorChain(error)}`)
            throw internalError(`model switch failed; recover the persisted session with session/resume: ${errorChain(error)}`)
          } finally {
            record.switching = undefined
          }
        }
        const configOptions = await modelConfigOptions(record)
        assertOpen()
        if (sessions.get(record.agent.session.id) !== record) throw invalidParams("session closed during model switch")
        notify({ sessionId: record.agent.session.id, update: { sessionUpdate: "config_option_update", configOptions } })
        return { configOptions }
      })
    .onRequest("session/prompt", async (context): Promise<PromptResponse> => {
      assertOpen()
      const params: PromptRequest = context.params
      const record = requireSession(params.sessionId)
      while (record.switching !== undefined) await record.switching.catch(() => {})
      assertOpen()
      if (sessions.get(record.agent.session.id) !== record) throw invalidParams("session closed while prompt was waiting")
      if (record.inflight?.cancelled) throw invalidParams("session cancellation is still in progress")
      if (promptHasUnsupportedContent(params.prompt)) {
        throw invalidParams("only text and resource_link prompt content is supported")
      }
      const text = acpPromptToText(params.prompt)
      if (text.trim().length === 0) {
        // Mirror alwith-cli: an empty prompt reports idle(end_turn) and returns; it is not a protocol error.
        if (record.inflight === undefined) reportIdle(record, "end_turn")
        return {}
      }

      // Bridge contract: never drive a retired agent — a loop-only reload disposes agents while bridge records survive.
      if (ctx.agents.get(record.agent.id) !== record.agent) {
        throw internalError("prompt was not queued: the agent was disposed outside the bridge")
      }
      // Deterministic first-prompt title lands immediately (the host backfills
      // run-state titles from this frame); the LLM upgrade runs after settlement.
      const firstPrompt = !record.titled
      if (firstPrompt) {
        record.titled = true
        const title = text.trim().replace(/\s+/g, " ").slice(0, 60)
        notify({
          sessionId: record.agent.session.id,
          update: { sessionUpdate: "session_info_update", title },
        })
      }
      const message = createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })
      if (record.inflight !== undefined) {
        // Another prompt while a turn is running: it enters the dsh inbox and
        // is claimed by the driver at the next step boundary (approximating
        // alwith-cli's mid-turn steering); completion is still announced by
        // the in-flight turn's idle frame.
        record.agent.followup(message)
        reportUserMessage(record, message.id, text)
        return {}
      }
      await new Promise<void>((resolve, reject) => {
        const inflight: NonNullable<SessionRecord["inflight"]> = {
          resolve,
          reject,
          messageId: message.id,
          turn: undefined,
          endReason: undefined,
          cancelled: false,
        }
        record.inflight = inflight
        try {
          record.agent.followup(message)
          reportUserMessage(record, message.id, text)
          notifyState(record, "running")
        } catch (error: unknown) {
          record.inflight = undefined
          const detail = error instanceof Error ? error.message : String(error)
          throw internalError(`prompt was not queued: ${detail}`)
        }
        // Settlement waits for whole-agent idle: a correlated turn/end arms
        // endReason first; a turnless slot (admission discarded the prompt)
        // stays cancelled. Since v2 the stop reason travels on the idle state
        // frame; the prompt response body is _meta-only.
        void record.agent.whenIdle().then(async () => {
          if (record.inflight !== inflight) return
          // Idle is a host-visible durability boundary: the process may exit as
          // soon as this frame arrives. Drain the official session write path first.
          await ctx.sessions.flush(record.agent.session)
          if (record.inflight !== inflight) return
          record.inflight = undefined
          const end = inflight.endReason
          if (end?.kind === "error") {
            reportIdle(record, "_error")
            inflight.reject(internalError(`turn failed: ${end.error.message}`))
            return
          }
          const reason: StopReason = inflight.cancelled || end === undefined ? "cancelled" : turnEndToStopReason(end)
          reportIdle(record, reason)
          inflight.resolve()
        }).catch((error: unknown) => {
          if (record.inflight !== inflight) return
          record.inflight = undefined
          reportIdle(record, "_error")
          inflight.reject(internalError(`turn settlement failed: ${errorChain(error)}`))
        })
      })
      // First turn settled: upgrade the deterministic title in the background.
      if (firstPrompt) void refineTitle(record, text)
      return {}
    })
    .onRequest("session/close", async (context): Promise<CloseSessionResponse> => {
      const params: CloseSessionRequest = context.params
      const record = requireSession(params.sessionId)
      // Baseline v2 method: stop foreground work, settle the caller, free the
      // agent. The record leaves the table first so a racing frame for this
      // session is dropped rather than reported on a released agent.
      sessions.delete(SessionId(params.sessionId))
      record.titleAbort.abort()
      record.agent.cancel({ kind: "user" })
      settlePrompt(record)
      try {
        await record.switching?.catch(() => {})
        await record.agent.whenIdle()
        // A switch flushes before retirement; its retired session is no longer in the store.
        if (ctx.agents.get(record.agent.id) === record.agent) await ctx.sessions.flush(record.agent.session)
      } catch (error: unknown) {
        throw internalError(`session close failed: ${errorChain(error)}`)
      } finally {
        await record.dispose()
      }
      return {}
    })
    .onNotification("session/cancel", context => {
      const params: CancelSessionNotification = context.params
      const record = sessions.get(SessionId(params.sessionId))
      if (record === undefined || record.inflight === undefined) return
      record.inflight.cancelled = true
      record.agent.cancel({ kind: "user" })
    })

  const stream: Stream =
    config.stream ??
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    )
  const connection: AgentConnection = app.connect(stream)

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    for (const record of records) {
      record.titleAbort.abort()
      record.agent.cancel({ kind: "user" })
      settlePrompt(record)
    }
    quiescing = (async () => {
      const disposals = await Promise.allSettled(records.map(async record => {
        await record.switching?.catch(() => {})
        await record.dispose()
      }))
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === "rejected") failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        const detail = failures.map(failure => errorChain(failure)).join("; ")
        throw new AggregateError(failures, `ACP agent teardown failed for ${failures.length} session(s): ${detail}`)
      }
    })()
    return quiescing
  }

  void connection.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })

  ctx.effect(() => quiesce, "dsh-agent.connection")
}

/**
 * dsh compaction lifecycle → ACP v2 (SDK 1.4) compaction frames. `compaction/start`
 * opens the bracket, each `compaction/summary` text block streams as a summary
 * chunk, `compaction/end` settles it — `error` present means it failed. The
 * internal `compaction/prune` bookkeeping has no client-visible counterpart.
 */
export function compactionUpdates(event: SessionEvent): UpdateSessionNotification["update"][] {
  if (event.type === "compaction/start") {
    return [{ sessionUpdate: "compaction_update", compactionId: CompactionId(event.data.compactionId), status: "in_progress" }]
  }
  if (event.type === "compaction/summary") {
    return event.data.summary.flatMap(block =>
      block.type === "text" && block.text.length > 0
        ? [{ sessionUpdate: "compaction_summary_chunk" as const, compactionId: CompactionId(event.data.compactionId), content: { type: "text" as const, text: block.text } }]
        : [],
    )
  }
  if (event.type === "compaction/end") {
    const error = event.data.error
    return [
      error === undefined
        ? { sessionUpdate: "compaction_update", compactionId: CompactionId(event.data.compactionId), status: "completed" }
        : { sessionUpdate: "compaction_update", compactionId: CompactionId(event.data.compactionId), status: "failed", error },
    ]
  }
  return []
}

/** Brand a string as a v2 CompactionId. */
function CompactionId(id: string): CompactionId {
  return id as CompactionId
}

function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
  }
}

/** Reject session features outside the bridge contract. */
function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams("additionalDirectories is not supported")
  }
  if (params.mcpServers !== undefined && params.mcpServers.length > 0) {
    throw invalidParams("mcpServers is not supported")
  }
}

export interface SeedMessage {
  role: "user" | "assistant"
  text: string
}

/** `session/new` `_meta.dsh.seedHistory`: prior conversation the host kept, to inject as model-facing context. */
export function seedHistoryOf(meta: NewSessionRequest["_meta"]): SeedMessage[] {
  const raw = (meta as { dsh?: { seedHistory?: unknown } } | null | undefined)?.dsh?.seedHistory
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw invalidParams("seedHistory must be an array of {role, text}")
  return raw.map((entry, index) => {
    const role = (entry as { role?: unknown })?.role
    const text = (entry as { text?: unknown })?.text
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
      throw invalidParams(`seedHistory[${index}] must be {role: "user" | "assistant", text: string}`)
    }
    return { role, text }
  })
}

/** dsh injects one user-authored context message; the transcript is framed so the model reads it as history. */
export function seedTranscript(seed: readonly SeedMessage[]): string {
  const lines = seed.map(message => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
  return `<prior_conversation>\n${lines.join("\n\n")}\n</prior_conversation>`
}
