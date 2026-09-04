/** `sessions` subcommand: list and show through dsh's own persistence backend. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHarness, textResponse, untilFrame } from "./harness.ts"
import { runSessionsCli } from "../src/sessions-cli.ts"

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(chunk.toString())
    return true
  }) as typeof process.stdout.write
  return { lines, restore: () => { process.stdout.write = original } }
}

describe("sessions CLI", () => {
  test("list surfaces persisted sessions; show returns meta and the event log", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-agent-sessions-"))
    const h = await makeHarness([textResponse("hello")], { sessionsRoot: root })
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "inspect me" }] })
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    await h.dispose()

    const stdout = captureStdout()
    try {
      await runSessionsCli(["list", "--root", root])
      const listed = JSON.parse(stdout.lines.at(-1)!) as { sessions: Array<{ id: string; cwd?: string; createdAt: number }> }
      expect(listed.sessions.map(session => session.id)).toContain(sessionId)
      expect(listed.sessions.find(session => session.id === sessionId)?.cwd).toBe("/tmp")

      await runSessionsCli(["show", sessionId, "--root", root])
      const shown = JSON.parse(stdout.lines.at(-1)!) as { meta: { id: string }; events: Array<{ type?: string }> }
      expect(shown.meta.id).toBe(sessionId)
      expect(shown.events.length).toBeGreaterThan(0)
      expect(JSON.stringify(shown.events)).toContain("inspect me")
      expect(JSON.stringify(shown.events)).toContain("hello")
    } finally {
      stdout.restore()
    }
  })

  test("show of an unknown session fails loud", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-agent-sessions-"))
    await expect(runSessionsCli(["show", "no-such-session", "--root", root])).rejects.toThrow()
  })
})
