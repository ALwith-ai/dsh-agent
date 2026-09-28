/** Bun pack excludes bun.lock; restore the pinned runtime lock in the publishable tarball. */
import { $ } from "bun"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
const root = resolve(import.meta.dirname, "..")
const destination = resolve(process.argv[2] ?? join(root, "dist.tgz"))
const work = mkdtempSync(join(tmpdir(), "dsh-pack-"))
try {
  await $`bun pm pack --ignore-scripts --filename ${join(work, "source.tgz")}`.cwd(root).quiet()
  await $`tar -xzf ${join(work, "source.tgz")} -C ${work}`.quiet()
  copyFileSync(join(root, "bun.lock"), join(work, "package/bun.lock"))
  mkdirSync(dirname(destination), { recursive: true })
  await $`tar -czf ${destination} -C ${work} package`.quiet()
  console.log(destination)
} finally {
  rmSync(work, { recursive: true, force: true })
}
