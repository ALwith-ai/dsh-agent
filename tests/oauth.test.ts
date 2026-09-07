/** Subscription OAuth on the harness credential plane: status/logout CLI, host interaction, keyless-route composition. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { credentialKey } from "@deepseek-ai/dsh-credentials"
import { composeRuntime } from "../src/compose.ts"
import { composeCredentialPlane, hostLoginInteraction, runOauthCli } from "../src/oauth.ts"

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "dsh-agent-oauth-")), ".credentials.yaml")
}

async function captureCli(argv: string[]): Promise<string[]> {
  const lines: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(chunk.toString())
    return true
  }) as typeof process.stdout.write
  try {
    await runOauthCli(argv)
  } finally {
    process.stdout.write = original
  }
  return lines
}

describe("credential plane", () => {
  test("a grant committed through ctx.credentials lands in the private file and lists without secrets", async () => {
    const file = tempFile()
    process.env.ALWITH_DSH_OAUTH_CREDENTIALS = file
    try {
      const ctx = await composeCredentialPlane(file)
      try {
        await ctx.credentials.modifyRecord(credentialKey("llm-pi-ai", "anthropic"), async () => ({
          kind: "grant",
          payload: { type: "oauth", refresh: "r1", access: "a1", expires: 123 },
        }))
      } finally {
        await ctx.fiber.dispose()
      }
      expect((statSync(file).mode & 0o777).toString(8)).toBe("600")

      const status = JSON.parse((await captureCli(["status"])).at(-1)!) as {
        credentials: Array<{ providerId: string; type: string }>
      }
      expect(status.credentials).toEqual([{ providerId: "anthropic", type: "oauth" }])
      expect(readFileSync(file, "utf8")).toContain("a1")

      const loggedOut = (await captureCli(["logout", "anthropic"])).join("")
      expect(loggedOut).toContain('"logged-out"')
      const after = JSON.parse((await captureCli(["status"])).at(-1)!) as { credentials: unknown[] }
      expect(after.credentials).toEqual([])
    } finally {
      delete process.env.ALWITH_DSH_OAUTH_CREDENTIALS
    }
  })

  test("the adapter registers an OAuth login for anthropic on the authorization seam", async () => {
    const file = tempFile()
    const ctx = await composeCredentialPlane(file)
    try {
      const flow = ctx.authorization.describe(credentialKey("llm-pi-ai", "anthropic"))
      expect(flow?.methods.map((method) => method.id)).toContain("oauth")
    } finally {
      await ctx.fiber.dispose()
    }
  })

  test("login for an unwired provider fails loud", async () => {
    process.env.ALWITH_DSH_OAUTH_CREDENTIALS = tempFile()
    try {
      await expect(runOauthCli(["login", "acme"])).rejects.toThrow("no subscription login wired")
    } finally {
      delete process.env.ALWITH_DSH_OAUTH_CREDENTIALS
    }
  })
})

describe("host login interaction", () => {
  test("an already aborted prompt rejects immediately", async () => {
    const controller = new AbortController()
    controller.abort()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await expect(Promise.race([
        hostLoginInteraction().prompt({
          kind: "text",
          message: "Paste the redirect URL",
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("prompt remained pending")), 100)
        }),
      ])).rejects.toThrow("settled out of band")
    } finally {
      clearTimeout(timeout)
    }
  })

  test("a signalled prompt (callback-server race) stays pending, rejects on abort", async () => {
    const controller = new AbortController()
    const pending = hostLoginInteraction().prompt({
      kind: "text",
      message: "Complete login in your browser, or paste the authorization code here:",
      signal: controller.signal,
    })
    let settled = false
    const observed = pending.catch((error) => {
      settled = true
      return error as Error
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    controller.abort()
    expect(((await observed) as Error).message).toContain("settled out of band")
  })

  test("a signal-less prompt is required input — fails loud", async () => {
    await expect(
      hostLoginInteraction().prompt({ kind: "select", message: "pick one", options: [{ id: "a", label: "A" }] })
    ).rejects.toThrow("interactive prompt not supported")
  })

  test("a notice with a page becomes the host's auth_url event", () => {
    const lines: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      hostLoginInteraction().notify({ message: "Open this page", url: "https://example.test/authorize" })
    } finally {
      process.stdout.write = original
    }
    expect(JSON.parse(lines[0]!)).toEqual({
      type: "auth_url",
      url: "https://example.test/authorize",
      instructions: "Open this page",
    })
  })
})

describe("keyless OAuth route", () => {
  test("a route with no apiKeyEnv composes beside the credential plane (auth deferred to the stored grant)", async () => {
    const ctx = await composeRuntime({
      preset: "standard",
      piProviders: { anthropic: {} },
      credentialsFile: tempFile(),
    })
    try {
      const providers = (ctx as unknown as { llm: { listProviders: () => Array<{ id: string }> } }).llm
        .listProviders()
        .map((provider) => provider.id)
      expect(providers).toContain("anthropic")
      expect(ctx.authorization.describe(credentialKey("llm-pi-ai", "anthropic"))).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
