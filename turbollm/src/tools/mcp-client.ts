// MCP host/client (v0.7.0). Implements stdio (subprocess JSON-RPC) and SSE (HTTP)
// transports per the MCP 2024-11-05 specification.
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

// ── MCP protocol types ────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

// ── Base client interface ─────────────────────────────────────────────────

export interface IMcpClient {
  readonly serverId: string
  readonly serverName: string
  connect(): Promise<void>
  disconnect(): void
  listTools(): Promise<McpTool[]>
  callTool(name: string, args: Record<string, unknown>): Promise<string>
}

// ── Stdio client ──────────────────────────────────────────────────────────

export class StdioMcpClient implements IMcpClient {
  readonly serverId: string
  readonly serverName: string
  private command: string
  private args: string[]
  private env: Record<string, string>
  private proc: ChildProcess | null = null
  private pending = new Map<string | number, { resolve: (r: JsonRpcResponse) => void }>()
  private buf = ''
  private msgId = 0
  private initialized = false

  constructor(opts: { id: string; name: string; command: string; args?: string[]; env?: Record<string, string> }) {
    this.serverId = opts.id
    this.serverName = opts.name
    this.command = opts.command
    this.args = opts.args ?? []
    this.env = opts.env ?? {}
  }

  async connect(): Promise<void> {
    if (this.proc) return
    this.proc = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8')
      const lines = this.buf.split('\n')
      this.buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification
          if ('id' in msg && msg.id != null) {
            const pending = this.pending.get(msg.id)
            if (pending) {
              this.pending.delete(msg.id)
              pending.resolve(msg as JsonRpcResponse)
            }
          }
        } catch { /* ignore parse errors */ }
      }
    })

    this.proc.on('error', () => this.cleanup())
    this.proc.on('exit', () => this.cleanup())

    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'turbollm', version: '0.7.0' },
    })
    await this.sendNotification('notifications/initialized', {})
    this.initialized = true
  }

  disconnect(): void {
    this.cleanup()
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) await this.connect()
    const result = await this.sendRequest('tools/list', {}) as { tools?: McpTool[] }
    return result.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.initialized) await this.connect()
    const result = await this.sendRequest('tools/call', { name, arguments: args }) as McpCallResult
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n')
    return result.isError ? `Error: ${text}` : (text || '(no output)')
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.msgId
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timeout: ${method}`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer)
          if (r.error) reject(new Error(r.error.message))
          else resolve(r.result)
        },
      })
      this.write(req)
    })
  }

  private sendNotification(method: string, params: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.write(msg)
  }

  private write(msg: unknown): void {
    if (!this.proc?.stdin?.writable) return
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n')
    } catch { /* ignore write errors on disconnected proc */ }
  }

  private cleanup(): void {
    for (const p of this.pending.values()) {
      p.resolve({ jsonrpc: '2.0', id: -1, error: { code: -1, message: 'MCP server disconnected' } })
    }
    this.pending.clear()
    try { this.proc?.kill() } catch { /* ignore */ }
    this.proc = null
    this.initialized = false
  }
}

// ── SSE client ────────────────────────────────────────────────────────────

export class SseMcpClient implements IMcpClient {
  readonly serverId: string
  readonly serverName: string
  private baseUrl: string
  private msgId = 0
  private sseEndpoint = ''
  private sseAbort: AbortController | null = null
  private emitter = new EventEmitter()
  private initialized = false

  constructor(opts: { id: string; name: string; url: string }) {
    this.serverId = opts.id
    this.serverName = opts.name
    this.baseUrl = opts.url.replace(/\/$/, '')
  }

  async connect(): Promise<void> {
    if (this.initialized) return

    // Connect to the SSE stream to discover the messages endpoint
    this.sseAbort = new AbortController()
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSE connect timeout')), 15_000)
      fetch(`${this.baseUrl}/sse`, { signal: this.sseAbort!.signal })
        .then(async (resp) => {
          if (!resp.ok || !resp.body) { clearTimeout(timer); reject(new Error(`SSE connect failed: ${resp.status}`)); return }
          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          let resolved = false
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            for (const line of lines) {
              if (line.startsWith('data:')) {
                const data = line.slice(5).trim()
                if (!resolved) {
                  // First event is the endpoint URL
                  resolved = true
                  clearTimeout(timer)
                  resolve(data)
                }
                try {
                  const msg = JSON.parse(data) as JsonRpcResponse
                  if (msg.id != null) this.emitter.emit(`rpc:${msg.id}`, msg)
                } catch { /* non-JSON events (endpoint URL) are fine */ }
              }
            }
          }
        })
        .catch((e) => { clearTimeout(timer); if (!this.sseAbort?.signal.aborted) reject(e) })
    })

    this.sseEndpoint = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`

    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'turbollm', version: '0.7.0' },
    })
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    this.initialized = true
  }

  disconnect(): void {
    this.sseAbort?.abort()
    this.sseAbort = null
    this.initialized = false
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) await this.connect()
    const result = await this.sendRequest('tools/list', {}) as { tools?: McpTool[] }
    return result.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.initialized) await this.connect()
    const result = await this.sendRequest('tools/call', { name, arguments: args }) as McpCallResult
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n')
    return result.isError ? `Error: ${text}` : (text || '(no output)')
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.msgId
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.removeAllListeners(`rpc:${id}`)
        reject(new Error(`MCP SSE request timeout: ${method}`))
      }, 30_000)
      this.emitter.once(`rpc:${id}`, (msg: JsonRpcResponse) => {
        clearTimeout(timer)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      })
      this.post(req).catch((e) => { clearTimeout(timer); reject(e) })
    })
  }

  private async post(msg: unknown): Promise<void> {
    const url = this.sseEndpoint || `${this.baseUrl}/messages`
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(10_000),
    })
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

export function createMcpClient(server: {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
}): IMcpClient {
  if (server.transport === 'sse') {
    if (!server.url) throw new Error(`MCP server "${server.name}" has transport=sse but no url`)
    return new SseMcpClient({ id: server.id, name: server.name, url: server.url })
  }
  if (!server.command) throw new Error(`MCP server "${server.name}" has transport=stdio but no command`)
  return new StdioMcpClient({
    id: server.id, name: server.name,
    command: server.command, args: server.args, env: server.env,
  })
}
