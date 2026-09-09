/**
 * `ctx.sessionPersistence` provider that stores DSH sessions as ALwith session records
 * (`<projectsDir>/<项目键>/<sessionId>.jsonl`, plain JSONL, Claude Code compatible).
 *
 * This is the storage seam, not a bridge side channel, so `session-checkpoint-policy` waits on
 * this provider's flush before a model request or a top-level tool runs: the record is durable
 * before side effects. Batching, single-writer ownership, prepared-session caching and crash
 * repair are the upstream `PersistenceCoordinator`'s; this class only implements the
 * `PersistenceBackend` file mechanics and the ALwith record codec (`./record.ts`).
 *
 * One writer per file: while DSH owns a session this provider is its only writer. Records the
 * ALwith CLI wrote (no version header) are read by their message layer and continued in place —
 * the DSH events append after the CLI's lines, no header is inserted (append-only).
 */
import z from "@deepseek-ai/schemastery"
import type { Context } from "@deepseek-ai/cordis"
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId, SessionLogOffset } from "@deepseek-ai/dsh-session"
import type { SessionEvent, SessionHeader, SessionId } from "@deepseek-ai/dsh-session"
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type BorrowedSessionSource,
  type PersistenceBackend,
  type SessionEventSuffix,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type SessionRawArtifact,
  type SessionStorageMetadata,
  type StoredPrefix,
} from "@deepseek-ai/dsh-session-persistence"
import type { SessionPreparation } from "@deepseek-ai/dsh-session"
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

interface TornMarker {
  readonly truncateTo: number
}

/** Byte length of the file prefix a listing reads to find a record's header or first message. */
const LIST_PROBE_BYTES = 16 * 1024

function fileRevision(identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): SessionPersistenceRevision {
  return SessionPersistenceRevision([identity.dev, identity.ino, identity.size, identity.mtimeNs, identity.ctimeNs].join(":"))
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
}

/** `<id>.jsonl`; ALwith ids are UUIDs and map to themselves, any other seam id is percent-escaped. */
export function recordFileName(id: string): string {
  return `${encodeURIComponent(id)}.jsonl`
}

export function recordIdFromFileName(name: string): string {
  return decodeURIComponent(name.slice(0, -".jsonl".length))
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST"
}

export default class AlwithSessionPersistence extends SessionPersistence implements PersistenceBackend<TornMarker> {
  static inject = ["sessions"]
  static Config: z<Config> = z.object({
    projectsDir: z.string().required(),
    providerId: z.string().default("deepseek"),
    writerName: z.string().default("@alwith-ai/dsh-agent"),
    writerVersion: z.string().default("0.0.0"),
  })

  override readonly name = "session-persistence-alwith"
  readonly supportsRawArtifacts = true

