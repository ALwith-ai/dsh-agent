/**
 * `ctx.sessionPersistence` provider that stores DSH sessions as ALwith session records
 * (`<projectsDir>/<项目键>/<sessionId>.jsonl`, plain JSONL, Claude Code compatible).
 *
 * This is the storage seam, not a bridge side channel: the loop creates a handle per session,
 * live events route into the write handle through `session/event`, and `session/flush` is the
 * durability barrier the checkpoint policy waits on before a model request or a top-level tool
 * runs. Single-writer ownership, live batching, torn-tail repair and lazy materialization are
 * implemented here (dsh 0.1.5 retired the upstream coordinator that used to own them); the
 * ALwith record codec lives in `./record.ts`.
 *
 * One writer per file: while DSH owns a session this provider is its only writer. Records the
 * ALwith CLI wrote (no version header) are read by their message layer and continued in place —
 * the DSH events append after the CLI's lines, no header is inserted (append-only).
 */
import z from "@deepseek-ai/schemastery"
import type { Context } from "@deepseek-ai/cordis"
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId, SessionLogOffset } from "@deepseek-ai/dsh-session"
import type { SessionEvent, SessionHeader, SessionId, SessionSeedEventState } from "@deepseek-ai/dsh-session"
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionPersistence,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  assertContiguous,
  assertStoredId,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
  type SessionLocation,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from "@deepseek-ai/dsh-session-persistence"
import { mkdir, open, readdir, readFile, stat, truncate } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { decodeRecord, encodeBatch, headerLine, projectKey, type EncodeState, type RecordWriter } from "./record.ts"

export interface Config {
  /** `~/.alwith/projects`: the ALwith session library root. */
  projectsDir: string
  /** Host provider identity stamped on projected messages (ALwith Desktop vocabulary). */
  providerId?: string
  writerName?: string
  writerVersion?: string
}

/** Byte length of the file prefix a listing reads to find a record's header or first message. */
const LIST_PROBE_BYTES = 16 * 1024
/** Live events published by the session store are batched into one durable append per window. */
const LIVE_BATCH_WINDOW_MS = 200

function fileRevision(identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): SessionPersistenceRevision {
  return SessionPersistenceRevision([identity.dev, identity.ino, identity.size, identity.mtimeNs, identity.ctimeNs].join(":"))
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST"
}

/** Stored events are shared between handles: freeze every reachable object so no reader can mutate the cache. */
function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** `<id>.jsonl`; ALwith ids are UUIDs and map to themselves, any other seam id is percent-escaped. */
export function recordFileName(id: string): string {
  return `${encodeURIComponent(id)}.jsonl`
}

export function recordIdFromFileName(name: string): string {
  return decodeURIComponent(name.slice(0, -".jsonl".length))
}

/** A stored record decoded into seam terms: the validated log plus what the writer needs to continue it. */
interface StoredRecord {
  readonly path: string
  readonly meta: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
  readonly eventState: SessionSeedEventState
  readonly revision: SessionPersistenceRevision
  /** Byte length of the committed prefix when a torn tail follows it; absent when the file is whole. */
  readonly tornTruncateTo: number | undefined
  readonly encode: EncodeState
}

/** A created session this process can already observe while its file does not exist yet. */
interface PendingSession {
  readonly header: SessionHeader
  readonly revision: SessionPersistenceRevision
  readonly inheritedEventCount: SessionLogOffset
}

interface HandleState {
  /** Stored next-seq: the logical length of the committed log. */
  cursor: number
  /** Whether the record file exists (a created session materializes on its first append or flush). */
  materialized: boolean
  inheritedEventCount: SessionLogOffset
  /** Committed prefix length to truncate to before the first append, when the file has a torn tail. */
  tornTruncateTo: number | undefined
  /** The prepared historical log, served until this handle appends. */
  primed: { events: readonly SessionEvent[]; eventState: SessionSeedEventState } | undefined
  /** Writer state (message-layer uuid chain, snapshot refs, system prompt ref) for the record. */
  encode: EncodeState
}

