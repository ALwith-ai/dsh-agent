/**
 * Plugin manifest: the sidecar's composition expressed as data.
 *
 * dsh's own deployments surface every mounted plugin as a configurable row
 * (the web UI's Plugins page); this sidecar keeps composition deterministic —
 * the roster per preset is fixed here, in code — but exposes the same two
 * degrees of freedom dsh gives its users: per-plugin enable/disable and
 * per-plugin config, both read from a hand-editable overrides file.
 *
 * Core rows (session, llm, sandbox, approvals, …) are protected: disabling
 * one would not produce "dsh minus a feature" but a broken runtime, so the
 * attempt fails loud instead. Tool-surface rows are free to toggle; rows with
 * hard capability dependencies declare `requires` and the resolver rejects a
 * combination that would leave a mounted plugin waiting forever on a missing
 * service (cordis would otherwise hang the mount, not error).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import SessionStore from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import LocalSandboxProvider from "@deepseek-ai/dsh-sandbox-local";
import SandboxPolicyService from "@deepseek-ai/dsh-sandbox-policy";
import SandboxBashExecutor from "@deepseek-ai/dsh-bash-sandbox";
import SandboxedFileSystem from "@deepseek-ai/dsh-fs-sandbox";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import PermissionPresetService from "@deepseek-ai/dsh-permission-presets";
import ApprovalService from "@deepseek-ai/dsh-user-approval";
// Namespace imports rather than default: a module-plugin default export drops
// `inject` (see dsh postmortem 0001). Service classes above carry inject as a
// static and are safe as defaults.
import * as LlmDeepseek from "@deepseek-ai/dsh-llm-deepseek";
import * as LlmPiAi from "@deepseek-ai/dsh-llm-pi-ai";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import AuthorizationService from "@deepseek-ai/dsh-authorization";
import * as ShellEnv from "@deepseek-ai/dsh-shell-env";
import * as FsObservationPolicy from "@deepseek-ai/dsh-fs-observation-policy";
import * as ToolFs from "@deepseek-ai/dsh-tool-fs";
import * as ToolBash from "@deepseek-ai/dsh-tool-bash";
import * as ToolTodo from "@deepseek-ai/dsh-tool-todo";
import * as ToolFsSearch from "@deepseek-ai/dsh-tool-fs-search";
import * as ToolWeb from "@deepseek-ai/dsh-tool-web";
import * as WebSearchDeepseek from "@deepseek-ai/dsh-web-search-deepseek";
import * as AnchoredToolBootstrap from "./vendor/anchored-tool-bootstrap.mjs";
import CodeRuntimeWorker from "@deepseek-ai/dsh-code-runtime-worker-thread";
import CordisHostRunner from "@deepseek-ai/dsh-cordis-host-runner";
import * as ToolCordis from "@deepseek-ai/dsh-tool-cordis";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import * as SkillFilesystem from "@deepseek-ai/dsh-skill-filesystem";
import * as ToolSkill from "@deepseek-ai/dsh-tool-skill";
import WebRuntime from "@deepseek-ai/dsh-web";
import TerminalSessionService from "@deepseek-ai/dsh-terminal";
import * as TerminalBash from "@deepseek-ai/dsh-terminal-bash";
import * as ToolBashPersistent from "@deepseek-ai/dsh-tool-bash-persistent";
import * as ToolStrReplaceEditor from "@deepseek-ai/dsh-tool-str-replace-editor";

export type HarnessPreset =
  "standard" | "minimal" | "anchored" | "code" | "cordis";

/** Bundled skill root (vendored from dsh's cordis preset; provenance in THIRD_PARTY_NOTICES). */
const BUNDLED_SKILLS_DIR = fileURLToPath(
  new URL("../skills/", import.meta.url),
);

/**
 * Cordis-preset persona, adapted from dsh's shipped `agent.cordis.yml`: the
 * two paragraphs about preset directories and the roster are dropped — this
 * deployment has no preset-authoring tree, its composition is fixed in code —
 * and the skill pointer targets the one bundled skill that applies here.
 */
const CORDIS_PERSONA =
  "You are a coding agent running on the DeepSeek Harness.\n\n" +
  "You can read and extend the harness you run on. Its composition is Cordis: every capability " +
  "is a plugin, and this session carries the Cordis toolset — inspect the live runtime, define " +
  "dynamic plugins, and activate them.\n\n" +
  "Load the `cordis-plugin-development` skill before defining or changing a plugin.";
