// Built-in tool definitions and execution (v0.7.0).
// Tools: web_search (Tavily), fetch_url, run_code (Node vm sandbox).
import { runInNewContext } from 'node:vm'

// ── Tool JSON-schema definitions (OpenAI tool format) ─────────────────────

export const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: 'Search the web for up-to-date information. Use this for current events, facts, or anything you are not certain about.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        max_results: { type: 'number', description: 'Maximum number of results to return (default 5, max 10).' },
      },
      required: ['query'],
    },
  },
}

export const FETCH_URL_TOOL = {
  type: 'function' as const,
  function: {
    name: 'fetch_url',
    description: 'Fetch the text content of a URL. Returns the main text of the page, stripped of HTML.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
      },
      required: ['url'],
    },
  },
}

export const RUN_CODE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'run_code',
    description: 'Execute a JavaScript snippet and return the result. Useful for calculations, data transformation, and logic. No network, file, or process access.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. The last expression is the return value.' },
      },
      required: ['code'],
    },
  },
}

// ── Tavily web search ─────────────────────────────────────────────────────

interface TavilyResult {
  title: string
  url: string
  content: string
  score: number
}

interface TavilyResponse {
  results?: TavilyResult[]
  answer?: string
}

export async function execWebSearch(args: Record<string, unknown>, tavilyApiKey: string): Promise<string> {
  const query = String(args.query ?? '')
  if (!query.trim()) return 'Error: query is required.'
  const maxResults = Math.min(10, Math.max(1, Number(args.max_results ?? 5) || 5))

  let resp: Response
  try {
    resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: tavilyApiKey, query, max_results: maxResults }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    return `Error: could not reach Tavily — ${(e as Error).message}`
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    return `Error: Tavily returned ${resp.status}${text ? ` — ${text.slice(0, 200)}` : ''}`
  }

  const data = (await resp.json()) as TavilyResponse
  const results = data.results ?? []
  if (results.length === 0) return 'No results found.'

  const lines: string[] = []
  if (data.answer) lines.push(`Summary: ${data.answer}\n`)
  for (const [i, r] of results.entries()) {
    lines.push(`[${i + 1}] ${r.title}`)
    lines.push(`URL: ${r.url}`)
    lines.push(r.content.slice(0, 400))
    lines.push('')
  }
  return lines.join('\n').trim()
}

// ── Fetch URL ─────────────────────────────────────────────────────────────

export async function execFetchUrl(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '').trim()
  if (!url) return 'Error: url is required.'
  if (!/^https?:\/\//i.test(url)) return 'Error: URL must start with http:// or https://'

  let resp: Response
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'TurboLLM/0.7 (tool-fetch)' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    return `Error: could not fetch URL — ${(e as Error).message}`
  }

  const contentType = resp.headers.get('content-type') ?? ''
  const text = await resp.text().catch(() => '')
  let content: string

  if (contentType.includes('text/html')) {
    // Strip HTML tags and collapse whitespace
    content = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, ' ')
      .trim()
  } else {
    content = text.trim()
  }

  // Truncate to ~4000 chars to fit comfortably in the context window
  if (content.length > 4000) content = content.slice(0, 4000) + '\n[truncated]'
  return content || '(empty response)'
}

// ── Run code ─────────────────────────────────────────────────────────────

export function execRunCode(args: Record<string, unknown>): string {
  const code = String(args.code ?? '').trim()
  if (!code) return 'Error: code is required.'

  const output: string[] = []
  const sandbox = {
    console: {
      log: (...a: unknown[]) => output.push(a.map(String).join(' ')),
      error: (...a: unknown[]) => output.push('ERROR: ' + a.map(String).join(' ')),
      warn: (...a: unknown[]) => output.push('WARN: ' + a.map(String).join(' ')),
    },
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
  }

  let result: unknown
  try {
    result = runInNewContext(`(function(){${code}})()`, sandbox, { timeout: 5000 })
  } catch (e) {
    return `Error: ${(e as Error).message}`
  }

  const parts: string[] = []
  if (output.length > 0) parts.push(output.join('\n'))
  if (result !== undefined) {
    try {
      parts.push(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
    } catch {
      parts.push(String(result))
    }
  }
  return parts.join('\n') || '(no output)'
}
