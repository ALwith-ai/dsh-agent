/**
 * Subscription OAuth for the pi-ai seat, on the harness's own credential plane.
 *
 * Since dsh 0.1.2 the pi-ai adapter ships the whole sign-in translation:
 * `dsh-llm-pi-ai` registers one `ctx.authorization` flow per catalog provider
 * that offers a login, and persists what pi-ai's `Models.login()` produces
 * (and later refreshes under its own lock) as `llm-pi-ai/<provider>` records in
 * `ctx.credentials`. This module only composes that plane and drives it:
 *
 * - `dsh-credentials-local` at `ALWITH_DSH_OAUTH_CREDENTIALS` (default
 *   `~/.dsh-agent/.credentials.yaml`; the file is private to the OS user),
 * - `dsh-authorization` — the flow registry the adapter registers into,
 * - the `oauth login/status/logout` CLI. `login` emits the flow's notices as
 *   JSON lines on stdout (`{"type":"auth_url",…}` → the host opens the
 *   browser); the provider's local callback server completes the exchange.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import AuthorizationService, {
  type AuthorizationInteraction,
  type AuthorizationNotice,
  type AuthorizationPrompt,
} from "@deepseek-ai/dsh-authorization"
import { credentialKey, credentialKeyId, credentialKeyScope } from "@deepseek-ai/dsh-credentials"
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local"
import LlmRuntime from "@deepseek-ai/dsh-llm"
// Namespace import: a module-plugin default export drops `inject` (dsh postmortem 0001).
import * as LlmPiAi from "@deepseek-ai/dsh-llm-pi-ai"

/** The record scope the pi-ai adapter writes under (its registered plugin name). */
const PI_AI_RECORD_SCOPE = "llm-pi-ai"

export function defaultCredentialsFile(): string {
  return process.env.ALWITH_DSH_OAUTH_CREDENTIALS ?? join(homedir(), ".dsh-agent", ".credentials.yaml")
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/**
 * The minimal composition that owns subscription credentials: the store, the
 * flow registry, and the adapter that registers the flows. No session, no
 * sandbox, no tools — signing in is not a conversation. `watch` is off: this
 * process is the only writer for its lifetime and must exit when done.
 */
export async function composeCredentialPlane(credentialsFile: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: credentialsFile, watch: false } as never)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: {} } as never)
  return ctx
}

/**
 * Interaction callbacks for a host-driven login, in the seam's neutral
 * vocabulary. Notices pass through as JSON lines: one carrying a page becomes
 * `auth_url` (the host opens it), one carrying a code becomes `device_code`,
 * the rest `info`. A prompt carrying `signal` is an alternative input path
 * raced against the flow's callback server (anthropic's paste-the-redirect-URL
 * question); answering is optional, so it stays pending until the flow aborts
 * it after login settles. A signal-less prompt is required input this
 * non-interactive host cannot supply — fail loud rather than hang. (A plain
 * rejection, not `AuthorizationDeclinedError`: "no" would settle the attempt
 * as cancelled and hide the fact that the host cannot answer.)
 */
export function hostLoginInteraction(): AuthorizationInteraction {
  return {
    notify: (notice: AuthorizationNotice) => {
      if (notice.url !== undefined && notice.code !== undefined) {
        emit({ type: "device_code", verificationUri: notice.url, userCode: notice.code, message: notice.message })
      } else if (notice.url !== undefined) {
        emit({ type: "auth_url", url: notice.url, instructions: notice.message })
      } else {
        emit({ type: "info", message: notice.message })
      }
    },
    prompt: (prompt: AuthorizationPrompt) =>
      new Promise<string>((_resolve, reject) => {
        if (!prompt.signal) {
          reject(new Error(`interactive prompt not supported in host login flow: ${JSON.stringify(prompt)}`))
          return
        }
        prompt.signal.addEventListener(
          "abort",
          () => reject(new Error(`prompt "${prompt.kind}" cancelled: login settled out of band`)),
          { once: true }
        )
      }),
  }
}

/** `oauth login <provider>` / `oauth status` / `oauth logout <provider>`; stdout is JSON lines. */
export async function runOauthCli(argv: string[]): Promise<void> {
  const [command, providerId] = argv
  const ctx = await composeCredentialPlane(defaultCredentialsFile())
  try {
    if (command === "status") {
      const stored = await ctx.credentials.listRecords()
      const credentials = stored
        .filter((entry) => credentialKeyScope(entry.key) === PI_AI_RECORD_SCOPE)
        .map((entry) => ({ providerId: credentialKeyId(entry.key), type: entry.kind === "api-key" ? "api_key" : "oauth" }))
      emit({ type: "status", credentials })
      return
    }
    if (command === "logout") {
      if (!providerId) throw new Error("usage: oauth logout <provider>")
      await ctx.credentials.deleteRecord(credentialKey(PI_AI_RECORD_SCOPE, providerId))
      emit({ type: "logged-out", providerId })
      return
    }
    if (command === "login") {
      if (!providerId) throw new Error("usage: oauth login <provider>")
      const key = credentialKey(PI_AI_RECORD_SCOPE, providerId)
      const flow = ctx.authorization.describe(key)
      if (flow === undefined) {
        const available = ctx.authorization
          .list()
          .filter((entry) => credentialKeyScope(entry.key) === PI_AI_RECORD_SCOPE)
          .map((entry) => credentialKeyId(entry.key))
        throw new Error(`no subscription login wired for "${providerId}" (available: ${available.join(", ")})`)
      }
      if (!flow.methods.some((method) => method.id === "oauth")) {
        throw new Error(`"${providerId}" offers no OAuth login (methods: ${flow.methods.map((m) => m.id).join(", ")})`)
      }
      const outcome = await ctx.authorization.begin({ key, method: "oauth", interaction: hostLoginInteraction() })
      if (outcome.status !== "authorized") throw new Error(`subscription login for "${providerId}" was cancelled`)
      emit({ type: "logged-in", providerId })
      return
    }
    throw new Error(`unknown oauth command "${command ?? ""}": expected login, status or logout`)
  } finally {
    await ctx.fiber.dispose()
  }
}