export type PermissionMode =
  "read-only" | "workspace-write" | "danger-full-access";

export const HARNESS_PRESETS: readonly HarnessPreset[] = [
  "standard",
  "minimal",
  "anchored",
  "code",
  "cordis",
];

export interface ResolvedComposeOptions {
  /** Absent means no persistence — session/resume then fails loud. */
  sessionsRoot?: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  preset: HarnessPreset;
  /**
   * Extra pi-ai provider routes (full upstream config shape passed through:
   * apiKeyEnv / baseURL / api / models / compat / …). Absent means the
   * multi-provider adapter is not mounted — DeepSeek rides its own
   * direct-fetch adapter either way. An empty object mounts the adapter with
   * no routes: its catalog and sign-in flows exist from the moment it mounts.
   */
  piProviders?: Record<string, unknown>;
  /**
   * The harness credential file (`dsh-credentials-local`). Present whenever
   * the pi-ai adapter is: a route declaring no apiKeyEnv authenticates through
   * the `llm-pi-ai/<provider>` record a subscription login committed here,
   * and pi-ai refreshes it in place.
   */
  credentialsFile?: string;
}

export interface PluginRow {
  /** Stable id = dsh package short name (package minus the @deepseek-ai/dsh- prefix). */
  id: string;
  package: string;
  description: string;
  /** Core rows keep the runtime coherent and cannot be disabled. */
  core: boolean;
  /** Ids of toggleable rows this row's injected services come from. */
  requires?: string[];
  /** Default config for this row under the resolved options (listing + mount input). */
  config?: Record<string, unknown>;
  /** Curated fields the desktop may edit without exposing arbitrary JSON. */
  configurable?: PluginConfigField[];
  /** Mounts the row; `config` is the effective (override-merged) config. */
  mount: (
    ctx: Context,
    config: Record<string, unknown> | undefined,
  ) => Promise<unknown>;
}

export interface PluginConfigField {
  key: string;
  type: "number" | "url";
  minimum?: number;
}

function core(
  id: string,
  pkg: string,
  description: string,
  mount: PluginRow["mount"],
  config?: Record<string, unknown>,
  configurable?: PluginConfigField[],
): PluginRow {
  return {
    id,
    package: pkg,
    description,
    core: true,
    config,
    configurable,
    mount,
  };
}

function tool(
  id: string,
  pkg: string,
  description: string,
  mount: PluginRow["mount"],
  config?: Record<string, unknown>,
  requires?: string[],
  configurable?: PluginConfigField[],
): PluginRow {
  return {
    id,
    package: pkg,
    description,
    core: false,
    config,
    requires,
    configurable,
    mount,
  };
}

