# dsh-agent

English | [中文](README.zh.md)

An **interactive ACP v2 bridge** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): exposes a dsh agent as a chat backend that desktop/editor clients can host — token-level streaming, run-state reporting (`state_update`), permission bridging, and cancellation. Ships as an out-of-tree plugin: no fork of dsh, dependencies pinned to exact npm versions.

Maintained by [ALwith](https://github.com/ALwith-ai); **ALwith Desktop is its reference client** (the desktop form of dsh). Upstream's own ACP surface is deliberately automation-only (fresh sessions, committed output only); this bridge provides the interactive side.

> Status: developer preview. Covers `session/new` + prompt + streaming + run-state reporting + cancel + `session/resume` (live-first reattach, cold resume from JSONL persistence, client-driven `replayFrom` history replay) + sandbox-first tools with escalation approvals + in-session model switching (`session/set_config_option`) + LLM session titles (deterministic first, one background generate upgrades) + all dsh presets (`standard` / `minimal` / `anchored` / `code` PTC on the Bun-patched official worker runtime / `cordis` creator with the vm-realm dynamic-plugin toolset and the bundled `cordis-plugin-development` skill) + host-facing `plugins` / `sessions` management CLIs + a multi-provider seat (`ALWITH_DSH_PI_PROVIDERS`: pi-ai catalog routes — openai / anthropic / google / xai / … — mounted beside the DeepSeek adapter).

## Layout

| File | Responsibility |
|---|---|
| `src/bridge.ts` | ACP v2 server plugin (adapted from upstream's automation-only v1 bridge, MIT) |
| `src/codec.ts` | Pure wire-format translation (adapted from the upstream codec) |
| `src/plugins.ts` | Plugin manifest: the composition as data (per-preset roster, core protection, overrides) |
| `src/compose.ts` | Composes the runtime from the manifest (no dsh loader/profile — deterministic, runs on Bun) |
| `src/plugins-cli.ts` | `plugins` subcommand: list and toggle plugins without a live session |
| `src/sessions-cli.ts` | `sessions` subcommand: session-log inspection through dsh's own persistence |
| `skills/` | Skills bundled into presets (vendored from dsh's cordis preset, MIT) |
| `src/main.ts` | stdio entry for hosts to spawn |

## Run

Requires Bun (validated with 1.4.0); Node.js is not a supported sidecar runtime. In a repository checkout, install the pinned dependency set with `bun install --frozen-lockfile`.

```sh
DEEPSEEK_API_KEY=… bun src/main.ts   # ACP v2 server over stdio
bun test                              # protocol tests with a mock adapter; no real model calls
```

`session/resume` semantics: an omitted `replayFrom` means context-only restore; `{ type: "start" }` replays the whole conversation as `session/update` frames. Session logs live under `$ALWITH_DSH_SESSIONS_ROOT` (default `~/.dsh-agent/sessions`).

Turn completion, including cancellation, waits for agent convergence and the session durability checkpoint before reporting `idle`. A tool that ignores cancellation can delay this boundary. Prompts arriving while cancellation settles are rejected; an empty prompt during an active turn does not end it. `session/close` drains pending events before releasing the agent and cancels background title work. Model and checkpoint failures report `_error`, so hosts can keep failures actionable.

Model changes are rejected while a prompt, another switch, or unconsumed input (including injected seed history) is pending. Consume seed history with a prompt before switching. Prompts wait for an existing switch; closing the session during it prevents replacement publication. After a failed switch, persisted sessions can be recovered with `session/resume`; an untouched session without a log requires `session/new`.

Cancel and close intentionally discard pending input, including unconsumed seed history. To re-seed from host-kept history, use `session/new`; `session/resume` does not accept `seedHistory`. Adapters must honor abort signals: otherwise cancellation, close and shutdown can stall. The host may enforce a process deadline, but forced termination can lose unflushed log entries and leave truncated history on resume. Background titles are aborted without delaying close. Standard ACP error codes are retained; human-readable error messages are not a stable parsing API.

From a repository checkout, for local artifact verification run `python3 scripts/verify-package.py`. The release and verifier use `npm pack` to include `bun.lock`. The verifier requires the extracted lock to match the repository bytes, records its SHA256, installs production dependencies frozen (network and native build prerequisites may be required), and runs the declared executable through credential-free ACP checks for all five presets. Its watchdogs belong to the verifier, not the bridge. Logs and artifacts are retained at the printed path; install failures remain failures. The `packageManager` field records the validated toolchain; it is not runtime enforcement. The published tarball carries the lock required by Desktop installation. This does not establish cross-platform or real-provider compatibility. The existing pinned set reports Cordis peer warnings (`4.0.1` versus upstream `^4.0.2`); exercised paths pass, but aligning the whole dependency set requires a separate decision and validation.

## Plugins

The composition per preset is fixed here in code (deterministic), but users keep dsh's two degrees of freedom — per-plugin enable/disable and per-plugin config — through an overrides file (`$ALWITH_DSH_PLUGINS_FILE`, default `~/.dsh-agent/plugins.json`), read at spawn so changes apply to new sessions:

```sh
bun src/main.ts plugins list --preset standard   # every row of the preset, JSON
bun src/main.ts plugins set tool-web disabled    # validated before writing
```

```json
{ "disabled": ["tool-web"], "config": { "bash-sandbox": { "timeoutMs": 120000 } } }
```

Core rows (session, llm, sandbox, approvals, …) cannot be disabled, and disabling a row another enabled row `requires` is rejected with the exact fix — both fail loud before anything is written. `config` entries shallow-merge over the row defaults.

## License

[MIT](LICENSE); portions adapted from upstream `@deepseek-ai/dsh-acp` are noted in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
