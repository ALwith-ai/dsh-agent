import { expect, test } from "bun:test"
import { makeHarness, textResponse, untilFrame } from "./harness.ts"
import { turnEndToStopReason } from "../src/codec.ts"

test("cancel waits for durable convergence and an empty concurrent prompt cannot report idle", async () => {
  const h = await makeHarness([])
  const started = Promise.withResolvers<void>()
  const checkpoint = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  h.adapter.stream = async function* (options) {
    started.resolve()
    await new Promise<void>(resolve => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener("abort", () => resolve(), { once: true })
    })
    throw new Error("aborted")
  }
  const remove = h.ctx.on("session/flush", async session => {
    if (!session.snapshotEvents().some(event => event.type === "turn/end")) return
    checkpoint.resolve()
    await release.promise
  })
  try {
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    let settled = false
    const prompt = h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "wait" }] })
      .then(() => { settled = true })
    await started.promise
    await h.agent.request("session/prompt", { sessionId, prompt: [] })
    expect(h.states().some(state => state.state === "idle")).toBe(false)
    await h.agent.notify("session/cancel", { sessionId })
    await checkpoint.promise
    expect(settled).toBe(false)
    expect(h.states().some(state => state.state === "idle")).toBe(false)
    await expect(h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "too soon" }] }))
      .rejects.toMatchObject({ code: -32602 })
    release.resolve()
    await prompt
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    expect(h.states().at(-1)?.stopReason).toBe("cancelled")
    const end = h.ctx.agents.get(sessionId as never)!.session.snapshotEvents().find(event => event.type === "turn/end")
    expect(end?.data).toMatchObject({ reason: { kind: "aborted", reason: { kind: "user" } } })
  } finally {
    release.resolve()
    remove()
    await h.dispose()
  }
})

test("live cancellation causes map to cancelled", () => {
  expect(turnEndToStopReason({ kind: "aborted", reason: { kind: "user" } })).toBe("cancelled")
  expect(turnEndToStopReason({ kind: "aborted", reason: { kind: "disposed" } })).toBe("cancelled")
})

test("completed idle waits for the session durability checkpoint", async () => {
  const h = await makeHarness([textResponse("pong")])
  const checkpoint = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const remove = h.ctx.on("session/flush", async session => {
    if (!session.snapshotEvents().some(event => event.type === "turn/end")) return
    checkpoint.resolve()
    await release.promise
  })
  try {
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    const prompt = h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "ping" }] })
    await checkpoint.promise
    await untilFrame(() => h.updates.some(update => update.sessionUpdate === "agent_message_chunk"))
    expect(h.states().some(state => state.state === "idle")).toBe(false)
    release.resolve()
    await prompt
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    expect(h.states().at(-1)?.stopReason).toBe("end_turn")
  } finally {
    release.resolve()
    remove()
    await h.dispose()
  }
})

test("a failed completion checkpoint rejects the prompt and reports an error", async () => {
  const h = await makeHarness([textResponse("pong")])
  const remove = h.ctx.on("session/flush", session => {
    if (session.snapshotEvents().some(event => event.type === "turn/end")) {
      throw new Error("disk full")
    }
  })
  try {
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await expect(h.agent.request("session/prompt", {
      sessionId, prompt: [{ type: "text", text: "ping" }],
    })).rejects.toThrow("disk full")
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    expect(h.states().at(-1)?.stopReason).toBe("_error")
  } finally {
    remove()
    await h.dispose()
  }
})

test("a model failure never reports a successful end_turn", async () => {
  const h = await makeHarness([() => { throw new Error("model unavailable") }])
  try {
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await expect(h.agent.request("session/prompt", {
      sessionId, prompt: [{ type: "text", text: "ping" }],
    })).rejects.toThrow("model unavailable")
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    expect(h.states().at(-1)?.stopReason).toBe("_error")
  } finally {
    await h.dispose()
  }
})


test("close releases its agent even when the final checkpoint fails", async () => {
  const h = await makeHarness([])
  const remove = h.ctx.on("session/flush", () => { throw new Error("disk full") })
  try {
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await expect(h.agent.request("session/close", { sessionId })).rejects.toThrow("disk full")
    expect(h.ctx.agents.get(sessionId as never)).toBeUndefined()
  } finally {
    remove()
    await h.dispose()
  }
})


test("a token limit retains max_tokens as the completion reason", async () => {
  const h = await makeHarness([[
    ...textResponse("partial").slice(0, -1),
    { type: "finish", reason: { kind: "max-tokens" } },
  ]])
  try {
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "ping" }] })
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    expect(h.states().at(-1)?.stopReason).toBe("max_tokens")
  } finally {
    await h.dispose()
  }
})