/** The composition for one preset, in mount order. */
export function pluginRows(options: ResolvedComposeOptions): PluginRow[] {
  const { preset, permissionMode, workspaceRoot } = options;
  const rows: PluginRow[] = [
    core(
      "llm",
      "@deepseek-ai/dsh-llm",
      "LLM runtime: adapter registry, model resolution, streaming",
      async (ctx, config) => ctx.plugin(LlmRuntime, config as never),
    ),
    core(
      "session",
      "@deepseek-ai/dsh-session",
      "Append-only session event log (model-visible ⟺ recorded)",
      async (ctx, config) => ctx.plugin(SessionStore, config as never),
    ),
    // Since dsh 0.1.2 the agent loop, sandbox policy and permission presets all
    // inject the projection registry (per-session derived views); without it
    // no agent factory ever registers and every session/new fails loud.
    core(
      "session-projection",
      "@deepseek-ai/dsh-session-projection",
      "Session projection registry (derived per-session views)",
      async (ctx, config) => ctx.plugin(SessionProjectionRegistry, config as never),
    ),
    // The anchored preset's phase 1 is persona-only, so the persona must be the
    // exact Minimal one-liner (dsh-persona is an agent-scope shadow and collides
    // process-wide; configuring the prompt runtime directly is the host-plane way).
    core(
      "system-prompt",
      "@deepseek-ai/dsh-system-prompt",
      "System prompt assembly (persona + tool sections)",
      async (ctx, config) => ctx.plugin(SystemPrompt, config as never),
      preset === "anchored"
        ? { persona: "You are a helpful software engineer assistant." }
        : preset === "cordis"
          ? { persona: CORDIS_PERSONA }
          : undefined,
    ),
    // Context-global presentation is the tools row's `mode` field (presentAs is
    // the per-agent-scope variant used by dsh's preset realms).
    core(
      "tools",
      "@deepseek-ai/dsh-tools",
      "Tool runtime: schema registry, dispatch, presentation mode",
      async (ctx, config) => ctx.plugin(ToolRuntime, config as never),
      preset === "code" ? { mode: "ptc" } : undefined,
    ),
    core(
      "agent",
      "@deepseek-ai/dsh-agent",
      "Agent registry (definitions and scopes)",
      async (ctx, config) => ctx.plugin(AgentRegistry, config as never),
    ),
    core(
      "agent-loop",
      "@deepseek-ai/dsh-agent-loop",
      "The turn loop: prompt → model → tools → settlement",
      async (ctx, config) => ctx.plugin(AgentLoop, config as never),
      { agents: [], maxParallelToolCalls: 10 },
      [{ key: "maxParallelToolCalls", type: "number", minimum: 1 }],
    ),
    core(
      "llm-deepseek",
      "@deepseek-ai/dsh-llm-deepseek",
      "DeepSeek model adapter ($DEEPSEEK_API_KEY)",
      async (ctx, config) => ctx.plugin(LlmDeepseek, config as never),
    ),
  ];
  if (options.credentialsFile !== undefined) {
    // The credential plane the pi-ai adapter signs into and reads from:
    // records (`llm-pi-ai/<provider>` grants) live in this private file, and
    // the authorization registry is where the adapter offers its logins.
    // `watch` stays on in the server: the login CLI is a separate process
    // writing the same file, and a fresh grant must reach a running session.
    rows.push(
      core(
        "credentials-local",
        "@deepseek-ai/dsh-credentials-local",
        "Local credential store (subscription grants, API keys)",
        async (ctx, config) => ctx.plugin(LocalCredentialProvider, config as never),
        { path: options.credentialsFile },
      ),
      core(
        "authorization",
        "@deepseek-ai/dsh-authorization",
        "Authorization flow registry (provider sign-ins)",
        async (ctx, config) => ctx.plugin(AuthorizationService, config as never),
      ),
    );
  }
  if (options.piProviders !== undefined) {
    rows.push(
      core(
        "llm-pi-ai",
        "@deepseek-ai/dsh-llm-pi-ai",
        "Multi-provider adapter (pi-ai catalog: openai / anthropic / google / …)",
        async (ctx, config) => ctx.plugin(LlmPiAi, config as never),
        { providers: options.piProviders },
      ),
    );
  }
  if (options.sessionsRoot !== undefined) {
    rows.push(
      core(
        "session-persistence-jsonl",
        "@deepseek-ai/dsh-session-persistence-jsonl",
        "JSONL session logs (session/resume source)",
        async (ctx, config) =>
          ctx.plugin(JsonlSessionPersistence, config as never),
        { root: options.sessionsRoot },
      ),
    );
  }
  rows.push(
    // Execution world, sandbox-first as in dsh's shipped base bundle: commands
    // run inside the OS sandbox; a denial asks the user only when the model
    // escalates with sandbox_permissions. Configs mirror the bundle rows.
    core(
      "subprocess-local",
      "@deepseek-ai/dsh-subprocess-local",
      "Local subprocess runtime",
      async (ctx, config) =>
        ctx.plugin(LocalSubprocessRuntime, config as never),
    ),
    core(
      "sandbox-local",
      "@deepseek-ai/dsh-sandbox-local",
      "OS sandbox provider (seatbelt on macOS)",
      async (ctx, config) => ctx.plugin(LocalSandboxProvider, config as never),
    ),
    core(
      "sandbox-policy",
      "@deepseek-ai/dsh-sandbox-policy",
      "Sandbox policy (mode + workspace root)",
      async (ctx, config) => ctx.plugin(SandboxPolicyService, config as never),
      { mode: permissionMode, workspaceRoot },
    ),
    core(
      "bash-sandbox",
      "@deepseek-ai/dsh-bash-sandbox",
      "Sandboxed bash executor",
      async (ctx, config) => ctx.plugin(SandboxBashExecutor, config as never),
      { timeoutMs: 60000, maxOutputBytes: 64000 },
      [
        { key: "timeoutMs", type: "number", minimum: 1 },
        { key: "maxOutputBytes", type: "number", minimum: 1 },
      ],
    ),
    core(
      "fs-sandbox",
      "@deepseek-ai/dsh-fs-sandbox",
      "Sandbox-policied filesystem service",
      async (ctx, config) => ctx.plugin(SandboxedFileSystem, config as never),
    ),
    core(
      "jobs-local",
      "@deepseek-ai/dsh-jobs-local",
      "Local background job registry",
      async (ctx, config) => ctx.plugin(LocalJobRegistry, config as never),
    ),
    core(
      "shell-env",
      "@deepseek-ai/dsh-shell-env",
      "Shell environment capture for subprocesses",
      async (ctx, config) => ctx.plugin(ShellEnv, config as never),
    ),
    core(
      "fs-observation-policy",
      "@deepseek-ai/dsh-fs-observation-policy",
      "Read-before-write observation policy",
      async (ctx, config) => ctx.plugin(FsObservationPolicy, config as never),
    ),
    // One-shot approvals ('ask' pairs with read-only/workspace-write presets);
    // the ACP bridge answers them over the wire.
    core(
      "user-approval",
      "@deepseek-ai/dsh-user-approval",
      "One-shot escalation approvals (bridged over ACP)",
      async (ctx, config) => ctx.plugin(ApprovalService, config as never),
      { policy: permissionMode === "danger-full-access" ? "never" : "ask" },
    ),
    core(
      "permission-presets",
      "@deepseek-ai/dsh-permission-presets",
      "Named permission presets (sandbox × approval)",
      async (ctx, config) =>
        ctx.plugin(PermissionPresetService, config as never),
      {
        presets: {
          "read-only": { sandbox: "read-only", approval: "ask" },
          "workspace-write": { sandbox: "workspace-write", approval: "ask" },
          "danger-full-access": {
            sandbox: "danger-full-access",
            approval: "never",
          },
        },
      },
    ),
  );
  // Model-facing tools per preset (configs mirror dsh's shipped rows).
  const terminalTrio: PluginRow[] = [
    tool(
      "terminal",
      "@deepseek-ai/dsh-terminal",
      "Persistent terminal session service",
      async (ctx, config) =>
        ctx.plugin(TerminalSessionService, config as never),
    ),
    tool(
      "terminal-bash",
      "@deepseek-ai/dsh-terminal-bash",
      "Bash over the persistent terminal",
      async (ctx, config) => ctx.plugin(TerminalBash, config as never),
      undefined,
      ["terminal"],
    ),
    tool(
      "tool-bash-persistent",
      "@deepseek-ai/dsh-tool-bash-persistent",
      "bash tool (persistent shell)",
      async (ctx, config) => ctx.plugin(ToolBashPersistent, config as never),
      undefined,
      ["terminal", "terminal-bash"],
    ),
    tool(
      "tool-str-replace-editor",
      "@deepseek-ai/dsh-tool-str-replace-editor",
      "str_replace_editor tool (view/create/str_replace)",
      async (ctx, config) => ctx.plugin(ToolStrReplaceEditor, config as never),
      { maxOutputChars: 16000 },
    ),
  ];
  const codingTools: PluginRow[] = [
    tool(
      "tool-fs",
      "@deepseek-ai/dsh-tool-fs",
      "read / write / edit file tools",
      async (ctx, config) => ctx.plugin(ToolFs, config as never),
    ),
    tool(
      "tool-fs-search",
      "@deepseek-ai/dsh-tool-fs-search",
      "glob / grep search tools",
      async (ctx, config) => ctx.plugin(ToolFsSearch, config as never),
      { sampleOverCapGlobResults: false },
    ),
    tool(
      "tool-todo",
      "@deepseek-ai/dsh-tool-todo",
      "todo_write plan tool",
      async (ctx, config) => ctx.plugin(ToolTodo, config as never),
      { allowParallelInProgress: true },
    ),
    // Web search rides the same DeepSeek key; fetch stays off as in the
    // shipped bundle (tool-web { fetch: false }).
    tool(
      "web",
      "@deepseek-ai/dsh-web",
      "Web runtime (search provider registry)",
      async (ctx, config) => ctx.plugin(WebRuntime, config as never),
      { searchProvider: "deepseek-official" },
    ),
    tool(
      "web-search-deepseek",
      "@deepseek-ai/dsh-web-search-deepseek",
      "DeepSeek official web search provider",
      async (ctx, config) => ctx.plugin(WebSearchDeepseek, config as never),
      {
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseURL: "https://api.deepseek.com/anthropic/v1",
        maxUses: 5,
      },
      ["web"],
      [
        { key: "baseURL", type: "url" },
        { key: "maxUses", type: "number", minimum: 1 },
      ],
    ),
    tool(
      "tool-web",
      "@deepseek-ai/dsh-tool-web",
      "web_search tool",
      async (ctx, config) => ctx.plugin(ToolWeb, config as never),
      { fetch: false, searchTimeoutMs: 60000 },
      ["web", "web-search-deepseek"],
    ),
  ];
  if (preset === "minimal") {
    // dsh's minimal preset: a two-tool coding agent — persistent bash + str_replace_editor.
    rows.push(...terminalTrio);
  } else if (preset === "anchored") {
    // Community "anchored standard" (dsh-liangshen / xiaobright): the FIRST
    // model request sees only the Minimal two-tool surface plus a one-line
    // persona (DeepSeek V4 Pro conditions its trajectory on the first-request
    // tool catalog: Minimal 99/96 vs Standard 91/92 in the community eval);
    // after the anchor the full native catalog and prompt sections open.
    rows.push(
      ...terminalTrio, // registers "bash"; the ephemeral tool-bash stays out (name collision)
      ...codingTools,
      tool(
        "anchored-tool-bootstrap",
        "dsh-liangshen (vendored)",
        "Anchored two-phase tool bootstrap",
        async (ctx, config) =>
          ctx.plugin(AnchoredToolBootstrap, config as never),
        {
          shellTools: ["bash"],
          commonTools: ["str_replace_editor"],
          messageSources: ["user"],
          anchorGate: true,
          maxBootstrapSteps: 4,
          promoteAfterFirstResponse: true,
          bootstrapMaxTokens: 1024,
          compactionTools: [
            "read",
            "write",
            "edit",
            "glob",
            "grep",
            "todo_write",
          ],
          deferredSources: [],
        },
      ),
    );
  } else {
    // standard, code, cordis share the coding-agent tool surface.
    rows.push(
      tool(
        "tool-bash",
        "@deepseek-ai/dsh-tool-bash",
        "bash tool (ephemeral, sandboxed)",
        async (ctx, config) => ctx.plugin(ToolBash, config as never),
      ),
      ...codingTools,
    );
    if (preset === "code") {
      // Code Mode presentation backed by the official worker runtime
      // (Bun-patched: amaro strip + null stdio, see patches/).
      rows.push(
        tool(
          "code-runtime-worker-thread",
          "@deepseek-ai/dsh-code-runtime-worker-thread",
          "Code Mode worker runtime (run_code)",
          async (ctx, config) => ctx.plugin(CodeRuntimeWorker, config as never),
        ),
      );
    }
    if (preset === "cordis") {
      // dsh's creator preset: the self-referential Cordis toolset (define /
      // run / inspect model-written plugins in a node:vm realm). Trust
      // boundary, not a sandbox — mirrors the preset's own header.
      rows.push(
        tool(
          "cordis-host-runner",
          "@deepseek-ai/dsh-cordis-host-runner",
          "node:vm realm host for model-written plugins",
          async (ctx, config) => ctx.plugin(CordisHostRunner, config as never),
        ),
        tool(
          "tool-cordis",
          "@deepseek-ai/dsh-tool-cordis",
          "cordis_define / cordis_run / cordis_inspect tools",
          async (ctx, config) => ctx.plugin(ToolCordis, config as never),
          undefined,
          ["cordis-host-runner"],
        ),
        // The composition-authoring skill travels with the preset (mirrors
        // dsh's shipped cordis preset): registry + filesystem provider over
        // the bundled skills/ dir + the skill tool the model calls.
        tool(
          "skill",
          "@deepseek-ai/dsh-skill",
          "Skill registry (session skill catalog)",
          async (ctx, config) => ctx.plugin(SkillRegistry, config as never),
        ),
        tool(
          "skill-filesystem",
          "@deepseek-ai/dsh-skill-filesystem",
          "Filesystem skill provider (bundled skills/)",
          async (ctx, config) => ctx.plugin(SkillFilesystem, config as never),
          { customSkillDirs: [BUNDLED_SKILLS_DIR] },
          ["skill"],
        ),
        tool(
          "tool-skill",
          "@deepseek-ai/dsh-tool-skill",
          "skill tool (load bundled skill instructions)",
          async (ctx, config) => ctx.plugin(ToolSkill, config as never),
          undefined,
          ["skill"],
        ),
      );
    }
  }
  return rows;
}

