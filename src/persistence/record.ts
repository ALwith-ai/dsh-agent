/**
 * ALwith session record codec: the DSH event log ⇄ `~/.alwith/projects/<项目键>/<id>.jsonl`.
 *
 * The record is the ALwith format that is compatible with Claude Code messages (contract:
 * alwith-desktop `docs/session-record.md`). Three layers share one file:
 *
 * - version header — first line `{"type":"alwith","kind":"header",…}` (absent on records
 *   written by the ALwith CLI today: those are v0, read by their message layer alone);
 * - message layer — Claude Code transcript lines (`user` / `assistant`), the model's history
 *   messages in Anthropic Messages shape, which the CLI reads natively;
 * - event layer — `{"type":"alwith","kind":…}` lines: every DSH event verbatim (`event` /
 *   `chunks`), request provenance (`request` + content-addressed `snapshot`).
 *
 * Writing projects each DSH surface event into the message layer AND keeps the event itself, so a
 * DSH resume restores the exact event stream while the CLI (or any Claude Code reader) sees the
 * conversation. Reading a record another engine wrote (no DSH events for those turns) rebuilds
 * DSH events from the message layer: user prompts, assistant text, tool calls and results.
 * Thinking blocks stay in the file and never enter DSH's context (they only mean something to the
 * model that produced them); an image block without a mounted attachment store is an error.
 */
import { createHash, randomUUID } from "node:crypto"
import { SESSION_FORMAT_VERSION, SessionSeq } from "@deepseek-ai/dsh-session"
import type { SessionEvent, SessionEventType, SessionHeader, SessionId } from "@deepseek-ai/dsh-session"
import { MessageId, ToolCallId } from "@deepseek-ai/dsh-llm"
import type { ContentBlock } from "@deepseek-ai/dsh-llm"

export const RECORD_VERSION = 1
export const ENGINE = "dsh"

export interface RecordWriter {
  readonly name: string
  readonly version: string
}

/** DSH storage metadata carried inside the ALwith header so a resume rebuilds the exact header. */
export interface DshHeaderBlock {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
}

/** Per-session state the writer needs beyond the events themselves. */
export interface EncodeState {
  /** uuid of the last message-layer line, the `parentUuid` of the next one. */
  lastUuid: string | null
  /** Content-addressed snapshot refs already present in the file. */
  readonly snapshotRefs: Set<string>
}

export interface EncodeContext {
  readonly recordId: SessionId
  readonly cwd: string | undefined
  /** Host provider identity (the ALwith Desktop vocabulary) stamped on projected messages. */
  readonly providerId: string
}

export interface DecodedRecord {
  readonly meta: SessionHeader
  readonly inheritedEventCount: number
  readonly events: SessionEvent[]
  /** Byte length of the complete-line prefix; smaller than the file when the tail is torn. */
  readonly committedBytes: number
  readonly state: EncodeState
  readonly hasHeader: boolean
}

// ---------------------------------------------------------------------------------------------
// paths

const MAX_SANITIZED_LENGTH = 200