interface Storage {
  resolveRecord(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
  readStored(path: string, id: SessionId, signal?: AbortSignal): Promise<StoredRecord>
  persistBatch(handle: AlwithSessionHandle, events: readonly SessionEvent[]): Promise<void>
  persistHeader(handle: AlwithSessionHandle): Promise<void>
  truncateTornTail(handle: AlwithSessionHandle, truncateTo: number): Promise<void>
  hasPending(id: SessionId): boolean
  releaseHandle(handle: AlwithSessionHandle, materialized: boolean): void
}

class AlwithSessionHandle implements SessionHandle {
  private chain: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private observedLength = 0
  /** Routed live events awaiting their batching deadline (persistence-owned copies). */
  private buffered: SessionEvent[] = []
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  /** Set when a drain failed; the timer stays quiet until the next explicit drain retries. */
  private drainPaused = false
  private draining: Promise<void> | undefined

  constructor(
    private readonly storage: Storage,
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    readonly state: HandleState,
  ) {}

  get inheritedEventCount(): SessionLogOffset {
    return this.state.inheritedEventCount
  }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen("read")
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`)
    if (!Number.isSafeInteger(length) || length < 0) throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`)
    options?.signal?.throwIfAborted()
    const primed = this.state.primed
    if (primed !== undefined && this.access === "write") return this.slice(primed, offset, length)
    if (this.access === "write" && !this.state.materialized) return { eventState: "detached", events: [] }
    const path = await this.storage.resolveRecord(this.id, options?.signal)
    if (path === undefined) {
      if (primed !== undefined) return this.slice(primed, offset, length)
      if (this.storage.hasPending(this.id)) return { eventState: "detached", events: [] }
      throw new SessionPersistenceNotFoundError(this.id)
    }
    this.state.primed = undefined
    const stored = await this.storage.readStored(path, this.id, options?.signal)
    if (stored.events.length < this.observedLength) {
      throw new Error(`session "${this.id}": stored log shrank below a previously observed prefix (${stored.events.length} < ${this.observedLength})`)
    }
    return this.slice(stored, offset, length)
  }

  private slice(source: { events: readonly SessionEvent[]; eventState: SessionSeedEventState }, offset: number, length: number): SessionHandleReadResult {
    this.observedLength = Math.max(this.observedLength, source.events.length)
    return { eventState: source.eventState, events: source.events.slice(offset, offset + length) }
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen("append")
    const batch = materializeAppendBatch(events)
    return this.run("append", async () => {
      options?.signal?.throwIfAborted()
      await this.persistContiguous(batch)
    })
  }

  flush(options?: SessionHandleFlushOptions): Promise<void> {
    return this.run("flush", async () => {
      options?.signal?.throwIfAborted()
      if (this.access !== "write") throw new SessionReadOnlyError(this.id, "flush")
      if (this.state.materialized) return
      await this.storage.persistHeader(this)
      this.state.materialized = true
    })
  }

  /** Idempotent, uncancellable: drains the routed live buffer, then releases ownership. */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      let drainFailure: unknown
      for (;;) {
        try {
          await this.drainLive()
        } catch (error) {
          drainFailure = error
          break
        }
        await this.chain
        if (this.buffered.length === 0) break
      }
      await this.chain
      this.storage.releaseHandle(this, this.state.materialized)
      if (drainFailure !== undefined) throw asError(drainFailure)
    })())
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /** Buffer one published live event and arm the batching window when it is idle (the router is the only caller). */
  enqueueLive(event: SessionEvent, reportBackgroundFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event))
    if (this.batchTimer !== undefined || this.drainPaused) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined
      this.drainLive().catch(reportBackgroundFailure)
    }, LIVE_BATCH_WINDOW_MS)
  }

  /** Durably drain the live buffer; concurrent callers join one drain, a failure keeps the batch in order for a loud retry. */
  drainLive(): Promise<void> {
    return (this.draining ??= this.drainBuffered().finally(() => {
      this.draining = undefined
    }))
  }

  private async drainBuffered(): Promise<void> {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    this.drainPaused = false
    while (this.buffered.length > 0) {
      await this.enqueueChain(async () => {
        const batch = this.buffered.splice(0)
        try {
          await this.persistContiguous(materializeAppendBatch(batch))
        } catch (error) {
          this.buffered = batch.concat(this.buffered)
          this.drainPaused = true
          throw error
        }
      })
    }
  }

  /** The shared durable-append body: ownership, contiguity, torn-tail repair, write, state advance. */
  private async persistContiguous(batch: readonly SessionEvent[]): Promise<void> {
    if (this.access !== "write") throw new SessionReadOnlyError(this.id, "append")
    if (batch.length === 0) return
    assertContiguous(this.id, batch, this.state.cursor)
    if (this.state.tornTruncateTo !== undefined) {
      await this.storage.truncateTornTail(this, this.state.tornTruncateTo)
      this.state.tornTruncateTo = undefined
    }
    await this.storage.persistBatch(this, batch)
    this.state.materialized = true
    this.state.cursor += batch.length
    this.state.primed = undefined
    this.observedLength = this.state.cursor
  }

  private enqueueChain<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op)
    this.chain = next.catch(() => {})
    return next
  }

  private async run<T>(operation: string, op: () => Promise<T>): Promise<T> {
    this.assertOpen(operation)
    return this.enqueueChain(async () => {
      this.assertOpen(operation)
      return op()
    })
  }

  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation)
  }
}

