// Cancellation-propagation regression test (gateway root cause A). The bug: when a
// Claude Code turn was cancelled/disconnected, the gateway kept the upstream engine
// request alive — it only released the reader lock, never cancelling the body — so the
// engine ran the abandoned request to completion and its queue "never ended". The fix
// cancels the reader in the generator's finally, which tears down the upstream body.
// This pins it: stopping consumption must cancel the source stream.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamToAnthropic } from './anthropic'

test('abandoning the stream cancels the upstream engine body', async () => {
  let cancelled = false
  const enc = new TextEncoder()
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      // One content delta, then we deliberately leave the stream OPEN — mimicking an
      // engine still generating after the client has gone away.
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n`))
    },
    cancel() {
      cancelled = true
    },
  })

  const gen = streamToAnthropic(upstream, 'model', 'msg_test')
  await gen.next() // message_start (emitted before the reader is acquired)
  await gen.next() // enters the read loop, consumes the chunk → reader is now active
  await gen.return(undefined) // client disconnects → generator finally runs

  assert.equal(cancelled, true, 'upstream body should be cancelled, not left running')
})
