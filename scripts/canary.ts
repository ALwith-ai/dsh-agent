// Canary: move every @deepseek-ai/* dependency to the version its npm dist-tag (default `next`) points at,
// so CI shows what the next dsh release breaks before we adopt it. Rewrites package.json in place; run it in
// a throwaway checkout (CI) and follow with a non-frozen `bun install`, typecheck and tests.
//   bun scripts/canary.ts [dist-tag]
import { readFileSync, writeFileSync } from "node:fs"
import { $ } from "bun"

const tag = process.argv[2] ?? "next"
const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> }
const names = Object.keys(manifest.dependencies).filter(name => name.startsWith("@deepseek-ai/"))
const moved: string[] = []
const missing: string[] = []
await Promise.all(
  names.map(async name => {
    const tags = JSON.parse(await $`npm view ${name} dist-tags --json`.text()) as Record<string, string>
    const version = tags[tag]
    if (version === undefined) {
      missing.push(name)
      return
    }
    // A dist-tag can lag behind what we already pin (cordis `next` sat below the pinned stable); never move backwards.
    if (Bun.semver.order(version, manifest.dependencies[name]) <= 0) return
    moved.push(`${name} ${manifest.dependencies[name]} -> ${version}`)
    manifest.dependencies[name] = version
  }),
)
writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`dist-tag ${tag}: ${moved.length} moved, ${names.length - moved.length - missing.length} unchanged, ${missing.length} without the tag`)
for (const line of moved.sort()) console.log(`  ${line}`)
if (missing.length > 0) console.log(`  kept (no ${tag} tag): ${missing.sort().join(", ")}`)
