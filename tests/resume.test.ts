/** session/resume: cold resume across contexts, history replay, cwd guard, live reuse. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHarness, textResponse, untilFrame } from "./harness.ts"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dsh-agent-resume-"))
}

function chunkText(h: Awaited<ReturnType<typeof makeHarness>>, kind: string): string {
  return h.updates
    .filter(update => update.sessionUpdate === kind)
    .map(update => (update as { content: { text: string } }).content.text)
    .join("")
}

describe("session/resume", () => {
  test("cold resume replays history and derives model context from the log", async () => {
    const root = tempRoot()

    // First life: create, prompt, settle, tear down (persists the log).
    const h1 = await makeHarness([textResponse("hello")], { sessionsRoot: root })
    await h1.initialize()
    const { sessionId } = await h1.agent.request("session/new", { cwd: "/tmp" })
    await h1.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] })
    await untilFrame(() => h1.states().at(-1)?.state === "idle")
    await h1.dispose()

    // Second life: resume with a full replay, then continue the conversation.
    const h2 = await makeHarness([textResponse("again")], { sessionsRoot: root })
    await h2.initialize()
    await h2.agent.request("session/resume", { sessionId, cwd: "/tmp", replayFrom: { type: "start" } })
    await untilFrame(() => chunkText(h2, "agent_message_chunk").includes("hello"))
    expect(chunkText(h2, "user_message_chunk")).toBe("hi")
    expect(chunkText(h2, "agent_message_chunk")).toBe("hello")

    await h2.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "more" }] })
    await untilFrame(() => h2.states().at(-1)?.state === "idle")
    // The resumed agent derives its model history from the persisted log:
    // the new request must carry the prior turn.
    const request = h2.adapter.requests.at(0)
    expect(request).toBeDefined()
    const serialized = JSON.stringify(request)
    expect(serialized).toContain("hello")
    expect(serialized).toContain("hi")
    await h2.dispose()
  })

  test("interrupted turn then restart: cancel mid-turn, cold resume continues from the log", async () => {
    const root = tempRoot()

    // First life: prompt and cancel without waiting for settlement, then tear down.
    const h1 = await makeHarness([textResponse("partial answer")], { sessionsRoot: root })
    await h1.initialize()
    const { sessionId } = await h1.agent.request("session/new", { cwd: "/tmp" })
    const prompt = h1.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "interrupted question" }] })
    await h1.agent.notify("session/cancel", { sessionId })
    await prompt
    await untilFrame(() => h1.states().at(-1)?.state === "idle")
    expect(h1.states().at(-1)?.stopReason).toBe("cancelled")
    await h1.dispose()

    // Second life: the user message survived; the continuation request carries it.
    const h2 = await makeHarness([textResponse("recovered")], { sessionsRoot: root })
    await h2.initialize()
    await h2.agent.request("session/resume", { sessionId, cwd: "/tmp" })
    await h2.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "continue" }] })
    await untilFrame(() => h2.states().at(-1)?.state === "idle")
    const request = h2.adapter.requests.at(0)
    expect(JSON.stringify(request)).toContain("interrupted question")
    await h2.dispose()
  })

  test("resume of an unknown session is invalid params", async () => {
    const h = await makeHarness([], { sessionsRoot: tempRoot() })
    await h.initialize()
    await expect(
      h.agent.request("session/resume", { sessionId: "no-such-session", cwd: "/tmp" }),
    ).rejects.toThrow()
    await h.dispose()
  })

  test("resume with a mismatched cwd is refused", async () => {
    const root = tempRoot()
    const h1 = await makeHarness([textResponse("ok")], { sessionsRoot: root })
    await h1.initialize()
    const { sessionId } = await h1.agent.request("session/new", { cwd: "/tmp" })
    await h1.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] })
    await untilFrame(() => h1.states().at(-1)?.state === "idle")
    await h1.dispose()

    const h2 = await makeHarness([], { sessionsRoot: root })
    await h2.initialize()
    await expect(h2.agent.request("session/resume", { sessionId, cwd: "/private" })).rejects.toThrow()
    await h2.dispose()
  })

  test("resume of a live session reuses the bridge-owned agent (context-only restore)", async () => {
    const h = await makeHarness([textResponse("one"), textResponse("two")], { sessionsRoot: tempRoot() })
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "first" }] })
    await untilFrame(() => h.states().at(-1)?.state === "idle")

    // Context-only restore: no replayFrom, no frames re-emitted.
    const before = h.updates.length
    await h.agent.request("session/resume", { sessionId, cwd: "/tmp" })
    expect(h.updates.length).toBe(before)

    // The reused agent keeps working.
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "second" }] })
    await untilFrame(() => h.states().filter(entry => entry.state === "idle").length >= 2)
    expect(chunkText(h, "agent_message_chunk")).toContain("two")
    await h.dispose()
  })

  test("without a persistence backend resume fails loud", async () => {
    const h = await makeHarness([])
    await h.initialize()
    await expect(h.agent.request("session/resume", { sessionId: "whatever", cwd: "/tmp" })).rejects.toThrow()
    await h.dispose()
  })
})