export default class AlwithSessionPersistence extends SessionPersistence implements Storage {
  static inject = ["sessions"]
  static Config: z<Config> = z.object({
    projectsDir: z.string().required(),
    providerId: z.string().default("deepseek"),
    writerName: z.string().default("@alwith-ai/dsh-agent"),
    writerVersion: z.string().default("0.0.0"),
  })

  override readonly name = "session-persistence-alwith"

  private readonly projectsDir: string
  private readonly providerId: string
  private readonly writer: RecordWriter
  /** Every open handle; teardown closes what remains. */
  private readonly openHandles = new Set<AlwithSessionHandle>()
  /** The single active writer per id; `null` marks a claim whose handle is still being built. */
  private readonly writers = new Map<SessionId, AlwithSessionHandle | null>()
  private readonly pending = new Map<SessionId, PendingSession>()
  private counter = 0

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.projectsDir = resolve(config.projectsDir)
    this.providerId = config.providerId ?? "deepseek"
    this.writer = { name: config.writerName ?? "@alwith-ai/dsh-agent", version: config.writerVersion ?? "0.0.0" }
    this.install(ctx)
  }

  /** Live session routing and teardown: one active write handle per id routes that session's published events. */
  private install(ctx: Context): void {
    ctx.on("session/event", (session, event) => {
      this.writers.get(session.id)?.enqueueLive(event, error => {
        ctx.logger.warn(`${this.name}: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`)
      })
    })
    ctx.on("session/flush", session => {
      const writer = this.writers.get(session.id)
      if (writer === null || writer === undefined) return undefined
      return (async () => {
        await writer.drainLive()
        await writer.flush()
      })()
    })
    ctx.on("session/disposed", session => {
      const writer = this.writers.get(session.id)
      if (writer === null || writer === undefined) return
      writer.close().catch(error => {
        ctx.logger.warn(`${this.name}: final drain for session "${session.id}" failed: ${String(error)}`)
      })
    })
    ctx.effect(() => async () => {
      const errors: unknown[] = []
      for (const handle of [...this.openHandles]) {
        try {
          await handle.close()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `${this.name} dispose failed`)
    }, `${this.name} open handles`)
  }

  locate(meta: SessionHeader): SessionLocation {
    return { kind: "alwith-record", path: this.recordPath(meta.cwd, meta.id) }
  }

  // ---- service surface ----

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0)
    if (snapshot.isSeeded ? inheritedEventCount === 0 : inheritedEventCount !== 0) {
      throw new TypeError(
        snapshot.isSeeded
          ? `session "${snapshot.id}" is seeded; create needs its exact inheritedEventCount`
          : `session "${snapshot.id}" is not seeded; create must not carry an inheritedEventCount`,
      )
    }
    if (this.pending.has(snapshot.id) || (await this.findRecord(snapshot.id, options?.signal)) !== undefined) {
      throw new SessionAlreadyExistsError(snapshot.id)
    }
    options?.signal?.throwIfAborted()
    if (this.writers.has(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id)
    this.writers.set(snapshot.id, null)
    this.pending.set(snapshot.id, { header: snapshot, revision: SessionPersistenceRevision(`memory:${this.name}:${++this.counter}`), inheritedEventCount })
    return this.adopt(
      new AlwithSessionHandle(this, snapshot.id, snapshot, "write", {
        cursor: 0,
        materialized: false,
        inheritedEventCount,
        tornTruncateTo: undefined,
        primed: undefined,
        encode: { lastUuid: null, snapshotRefs: new Set(), systemPromptRef: null },
      }),
    )
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const pending = this.pending.get(id)
    if (access === "read") {
      if (pending !== undefined) {
        return this.adopt(
          new AlwithSessionHandle(this, id, pending.header, "read", {
            cursor: 0,
            materialized: false,
            inheritedEventCount: pending.inheritedEventCount,
            tornTruncateTo: undefined,
            primed: undefined,
            encode: { lastUuid: null, snapshotRefs: new Set(), systemPromptRef: null },
          }),
        )
      }
      const stored = await this.requireStored(id, options?.signal)
      return this.adopt(
        new AlwithSessionHandle(this, id, stored.meta, "read", {
          cursor: 0,
          materialized: true,
          inheritedEventCount: stored.inheritedEventCount,
          tornTruncateTo: undefined,
          primed: stored,
          encode: stored.encode,
        }),
      )
    }
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    this.writers.set(id, null)
    try {
      const stored = await this.requireStored(id, options?.signal)
      options?.signal?.throwIfAborted()
      return this.adopt(
        new AlwithSessionHandle(this, id, stored.meta, "write", {
          cursor: stored.events.length,
          materialized: true,
          inheritedEventCount: stored.inheritedEventCount,
          tornTruncateTo: stored.tornTruncateTo,
          primed: stored,
          encode: stored.encode,
        }),
      )
    } catch (error) {
      this.writers.delete(id)
      throw error
    }
  }

  /** Service-wide durability barrier: every active write handle drains and materializes. */
  async flush(): Promise<void> {
    const errors: unknown[] = []
    for (const writer of [...this.writers.values()]) {
      if (writer === null) continue
      try {
        await writer.drainLive()
        await writer.flush()
      } catch (error) {
        if (error instanceof SessionHandleClosedError) continue
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${this.name} flush failed`)
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    const pending = this.pending.get(id)
    if (pending !== undefined) return { header: pending.header, revision: pending.revision }
    const path = await this.findRecord(id, options?.signal)
    if (path === undefined) return undefined
    const header = await this.probeHeader(path, id, options?.signal)
    if (header === undefined) return undefined
    try {
      const identity = await stat(path, { bigint: true })
      options?.signal?.throwIfAborted()
      return { header, revision: fileRevision(identity), sizeBytes: Number(identity.size) }
    } catch (error: unknown) {
      options?.signal?.throwIfAborted()
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    const signal = options?.signal
    const snapshots: SessionPersistenceSnapshot[] = []
    const listed = new Set<SessionId>()
    for (const artifact of await this.listArtifacts(signal)) {
      signal?.throwIfAborted()
      try {
        const identity = await stat(artifact.path, { bigint: true })
        signal?.throwIfAborted()
        listed.add(artifact.header.id)
        snapshots.push({ header: artifact.header, revision: fileRevision(identity), sizeBytes: Number(identity.size) })
      } catch (error: unknown) {
        signal?.throwIfAborted()
        if (!isENOENT(error)) throw error
      }
    }
    for (const [id, entry] of this.pending) {
      if (!listed.has(id)) snapshots.push({ header: entry.header, revision: entry.revision })
    }
    signal?.throwIfAborted()
    return snapshots
  }

  // ---- Storage (the handle's view of this provider) ----

  private adopt(handle: AlwithSessionHandle): AlwithSessionHandle {
    this.openHandles.add(handle)
    if (handle.access === "write") this.writers.set(handle.id, handle)
    return handle
  }

  releaseHandle(handle: AlwithSessionHandle, materialized: boolean): void {
    this.openHandles.delete(handle)
    if (handle.access !== "write") return
    this.writers.delete(handle.id)
    if (!materialized) this.pending.delete(handle.id)
  }

  hasPending(id: SessionId): boolean {
    return this.pending.has(id)
  }

  resolveRecord(id: SessionId, signal?: AbortSignal): Promise<string | undefined> {
    return this.findRecord(id, signal)
  }

  private async requireStored(id: SessionId, signal?: AbortSignal): Promise<StoredRecord> {
    const path = await this.findRecord(id, signal)
    if (path === undefined) throw new SessionPersistenceNotFoundError(id)
    return this.readStored(path, id, signal)
  }

  /** Read and validate one record; a torn final line is reported, never served. */
  async readStored(path: string, id: SessionId, signal?: AbortSignal): Promise<StoredRecord> {
    signal?.throwIfAborted()
    const { buffer, revision } = await this.readStableFile(path, signal)
    if (buffer.length === 0) throw new SessionPersistenceNotFoundError(id) // exclusive-create crashed before the header landed
    let decoded
    try {
      decoded = decodeRecord(buffer, id)
    } catch (error) {
      throw new SessionPersistenceCorruptionError(`session "${id}": ALwith record is corrupt: ${String(error)} (raw log: ${path})`, { cause: error })
    }
    signal?.throwIfAborted()
    assertStoredId(id, decoded.meta)
    const location: SessionLocation = { kind: "alwith-record", path }
    const events = validateStoredEvents(decoded.meta, decoded.events, location)
    for (const event of events) deepFreeze(event)
    Object.freeze(events)
    return {
      path,
      meta: decoded.meta,
      inheritedEventCount: SessionLogOffset(decoded.inheritedEventCount),
      events,
      eventState: "shared-frozen",
      revision,
      tornTruncateTo: decoded.committedBytes < buffer.byteLength ? decoded.committedBytes : undefined,
      encode: decoded.state,
    }
  }

  async persistBatch(handle: AlwithSessionHandle, events: readonly SessionEvent[]): Promise<void> {
    if (handle.state.materialized) {
      await this.appendLines(handle.header, this.encode(handle, events))
    } else {
      await this.materialize(handle, events)
    }
  }

  async persistHeader(handle: AlwithSessionHandle): Promise<void> {
    await this.materialize(handle, [])
  }

  async truncateTornTail(handle: AlwithSessionHandle, truncateTo: number): Promise<void> {
    const path = this.recordPath(handle.header.cwd, handle.id)
    await truncate(path, truncateTo)
    const file = await open(path, "r+")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    this.ctx.logger.warn(`${this.name}: session "${handle.id}" recovered from a torn tail; incomplete tail bytes were discarded`)
  }

  // ---- file mechanics ----

  private recordPath(cwd: string | undefined, id: SessionId): string {
    return join(this.projectsDir, projectKey(cwd), recordFileName(id))
  }

  private encode(handle: AlwithSessionHandle, events: readonly SessionEvent[]): string {
    return encodeBatch({ recordId: handle.id, cwd: handle.header.cwd, providerId: this.providerId }, handle.state.encode, events)
  }

  /** First write of a DSH-created session: exclusive create, header + first batch, fsync file and directory. */
  private async materialize(handle: AlwithSessionHandle, events: readonly SessionEvent[]): Promise<void> {
    const meta = handle.header
    const path = this.recordPath(meta.cwd, meta.id)
    await mkdir(dirname(path), { recursive: true })
    const context = { recordId: meta.id, cwd: meta.cwd, providerId: this.providerId }
    const header = headerLine(context, meta.createdAt, this.writer, { header: meta, inheritedEventCount: handle.state.inheritedEventCount })
    const content = `${header}\n${encodeBatch(context, handle.state.encode, events)}`
    let file
    try {
      file = await open(path, "wx")
    } catch (error: unknown) {
      if (isEEXIST(error)) throw new SessionAlreadyExistsError(meta.id)
      throw error
    }
    try {
      await file.writeFile(content)
      await file.sync()
    } finally {
      await file.close()
    }
    await this.syncDir(dirname(path))
    this.pending.delete(meta.id)
  }

  private async appendLines(meta: SessionHeader, content: string): Promise<void> {
    if (content.length === 0) return
    const path = this.recordPath(meta.cwd, meta.id)
    const file = await open(path, "a")
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      await file.close()
    }
    try {
      const { size: before } = await file.stat()
      try {
        await file.writeFile(content)
        await file.sync()
      } catch (error) {
        try {
          await close()
          await this.rollback(path, before, content)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to roll back append to "${path}"`)
        }
        throw error
      }
    } finally {
      await close()
    }
  }

  /**
   * Cut a failed append back to the confirmed prefix — but only our own partial bytes. The platform
   * appends whole metadata lines (`custom-title`, envelope) to a record it does not own; those bytes are
   * never ours to remove, so anything after the prefix that is not a prefix of what we tried to write
   * stays, and the failure is reported instead of silently truncating another writer's line.
   */
  private async rollback(path: string, size: number, attempted: string): Promise<void> {
    const file = await open(path, "r+")
    try {
      const { size: now } = await file.stat()
      if (now < size) throw new Error(`"${path}" is shorter than its confirmed prefix (${now} < ${size} bytes)`)
      const tail = Buffer.alloc(now - size)
      if (tail.length > 0) await file.read(tail, 0, tail.length, size)
      if (!tail.equals(Buffer.from(attempted).subarray(0, tail.length))) {
        throw new Error(`"${path}" has ${tail.length} bytes after the confirmed prefix that this writer did not write; not truncating`)
      }
      if (now === size) return
      await file.truncate(size)
      await file.sync()
    } finally {
      await file.close()
    }
  }

  private async syncDir(dir: string): Promise<void> {
    if (process.platform === "win32") return // Windows has no directory fsync; the file itself is synced
    const file = await open(dir, "r")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
  }

  /** Stat-stable read: retry while a concurrent append changes the revision between stat and read. */
  private async readStableFile(path: string, signal?: AbortSignal): Promise<{ buffer: Buffer; revision: SessionPersistenceRevision }> {
    for (;;) {
      signal?.throwIfAborted()
      const before = fileRevision(await stat(path, { bigint: true }))
      const buffer = await readFile(path, { signal })
      signal?.throwIfAborted()
      const after = fileRevision(await stat(path, { bigint: true }))
      if (before === after) return { buffer, revision: after }
    }
  }

  /**
   * A record id can sit under more than one project key: the CLI's cross-project `--resume` leaves the
   * same session in the old and the new cwd's directory. The most recently written file is the one
   * being continued; the others are shadowed and reported, never silently merged.
   */
  private async findRecord(id: SessionId, signal?: AbortSignal): Promise<string | undefined> {
    const candidates: Array<{ path: string; mtimeMs: number }> = []
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      const path = join(project, recordFileName(id))
      try {
        candidates.push({ path, mtimeMs: (await stat(path)).mtimeMs })
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
      }
    }
    return this.newest(id, candidates)?.path
  }

  private newest<T extends { path: string; mtimeMs: number }>(id: SessionId, candidates: readonly T[]): T | undefined {
    if (candidates.length === 0) return undefined
    const sorted = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)
    const [winner, ...shadowed] = sorted
    if (shadowed.length > 0) {
      this.ctx.logger.warn(
        `${this.name}: record "${id}" exists under ${sorted.length} project directories; using the most recently written ${winner!.path}, shadowing ${shadowed.map(entry => entry.path).join(", ")}`,
      )
    }
    return winner
  }

  private async listProjectDirs(signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    let entries
    try {
      entries = await readdir(this.projectsDir, { withFileTypes: true })
    } catch (error: unknown) {
      if (isENOENT(error)) return []
      throw error
    }
    return entries.filter(entry => entry.isDirectory()).map(entry => join(this.projectsDir, entry.name)).sort()
  }

  private async listArtifacts(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; path: string }>> {
    const found = new Map<SessionId, Array<{ header: SessionHeader; path: string; mtimeMs: number }>>()
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      let entries: string[]
      try {
        entries = await readdir(project)
      } catch (error: unknown) {
        if (isENOENT(error)) continue
        throw error
      }
      for (const entry of entries.sort()) {
        if (!entry.endsWith(".jsonl")) continue
        signal?.throwIfAborted()
        const path = join(project, entry)
        const id = makeSessionId(recordIdFromFileName(entry))
        const header = await this.probeHeader(path, id, signal)
        if (header === undefined) continue
        const { mtimeMs } = await stat(path)
        const candidates = found.get(header.id) ?? []
        candidates.push({ header, path, mtimeMs })
        found.set(header.id, candidates)
      }
    }
    const artifacts: Array<{ header: SessionHeader; path: string }> = []
    for (const [id, candidates] of found) {
      const winner = this.newest(id, candidates)!
      artifacts.push({ header: winner.header, path: winner.path })
    }
    return artifacts
  }

  /** Read only the file head: enough for the version header or the first message's cwd/timestamp. */
  private async probeHeader(path: string, id: SessionId, signal?: AbortSignal): Promise<SessionHeader | undefined> {
    const file = await open(path, "r")
    try {
      const buffer = Buffer.alloc(LIST_PROBE_BYTES)
      const { bytesRead } = await file.read(buffer, 0, LIST_PROBE_BYTES, 0)
      signal?.throwIfAborted()
      if (bytesRead === 0) return undefined
      const head = buffer.subarray(0, bytesRead)
      const lastNewline = head.lastIndexOf(0x0a)
      if (lastNewline === -1) return undefined // no complete line in the probe: not a listable record
      try {
        return decodeRecord(head.subarray(0, lastNewline + 1), id).meta
      } catch {
        return undefined
      }
    } finally {
      await file.close()
    }
  }
}

export { SESSION_FORMAT_VERSION, SessionFormatUnsupportedError }
