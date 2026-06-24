// Background agent HTTP routes.
// POST   /api/v1/agents/runs        — create + queue a run
// GET    /api/v1/agents/runs        — list runs (newest first)
// GET    /api/v1/agents/runs/:id    — get run + messages
// DELETE /api/v1/agents/runs/:id    — cancel
// GET    /api/v1/agents/runs/:id/stream — SSE live-tail (replay + live)
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Deps } from '../deps'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function err(c: any, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body<T>(c: any): Promise<T> {
  try { return (await c.req.json()) as T } catch { return {} as T }
}

export function registerAgentRoutes(app: Hono, d: Deps): void {
  // Create and queue a run
  app.post('/api/v1/agents/runs', async (c) => {
    if (!d.agentRunner) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    const b = await body<{ title?: string; systemPrompt?: string; userMessage?: string; allowedTools?: string[] }>(c)
    if (!b.userMessage?.trim()) return err(c, 400, 'invalid_input', 'userMessage is required.')

    const id = await d.agentRunner.launch({
      title: b.title?.trim() || 'Agent run',
      systemPrompt: b.systemPrompt ?? '',
      userMessage: b.userMessage.trim(),
      allowedTools: Array.isArray(b.allowedTools) ? b.allowedTools : [],
    })

    const run = d.db.getAgentRun?.(id)
    return c.json(run, 201)
  })

  // List runs (newest first)
  app.get('/api/v1/agents/runs', (c) => {
    if (!d.db.listAgentRuns) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    return c.json(d.db.listAgentRuns())
  })

  // Get a single run with its conversation messages
  app.get('/api/v1/agents/runs/:id', (c) => {
    const id = c.req.param('id')
    if (!d.db.getAgentRun) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    const run = d.db.getAgentRun(id)
    if (!run) return err(c, 404, 'not_found', 'Run not found.')
    const conv = d.db.getConversation(run.convId, true)
    return c.json({ ...run, messages: conv?.messages ?? [] })
  })

  // Cancel a run
  app.delete('/api/v1/agents/runs/:id', (c) => {
    const id = c.req.param('id')
    if (!d.agentRunner) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    const ok = d.agentRunner.cancel(id)
    if (!ok) return err(c, 404, 'not_found', 'Run not found or already complete.')
    return c.json({ ok: true })
  })

  // SSE stream — replay buffered events from `fromSeq`, then live-tail
  app.get('/api/v1/agents/runs/:id/stream', (c) => {
    const id = c.req.param('id')
    const fromSeq = Math.max(0, Number(c.req.query('fromSeq') ?? '0'))
    if (!d.agentRunner) return err(c, 501, 'not_implemented', 'Agent runner not available.')
    const run = d.db.getAgentRun?.(id)
    if (!run) return err(c, 404, 'not_found', 'Run not found.')

    return streamSSE(c, async (stream) => {
      const sub = d.agentRunner!.subscribe(id, fromSeq)
      stream.onAbort(() => sub.close())
      try {
        for await (const ev of sub) {
          await stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) })
          if (ev.event === 'done' || ev.event === 'error') break
        }
      } finally {
        sub.close()
      }
    })
  })
}
