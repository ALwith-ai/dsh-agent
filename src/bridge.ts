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
 * MVP scope: session/new + prompt + cancel. session/resume is the next
 * milestone (v2 renamed v1's session/load; it carries a client-driven
 * replayFrom cursor — omitted means context-only restore, { type: "start" }
 * means replay the whole conversation as session/update frames).
 */

import type { Context } from "@deepseek-ai/cordis"
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
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
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
import type {} from "@deepseek-ai/dsh-session-persistence"
import type { ContentBlock as DshContentBlock } from "@deepseek-ai/dsh-llm"
import { acpPromptToText, promptHasUnsupportedContent, turnEndToStopReason } from "./codec.ts"

export const name = "alwith-dsh-acp"
/** The bridge creates and owns agents (llm serves background session titling); every other concern is carried by the composition. */
export const inject = ["agents", "llm"]

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
  } | undefined
  /** Pending permission requests; while > 0 the reported state is requires_action. */
  pendingPermissions: number
  /** Last emitted state_update value, deduplicating consecutive identical frames. */
  lastState: "running" | "idle" | "requires_action" | undefined
  /** Whether a session_info_update title was already emitted (first prompt names the session). */
  titled: boolean
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
    try {
      const message = createUserMessage({ content: [{ type: "text", text: firstPrompt }], source: { kind: "user" } })
      // Reasoning models burn budget on reasoning before any text, so the cap
      // is generous and the effort drops to the model's own "low" when it
      // advertises one (efforts are adapter-owned; an invented id is rejected).
      const modelInfo = await ctx.llm.resolveModelInfo(config.provider, config.titleModel).catch(() => undefined)
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

  // usage_update needs the context-window size; resolve it once per bridge
  // lifetime (provider/model are fixed per composition) and skip the frame
  // when the model does not declare a window.
  let contextWindow: Promise<number | undefined> | undefined
  const resolveContextWindow = (): Promise<number | undefined> => {
    contextWindow ??= (async () => {
      const llm = ctx.get("llm")
      if (llm === undefined || config.provider === undefined || config.model === undefined) return undefined
      try {
        const info = await llm.resolveModelInfo(config.provider, config.model)
        return info.context?.contextWindow
      } catch (error: unknown) {
        logger.warn(`acp: resolveModel failed, usage_update disabled: ${String(error)}`)
        return undefined
      }
    })()
    return contextWindow
  }

  const emitUsage = (record: SessionRecord, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined): void => {
    if (usage === undefined) return
    void resolveContextWindow().then(size => {
      if (size === undefined) return
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
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: record.model,
        options: models.map(model => ({ value: model.id, name: model.name })),
      } as unknown as SessionConfigOption,
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
        if (event.data.reason.kind === "error") {
          record.inflight = undefined
          reportIdle(record, "end_turn")
          inflight.reject(internalError(`turn failed: ${event.data.reason.error.message}`))
        } else {
          inflight.endReason = event.data.reason
        }
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
    reportIdle(record, "end_turn")
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
    return client
      .request("session/request_permission", {
        sessionId: record.agent.session.id,
        title: request.reason ?? `Allow ${request.toolName}?`,
        subject: { type: "tool_call", toolCall: { toolCallId: callId } },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      })
      .then(({ outcome }) => {
        if (outcome.outcome === "cancelled") return "cancelled" as const
        return outcome.outcome === "selected" && outcome.optionId === "allow-once"
          ? ("allowed-once" as const)
          : ("rejected" as const)
      })
      .finally(() => {
        record.pendingPermissions -= 1
        if (record.pendingPermissions === 0) notifyState(record, "running")
      })
  })

  const app = createAgentApp()
    .onConnect(connected => {
      client = connected.client
    })
    .onRequest("initialize", (): InitializeResponse => {
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        info: { name: "alwith-dsh-acp", title: "ALwith dsh bridge", version: "0.1.0" },
        authMethods: [],
        capabilities: { session: { prompt: {} } },
      }
    })
    .onRequest("session/new", async (context): Promise<NewSessionResponse> => {
      assertOpen()
      const params: NewSessionRequest = context.params
      validateSessionParams(params)
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
        model: config.model ?? "",
        switching: undefined,
      })
      const record = sessions.get(sessionId)
      if (record === undefined) throw internalError("session record vanished during session/new")
      return { sessionId, configOptions: await modelConfigOptions(record) }
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
    .onRequest(
      "session/set_config_option",
      // Custom parser: ALwith Desktop sends { sessionId, configId, value } without
      // the schema's `type` discriminant (the alwith-cli dialect); accept both.
      (params: unknown) => {
        const body = params as { sessionId?: string; configId?: string; value?: unknown }
        if (typeof body?.sessionId !== "string" || typeof body.configId !== "string") {
          throw invalidParams("session/set_config_option requires sessionId and configId")
        }
        return { sessionId: body.sessionId, configId: body.configId, value: body.value }
      },
      async (context): Promise<SetSessionConfigOptionResponse> => {
        assertOpen()
        const { sessionId, configId, value } = context.params
        const record = requireSession(sessionId)
        if (configId !== "model") throw invalidParams(`unsupported config option: ${configId}`)
        if (typeof value !== "string" || value.length === 0) throw invalidParams("model value must be a non-empty string")
        if (record.inflight !== undefined) throw invalidParams("cannot switch model while a prompt is in flight")
        if (record.switching !== undefined) await record.switching
        if (record.model !== value) {
          // In-place options are immutable on a live dsh agent; the sanctioned
          // switch is dispose + resume with new agentOptions — same machinery
          // as session/resume, so history and turn numbering carry over.
          const persistence = ctx.get("sessionPersistence")
          if (persistence === undefined) {
            throw internalError("session persistence is not configured; model switching is unavailable")
          }
          const previous = record.agent
          const id = previous.session.id
          record.switching = (async () => {
            await record.dispose()
            const handle = await agents.resume({
              resumeSessionId: id,
              agentOptions: { ...(config.provider !== undefined ? { provider: config.provider } : {}), model: value },
            })
            record.agent = handle.agent
            record.dispose = () => handle.dispose()
            record.model = value
          })()
          try {
            await record.switching
          } finally {
            record.switching = undefined
          }
        }
        const configOptions = await modelConfigOptions(record)
        notify({ sessionId: record.agent.session.id, update: { sessionUpdate: "config_option_update", configOptions } })
        return { configOptions }
      },
    )
    .onRequest("session/prompt", async (context): Promise<PromptResponse> => {
      assertOpen()
      const params: PromptRequest = context.params
      const record = requireSession(params.sessionId)
      if (record.switching !== undefined) await record.switching
      if (promptHasUnsupportedContent(params.prompt)) {
        throw invalidParams("only text and resource_link prompt content is supported")
      }
      const text = acpPromptToText(params.prompt)
      if (text.trim().length === 0) {
        // Mirror alwith-cli: an empty prompt reports idle(end_turn) and returns; it is not a protocol error.
        reportIdle(record, "end_turn")
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
        return {}
      }
      await new Promise<void>((resolve, reject) => {
        const inflight: NonNullable<SessionRecord["inflight"]> = {
          resolve,
          reject,
          messageId: message.id,
          turn: undefined,
          endReason: undefined,
        }
        record.inflight = inflight
        try {
          record.agent.followup(message)
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
        void record.agent.whenIdle().then(() => {
          if (record.inflight !== inflight) return
          record.inflight = undefined
          const end = inflight.endReason
          const reason: StopReason =
            end === undefined ? "cancelled" : end.kind === "max-tokens" ? "end_turn" : turnEndToStopReason(end)
          reportIdle(record, reason)
          inflight.resolve()
        })
      })
      // First turn settled: upgrade the deterministic title in the background.
      if (firstPrompt) void refineTitle(record, text)
      return {}
    })
    .onNotification("session/cancel", context => {
      const params: CancelSessionNotification = context.params
      const record = sessions.get(SessionId(params.sessionId))
      if (record === undefined) return
      record.agent.cancel({ kind: "user" })
      reportIdle(record, "cancelled")
      settlePrompt(record)
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
      record.agent.cancel({ kind: "user" })
      settlePrompt(record)
    }
    quiescing = (async () => {
      const disposals = await Promise.allSettled(records.map(record => record.dispose()))
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

  ctx.effect(() => quiesce, "alwith-dsh-acp.connection")
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
