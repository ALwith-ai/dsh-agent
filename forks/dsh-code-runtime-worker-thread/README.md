# @nyssance/dsh-code-runtime-worker-thread (fork)

Upstream `@deepseek-ai/dsh-code-runtime-worker-thread` strips TypeScript types with
`node:module`'s `stripTypeScriptTypes`, which Bun (1.4 still) does not implement, so
every `run_code` program fails before the worker starts. Upstream accepts no external
PRs (CONTRIBUTING.md) and has issues disabled, so the fix ships as this fork: the exact
upstream npm artifact plus one change — probe the API through the module namespace and
fall back to `amaro`, the library Node itself vendors for that call (same
offset-preserving output). Nothing else differs; the package.json carries `upstream`
provenance (name / version / integrity).

Publishing is CI-only (`.github/workflows/publish-worker-thread-fork.yml`, manual run;
it rebuilds from the upstream artifact, refuses an already-published version, and publishes
with provenance using the repository's `NPM_TOKEN` secret). Local build for inspection:

```bash
bun forks/dsh-code-runtime-worker-thread/build.ts        # upstream version from UPSTREAM_VERSION
```

Consumers pin the same version string as the upstream family. Bump `UPSTREAM_VERSION`
with every family bump, rebuild, republish. Delete this directory the day upstream ships
the fallback (the same one-line patch is kept at `Vendor/deepseek-harness`
branch `fix/worker-thread-bun-strip-types`).