/** Every id any preset can compose — the vocabulary the overrides file may reference. */
export function allPluginIds(): Set<string> {
  const ids = new Set<string>();
  for (const preset of HARNESS_PRESETS) {
    for (const row of pluginRows({
      sessionsRoot: "/",
      workspaceRoot: "/",
      permissionMode: "workspace-write",
      preset,
    })) {
      ids.add(row.id);
    }
  }
  return ids;
}

/** User overrides: hand-editable, also written by the `plugins` CLI. */
export interface PluginOverrides {
  disabled?: string[];
  /** Shallow-merged over the row's default config. */
  config?: Record<string, Record<string, unknown>>;
}

export function loadPluginOverrides(file: string): PluginOverrides {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `plugin overrides file ${file} is not valid JSON: ${String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`plugin overrides file ${file} must contain a JSON object`);
  }
  const overrides = parsed as PluginOverrides;
  if (
    overrides.disabled !== undefined &&
    !(
      Array.isArray(overrides.disabled) &&
      overrides.disabled.every((id) => typeof id === "string")
    )
  ) {
    throw new Error(
      `plugin overrides file ${file}: "disabled" must be an array of plugin ids`,
    );
  }
  if (
    overrides.config !== undefined &&
    (typeof overrides.config !== "object" ||
      overrides.config === null ||
      Array.isArray(overrides.config))
  ) {
    throw new Error(
      `plugin overrides file ${file}: "config" must be an object keyed by plugin id`,
    );
  }
  return { disabled: overrides.disabled, config: overrides.config };
}

export function savePluginOverrides(
  file: string,
  overrides: PluginOverrides,
): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(overrides, null, 2)}\n`);
}

