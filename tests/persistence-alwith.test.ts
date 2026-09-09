/**
 * `alwith` persistence provider: upstream seam contracts + the ALwith record shape, plus reading a
 * record the ALwith CLI wrote (message layer only) and continuing it as a DSH session.
 */
import { describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AlwithSessionPersistence from "../src/persistence/alwith.ts"
import { decodeRecord, projectKey } from "../src/persistence/record.ts"
import { makeHarness, textResponse, untilFrame } from "./harness.ts"
import { meta, oneTurnLog, runPersistenceContract } from "./upstream/persistence-contract.ts"
import { runCoordinatorContract, type CoordinatorFixture } from "./upstream/coordinator-contract.ts"

const WORK = "/w"

function recordPath(root: string, cwd: string | undefined, id: string): string {
  return join(root, projectKey(cwd ?? "/"), `${id}.jsonl`)
}

async function freshRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

runPersistenceContract("alwith", async () => {
  const dir = await freshRoot("dsh-alwith-")
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(AlwithSessionPersistence, { projectsDir: dir })
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => {
      await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
})

runCoordinatorContract("alwith", async (): Promise<CoordinatorFixture> => {
  const dir = await freshRoot("dsh-alwith-coord-")
  return {
    mount: async ctx => ctx.plugin(AlwithSessionPersistence, { projectsDir: dir }),
    // A half-written line with no trailing newline is an uncommitted crash fragment: the decoder
    // reports committedBytes < byteLength and the coordinator repairs through commitRepair.
    corruptTail: async (id, cwd) => {
      await appendFile(recordPath(dir, cwd, id), '{"type":"alwith","kind":"event","seq":8,"ti')
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
})

describe("ALwith record shape", () => {
  test("a DSH session becomes a Claude Code compatible record with header, events and messages", async () => {
    const dir = await freshRoot("dsh-alwith-shape-")
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      const fiber = await ctx.plugin(AlwithSessionPersistence, { projectsDir: dir, providerId: "deepseek", writerVersion: "9.9.9" })
      const id = SessionId("shape-1")
      const header = meta(id, WORK)
      await ctx.sessionPersistence.create(header)
      await ctx.sessionPersistence.append(id, oneTurnLog())
      const lines = (await readFile(recordPath(dir, WORK, id), "utf8")).trim().split("\n").map(line => JSON.parse(line))

      expect(lines[0]).toMatchObject({ type: "alwith", kind: "header", version: 1, recordId: id, cwd: WORK, writer: { engine: "dsh", version: "9.9.9" } })
      expect(lines[0].dsh.header).toEqual(header)

      const events = lines.filter(line => line.type === "alwith" && line.kind === "event").map(line => line.event.type)
      expect(events).toEqual(["turn/start", "user/message", "step/start", "assistant/message", "step/end", "turn/end"])

      const user = lines.find(line => line.type === "user")
      const assistant = lines.find(line => line.type === "assistant")
      expect(user).toMatchObject({ sessionId: id, cwd: WORK, message: { role: "user", content: "hi" }, alwith: { engine: "dsh", providerId: "deepseek" } })
      expect(assistant).toMatchObject({ message: { role: "assistant", model: "mock", content: [{ type: "text", text: "hello" }] } })
      expect(assistant.parentUuid).toBe(user.uuid)
      expect(user.parentUuid).toBeNull()

      const loaded = await ctx.sessionPersistence.load(id)
      expect(loaded.events).toEqual(oneTurnLog())
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("request provenance is written once per distinct system prompt and tool schema", async () => {
    const dir = await freshRoot("dsh-alwith-request-")
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      const fiber = await ctx.plugin(AlwithSessionPersistence, { projectsDir: dir })
      const id = SessionId("request-1")
      await ctx.sessionPersistence.create(meta(id, WORK))
      const requestHeader = (seq: number) => ({
        type: "request/header" as const,
        seq,
        time: 10 + seq,
        data: { header: { config: { provider: "mock", model: "m" }, system: "be brief", tools: [{ name: "read", description: "r", parameters: {} }] }, reason: "initial" as const },
      })
      await ctx.sessionPersistence.append(id, [requestHeader(0), requestHeader(1)] as never)
      const lines = (await readFile(recordPath(dir, WORK, id), "utf8")).trim().split("\n").map(line => JSON.parse(line))
      const snapshots = lines.filter(line => line.kind === "snapshot")
      const requests = lines.filter(line => line.kind === "request")
      expect(snapshots).toHaveLength(2)
      expect(requests).toHaveLength(2)
      expect(requests[0].systemPrompt.ref).toBe(snapshots.find(s => s.content === "be brief").ref)
      expect(requests[0].tools.ref).toBe(requests[1].tools.ref)
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/** A record exactly as the ALwith CLI writes it: message layer only, no version header. */
function cliRecord(id: string, cwd: string): string {
  const stamp = (offset: number) => new Date(1_700_000_000_000 + offset * 1000).toISOString()
  return [
    { parentUuid: null, isSidechain: false, userType: "external", cwd, sessionId: id, type: "user", message: { role: "user", content: "read the readme" }, uuid: "u1", timestamp: stamp(0) },
    { parentUuid: "u1", isSidechain: false, cwd, sessionId: id, type: "assistant", message: { role: "assistant", model: "claude-x", content: [{ type: "thinking", thinking: "private", signature: "sig" }, { type: "text", text: "Reading." }, { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/w/README.md" } }] }, uuid: "a1", timestamp: stamp(1) },
    { parentUuid: "a1", isSidechain: false, cwd, sessionId: id, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "# Hello", is_error: false }] }, uuid: "u2", timestamp: stamp(2) },
    { parentUuid: "u2", isSidechain: false, cwd, sessionId: id, type: "assistant", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "It says hello." }] }, uuid: "a2", timestamp: stamp(3) },
    { type: "queue-operation", operation: "dequeue", timestamp: stamp(3) },
  ]
    .map(line => JSON.stringify(line))
    .join("\n")
    .concat("\n")
}

/** The same conversation as written by ALwith CLI 2.9.49+: v1 header, then its request provenance lines. */
function cliRecordV1(id: string, cwd: string): string {
  const header = {
    type: "alwith",
    kind: "header",
    version: 1,
    recordId: id,
    cwd,
    createdAt: new Date(1_700_000_000_000).toISOString(),
    writer: { engine: "alwith", name: "alwith-cli", version: "2.9.49" },
  }
  const provenance = [
    { type: "alwith", kind: "snapshot", seq: 0, time: "t", ref: "sha256:aa", content: ["You are ALwith."] },
    { type: "alwith", kind: "snapshot", seq: 1, time: "t", ref: "sha256:bb", content: [{ name: "Read", input_schema: {} }] },
    { type: "alwith", kind: "request", seq: 2, time: "t", engine: "alwith", providerId: "kimi", model: "claude-x", systemPrompt: { ref: "sha256:aa" }, tools: { ref: "sha256:bb" }, messages: { leaf: "u1", count: 1 }, compaction: null, contextWindow: 200000 },
  ]
  const [user, ...rest] = cliRecord(id, cwd).trimEnd().split("\n")
  return [JSON.stringify(header), user, ...provenance.map(line => JSON.stringify(line)), ...rest].join("\n").concat("\n")
}

describe("records written by the ALwith CLI", () => {
  test("a v1 CLI record (header, request provenance, messages) rebuilds the same DSH events as v0", () => {
    const id = SessionId("cli-v1")
    const decoded = decodeRecord(Buffer.from(cliRecordV1(id, WORK)), id)
    const reference = decodeRecord(Buffer.from(cliRecord(id, WORK)), id)
    expect(decoded.hasHeader).toBe(true)
    expect(decoded.meta).toMatchObject({ id, cwd: WORK, isSeeded: false })
    expect(decoded.events.map(event => event.type)).toEqual(reference.events.map(event => event.type))
    // The CLI's snapshots are known to the writer state: the same system prompt is not written twice.
    expect([...decoded.state.snapshotRefs]).toEqual(["sha256:aa", "sha256:bb"])
    expect(decoded.committedBytes).toBe(Buffer.byteLength(cliRecordV1(id, WORK)))
  })

  test("decode rebuilds DSH events: turns, steps, messages, tool calls and results; thinking stays out", () => {
    const id = SessionId("cli-1")
    const decoded = decodeRecord(Buffer.from(cliRecord(id, WORK)), id)
    expect(decoded.hasHeader).toBe(false)
    expect(decoded.meta).toMatchObject({ version: 0, id, cwd: WORK, isSeeded: false })
    expect(decoded.events.map(event => event.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "tool/call",
      "tool/result",
      "step/end",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end",
    ])
    expect(decoded.events.map(event => Number(event.seq))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const assistant = decoded.events[3] as Extract<(typeof decoded.events)[number], { type: "assistant/message" }>
    expect(assistant.data.message.content).toEqual([
      { type: "text", text: "Reading." },
      { type: "tool-call", id: "call_1", name: "Read", arguments: JSON.stringify({ file_path: "/w/README.md" }) },
    ] as unknown as typeof assistant.data.message.content)
    expect(assistant.data.message.source).toEqual({ kind: "model", provider: "alwith", model: "claude-x" })
    expect(decoded.state.lastUuid).toBe("a2")
    expect(decoded.committedBytes).toBe(Buffer.byteLength(cliRecord(id, WORK)))
  })

  test("a DSH agent resumes a CLI record, answers, and appends its own events after the CLI lines", async () => {
    const dir = await freshRoot("dsh-alwith-cli-")
    try {
      const id = "11111111-2222-4333-8444-555555555555"
      const path = recordPath(dir, WORK, id)
      await mkdir(join(dir, projectKey(WORK)), { recursive: true })
      await writeFile(path, cliRecord(id, WORK))

      const h = await makeHarness([textResponse("continuing")], { persistence: { kind: "alwith", projectsDir: dir } })
      try {
        await h.initialize()
        await h.agent.request("session/resume", { sessionId: id, cwd: WORK, replayFrom: { type: "start" } })
        await untilFrame(() => h.updates.some(update => update.sessionUpdate === "agent_message_chunk"))
        await h.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "go on" }] })
        await untilFrame(() => h.states().at(-1)?.state === "idle")
        await h.ctx.sessions.flush(h.ctx.sessions.get(SessionId(id))!)

        // The model saw the CLI history: its request carries the reconstructed messages.
        const request = h.adapter.requests[0]!
        const roles = request.messages.map(message => message.role)
        expect(roles.slice(0, 2)).toEqual(["user", "assistant"])
        expect(JSON.stringify(request.messages)).toContain("It says hello.")
        expect(JSON.stringify(request.messages)).not.toContain("private")

        const lines = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line))
        expect(lines[0].type).toBe("user") // CLI lines untouched, no header inserted
        const appended = lines.slice(5)
        expect(appended.some(line => line.type === "alwith" && line.kind === "event" && line.event.type === "user/message")).toBe(true)
        const dshUser = appended.find(line => line.type === "user" && line.alwith?.engine === "dsh")
        expect(dshUser.parentUuid).toBe("a2")
        expect(dshUser.message.content).toBe("go on")
        const dshAssistant = appended.find(line => line.type === "assistant" && line.alwith?.engine === "dsh")
        expect(dshAssistant.message.content).toEqual([{ type: "text", text: "continuing" }])
      } finally {
        await h.dispose()
      }

      // Second life: the record now holds CLI lines + DSH events; resume again and continue.
      const h2 = await makeHarness([textResponse("still here")], { persistence: { kind: "alwith", projectsDir: dir } })
      try {
        await h2.initialize()
        await h2.agent.request("session/resume", { sessionId: id, cwd: WORK })
        await h2.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "and?" }] })
        await untilFrame(() => h2.states().at(-1)?.state === "idle")
        const request = h2.adapter.requests[0]!
        const text = JSON.stringify(request.messages)
        expect(text).toContain("It says hello.")
        expect(text).toContain("continuing")
        expect(text).toContain("go on")
      } finally {
        await h2.dispose()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("session/list sees CLI records and DSH records alike", async () => {
    const dir = await freshRoot("dsh-alwith-list-")
    try {
      const cliId = "aaaaaaaa-0000-4000-8000-000000000001"
      await mkdir(join(dir, projectKey(WORK)), { recursive: true })
      await writeFile(recordPath(dir, WORK, cliId), cliRecord(cliId, WORK))
      const h = await makeHarness([textResponse("hi")], { persistence: { kind: "alwith", projectsDir: dir } })
      try {
        await h.initialize()
        const created = await h.agent.request("session/new", { cwd: WORK })
        await h.agent.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "x" }] })
        await untilFrame(() => h.states().at(-1)?.state === "idle")
        await h.ctx.sessions.flush(h.ctx.sessions.get(SessionId(created.sessionId))!)
        const listed = await h.agent.request("session/list", { cwd: WORK })
        expect(listed.sessions.map(session => session.sessionId).sort()).toEqual([cliId, created.sessionId].sort())
      } finally {
        await h.dispose()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("one record, whole-line co-writers", () => {
  test("a failed append rolls back only this writer's partial bytes; a platform line after the prefix is kept and reported", async () => {
    const dir = await freshRoot("dsh-alwith-rollback-")
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AlwithSessionPersistence, { projectsDir: dir })
      const provider = ctx.get("sessionPersistence") as unknown as {
        rollback(path: string, size: number, attempted: string): Promise<void>
      }
      const path = join(dir, "record.jsonl")
      const prefix = '{"type":"alwith","kind":"header","version":1}\n'
      const attempted = '{"type":"alwith","kind":"event","seq":0}\n'

      // Our own torn write after the confirmed prefix: cut back to the prefix.
      await writeFile(path, prefix + attempted.slice(0, 12))
      await provider.rollback(path, Buffer.byteLength(prefix), attempted)
      expect(await readFile(path, "utf8")).toBe(prefix)

      // Someone else's whole line (desktop custom-title) after the prefix: not ours, must survive.
      const platformLine = '{"type":"custom-title","customTitle":"renamed"}\n'
      await writeFile(path, prefix + platformLine)
      await expect(provider.rollback(path, Buffer.byteLength(prefix), attempted)).rejects.toThrow("did not write")
      expect(await readFile(path, "utf8")).toBe(prefix + platformLine)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("one record id under two project directories", () => {
  test("list and resume use the most recently written file and report the shadowed one", async () => {
    const dir = await freshRoot("dsh-alwith-shadow-")
    try {
      const id = SessionId("11111111-2222-4333-8444-555555555555")
      const older = join(dir, projectKey("/w/old"), `${id}.jsonl`)
      const newer = join(dir, projectKey("/w/new"), `${id}.jsonl`)
      await mkdir(join(dir, projectKey("/w/old")), { recursive: true })
      await mkdir(join(dir, projectKey("/w/new")), { recursive: true })
      await writeFile(older, cliRecord(id, "/w/old"))
      await new Promise(resolve => setTimeout(resolve, 20))
      await writeFile(newer, cliRecord(id, "/w/new"))
      const warnings: string[] = []
      const ctx = new Context()
      ctx.logger.warn = ((message: unknown) => warnings.push(String(message))) as typeof ctx.logger.warn
      await ctx.plugin(SessionStore)
      await ctx.plugin(AlwithSessionPersistence, { projectsDir: dir })
      const provider = ctx.get("sessionPersistence")!
      const listed = await provider.list()
      expect(listed.map(header => [header.id, header.cwd])).toEqual([[id, "/w/new"]])
      expect((await provider.readRaw(id))?.meta.cwd).toBe("/w/new")
      expect(warnings.some(message => message.includes("shadowing") && message.includes(older))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
