/** Failure and concurrency boundaries for bridge-owned agents. */
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHarness, textResponse } from "./harness.ts"

test("a failed model catalog during session/new releases its agent", async () => {
  const h = await makeHarness([])
  h.adapter.listModels = async () => { throw new Error("catalog unavailable") }
  try {
    await h.initialize()
    await expect(h.agent.request("session/new", { cwd: "/tmp" })).rejects.toMatchObject({ code: -32603 })
    expect(h.ctx.agents.list()).toHaveLength(0)
  } finally {
    await h.dispose()
  }
})

test("close during a model switch cannot publish a replacement agent", async () => {
  const h = await makeHarness([textResponse("saved")], {
    sessionsRoot: mkdtempSync(join(tmpdir(), "dsh-agent-switch-close-")),
  })
  const acquired = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "save" }] })
    h.ctx.agents.get(sessionId as never)!.ctx.effect(() => async () => {
      acquired.resolve()
      await release.promise
    })
    const switching = h.agent.request("session/set_config_option", {
      sessionId, configId: "model", type: "id", value: "mock-pro",
    })
    const switched = Promise.allSettled([switching])
    await acquired.promise
    await expect(h.agent.request("session/set_config_option", {
      sessionId, configId: "model", type: "id", value: "mock",
    })).rejects.toMatchObject({ code: -32602 })
    const waitingPrompt = Promise.allSettled([
      h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "queued" }] }),
    ])
    const closing = h.agent.request("session/close", { sessionId })
    // Cross the transport so close invalidates the record before releasing resume.
    await h.agent.request("session/list", {})
    release.resolve()
    await closing
    expect((await switched)[0]?.status).toBe("rejected")
    expect((await waitingPrompt)[0]?.status).toBe("rejected")
    expect(h.ctx.agents.list()).toHaveLength(0)
  } finally {
    release.resolve()
    await h.dispose()
  }
})

test("a fresh session can switch models before its first prompt", async () => {
  const h = await makeHarness([textResponse("ready")], {
    sessionsRoot: mkdtempSync(join(tmpdir(), "dsh-agent-fresh-switch-")),
  })
  try {
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/set_config_option", { sessionId, configId: "model", type: "id", value: "mock-pro" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })
    expect(h.adapter.requests.at(-1)?.model).toBe("mock-pro")
  } finally {
    await h.dispose()
  }
})

test("a model switch refuses unconsumed seed history instead of discarding it", async () => {
  const h = await makeHarness([textResponse("ready")], {
    sessionsRoot: mkdtempSync(join(tmpdir(), "dsh-agent-seeded-switch-")),
  })
  try {
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", {
      cwd: "/tmp", _meta: { dsh: { seedHistory: [{ role: "user", text: "keep this history" }] } },
    })
    await expect(h.agent.request("session/set_config_option", { sessionId, configId: "model", type: "id", value: "mock-pro" }))
      .rejects.toMatchObject({ code: -32602 })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "continue" }] })
    expect(JSON.stringify(h.adapter.requests.at(-1))).toContain("keep this history")
  } finally {
    await h.dispose()
  }
})

test("a failed model replacement leaves the persisted session recoverable", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-agent-failed-switch-"))
  const moved = `${root}-offline`
  const h = await makeHarness([textResponse("saved"), textResponse("recovered")], { sessionsRoot: root })
  try {
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "remember me" }] })
    h.ctx.agents.get(sessionId as never)!.ctx.effect(() => () => { renameSync(root, moved) })
    await expect(h.agent.request("session/set_config_option", {
      sessionId, configId: "model", type: "id", value: "mock-pro",
    })).rejects.toMatchObject({ code: -32603 })
    expect(h.ctx.agents.list()).toHaveLength(0)
    renameSync(moved, root)
    await h.agent.request("session/resume", { sessionId, cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "continue" }] })
    expect(JSON.stringify(h.adapter.requests.at(-1))).toContain("remember me")
  } finally {
    if (existsSync(moved)) renameSync(moved, root)
    await h.dispose()
  }
})
