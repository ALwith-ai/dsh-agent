#!/usr/bin/env bun
/**
 * stdio entry: `bun src/main.ts` starts an ACP v2 server for a host to spawn.
 * The DeepSeek key resolves through llm-deepseek's default credential lookup
 * ($DEEPSEEK_API_KEY).
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { credentialKey } from "@deepseek-ai/dsh-credentials"
import { composeRuntime } from "./compose.ts"
import { defaultCredentialsFile } from "./oauth.ts"
import { loadPluginOverrides } from "./plugins.ts"
import { defaultPluginsFile, runPluginsCli } from "./plugins-cli.ts"
import * as Bridge from "./bridge.ts"

// `plugins` / `sessions` subcommands: host-facing management without an ACP
// server. Failures exit 1 with the reason as a single stderr line — the host
// surfaces stderr verbatim, so no runtime stack noise here. No process.exit()
// on the success path: Bun's exit does not flush pipes and a session dump
// exceeds the 64KB pipe buffer — the drained event loop ends the process.
const subcommand = process.argv[2]
if (subcommand === "plugins" || subcommand === "sessions" || subcommand === "oauth") {
  try {
    if (subcommand === "plugins") await runPluginsCli(process.argv.slice(3))
    else if (subcommand === "oauth") await (await import("./oauth.ts")).runOauthCli(process.argv.slice(3))
    else await (await import("./sessions-cli.ts")).runSessionsCli(process.argv.slice(3))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
} else {
  await startServer()
}

async function startServer(): Promise<void> {
  const provider = process.env.ALWITH_DSH_PROVIDER ?? "deepseek-official"
  const model = process.env.ALWITH_DSH_MODEL ?? "deepseek-v4-flash"
  // Host-facing provider identity for _meta.alwith turn metadata (the ALwith
  // Desktop provider vocabulary, not the dsh adapter route).
  const providerId = process.env.ALWITH_DSH_PROVIDER_ID ?? "deepseek"
  // Background LLM session titles ride the session's model unless overridden.
  const titleModel = process.env.ALWITH_DSH_TITLE_MODEL ?? model
  // Session logs live under the sidecar's own home by default; the host
  // (ALwith Desktop) overrides this to its managed location.
  const sessionsRoot = process.env.ALWITH_DSH_SESSIONS_ROOT ?? join(homedir(), ".dsh-agent", "sessions")
  // The host spawns one sidecar per session and pins the sandbox workspace to
  // that session's cwd; standalone runs default to the process cwd.
  const workspaceRoot = process.env.ALWITH_DSH_WORKSPACE_ROOT ?? process.cwd()
  const permissionMode = (process.env.ALWITH_DSH_PERMISSION_MODE ?? "workspace-write") as
    | "read-only"
    | "workspace-write"
    | "danger-full-access"
  // Preset gate fails loud on the modes this sidecar does not compose yet —
  // the host UI disables them, and a misrouted value must not silently degrade.
  const rawPreset = process.env.ALWITH_DSH_PRESET ?? "standard"
  const PRESETS = ["standard", "minimal", "anchored", "code", "cordis"] as const
  if (!(PRESETS as readonly string[]).includes(rawPreset)) {
    throw new Error(`unsupported harness preset "${rawPreset}": this sidecar composes ${PRESETS.join(", ")}`)
  }

  // Per-plugin enable/disable + config; invalid content fails the spawn loud.
  const overrides = loadPluginOverrides(defaultPluginsFile())

  // Extra pi-ai provider routes (JSON dict, full upstream config shape:
  // apiKeyEnv / baseURL / api / models / compat / …). Absent = DeepSeek-only.
  let piProviders: Record<string, unknown> | undefined
  const rawPiProviders = process.env.ALWITH_DSH_PI_PROVIDERS
  if (rawPiProviders !== undefined) {
    const parsed: unknown = JSON.parse(rawPiProviders)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("ALWITH_DSH_PI_PROVIDERS must be a JSON object keyed by provider route")
    }
    piProviders = parsed as Record<string, unknown>
  }

  const ctx = await composeRuntime({
    sessionsRoot,
    workspaceRoot,
    permissionMode,
    preset: rawPreset as (typeof PRESETS)[number],
    overrides,
    piProviders,
    // The credential plane rides with the pi-ai seat: subscription grants and
    // their refreshes live in the harness credential file, not in this process.
    credentialsFile: piProviders === undefined ? undefined : defaultCredentialsFile(),
  })
  // A route with no apiKeyEnv authenticates through a stored subscription
  // grant. Check it here, where the credential plane is the single source of
  // truth, so a session never boots into a first request that must fail —
  // the host cannot read the harness credential file and should not try.
  for (const [route, config] of Object.entries(piProviders ?? {})) {
    const declared = config as { apiKeyEnv?: unknown }
    if (declared.apiKeyEnv !== undefined) continue
    const record = await ctx.credentials.describeRecord(credentialKey("llm-pi-ai", route))
    if (!record.configured) {
      throw new Error(
        `provider route "${route}" declares no API key and has no stored subscription credential: `
        + "add an API key (Settings → Model providers) or sign in with a subscription (Settings → Harness)",
      )
    }
  }
  await ctx.plugin(
    { name: Bridge.name, inject: [...Bridge.inject], apply: (inner: typeof ctx) => Bridge.apply(inner, { provider, model, providerId, titleModel }) },
  )
  // stdin keeps the process alive; the bridge's quiesce handles connection close.
}
