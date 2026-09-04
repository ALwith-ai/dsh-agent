/**
 * `sessions` subcommand: session-log inspection for hosts without a live
 * bridge (`bun src/main.ts sessions list --json`). Reads through dsh's own
 * persistence backend — the on-disk format (zstd JSONL) stays private to it.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import SessionStore from "@deepseek-ai/dsh-session"
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"
import type {} from "@deepseek-ai/dsh-session-persistence"

function defaultSessionsRoot(): string {
  return process.env.ALWITH_DSH_SESSIONS_ROOT ?? join(homedir(), ".dsh-agent", "sessions")
}

interface CliFlags {
  root: string
  positional: string[]
}

function parseFlags(argv: string[]): CliFlags {
  let root = defaultSessionsRoot()
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === "--root") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--root requires a value")
      root = value
      index += 1
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown flag ${argument}`)
    } else {
      positional.push(argument)
    }
  }
  return { root, positional }
}

type Persistence = NonNullable<Context["sessionPersistence"]>

async function withPersistence<T>(root: string, run: (persistence: Persistence) => Promise<T>): Promise<T> {
  const ctx = new Context()
  // The jsonl plugin is a backend; the coordinator that publishes
  // ctx.sessionPersistence rides the session store.
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root })
  const persistence = ctx.get("sessionPersistence")
  if (persistence === undefined) throw new Error("session persistence failed to mount")
  try {
    return await run(persistence)
  } finally {
    await ctx.fiber.dispose()
  }
}

export async function runSessionsCli(argv: string[]): Promise<void> {
  const { root, positional } = parseFlags(argv)
  const [command, ...rest] = positional
  if (command === "list") {
    const headers = await withPersistence(root, persistence => persistence.list())
    const sessions = [...headers]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(header => ({ id: header.id, createdAt: header.createdAt, cwd: header.cwd, parentSession: header.parentSession }))
    process.stdout.write(`${JSON.stringify({ root, sessions })}\n`)
    return
  }
  if (command === "show") {
    const [id] = rest
    if (id === undefined) throw new Error("usage: sessions show <sessionId> [--root <dir>]")
    const inspection = await withPersistence(root, persistence => persistence.inspect(id as never))
    process.stdout.write(`${JSON.stringify({ root, meta: inspection.meta, events: inspection.events })}\n`)
    return
  }
  throw new Error(`unknown sessions command "${command ?? ""}": expected list or show`)
}