function simpleHash(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

/** Sessions created without a cwd (never by the ALwith bridge) share one directory, as upstream does. */
export const NO_CWD_PROJECT = "_no-cwd"

/** Project key: byte-identical to the ALwith CLI's `sanitizePath` (non-alphanumerics → `-`). */
export function projectKey(cwd: string | undefined): string {
  if (cwd === undefined) return NO_CWD_PROJECT
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${simpleHash(cwd)}`
}

// ---------------------------------------------------------------------------------------------
// encoding

function isoTime(time: number): string {
  return new Date(time).toISOString()
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function alwithLine(kind: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "alwith", kind, ...fields })
}

export function headerLine(context: EncodeContext, createdAt: number, writer: RecordWriter, dsh: DshHeaderBlock): string {
  return alwithLine("header", {
    version: RECORD_VERSION,
    recordId: context.recordId,
    ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
    createdAt: isoTime(createdAt),
    writer: { engine: ENGINE, ...writer },
    dsh,
  })
}

type ClaudeBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }

function blockText(block: ContentBlock): string | undefined {
  switch (block.type) {
    case "text":
      return block.text
    case "image":
      // Only a mounted AttachmentStore can put an image into a dsh session; the record must then carry
      // the bytes (Claude Code `image` block), not a paraphrase. No store is mounted in this composition.
      throw new Error(`image attachment ${block.attachment.attachmentId} cannot be recorded: no attachment store is mounted`)
    case "reasoning":
    case "tool-call":
    case "tool-result":
      return undefined
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return { raw }
  }
}

function claudeMessageLine(
  context: EncodeContext,
  state: EncodeState,
  role: "user" | "assistant",
  content: string | ClaudeBlock[],
  time: number,
  extra: Record<string, unknown>,
  alwith: Record<string, unknown>,
): string {
  const uuid = randomUUID()
  const line = JSON.stringify({
    parentUuid: state.lastUuid,
    isSidechain: false,
    userType: "external",
    ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
    sessionId: context.recordId,
    type: role,
    message: { role, ...extra, content },
    uuid,
    timestamp: isoTime(time),
    alwith: { engine: ENGINE, providerId: context.providerId, ...alwith },
  })
  state.lastUuid = uuid
  return line
}

function projectUserMessage(context: EncodeContext, state: EncodeState, event: SessionEvent<"user/message">): string | undefined {
  if (event.data.id === undefined || event.data.source?.kind !== "user" || !Array.isArray(event.data.content)) return undefined
  const texts = event.data.content.map(blockText).filter((text): text is string => text !== undefined)
  if (texts.length === 0) return undefined
  return claudeMessageLine(context, state, "user", texts.join("\n"), event.time, {}, { seq: event.seq, messageId: event.data.id })
}

function projectAssistantMessage(context: EncodeContext, state: EncodeState, event: SessionEvent<"assistant/message">): string | undefined {
  // Pre-identity logs carry `content` + `provenance` on the event itself; the coordinator migrates
  // them on load, and the verbatim event line is what a reload reads. No projection for those.
  if (event.data.message?.content === undefined || event.data.message.source === undefined) return undefined
  const blocks: ClaudeBlock[] = []
  for (const block of event.data.message.content) {
    if (block.type === "tool-call") {
      blocks.push({ type: "tool_use", id: block.id, name: block.name, input: parseArguments(block.arguments) })
      continue
    }
    const text = blockText(block)
    if (text !== undefined && text.length > 0) blocks.push({ type: "text", text })
  }
  if (blocks.length === 0) return undefined
  const usage = event.data.usage
  const hasToolUse = blocks.some(block => block.type === "tool_use")
  return claudeMessageLine(
    context,
    state,
    "assistant",
    blocks,
    event.time,
    {
      id: event.data.message.id,
      type: "message",
      model: event.data.message.source.model,
      stop_reason: event.data.interrupted === true ? null : hasToolUse ? "tool_use" : "end_turn",
      ...(usage === undefined
        ? {}
        : {
            usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              ...(usage.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: usage.cacheReadTokens }),
              ...(usage.cacheWriteTokens === undefined ? {} : { cache_creation_input_tokens: usage.cacheWriteTokens }),
            },
          }),
    },
    {
      seq: event.seq,
      messageId: event.data.message.id,
      provider: event.data.message.source.provider,
      ...(event.data.interrupted === true ? { interrupted: true } : {}),
    },
  )
}

function projectToolResult(context: EncodeContext, state: EncodeState, event: SessionEvent<"tool/result">): string | undefined {
  const block = event.data.message?.content?.[0]
  if (block === undefined || block.type !== "tool-result") return undefined
  const text = block.content.map(blockText).filter((part): part is string => part !== undefined).join("\n")
  return claudeMessageLine(
    context,
    state,
    "user",
    [{ type: "tool_result", tool_use_id: block.toolCallId, content: text, is_error: block.isError === true }],
    event.time,
    {},
    { seq: event.seq, messageId: event.data.message.id, ...(event.data.error === undefined ? {} : { error: event.data.error }) },
  )
}

function projectRequestHeader(context: EncodeContext, state: EncodeState, event: SessionEvent<"request/header">): string[] {
  const lines: string[] = []
  const { header } = event.data
  const snapshot = (content: unknown): { ref: string } => {
    const ref = sha256(content)
    if (!state.snapshotRefs.has(ref)) {
      state.snapshotRefs.add(ref)
      lines.push(alwithLine("snapshot", { seq: event.seq, time: isoTime(event.time), engine: ENGINE, ref, content }))
    }
    return { ref }
  }
  const systemPrompt = header.system === undefined ? null : snapshot(header.system)
  const tools = header.tools === undefined ? null : snapshot(header.tools)
  lines.push(
    alwithLine("request", {
      seq: event.seq,
      time: isoTime(event.time),
      engine: ENGINE,
      providerId: context.providerId,
      provider: header.config.provider,
      model: header.config.model,
      ...(header.config.reasoningEffort === undefined ? {} : { reasoningEffort: header.config.reasoningEffort }),
      reason: event.data.reason,
      systemPrompt,
      tools,
    }),
  )
  return lines
}

/**
 * Encode one contiguous batch: every event verbatim (delta chunks packed per run), plus the
 * message-layer projection and request provenance. Returns newline-terminated text.
 */
export function encodeBatch(context: EncodeContext, state: EncodeState, events: readonly SessionEvent[]): string {
  const lines: string[] = []
  let chunkRun: SessionEvent[] = []
  const flushChunks = (): void => {
    if (chunkRun.length === 0) return
    const first = chunkRun[0]!
    lines.push(alwithLine("chunks", { seq: first.seq, time: isoTime(first.time), engine: ENGINE, events: chunkRun }))
    chunkRun = []
  }
  for (const event of events) {
    if (event.type === "assistant/chunk") {
      chunkRun.push(event)
      continue
    }
    flushChunks()
    lines.push(alwithLine("event", { seq: event.seq, time: isoTime(event.time), engine: ENGINE, event }))
    switch (event.type) {
      case "user/message": {
        const line = projectUserMessage(context, state, event)
        if (line !== undefined) lines.push(line)
        break
      }
      case "assistant/message": {
        const line = projectAssistantMessage(context, state, event)
        if (line !== undefined) lines.push(line)
        break
      }
      case "tool/result": {
        const line = projectToolResult(context, state, event)
        if (line !== undefined) lines.push(line)
        break
      }
      case "request/header":
        lines.push(...projectRequestHeader(context, state, event))
        break
      default:
        break
    }
  }
  flushChunks()
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------------------------
// decoding

interface RecordLine {
  type?: string
  kind?: string
  subtype?: string
  uuid?: string
  timestamp?: string
  cwd?: string
  isMeta?: boolean
  isCompactSummary?: boolean
  messageUuid?: string
  status?: string
  seq?: number
  engine?: string
  event?: SessionEvent
  events?: SessionEvent[]
  ref?: string
  version?: number
  createdAt?: string
  dsh?: DshHeaderBlock
  alwith?: { engine?: string; delivery?: string; providerId?: string; projected?: boolean }
  message?: { role?: string; model?: string; content?: string | ClaudeContentBlock[] }
}

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image"; source: { media_type?: string; data?: string } }
  | { type: "tool_use"; id: string; name: string; input?: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string }

interface ParsedLines {
  readonly lines: RecordLine[]
  readonly committedBytes: number
}

/** Split into complete lines; the final line may be torn (no newline / not JSON) and is excluded. */
function parseLines(buffer: Buffer): ParsedLines {
  const lines: RecordLine[] = []
  let offset = 0
  let committedBytes = 0
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset)
    const end = newline === -1 ? buffer.length : newline
    const raw = buffer.subarray(offset, end).toString("utf8")
    const complete = newline !== -1
    if (raw.trim().length > 0) {
      let parsed: RecordLine
      try {
        parsed = JSON.parse(raw) as RecordLine
      } catch (error) {
        if (!complete) break
        throw new Error(`corrupt ALwith record: line ending at byte ${end} is not JSON: ${String(error)}`)
      }
      lines.push(parsed)
    }
    if (!complete) break
    offset = end + 1
    committedBytes = offset
  }
  return { lines, committedBytes }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map(block => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : JSON.stringify(block)))
      .join("\n")
  }
  if (content === undefined || content === null) return ""
  return JSON.stringify(content)
}

/** A DSH event before its seq is assigned; distributive so surface intents keep their fields. */
type NewEvent = { [K in SessionEventType]: Omit<SessionEvent<K>, "seq"> }[SessionEventType]

/** Rebuilds DSH events from Claude Code message lines another engine wrote. */
class Reconstruction {
  readonly events: SessionEvent[] = []
  private turn = 0
  private step = 0
  private turnOpen = false
  private stepOpen = false
  private time = 0
  /** Tool calls without a result yet; an open trailing turn with none pending is complete. */
  private pendingCalls = 0

  constructor(private readonly recordId: SessionId) {}

  private push(event: NewEvent): void {
    this.events.push({ ...event, seq: SessionSeq(this.events.length) } as SessionEvent)
  }

  private stamp(line: RecordLine): number {
    const parsed = line.timestamp === undefined ? Number.NaN : Date.parse(line.timestamp)
    if (!Number.isNaN(parsed)) this.time = Math.max(this.time, parsed)
    return this.time
  }

  private closeStep(): void {
    if (!this.stepOpen) return
    this.push({ type: "step/end", time: this.time, data: { turn: this.turn, step: this.step } })
    this.stepOpen = false
  }

  closeTurn(): void {
    if (!this.turnOpen) return
    this.closeStep()
    this.push({ type: "turn/end", time: this.time, data: { turn: this.turn, reason: { kind: "completed" } } })
    this.turnOpen = false
  }

  private openStep(): void {
    if (this.stepOpen) return
    if (!this.turnOpen) {
      this.turn += 1
      this.step = 0
      this.push({ type: "turn/start", time: this.time, data: { turn: this.turn } })
      this.turnOpen = true
    }
    this.step += 1
    this.push({ type: "step/start", time: this.time, data: { turn: this.turn, step: this.step } })
    this.stepOpen = true
  }

  /**
   * End of file: a turn whose last message is a final assistant answer is complete. Only a tool
   * call still awaiting its result stays open, for the coordinator to close as interrupted.
   */
  finish(): void {
    if (this.turnOpen && this.pendingCalls === 0) this.closeTurn()
  }

  /** Compaction restarts the model context: everything before the boundary leaves the stream. */
  compactBoundary(): void {
    this.closeTurn()
    this.pendingCalls = 0
    this.events.length = 0
  }

  /** Lines mixing tool results and prompt text do not occur in Claude Code records. */
  user(line: RecordLine): void {
    const time = this.stamp(line)
    const content = line.message?.content
    if (content === undefined || content === null) return
    const blocks = typeof content === "string" ? [{ type: "text", text: content } as ClaudeContentBlock] : content
    const results = blocks.filter((block): block is Extract<ClaudeContentBlock, { type: "tool_result" }> => block.type === "tool_result")
    if (results.length > 0) {
      if (!this.stepOpen) return
      for (const result of results) {
        this.pendingCalls = Math.max(0, this.pendingCalls - 1)
        const text = toolResultText(result.content)
        this.push({
          type: "tool/result",
          time,
          data: {
            turn: this.turn,
            step: this.step,
            message: {
              id: MessageId(line.uuid ?? randomUUID()),
              role: "user",
              content: [{ type: "tool-result", toolCallId: ToolCallId(result.tool_use_id), content: [{ type: "text", text }], isError: result.is_error === true }],
              source: { kind: "tool", callId: ToolCallId(result.tool_use_id) },
            },
          },
          surfaceOp: "append",
        })
      }
      // The next assistant message answers these results in a fresh step.
      this.closeStep()
      return
    }
    const texts: string[] = []
    for (const block of blocks) {
      if (block.type === "text") texts.push((block as { text: string }).text)
      else if (block.type === "image") texts.push(`[image ${(block as { source: { media_type?: string } }).source.media_type ?? "image"}]`)
    }
    const text = texts.join("\n")
    if (text.trim().length === 0) return
    this.closeTurn()
    this.turn += 1
    this.step = 0
    this.push({ type: "turn/start", time, data: { turn: this.turn } })
    this.turnOpen = true
    this.push({
      type: "user/message",
      time,
      data: { id: MessageId(line.uuid ?? randomUUID()), role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
      surfaceOp: "append",
    })
  }

  assistant(line: RecordLine): void {
    const time = this.stamp(line)
    const content = line.message?.content
    if (content === undefined || content === null) return
    const blocks = typeof content === "string" ? [{ type: "text", text: content } as ClaudeContentBlock] : content
    const message: ContentBlock[] = []
    const calls: Array<{ id: string; name: string; arguments: string }> = []
    for (const block of blocks) {
      if (block.type === "text") {
        const text = (block as { text: string }).text
        if (text.length > 0) message.push({ type: "text", text })
      } else if (block.type === "tool_use") {
        const tool = block as { id: string; name: string; input?: unknown }
        const args = JSON.stringify(tool.input ?? {})
        message.push({ type: "tool-call", id: ToolCallId(tool.id), name: tool.name, arguments: args })
        calls.push({ id: tool.id, name: tool.name, arguments: args })
      }
      // thinking: kept in the file, never re-entered into another model's context.
    }
    if (message.length === 0) return
    this.openStep()
    this.push({
      type: "assistant/message",
      time,
      data: {
        turn: this.turn,
        step: this.step,
        message: {
          id: MessageId(line.uuid ?? randomUUID()),
          role: "assistant",
          content: message,
          source: { kind: "model", provider: line.alwith?.providerId ?? "alwith", model: line.message?.model ?? "unknown" },
        },
      },
      surfaceOp: "append",
    })
    for (const call of calls) {
      this.pendingCalls += 1
      this.push({ type: "tool/call", time, data: { turn: this.turn, step: this.step, callId: ToolCallId(call.id), name: call.name, arguments: call.arguments } })
    }
  }
}

function headerFromLines(recordId: SessionId, lines: readonly RecordLine[], fallbackCwd: string | undefined): SessionHeader {
  const cwd = lines.find(line => typeof line.cwd === "string")?.cwd ?? fallbackCwd
  const stamp = lines.find(line => line.timestamp !== undefined)?.timestamp
  const createdAt = stamp === undefined ? Number.NaN : Date.parse(stamp)
  if (Number.isNaN(createdAt)) throw new Error(`ALwith record ${recordId} has no usable timestamp to derive its creation time`)
  return { version: SESSION_FORMAT_VERSION, id: recordId, createdAt, ...(cwd === undefined ? {} : { cwd }), isSeeded: false }
}

/**
 * Decode a record into DSH storage terms. DSH's own events come back verbatim (renumbered
 * contiguously in file order); message lines from other writers are rebuilt into DSH events;
 * a torn final line is reported through `committedBytes`.
 */
export function decodeRecord(buffer: Buffer, recordId: SessionId, fallbackCwd?: string): DecodedRecord {
  const { lines, committedBytes } = parseLines(buffer)
  const first = lines[0]
  const hasHeader = first?.type === "alwith" && first.kind === "header"
  if (hasHeader && first.version !== undefined && first.version > RECORD_VERSION) {
    throw new Error(`ALwith record ${recordId} is version ${first.version}; this build reads up to v${RECORD_VERSION}`)
  }
  let meta: SessionHeader
  let inheritedEventCount = 0
  if (hasHeader && first.dsh !== undefined) {
    meta = first.dsh.header
    inheritedEventCount = first.dsh.inheritedEventCount
  } else {
    meta = headerFromLines(recordId, lines, fallbackCwd)
  }

  // Message-layer identity: the last version of a uuid wins, in its first position.
  const sent = new Set<string>()
  for (const line of lines) if (line.type === "acpDelivery" && line.status === "sent" && line.messageUuid !== undefined) sent.add(line.messageUuid)
  const ordered: RecordLine[] = []
  const positions = new Map<string, number>()
  for (const line of lines) {
    if (line.type === "user" || line.type === "assistant") {
      if (line.uuid !== undefined) {
        const position = positions.get(line.uuid)
        if (position !== undefined) {
          ordered[position] = line
          continue
        }
        positions.set(line.uuid, ordered.length)
      }
    }
    ordered.push(line)
  }

  const state: EncodeState = { lastUuid: null, snapshotRefs: new Set() }
  const collected: Array<{ event: SessionEvent; oldSeq: number | undefined }> = []
  const reconstruction = new Reconstruction(recordId)
  const flushReconstruction = (): void => {
    for (const event of reconstruction.events) collected.push({ event, oldSeq: undefined })
    reconstruction.events.length = 0
  }
  for (const line of ordered) {
    if (line.type === "alwith") {
      switch (line.kind) {
        case "event":
          if (line.engine === ENGINE && line.event !== undefined) {
            reconstruction.closeTurn()
            flushReconstruction()
            collected.push({ event: line.event, oldSeq: line.event.seq })
          }
          break
        case "chunks":
          if (line.engine === ENGINE && line.events !== undefined) {
            reconstruction.closeTurn()
            flushReconstruction()
            for (const event of line.events) collected.push({ event, oldSeq: event.seq })
          }
          break
        case "snapshot":
          if (line.ref !== undefined) state.snapshotRefs.add(line.ref)
          break
        default:
          break
      }
      continue
    }
    if (line.type === "system" && line.subtype === "compact_boundary") {
      reconstruction.compactBoundary()
      flushReconstruction()
      collected.length = 0
      continue
    }
    if (line.type !== "user" && line.type !== "assistant") continue
    if (line.uuid !== undefined) state.lastUuid = line.uuid
    if (line.isMeta === true) continue
    if (line.alwith?.engine === ENGINE) continue // projected from an event line above
    if (line.alwith?.projected === true) continue // v0 Hub projection: the acp journal was the truth
    if (line.alwith?.delivery === "intent" && (line.uuid === undefined || !sent.has(line.uuid))) continue
    if (line.type === "user") reconstruction.user(line)
    else reconstruction.assistant(line)
  }
  reconstruction.finish()
  flushReconstruction()

  // Renumber contiguously; remap chunk provenance refs of DSH-native events.
  const remap = new Map<number, number>()
  collected.forEach((entry, index) => {
    if (entry.oldSeq !== undefined) remap.set(entry.oldSeq, index)
  })
  const events = collected.map((entry, index) => {
    const event = { ...entry.event, seq: SessionSeq(index) } as SessionEvent
    const refs = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
    if (refs !== undefined) {
      const mapped = refs.map(seq => remap.get(seq)).filter((seq): seq is number => seq !== undefined)
      ;(event as { sourceEventSeqs?: unknown }).sourceEventSeqs = mapped.map(seq => SessionSeq(seq))
    }
    return event
  })
  return { meta, inheritedEventCount, events, committedBytes, state, hasHeader }
}