/** One row of the resolved composition as the host UI sees it. */
export interface PluginListing {
  id: string;
  package: string;
  description: string;
  core: boolean;
  enabled: boolean;
  requires?: string[];
  config?: Record<string, unknown>;
  /** Composition-owned values before user overrides. */
  defaultConfig?: Record<string, unknown>;
  /** User-owned values only; absent keys inherit the composition default. */
  overrideConfig?: Record<string, unknown>;
  configurable?: PluginConfigField[];
}

export interface ResolvedPlugins {
  /** Rows to mount, in order, with effective configs. */
  mounted: Array<{
    row: PluginRow;
    config: Record<string, unknown> | undefined;
  }>;
  /** Every row of the preset (enabled and disabled) for listing. */
  listing: PluginListing[];
}

/**
 * Applies overrides to a preset's rows. Fails loud on: unknown ids, disabling
 * a core row, and disabling a row another enabled row `requires` (cordis would
 * hang the dependent mount instead of erroring).
 */
export function resolvePlugins(
  rows: PluginRow[],
  overrides: PluginOverrides,
): ResolvedPlugins {
  const known = allPluginIds();
  for (const id of overrides.disabled ?? []) {
    if (!known.has(id))
      throw new Error(
        `unknown plugin id "${id}" in overrides (known: ${[...known].sort().join(", ")})`,
      );
  }
  for (const id of Object.keys(overrides.config ?? {})) {
    if (!known.has(id))
      throw new Error(
        `unknown plugin id "${id}" in overrides config (known: ${[...known].sort().join(", ")})`,
      );
  }
  const disabled = new Set(overrides.disabled ?? []);
  for (const row of rows) {
    if (row.core && disabled.has(row.id)) {
      throw new Error(
        `plugin "${row.id}" is a core row and cannot be disabled`,
      );
    }
  }
  const presentIds = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    if (disabled.has(row.id)) continue;
    for (const dependency of row.requires ?? []) {
      if (disabled.has(dependency) || !presentIds.has(dependency)) {
        throw new Error(
          `plugin "${row.id}" requires "${dependency}"; disable "${row.id}" too or re-enable "${dependency}"`,
        );
      }
    }
  }
  const effectiveConfig = (
    row: PluginRow,
  ): Record<string, unknown> | undefined => {
    const override = overrides.config?.[row.id];
    if (override === undefined) return row.config;
    return { ...row.config, ...override };
  };
  return {
    mounted: rows
      .filter((row) => !disabled.has(row.id))
      .map((row) => ({ row, config: effectiveConfig(row) })),
    listing: rows.map((row) => ({
      id: row.id,
      package: row.package,
      description: row.description,
      core: row.core,
      enabled: !disabled.has(row.id),
      requires: row.requires,
      config: effectiveConfig(row),
      defaultConfig: row.config,
      overrideConfig: overrides.config?.[row.id],
      configurable: row.configurable,
    })),
  };
}
