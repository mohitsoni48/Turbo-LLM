// LAN auth enforcement (spec 06 §5). The daemon binds loopback-only by default
// (daemon.lanBind=false), so local dev and the embedded web UI need no key. Once
// the user flips the LAN-expose toggle (lanBind=true → bind 0.0.0.0), the listener
// is reachable from other machines and EVERY non-loopback request to the API /
// gateway surface must carry a valid API key. Loopback is always exempt so the
// local browser UI and `turbollm launch claude` keep working with no key.
import { createHash } from 'node:crypto'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, MiddlewareHandler } from 'hono'
import type { Deps } from './deps'

/** Loopback addresses that never require a key, in the forms Node surfaces them
 *  (IPv4, IPv6, and the IPv4-mapped-IPv6 form Windows/dual-stack sockets report). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** SHA-256 hex of the presented key — the SAME derivation used when keys are
 *  created (api/routes.ts generateApiKey). Stored config holds only this hash. */
function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Pull the presented key from any of the accepted headers (spec 06 §5):
 *  the web-UI header, the Anthropic `x-api-key`, or `Authorization: Bearer`. */
function presentedKey(c: Context): string {
  const direct = c.req.header('X-TurboLLM-Auth') ?? c.req.header('x-api-key')
  if (direct && direct.trim()) return direct.trim()
  const authz = c.req.header('Authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(authz.trim())
  return m ? m[1].trim() : ''
}

/** True for requests we cannot tie to a credential surface and so let through
 *  even when enforcing: the SPA shell + its static assets (any path NOT under
 *  /api/ or /v1/) and the always-open health probe. A user must be able to load
 *  the page on the LAN to paste a key (spec 06 §5: `/healthz` always open). */
function isExempt(c: Context): boolean {
  if (c.req.path === '/healthz') return true
  if (c.req.method !== 'GET') return false
  const p = c.req.path
  return !p.startsWith('/api/') && !p.startsWith('/v1/')
}

/** Best-effort: is the request from loopback? Returns `null` when the address
 *  cannot be determined (caller decides how to treat unknown — safer = remote
 *  when the listener is LAN-exposed). */
function isLoopback(c: Context): boolean | null {
  let addr: string | undefined
  try {
    addr = getConnInfo(c).remote.address
  } catch {
    addr = undefined
  }
  if (!addr) return null
  return LOOPBACK.has(addr)
}

/** LAN auth middleware (spec 06 §5). Register AFTER cors + the Server header and
 *  BEFORE the API/chat/gateway routes. Enforcement only kicks in when the daemon
 *  is LAN-exposed (lanBind=true); with the default loopback-only bind it is a pure
 *  pass-through, so local dev and the UI can never be locked out. */
export function lanAuth(d: Deps): MiddlewareHandler {
  return async (c, next) => {
    const daemon = d.store.snapshot().daemon
    if (!daemon.lanBind) return next() // loopback-only bind: no enforcement
    if (!daemon.requireApiKey) return next() // user opted into open (unauthenticated) LAN access

    const loopback = isLoopback(c)
    // Unknown address while LAN-exposed → treat as remote (fail closed).
    if (loopback === true) return next() // local clients never need a key

    if (isExempt(c)) return next() // SPA/static assets + /healthz so a user can paste a key

    const key = presentedKey(c)
    if (key) {
      const hash = hashKey(key)
      const cfg = d.store.snapshot()
      const match = cfg.apiKeys.find((k) => k.hash === hash)
      if (match) {
        // Best-effort lastUsedAt bump (spec 06 §5). Never block the request on it.
        try {
          d.store.update((mut) => {
            const k = mut.apiKeys.find((x) => x.id === match.id)
            if (k) k.lastUsedAt = new Date().toISOString()
          })
        } catch {
          /* swallow — usage tracking is best-effort */
        }
        return next()
      }
    }

    return c.json(
      { error: { code: 'unauthorized', message: 'A valid API key is required for non-local access.' } },
      401,
    )
  }
}
