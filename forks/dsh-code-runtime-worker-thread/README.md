# @nyssance/dsh-code-runtime-worker-thread (fork)

Upstream `@deepseek-ai/dsh-code-runtime-worker-thread` strips TypeScript types with
`node:module`'s `stripTypeScriptTypes`, which Bun (1.4 still) does not implement, so
every `run_code` program fails before the worker starts. Upstream accepts no external
PRs (CONTRIBUTING.md) and has issues disabled, so the fix ships as this fork: the exact
upstream npm artifact plus one change — probe the API through the module namespace and
fall back to `amaro`, the library Node itself vendors for that call (same
offset-preserving output). Nothing else differs; the package.json carries `upstream`
provenance (name / version / integrity).

```bash
bun forks/dsh-code-runtime-worker-thread/build.ts        # upstream version from UPSTREAM_VERSION
npm publish forks/dsh-code-runtime-worker-thread/dist/*.tgz --access public
```

Consumers pin the same version string as the upstream family. Bump `UPSTREAM_VERSION`
with every family bump, rebuild, republish. Delete this directory the day upstream ships
the fallback (the same one-line patch is kept at `Vendor/deepseek-harness`
branch `fix/worker-thread-bun-strip-types`).
