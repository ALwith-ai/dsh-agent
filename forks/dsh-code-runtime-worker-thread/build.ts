#!/usr/bin/env bun
/**
 * Fork publisher for @deepseek-ai/dsh-code-runtime-worker-thread.
 *
 * Upstream does not accept external PRs (CONTRIBUTING.md) and its worker strips
 * TypeScript types with `node:module`'s `stripTypeScriptTypes`, which Bun (1.4
 * still) does not implement — every run_code program fails before the worker
 * starts. This script takes the exact upstream npm artifact, applies that one
 * change (fall back to `amaro`, the library Node itself vendors for the call),
 * and repacks it under our scope with the same version. Nothing else differs;
 * the provenance (upstream name / version / integrity) is written into the
 * package.json so a reader can verify the base. Delete this fork the day
 * upstream ships the fallback.
 *
 *   bun forks/dsh-code-runtime-worker-thread/build.ts [upstream-version]
 */
import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const UPSTREAM = "@deepseek-ai/dsh-code-runtime-worker-thread"
const FORK = "@nyssance/dsh-code-runtime-worker-thread"
const AMARO = "^1.1.11"

const root = import.meta.dirname
const version = process.argv[2] ?? readFileSync(join(root, "UPSTREAM_VERSION"), "utf8").trim()
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`upstream version looks wrong: ${version}`)

const work = join(root, ".work")
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
await $`npm pack ${UPSTREAM}@${version} --silent`.cwd(work)
const tarball = (await $`ls ${work}`.text()).trim().split("\n").find(name => name.endsWith(".tgz"))
if (tarball === undefined) throw new Error("npm pack produced no tarball")
const integrity = `sha512-${createHash("sha512").update(readFileSync(join(work, tarball))).digest("base64")}`
await $`tar -xzf ${tarball}`.cwd(work)
const pkg = join(work, "package")

// The one change: feature-detect the Node API, fall back to amaro under Bun.
const entry = join(pkg, "lib", "index.js")
let source = readFileSync(entry, "utf8")
const importLine = 'import { stripTypeScriptTypes } from "node:module";\n'
if (source.split(importLine).length !== 2) throw new Error(`upstream entry changed: expected exactly one ${JSON.stringify(importLine)}`)
source = source.replace(
  importLine,
  '// FORK (@nyssance): Bun has no node:module.stripTypeScriptTypes and rejects a named\n' +
    "// import of a missing export at link time, so detect through the namespace; amaro is\n" +
    "// the library Node vendors for this exact call, same offset-preserving output.\n" +
    'import * as nodeModule from "node:module";\n' +
    "const stripTypeScriptTypes = typeof nodeModule.stripTypeScriptTypes === \"function\"\n" +
    "\t? (source) => nodeModule.stripTypeScriptTypes(source)\n" +
    "\t: await import(\"amaro\").then(({ transformSync }) => (source) => transformSync(source).code);\n",
)
writeFileSync(entry, source)

const manifestPath = join(pkg, "package.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
if (manifest.name !== UPSTREAM || manifest.version !== version) throw new Error("upstream manifest mismatch")
manifest.name = FORK
manifest.description = `${String(manifest.description ?? "")} (fork: strips TypeScript types via amaro under Bun)`.trim()
manifest.dependencies = { ...(manifest.dependencies as Record<string, string>), amaro: AMARO }
manifest.upstream = { name: UPSTREAM, version, integrity, patch: "lib/index.js: stripTypeScriptTypes → amaro fallback under Bun" }
manifest.repository = { type: "git", url: "https://github.com/ALwith-ai/alwith-dsh.git", directory: "forks/dsh-code-runtime-worker-thread" }
delete manifest.publishConfig
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const dist = join(root, "dist")
mkdirSync(dist, { recursive: true })
for (const stale of (await $`ls ${dist}`.text()).trim().split("\n").filter(Boolean)) rmSync(join(dist, stale))
const out = join(dist, `nyssance-dsh-code-runtime-worker-thread-${version}.tgz`)
await $`bun pm pack --ignore-scripts --filename ${out}`.cwd(pkg)
if (!existsSync(out)) throw new Error("bun pm pack produced no tarball")
rmSync(work, { recursive: true, force: true })
console.log(`${FORK}@${version} ← ${UPSTREAM}@${version} (${integrity.slice(0, 24)}…)\n${out}`)
