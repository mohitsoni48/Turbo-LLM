// Pure streaming parse state machine extracted from chat-routes.ts.
// No I/O — callers drive the loop and dispatch the returned events.
export const THINK_OPEN = '<think>'
export const THINK_CLOSE = '</think>'
export const CHAN_ANALYSIS_OPEN = '<|channel|>analysis<|message|>'
export const CHAN_CLOSE = '<|end|>'
export const CHAN_FINAL_SKIP = '<|start|>assistant<|channel|>final<|message|>'

export type ParsePhase = 'initial' | 'reasoning' | 'skipFinal' | 'content'

export interface ParseState {
  phase: ParsePhase
  isChannel: boolean
  buf: string
}

export interface ParseEvent {
  type: 'reasoning' | 'delta'
  text: string
}

export function initParseState(): ParseState {
  return { phase: 'initial', isChannel: false, buf: '' }
}

/** Feed one raw-content chunk into the streaming parser. Returns the updated state
 *  and zero or more events (reasoning or content deltas) ready for dispatch. */
export function feedChunk(state: ParseState, raw: string): { state: ParseState; events: ParseEvent[] } {
  const events: ParseEvent[] = []
  let { phase, isChannel, buf } = state
  buf += raw

  while (buf.length > 0) {
    if (phase === 'initial') {
      const thinkIdx = buf.indexOf(THINK_OPEN)
      const chanIdx  = buf.indexOf(CHAN_ANALYSIS_OPEN)
      const hasThink = thinkIdx >= 0
      const hasChan  = chanIdx >= 0
      const useThink = hasThink && (!hasChan || thinkIdx <= chanIdx)
      const openIdx  = useThink ? thinkIdx : hasChan ? chanIdx : -1
      const openTag  = useThink ? THINK_OPEN : CHAN_ANALYSIS_OPEN

      if (openIdx === 0) {
        isChannel = !useThink
        phase = 'reasoning'
        buf = buf.slice(openTag.length)
      } else if (openIdx > 0) {
        events.push({ type: 'delta', text: buf.slice(0, openIdx) })
        isChannel = !useThink
        phase = 'reasoning'
        buf = buf.slice(openIdx + openTag.length)
      } else {
        // 29-char lookahead: safe threshold to detect the 30-char CHAN_ANALYSIS_OPEN
        // before flushing, avoiding false flushes mid-tag.
        const safeLen = buf.length - (CHAN_ANALYSIS_OPEN.length - 1)
        if (safeLen > 0) {
          events.push({ type: 'delta', text: buf.slice(0, safeLen) })
          buf = buf.slice(safeLen)
          phase = 'content'
        } else {
          break
        }
      }
    } else if (phase === 'reasoning') {
      const closeTag = isChannel ? CHAN_CLOSE : THINK_CLOSE
      const closeIdx = buf.indexOf(closeTag)
      if (closeIdx >= 0) {
        if (closeIdx > 0) {
          events.push({ type: 'reasoning', text: buf.slice(0, closeIdx) })
        }
        const wasChannel = isChannel
        buf = buf.slice(closeIdx + closeTag.length)
        phase = wasChannel ? 'skipFinal' : 'content'
        if (!wasChannel && buf) {
          events.push({ type: 'delta', text: buf })
          buf = ''
        }
      } else if (buf.length >= closeTag.length) {
        const safe = buf.length - (closeTag.length - 1)
        events.push({ type: 'reasoning', text: buf.slice(0, safe) })
        buf = buf.slice(safe)
      } else {
        break
      }
    } else if (phase === 'skipFinal') {
      if (buf.startsWith(CHAN_FINAL_SKIP)) {
        buf = buf.slice(CHAN_FINAL_SKIP.length)
        phase = 'content'
      } else if (CHAN_FINAL_SKIP.startsWith(buf) && buf.length < CHAN_FINAL_SKIP.length) {
        break
      } else {
        // Unexpected prefix (e.g. whitespace between <|end|> and <|start|>assistant…).
        // Find the token anywhere in the buffer so content after it isn't discarded.
        const skipIdx = buf.indexOf(CHAN_FINAL_SKIP)
        buf = skipIdx >= 0 ? buf.slice(skipIdx + CHAN_FINAL_SKIP.length) : ''
        phase = 'content'
      }
    } else {
      events.push({ type: 'delta', text: buf })
      buf = ''
      break
    }
  }

  return { state: { phase, isChannel, buf }, events }
}

/** Flush any remaining buffer at end-of-stream. Returns zero or one event. */
export function flushState(state: ParseState): ParseEvent[] {
  if (!state.buf) return []
  return state.phase === 'reasoning'
    ? [{ type: 'reasoning', text: state.buf }]
    : [{ type: 'delta', text: state.buf }]
}
