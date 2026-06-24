// Background agent runner — one active run at a time; extras queue.
// Each run gets a dedicated conversation (kind='agent') and its own AbortController.
// Events are stored in a ring buffer (cap 2000) and live-tailed via EventEmitter.
import { EventEmitter } from 'node:events'
import type { Deps } from '../deps'
import { runGeneration } from '../chat/generation'

const BUFFER_CAP = 2000

export interface BufferedEvent {
  seq: number
  event: string
  data: unknown
}

class RunBuffer {
  private events: BufferedEvent[] = []
  private next = 0

  push(event: string, data: unknown): BufferedEvent {
    const ev: BufferedEvent = { seq: this.next++, event, data }
    this.events.push(ev)
    if (this.events.length > BUFFER_CAP) this.events.shift()
    return ev
  }

  since(fromSeq: number): BufferedEvent[] {
    return this.events.filter((e) => e.seq >= fromSeq)
  }
}

export interface LaunchParams {
  title: string
  systemPrompt?: string
  userMessage: string
  allowedTools: string[]
  maxToolIter?: number
}

interface PendingRun extends LaunchParams {
  id: string
  convId: string
}

export class AgentRunner {
  private d: Deps
  private buffers = new Map<string, RunBuffer>()
  private emitters = new Map<string, EventEmitter>()
  private acs = new Map<string, AbortController>()
  private queue: PendingRun[] = []
  private active: string | null = null

  constructor(d: Deps) { this.d = d }

  /** On startup: mark any DB runs left in queued/running state as interrupted. */
  reconcileOnStartup(): void {
    const runs = this.d.db.listAgentRuns?.({ statuses: ['queued', 'running'] }) ?? []
    for (const run of runs) {
      this.d.db.updateAgentRun?.(run.id, { status: 'interrupted', endedAt: new Date().toISOString() })
    }
  }

  /** Create a new agent run and queue it. Returns the run ID immediately. */
  async launch(params: LaunchParams): Promise<string> {
    const db = this.d.db

    // Create a dedicated conversation for this run
    const conv = db.createConversation({
      title: params.title,
      systemPrompt: params.systemPrompt ?? '',
      kind: 'agent',
    })

    const run = db.createAgentRun?.({
      convId: conv.id,
      title: params.title,
      allowedTools: params.allowedTools,
    })
    if (!run) throw new Error('createAgentRun not available (DB migration pending?)')

    this.queue.push({ ...params, id: run.id, convId: conv.id })
    void this.processNext()
    return run.id
  }

  private async processNext(): Promise<void> {
    if (this.active !== null || this.queue.length === 0) return
    const pending = this.queue.shift()!
    this.active = pending.id

    const buffer = new RunBuffer()
    const emitter = new EventEmitter()
    emitter.setMaxListeners(50)
    const ac = new AbortController()

    this.buffers.set(pending.id, buffer)
    this.emitters.set(pending.id, emitter)
    this.acs.set(pending.id, ac)

    const sink = ({ event, data }: { event: string; data: unknown }) => {
      const ev = buffer.push(event, data)
      emitter.emit('event', ev)
    }

    this.d.db.updateAgentRun?.(pending.id, { status: 'running', startedAt: new Date().toISOString() })

    const ms = this.d.manager.status()
    const target = this.d.manager.target()

    if (ms.state !== 'running' || !ms.model || !target) {
      this.d.db.updateAgentRun?.(pending.id, { status: 'failed', error: 'Model not loaded', endedAt: new Date().toISOString() })
      sink({ event: 'error', data: { code: 'model_not_loaded', message: 'Load a model first.' } })
      this.finish(pending.id)
      return
    }

    const conv = this.d.db.getConversation(pending.convId)!

    this.d.db.addMessage(pending.convId, 'user', pending.userMessage)
    this.d.db.addMessage(pending.convId, 'assistant', '', { stats: { aborted: false } })
    const assistantMsg = this.d.db.getLastMessage(pending.convId)!

    const engineMessages: { role: string; content: unknown }[] = []
    if (conv.systemPrompt) engineMessages.push({ role: 'system', content: conv.systemPrompt })
    engineMessages.push({ role: 'user', content: pending.userMessage })

    try {
      await runGeneration(this.d, sink, {
        convId: pending.convId,
        conv,
        engineMessages,
        assistantMsg,
        ms,
        target,
        ac,
        disableThinking: false,
        maxToolIter: pending.maxToolIter ?? 30,
        allowedTools: pending.allowedTools,
        skipAutoTitle: true,
        gatePriority: 'bg',
      })
      this.d.db.updateAgentRun?.(pending.id, { status: 'done', endedAt: new Date().toISOString() })
    } catch (e) {
      const isAbort = (e as Error)?.name === 'AbortError'
      this.d.db.updateAgentRun?.(pending.id, {
        status: isAbort ? 'cancelled' : 'failed',
        error: isAbort ? undefined : (e as Error).message,
        endedAt: new Date().toISOString(),
      })
    } finally {
      this.finish(pending.id)
    }
  }