  private readonly projectsDir: string
  private readonly providerId: string
  private readonly writer: RecordWriter
  private readonly coordinator: PersistenceCoordinator<TornMarker>
  /** Per-session writer state (uuid chain, snapshot refs) for records currently being appended. */
  private readonly states = new Map<SessionId, EncodeState>()

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.projectsDir = resolve(config.projectsDir)
    this.providerId = config.providerId ?? "deepseek"
    this.writer = { name: config.writerName ?? "@alwith-ai/dsh-agent", version: config.writerVersion ?? "0.0.0" }
    this.coordinator = new PersistenceCoordinator(this.ctx, this, {
      preparedSessionCacheSize: DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  // ---- service surface (delegates to the coordinator, like the upstream jsonl backend) ----

  locate(meta: SessionHeader): SessionLocation {
    return { kind: "alwith-record", path: this.recordPath(meta.cwd, meta.id) }
  }

  create(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): Promise<void> {
    return this.coordinator.create(meta, inheritedEventCount)
  }

  override ensureMaterialized(session: Parameters<PersistenceCoordinator["ensureMaterialized"]>[0]): Promise<void> {
    return this.coordinator.ensureMaterialized(session)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    return this.coordinator.borrowSession(id, signal)
  }

  readFrom(id: SessionId, fromSeq: SessionLogOffset, signal?: AbortSignal): Promise<SessionEventSuffix> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  override async readRaw(id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    signal?.throwIfAborted()
    const path = await this.findRecord(id, signal)
    if (path === undefined) return undefined
    const { buffer } = await this.readStableFile(path, signal)
    const decoded = decodeRecord(buffer, id)
    return {
      meta: decoded.meta,
      inheritedEventCount: SessionLogOffset(decoded.inheritedEventCount),
      filename: `${id}.jsonl`,
      content: buffer.subarray(0, decoded.committedBytes).toString("utf8"),
    }
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const snapshots: SessionPersistenceSnapshot[] = []
    for (const artifact of await this.listArtifacts(signal)) {
      signal?.throwIfAborted()
      try {
        snapshots.push({ header: artifact.header, revision: fileRevision(await stat(artifact.path, { bigint: true })) })
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
      }
    }
    return snapshots
  }

  // ---- PersistenceBackend ----

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<TornMarker> | undefined> {
    signal?.throwIfAborted()
    const path = await this.findRecord(id, signal)
    if (path === undefined) return undefined
    const { buffer, revision } = await this.readStableFile(path, signal)
    if (buffer.length === 0) return undefined // exclusive-create crashed before the header landed
    const decoded = decodeRecord(buffer, id, this.cwdFromPath(path))
    if (decoded.meta.id !== id) throw new Error(`ALwith record at ${path} belongs to session "${decoded.meta.id}", expected "${id}"`)
    this.states.set(id, decoded.state)
    return {
      meta: decoded.meta,
      inheritedEventCount: SessionLogOffset(decoded.inheritedEventCount),
      events: decoded.events,
      revision,
      ...(decoded.committedBytes < buffer.byteLength ? { tornMarker: { truncateTo: decoded.committedBytes } } : {}),
    }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const path = await this.findRecord(id, signal)
    if (path === undefined) return undefined
    try {
      return fileRevision(await stat(path, { bigint: true }))
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  async materializeHeader(storage: SessionStorageMetadata): Promise<void> {
    await this.materialize(storage, [])
  }

  async appendBatch(storage: SessionStorageMetadata, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    if (isMaterialized) {
      await this.appendLines(storage.meta, this.encode(storage.meta, events))
    } else {
      await this.materialize(storage, events)
    }
  }

  async commitRepair(storage: SessionStorageMetadata, tornMarker: TornMarker | undefined, closers: readonly SessionEvent[]): Promise<void> {
    const { meta } = storage
    if (tornMarker !== undefined) {
      const path = this.recordPath(meta.cwd, meta.id)
      await truncate(path, tornMarker.truncateTo)
      const handle = await open(path, "r+")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.ctx.logger.warn(`${this.name}: session "${meta.id}" recovered from a torn tail; incomplete tail bytes were discarded`)
    }
    if (closers.length > 0) await this.appendLines(meta, this.encode(meta, closers))
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return (await this.listArtifacts(signal)).map(artifact => artifact.header)
  }

  // ---- file mechanics ----

  private recordPath(cwd: string | undefined, id: SessionId): string {
    return join(this.projectsDir, projectKey(cwd), recordFileName(id))
  }

  /** Project keys are one-way; a record found by scanning has no cwd until its lines say so. */
  private cwdFromPath(_path: string): string | undefined {
    return undefined
  }

  private encode(meta: SessionHeader, events: readonly SessionEvent[]): string {
    let state = this.states.get(meta.id)
    if (state === undefined) {
      state = { lastUuid: null, snapshotRefs: new Set() }
      this.states.set(meta.id, state)
    }
    return encodeBatch({ recordId: meta.id, cwd: meta.cwd, providerId: this.providerId }, state, events)
  }

  /** First write of a DSH-created session: exclusive create, header + first batch, fsync file and directory. */
  private async materialize(storage: SessionStorageMetadata, events: readonly SessionEvent[]): Promise<void> {
    const { meta } = storage
    const cwd = meta.cwd
    const path = this.recordPath(cwd, meta.id)
    await mkdir(dirname(path), { recursive: true })
    const state: EncodeState = { lastUuid: null, snapshotRefs: new Set() }
    this.states.set(meta.id, state)
    const header = headerLine({ recordId: meta.id, cwd, providerId: this.providerId }, meta.createdAt, this.writer, {
      header: meta,
      inheritedEventCount: storage.inheritedEventCount,
    })
    const content = `${header}\n${encodeBatch({ recordId: meta.id, cwd, providerId: this.providerId }, state, events)}`
    let handle
    try {
      handle = await open(path, "wx")
    } catch (error: unknown) {
      if (isEEXIST(error)) throw new Error(`session "${meta.id}" already has an ALwith record at ${path}`)
      throw error
    }
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await this.syncDir(dirname(path))
  }

  private async appendLines(meta: SessionHeader, content: string): Promise<void> {
    if (content.length === 0) return
    const path = this.recordPath(meta.cwd, meta.id)
    const handle = await open(path, "a")
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      await handle.close()
    }
    try {
      const { size: before } = await handle.stat()
      try {
        await handle.writeFile(content)
        await handle.sync()
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
    const handle = await open(path, "r+")
    try {
      const { size: now } = await handle.stat()
      if (now < size) throw new Error(`"${path}" is shorter than its confirmed prefix (${now} < ${size} bytes)`)
      const tail = Buffer.alloc(now - size)
      if (tail.length > 0) await handle.read(tail, 0, tail.length, size)
      if (!tail.equals(Buffer.from(attempted).subarray(0, tail.length))) {
        throw new Error(`"${path}" has ${tail.length} bytes after the confirmed prefix that this writer did not write; not truncating`)
      }
      if (now === size) return
      await handle.truncate(size)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async syncDir(dir: string): Promise<void> {
    if (process.platform === "win32") return // Windows has no directory fsync; the file itself is synced
    const handle = await open(dir, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
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

  /** `<id>.jsonl` under any project directory; ids are UUIDs, so at most one match exists. */
  private async findRecord(id: SessionId, signal?: AbortSignal): Promise<string | undefined> {
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      const path = join(project, recordFileName(id))
      try {
        await stat(path)
        return path
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
      }
    }
    return undefined
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
    const artifacts: Array<{ header: SessionHeader; path: string }> = []
    const ids = new Set<SessionId>()
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
        if (ids.has(header.id)) throw new Error(`ALwith record id "${header.id}" appears in multiple project directories`)
        ids.add(header.id)
        artifacts.push({ header, path })
      }
    }
    return artifacts
  }

  /** Read only the file head: enough for the version header or the first message's cwd/timestamp. */
  private async probeHeader(path: string, id: SessionId, signal?: AbortSignal): Promise<SessionHeader | undefined> {
    const handle = await open(path, "r")
    try {
      const buffer = Buffer.alloc(LIST_PROBE_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, LIST_PROBE_BYTES, 0)
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
      await handle.close()
    }
  }
}

export { SESSION_FORMAT_VERSION }
