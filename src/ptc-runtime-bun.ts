/** Keep both the official PTC host and its confined child on Bun. */
import "./ptc-bun-loader.ts"
import { fileURLToPath } from "node:url"
import type { Context } from "@deepseek-ai/cordis"
import type { Config } from "@deepseek-ai/dsh-ptc-runtime-node"
const { default: PtcRuntime } = await import("@deepseek-ai/dsh-ptc-runtime-node")

export default class BunPtcRuntime extends PtcRuntime {
  constructor(ctx: Context, config: Config) {
    super(ctx, {
      ...config,
      nodeExecutable: process.execPath,
      bootstrapPath: fileURLToPath(new URL("./ptc-process-bun.ts", import.meta.url)),
    })
  }
}
