/**
 * Pure translation between the ACP wire format and the harness lifecycle.
 * Adapted from @deepseek-ai/dsh-acp's codec (MIT); upstream deliberately
 * removed its interactive ACP surface (automation-only, design note
 * 2026-07-23), so this layer is self-contained rather than importing the
 * upstream package.
 */

import type { ContentBlock as AcpContentBlock, StopReason } from "@agentclientprotocol/sdk/experimental/v2"
import type { TurnEndReason } from "@deepseek-ai/dsh-session"

/** Map a harness turn ending to ACP's terminal reason vocabulary. */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case "completed":
      return "end_turn"
    case "max-tokens":
      return "max_tokens"
    case "aborted":
      return reason.reason.kind === "user" || reason.reason.kind === "disposed" ? "cancelled" : "end_turn"
    // Persistence synthesizes this marker for a crash-orphaned turn.
    case "interrupted":
      return "cancelled"
    case "blocked":
    case "error":
      return "end_turn"
    default:
      return "end_turn"
  }
}

// The v2 unions carry an open fallback variant ({ type: string; [key: string]: unknown }),
// so a `case` switch cannot narrow them — take variants with Extract instead.
type BlockVariant<K extends string> = Extract<AcpContentBlock, { type: K }>

/** Flatten baseline ACP prompt blocks to text; resource links become explicit textual references. */
export function acpPromptToText(prompt: readonly AcpContentBlock[]): string {
  return prompt
    .flatMap((block): string[] => {
      if (block.type === "text") return [(block as BlockVariant<"text">).text]
      if (block.type === "resource_link") {
        const link = block as BlockVariant<"resource_link">
        return [`\n[resource_link name=${JSON.stringify(link.name)} uri=${JSON.stringify(link.uri)}]\n`]
      }
      return []
    })
    .join("")
}

/** Whether the prompt carries content beyond the baseline (text / resource_link). */
export function promptHasUnsupportedContent(prompt: readonly AcpContentBlock[]): boolean {
  return prompt.some(block => block.type !== "text" && block.type !== "resource_link")
}
