export interface MessageStats {
  promptTokens: number
  promptMs: number
  promptTps: number
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

export interface Message {
  id: string
  convId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  attachments: string[]
  stats: Partial<MessageStats>
  createdAt: string
}

export interface Conversation {
  id: string
  title: string
  systemPrompt: string
  modelKey: string
  sampling: Record<string, number>
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
  | { event: 'done';      data: { message: Message } }
  | { event: 'error';     data: { code: string; message: string } }
