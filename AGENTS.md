# AGENTS.md

Conventions for this repository. They apply to every contributor, human or agent.

- **Language**: code comments and commit messages are English only. Documentation ships bilingual: `<doc>.md` is the English authoritative source, `<doc>.zh.md` is its Chinese counterpart — update both together.
- **Dependencies**: every `@deepseek-ai/*` dependency is pinned to an exact version from one consistent upstream release set. Never track `latest` (upstream is in rc with breaking changes and occasionally publishes inconsistent sets); upgrades are deliberate, whole-set moves.
- **Composition is deterministic**: the per-preset roster is fixed in `src/plugins.ts` (mounted by `src/compose.ts`); users only toggle/configure rows through the overrides file. No dsh loader/profile/patch trees, no HMR — the sidecar and PTC execution children must both run on Bun. Do not introduce a Node runtime dependency; adapt missing Bun APIs at the upstream boundary.
- **Wire protocol authority**: the dsh-facing half of the bridge follows upstream `@deepseek-ai/dsh-acp`; the wire-facing half follows the ACP v2 protocol from the SDK's `experimental/v2` subpath, as consumed by ALwith Desktop. When in doubt about a frame shape, verify against the consumer implementation and the v2 schema types, not prose documentation.
- **Checks**: `bun test` and `bunx tsc --noEmit` must pass before pushing.
