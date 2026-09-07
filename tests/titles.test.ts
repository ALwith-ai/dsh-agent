/** Background LLM session titles: one short generate after the first turn upgrades the deterministic title. */

import { describe, expect, test } from "bun:test"
import { makeHarness, textResponse, untilFrame } from "./harness.ts"

function titles(h: Awaited<ReturnType<typeof makeHarness>>): Array<string | undefined> {
  return h.updates
    .filter(update => update.sessionUpdate === "session_info_update")
    .map(update => (update as { title?: string }).title)
}

describe("llm session titles", () => {
  test("closing the session aborts its background title request", async () => {
    const h = await makeHarness([], { titleModel: "mock-pro" })
    const started = Promise.withResolvers<void>()
    let aborted = false
    h.adapter.stream = async function* (options) {
      if (options.model === "mock") {
        yield* textResponse("hello")
        return
      }
      started.resolve()
      await new Promise<void>(resolve => {
        const onAbort = () => { aborted = true; resolve() }
        if (options.signal?.aborted) onAbort()
        else options.signal?.addEventListener("abort", onAbort, { once: true })
      })
    }
    try {
      await h.initialize()
      const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
      await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })
      await started.promise
      await h.agent.request("session/close", { sessionId })
      expect(aborted).toBe(true)
      expect(titles(h)).toEqual(["hello"])
    } finally {
      await h.dispose()
    }
  })

  test("first turn upgrades the deterministic title; the title call targets the title model", async () => {
    const h = await makeHarness([textResponse("hello"), textResponse('"Greeting Session."')], { titleModel: "mock-pro" })
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi there friend" }] })
    await untilFrame(() => titles(h).length >= 2)
    // Deterministic truncation first, refined title second (quotes and trailing punctuation stripped).
    expect(titles(h)).toEqual(["hi there friend", "Greeting Session"])
    const titleRequest = h.adapter.requests[1]
    expect(titleRequest?.model).toBe("mock-pro")
    expect(titleRequest?.maxTokens).toBe(128)
    expect(titleRequest?.messages.map(message => message.content)).toEqual([[{ type: "text", text: "hi there friend" }]])
    await h.dispose()
  })

  test("only the first turn titles: the second prompt does not regenerate", async () => {
    const h = await makeHarness([textResponse("a"), textResponse("First Title"), textResponse("b")], {
      titleModel: "mock",
    })
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "one" }] })
    await untilFrame(() => titles(h).length >= 2)
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "two" }] })
    await untilFrame(() => h.states().filter(entry => entry.state === "idle").length >= 2)
    expect(titles(h)).toEqual(["one", "First Title"])
    await h.dispose()
  })

  test("a max-tokens finish keeps the text that arrived (reasoning models burn budget)", async () => {
    const h = await makeHarness(
      [
        textResponse("ok"),
        [
          { type: "block-start", index: 0, blockType: "text" },
          { type: "text-delta", index: 0, text: "Trimmed Title" },
          { type: "finish", reason: { kind: "max-tokens" } },
        ],
      ],
      { titleModel: "mock" },
    )
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "budget test" }] })
    await untilFrame(() => titles(h).length >= 2)
    expect(titles(h).at(-1)).toBe("Trimmed Title")
    await h.dispose()
  })

  test("a failed title generate leaves the deterministic title standing", async () => {
    // Script has only the turn response; the title call exhausts the script and throws.
    const h = await makeHarness([textResponse("ok")], { titleModel: "mock" })
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })
    // The title call was attempted (second adapter request) and failed; only the deterministic frame exists.
    await untilFrame(() => h.adapter.requests.length >= 2)
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    expect(titles(h)).toEqual(["hello"])
    await h.dispose()
  })
})
