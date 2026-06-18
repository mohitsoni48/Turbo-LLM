export interface MessageStats {
  promptTokens: number
  promptMs: number
  promptTps: number
  cachedTokens: number
  genTokens: number
  genMs: number
  tps: number
  ttftMs: number
  totalMs: number
  thinkMs: number
  ctxUsed: number
  ctxMax: number
  model: string
  aborted: boolean
}

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  error?: string
}

export interface LiveToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'pending' | 'done' | 'error'
  result?: string
}

export interface Message {
  id: string
  convId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  attachments: string[]
  textAttachments: string[]
  toolCalls: ToolCallRecord[]
  stats: Partial<MessageStats>
  createdAt: string
}

export interface Conversation {
  id: string
  title: string
  systemPrompt: string
  modelKey: string
  sampling: Record<string, number>
  /** Built-in TurboLLM Expert thread — its system prompt is managed server-side
   *  and hidden from the UI (spec 08 §2). */
  expertMode: boolean
  createdAt: string
  updatedAt: string
  messages?: Message[]
}

// SSE event payloads
export type ChatSseEvent =
  | { event: 'meta';      data: { userMessageId: string; assistantMessageId: string } }
  | { event: 'progress';  data: { phase: string; processed: number; total: number; pct: number; tps: number } }
  | { event: 'reasoning'; data: { delta: string } }
  | { event: 'delta';     data: { delta: string } }
  | { event: 'tool_call'; data: { id: string; name: string; args: Record<string, unknown>; status: 'pending' | 'done' | 'error'; result?: string } }
  | { event: 'done';      data: { message: Message } }
  | { event: 'error';     data: { code: string; message: string } }
