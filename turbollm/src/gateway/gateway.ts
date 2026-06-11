// Gateway: /v1/* OpenAI-compatible pass-through to the running engine (spec 06
// §1). Streams bodies (incl. SSE) through unmodified. Anthropic /v1/messages
// translation (spec 06 §2) is added in A5.
import type { Hono } from 'hono'
import type { Manager } from '../engines/manager'

export function registerGateway(app: Hono, mgr: Manager): void {
  app.all('/v1/*', async (c) => {
    const target = mgr.target()
    if (!target) {
      // Clients probe /v1/models before chatting — answer locally (spec 06 §1).
      if (c.req.method === 'GET' && c.req.path === '/v1/models') {
        return c.json({ object: 'list', data: [] })
      }
      return c.json(
        { error: { message: 'No model loaded. Load one in TurboLLM.', type: 'model_not_loaded', code: 'model_not_loaded' } },
        503,
      )
    }
    mgr.touch()

    const url = new URL(c.req.url)
    const upstream = target + url.pathname + url.search
    const headers = new Headers(c.req.raw.headers)
    headers.delete('host')

    const init: RequestInit & { duplex?: 'half' } = { method: c.req.method, headers }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      init.body = c.req.raw.body
      init.duplex = 'half'
    }

    const res = await fetch(upstream, init)
    return new Response(res.body, { status: res.status, headers: res.headers })
  })
}
