/**
 * Composes the dsh runtime from the plugin manifest (src/plugins.ts).
 *
 * The roster per preset is fixed in code — a platform decision, not a
 * user-patchable tree — but users keep dsh's two degrees of freedom through
 * the overrides file: per-plugin enable/disable and per-plugin config.
 * Composition stays deterministic: same preset + same overrides ⟹ same tree.
 *
 * Why not dsh's loader: the sidecar spawns one process per session, so
 * overrides naturally take effect on the next session — no HMR needed — and
 * dsh's HMR machinery requires Node loader internals Bun does not provide.
 */

import { Context } from "@deepseek-ai/cordis"
import {
  type HarnessPreset,
  type PermissionMode,
  type PluginOverrides,
  pluginRows,
  resolvePlugins,
} from "./plugins.ts"

export type { HarnessPreset, PermissionMode }

export interface ComposeOptions {
  /**
   * Root directory for JSONL session logs. Absent means no persistence —
   * session/resume then fails loud (`session persistence is not configured`).
   */
  sessionsRoot?: string
  /** Sandbox workspace root (writes allowed under it in workspace-write mode). */
  workspaceRoot?: string
  /** Deployment permission mode; mirrors dsh's DSH_PERMISSION_MODE. */
  permissionMode?: PermissionMode
  /** Tool-surface preset; defaults to the standard coding agent. */
  preset?: HarnessPreset
  /** Per-plugin enable/disable + config, from the plugins.json overrides file. */
  overrides?: PluginOverrides
  /** Extra pi-ai provider routes (see ResolvedComposeOptions.piProviders). */
  piProviders?: Record<string, unknown>
  /** The harness credential file (see ResolvedComposeOptions.credentialsFile). */
  credentialsFile?: string
}

export async function composeRuntime(options: ComposeOptions = {}): Promise<Context> {
  const rows = pluginRows({
    sessionsRoot: options.sessionsRoot,
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    permissionMode: options.permissionMode ?? "workspace-write",
    preset: options.preset ?? "standard",
    piProviders: options.piProviders,
    credentialsFile: options.credentialsFile,
  })
  const { mounted } = resolvePlugins(rows, options.overrides ?? {})
  const ctx = new Context()
  for (const entry of mounted) {
    await entry.row.mount(ctx, entry.config)
  }
  return ctx
}
