// F-020: pluggable web-search backends. The web_search tool calls a SearchClient
// produced by searchProviderClient(); only this module knows provider specifics.
// Supported providers: Tavily (default, BYO key), Kagi (BYO key), SearXNG (self-hosted URL).
import type { SearchConfig, SearchProvider } from '../config/config'

export type { SearchConfig, SearchProvider }

export interface SearchResult {
  title: string
  url: string
  content: string
  score?: number
}

export interface SearchClient {
  readonly provider: SearchProvider
  /** Run a search. Throws on transport/HTTP errors so the caller can surface them. */
  search(query: string, maxResults: number): Promise<SearchResult[]>
}

export type FetchImpl = typeof fetch

const SEARCH_TIMEOUT_MS = 20_000

/** Whether the selected provider has the credential/URL it needs to run. */
export function searchConfigured(cfg?: SearchConfig): boolean {
  if (!cfg) return false
  switch (cfg.provider) {
    case 'tavily':
      return !!cfg.tavilyApiKey
    case 'kagi':
      return !!cfg.kagiApiKey
    case 'searxng':
      return !!cfg.searxngUrl
    default:
      return false
  }
}

/** Build the client for the configured provider, or null if it isn't configured. */
export function searchProviderClient(
  cfg: SearchConfig | undefined,
  fetchImpl: FetchImpl = fetch,
): SearchClient | null {
  if (!cfg || !searchConfigured(cfg)) return null
  switch (cfg.provider) {
    case 'tavily':
      return new TavilyClient(cfg.tavilyApiKey!, fetchImpl)
    case 'kagi':
      return new KagiClient(cfg.kagiApiKey!, fetchImpl)
    case 'searxng':
      return new SearxngClient(cfg.searxngUrl!, fetchImpl)
    default:
      return null
  }
}

class TavilyClient implements SearchClient {
  readonly provider = 'tavily' as const
  constructor(private key: string, private fetchImpl: FetchImpl) {}

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const resp = await this.fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.key,
        query,
        max_results: maxResults,
        search_depth: 'advanced',
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(await httpError('Tavily', resp))
    const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string; content?: string; score?: number }> }
    return (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
      score: r.score,
    }))
  }
}

class KagiClient implements SearchClient {
  readonly provider = 'kagi' as const
  constructor(private key: string, private fetchImpl: FetchImpl) {}

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = `https://kagi.com/api/v0/search?q=${encodeURIComponent(query)}&limit=${maxResults}`
    const resp = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bot ${this.key}` },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(await httpError('Kagi', resp))
    // Kagi returns mixed items: t:0 = search result, t:1 = related searches (dropped).
    const data = (await resp.json()) as { data?: Array<{ t?: number; url?: string; title?: string; snippet?: string }> }
    return (data.data ?? [])
      .filter((r) => r.t === 0 && r.url)
      .map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.snippet ?? '',
      }))
  }
}

class SearxngClient implements SearchClient {
  readonly provider = 'searxng' as const
  constructor(private baseUrl: string, private fetchImpl: FetchImpl) {}

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = this.baseUrl.replace(/\/+$/, '')
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general`
    const resp = await this.fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(await httpError('SearXNG', resp))
    const data = (await resp.json()) as { results?: Array<{ url?: string; title?: string; content?: string; score?: number }> }
    return (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
      score: r.score,
    }))
  }
}

async function httpError(name: string, resp: Response): Promise<string> {
  const text = await resp.text().catch(() => '')
  return `${name} returned ${resp.status}${text ? ` — ${text.slice(0, 200)}` : ''}`
}