  private finish(id: string): void {
    this.emitters.get(id)?.emit('done')
    this.acs.delete(id)
    this.active = null
    void this.processNext()
  }

  cancel(id: string): boolean {
    // Active run: abort it
    const ac = this.acs.get(id)
    if (ac) {
      ac.abort()
      this.d.db.updateAgentRun?.(id, { status: 'cancelled', endedAt: new Date().toISOString() })
      return true
    }
    // Queued but not started yet
    const qIdx = this.queue.findIndex((r) => r.id === id)
    if (qIdx >= 0) {
      this.queue.splice(qIdx, 1)
      this.d.db.updateAgentRun?.(id, { status: 'cancelled', endedAt: new Date().toISOString() })
      return true
    }
    return false
  }

  /** Called by the engine manager when the active model is evicted. */
  interruptActive(): void {
    if (!this.active) return
    this.acs.get(this.active)?.abort()
    this.d.db.updateAgentRun?.(this.active, { status: 'interrupted', endedAt: new Date().toISOString() })
  }

  subscribe(runId: string, fromSeq: number): AsyncIterable<BufferedEvent> & { close: () => void } {
    const buffer = this.buffers.get(runId)
    const emitter = this.emitters.get(runId)

    // Run already finished or unknown — return a closed iterable
    if (!emitter) {
      return {
        close() {},
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ value: undefined as unknown as BufferedEvent, done: true as const }),
            return: async () => ({ value: undefined as unknown as BufferedEvent, done: true as const }),
          }
        },
      }
    }

    let closed = false
    const pending: BufferedEvent[] = buffer ? buffer.since(fromSeq) : []
    let resolver: ((v: IteratorResult<BufferedEvent>) => void) | null = null

    const onEvent = (ev: BufferedEvent) => {
      if (closed) return
      if (resolver) { const r = resolver; resolver = null; r({ value: ev, done: false }) }
      else pending.push(ev)
    }
    const onDone = () => {
      if (resolver) { const r = resolver; resolver = null; r({ value: undefined as unknown as BufferedEvent, done: true }) }
    }

    emitter.on('event', onEvent)
    emitter.once('done', onDone)

    function close() {
      if (closed) return
      closed = true
      emitter!.off('event', onEvent)
      emitter!.off('done', onDone)
      if (resolver) { const r = resolver; resolver = null; r({ value: undefined as unknown as BufferedEvent, done: true }) }
    }

    return {
      close,
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<BufferedEvent>> {
            if (closed) return Promise.resolve({ value: undefined as unknown as BufferedEvent, done: true })
            if (pending.length > 0) return Promise.resolve({ value: pending.shift()!, done: false })
            return new Promise<IteratorResult<BufferedEvent>>((res) => { resolver = res })
          },
          return(): Promise<IteratorResult<BufferedEvent>> {
            close()
            return Promise.resolve({ value: undefined as unknown as BufferedEvent, done: true })
          },
        }
      },
    }
  }
}
