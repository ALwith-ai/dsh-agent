/** The confined child installs the same Bun pipe adaptation before loading upstream. */
import "./ptc-bun-loader.ts"
await import("@deepseek-ai/dsh-ptc-runtime-node/process")
