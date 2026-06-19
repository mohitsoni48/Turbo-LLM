/**
 * Utilities for handling <think>...</think> blocks in model output (BUG-001).
 * Kept in a separate module so they can be unit-tested without importing Hono.
 */

/**
 * Strip all <think>...</think> blocks (case-insensitive, multiline) from `text`.
 * Returns the remaining string (may be empty / whitespace-only).
 */
export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '')
}

/**
 * Return true when the accumulated assistant content contains no visible text
 * after stripping <think> blocks — i.e. an extra inference pass is needed.
 */
export function needsExtraPass(content: string): boolean {
  return stripThinkingBlocks(content).trim() === ''
}
