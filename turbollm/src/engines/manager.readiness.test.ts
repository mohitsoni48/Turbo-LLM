// Readiness-probe regression tests (B1a). The bug: probeReady fell back to
// /v1/models — which returns 200 the instant the socket binds, before the model
// finishes loading — so the engine flipped to "running" prematurely and then to
// "error" when the load actually failed. These tests pin the corrected contract:
//   • /health 200            → ready
//   • /health 503 (loading)  → NOT ready (the regression case)
//   • /health 404/501 (none) → fall back to /v1/models (mlx-lm path)
//   • socket refused          → NOT ready
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { probeReady } from './manager'

/** Start a throwaway HTTP server with explicit status codes per route, on an
 *  ephemeral port. Returns the port + a stop().*/
function startFake(routes: { health?: number; models?: number }): Promise<{ port: number; stop: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    if (req.url === '/health' && routes.health !== undefined) res.writeHead(routes.health)
    else if (req.url === '/v1/models' && routes.models !== undefined) res.writeHead(routes.models)
    else res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      resolve({ port, stop: () => new Promise<void>((r) => srv.close(() => r())) })
    })
  })
}

test('ready when /health is 200', async () => {
  const f = await startFake({ health: 200, models: 200 })
  try {
    assert.equal(await probeReady(f.port), true)
  } finally {
    await f.stop()
  }
})

test('NOT ready while /health is 503 even though /v1/models is 200 (the regression)', async () => {
  const f = await startFake({ health: 503, models: 200 })
  try {
    assert.equal(await probeReady(f.port), false)
  } finally {
    await f.stop()
  }
})

test('falls back to /v1/models when /health is absent (404) — mlx-lm path', async () => {
  const f = await startFake({ health: 404, models: 200 })
  try {
    assert.equal(await probeReady(f.port), true)
  } finally {
    await f.stop()
  }
})

test('NOT ready when /health absent (404) and /v1/models not yet 200', async () => {
  const f = await startFake({ health: 404, models: 503 })
  try {
    assert.equal(await probeReady(f.port), false)
  } finally {
    await f.stop()
  }
})

test('NOT ready when nothing is listening (connection refused)', async () => {
  // Bind then immediately free a port so it is almost certainly closed.
  const f = await startFake({ health: 200 })
  const dead = f.port
  await f.stop()
  assert.equal(await probeReady(dead), false)
})
