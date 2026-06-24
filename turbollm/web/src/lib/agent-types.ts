export type AgentRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface AgentRun {
  id: string
  convId: string
  title: string
  status: AgentRunStatus
  allowedTools: string[]
  error?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  endedAt?: string
  messages?: AgentMessage[]
}

export interface AgentToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  result: string
}

export interface AgentMessage {
  id: string
  convId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  toolCalls?: AgentToolCall[]
  createdAt: string
}

export interface AgentSseEvent {
  seq: number
  event: string
  data: unknown
}
