// Conversation + message persistence (spec 01 §4). Uses node:sqlite (Node 22+).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface Conversation {
  id: string
  title: string
  systemPrompt: string
  modelKey: string
  /** Sampling overrides applied to every request in this conversation. Numeric keys
   *  (temp, topP, …) are camelCase; stop strings live under the 'stop' key as string[]. */
  sampling: Record<string, unknown>
  /** When true, this is the built-in TurboLLM Expert thread: its system prompt is
   *  managed server-side and hidden from the UI (spec 08 §2). */
  expertMode: boolean
  /** Tool-calling policy for this conversation. 'force_web_search' forces the model
   *  to call web_search on the first iteration before composing a reply. */
  toolPolicy?: string
  createdAt: string
  updatedAt: string
  messages?: Message[]
}

export interface MessageStats {
  promptTokens: number
  promptMs: number
  promptTps: number
  cachedTokens: number
  genTokens: number
  genMs: number
  tps: number
  ttftMs: number
  totalMs: number
  thinkMs: number
  ctxUsed: number
  ctxMax: number
  model: string
  aborted: boolean
}

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  error?: string
}

/** F-021: research metadata attached to Research-persona assistant messages. */
export interface ResearchMeta {
  /** Self-assessed confidence score emitted by the model (0.0–1.0). */
  confidence?: number
  /** Ranked source list from the retrieval service (F-021). */
  sources?: ResearchSource[]
  /** Per-claim referee verdicts (F-022). */
  refereeVerdicts?: ClaimVerdict[]
}

/** A single ranked research result persisted with the message. */
export interface ResearchSource {
  url: string
  title: string
  passage: string
  relevanceScore: number
  freshnessSignal: 'recent' | 'dated' | 'unknown'
  domain: string
}

/** F-022: per-sentence claim verdict from the heuristic referee. */
export interface ClaimVerdict {
  sentence: string
  citedUrl?: string
  verdict: 'verified' | 'unverified' | 'uncited'
  matchedPassage?: string
}

export interface Message {
  id: string
  convId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  attachments: string[]
  textAttachments: string[]
  /** Tool calls made by this assistant turn (v0.7.0). */
  toolCalls: ToolCallRecord[]
  stats: Partial<MessageStats>
  /** F-021/F-022: research metadata (confidence, sources, referee verdicts). Absent on non-research messages. */
  researchMeta?: ResearchMeta
  createdAt: string
}

interface ConvRow { id: string; title: string; system_prompt: string; model_key: string; sampling: string; expert_mode: number; tool_policy: string | null; created_at: string; updated_at: string }
interface MsgRow  { id: string; conv_id: string; seq: number; role: 'user' | 'assistant'; content: string; reasoning: string; attachments: string; text_attachments: string | null; tool_calls: string | null; stats: string; model_key: string | null; research_meta: string | null; created_at: string }

// node:sqlite named-param objects need an explicit cast to Record<string, SQLInputValue>
type P = Record<string, SQLInputValue>

function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return {} } }

function rowToConv(r: ConvRow): Conversation {
  return { id: r.id, title: r.title, systemPrompt: r.system_prompt, modelKey: r.model_key, sampling: safeJson(r.sampling) as Record<string, unknown>, expertMode: r.expert_mode === 1, toolPolicy: r.tool_policy ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at }
}

function rowToMsg(r: MsgRow): Message {
  const msg: Message = { id: r.id, convId: r.conv_id, seq: r.seq, role: r.role, content: r.content, reasoning: r.reasoning, attachments: safeJson(r.attachments) as string[], textAttachments: r.text_attachments ? safeJson(r.text_attachments) as string[] : [], toolCalls: r.tool_calls ? safeJson(r.tool_calls) as ToolCallRecord[] : [], stats: safeJson(r.stats) as Partial<MessageStats>, createdAt: r.created_at }
  if (r.research_meta) msg.researchMeta = safeJson(r.research_meta) as ResearchMeta
  return msg
}

interface Changes { changes: number }

export class ConversationStore {
  private db: DatabaseSync

  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, 'turbollm.db'))
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`)
    const { user_version: v } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (v < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat',
          system_prompt TEXT NOT NULL DEFAULT '', model_key TEXT NOT NULL DEFAULT '',
          sampling TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant')),
          content TEXT NOT NULL, reasoning TEXT NOT NULL DEFAULT '',
          attachments TEXT NOT NULL DEFAULT '[]', stats TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL, UNIQUE (conv_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, seq);
        PRAGMA user_version = 1;
      `)
    }
    // v2 (spec 04 §5): attribute each assistant reply to the model that produced it
    // so the Models screen can show last-session gen t/s per model. Nullable — old
    // rows stay NULL and are simply not counted (non-breaking).
    if (v < 2) {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN model_key TEXT;
        CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model_key, created_at);
        PRAGMA user_version = 2;
      `)
    }
    // v3 (spec 08 §2): mark the built-in TurboLLM Expert thread so its server-managed
    // system prompt stays hidden from the UI. Additive — existing conversations get 0.
    if (v < 3) {
      this.db.exec(`
        ALTER TABLE conversations ADD COLUMN expert_mode INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version = 3;
      `)
    }
    // v4 (spec 07 §9b): store text-file attachment filenames on user messages so the
    // UI can render file chips in the sent bubble. Nullable — existing rows get NULL
    // and are decoded as [] in rowToMsg (non-breaking).
    if (v < 4) {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN text_attachments TEXT;
        PRAGMA user_version = 4;
      `)
    }
    // v5 (v0.7.0 agentic): store tool call records on assistant messages so the UI
    // can render tool invocations + results inline. Nullable — existing rows get NULL
    // and are decoded as [] in rowToMsg (non-breaking).
    if (v < 5) {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN tool_calls TEXT;
        PRAGMA user_version = 5;
      `)
    }
    // v6 (v0.7.0 agentic): per-conversation tool policy. 'force_web_search' forces
    // the model to call web_search on the first iteration. Nullable — existing rows
    // get NULL and default to standard auto tool_choice (non-breaking).
    if (v < 6) {
      this.db.exec(`
        ALTER TABLE conversations ADD COLUMN tool_policy TEXT;
        PRAGMA user_version = 6;
      `)
    }
    // v7 (F-021/F-022): research metadata — confidence score, ranked sources, and
    // referee verdicts stored as JSON alongside the assistant message. Nullable —
    // only set on Research-persona replies that use the retrieval service.
    if (v < 7) {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN research_meta TEXT;
        PRAGMA user_version = 7;
      `)
    }
  }

  listConversations(q?: string): Conversation[] {
    if (q) {
      const rows = this.db.prepare(`
        SELECT DISTINCT c.* FROM conversations c
        LEFT JOIN messages m ON m.conv_id = c.id
        WHERE c.title LIKE $q OR m.content LIKE $q
        ORDER BY c.updated_at DESC LIMIT 200
      `).all({ $q: `%${q}%` } as P) as unknown as ConvRow[]
      return rows.map(rowToConv)
    }
    return (this.db.prepare(`SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 200`).all() as unknown as ConvRow[]).map(rowToConv)
  }

  createConversation(partial?: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'modelKey' | 'sampling' | 'expertMode' | 'toolPolicy'>>): Conversation {
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db.prepare(`INSERT INTO conversations (id,title,system_prompt,model_key,sampling,expert_mode,tool_policy,created_at,updated_at) VALUES ($id,$title,$sp,$mk,$samp,$expert,$tp,$now,$now)`)
      .run({ $id: id, $title: partial?.title ?? 'New chat', $sp: partial?.systemPrompt ?? '', $mk: partial?.modelKey ?? '', $samp: JSON.stringify(partial?.sampling ?? {}), $expert: partial?.expertMode ? 1 : 0, $tp: partial?.toolPolicy ?? null, $now: now } as P)
    return this.getConversation(id)!
  }

  getConversation(id: string, withMessages = false): Conversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = $id`).get({ $id: id } as P) as unknown as ConvRow | undefined
    if (!row) return null
    const conv = rowToConv(row)
    if (withMessages) conv.messages = this.getMessages(id)
    return conv
  }

  updateConversation(id: string, patch: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'sampling'>>): boolean {
    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = $now']
    const params: Record<string, SQLInputValue> = { $id: id, $now: now }
    if (patch.title !== undefined)        { sets.push('title = $title');      params.$title = patch.title }
    if (patch.systemPrompt !== undefined) { sets.push('system_prompt = $sp'); params.$sp    = patch.systemPrompt }
    if (patch.sampling !== undefined)     { sets.push('sampling = $samp');    params.$samp  = JSON.stringify(patch.sampling) }
    return ((this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
  }

  touchConversation(id: string): void {
    this.db.prepare(`UPDATE conversations SET updated_at = $now WHERE id = $id`).run({ $id: id, $now: new Date().toISOString() } as P)
  }

  deleteConversation(id: string): boolean {
    return ((this.db.prepare(`DELETE FROM conversations WHERE id = $id`).run({ $id: id } as P) as unknown) as Changes).changes > 0
  }

  getMessages(convId: string): Message[] {
    return (this.db.prepare(`SELECT * FROM messages WHERE conv_id = $id ORDER BY seq ASC`).all({ $id: convId } as P) as unknown as MsgRow[]).map(rowToMsg)
  }

  addMessage(convId: string, role: 'user' | 'assistant', content: string, extra?: Partial<Pick<Message, 'reasoning' | 'attachments' | 'textAttachments' | 'toolCalls' | 'stats'>>): Message {
    const id = randomUUID()
    const now = new Date().toISOString()
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS ms FROM messages WHERE conv_id = $id`).get({ $id: convId } as P) as unknown as { ms: number }
    // Attribute assistant replies to the conversation's model so the Models screen
    // can surface last-session gen t/s (spec 04 §5). User turns are left NULL.
    const modelKey = role === 'assistant' ? this.conversationModelKey(convId) : null
    const textAttachments = extra?.textAttachments?.length ? JSON.stringify(extra.textAttachments) : null
    const toolCalls = extra?.toolCalls?.length ? JSON.stringify(extra.toolCalls) : null
    this.db.prepare(`INSERT INTO messages (id,conv_id,seq,role,content,reasoning,attachments,text_attachments,tool_calls,stats,model_key,created_at) VALUES ($id,$cid,$seq,$role,$content,$reasoning,$attachments,$ta,$tc,$stats,$mk,$now)`)
      .run({ $id: id, $cid: convId, $seq: row.ms + 1, $role: role, $content: content, $reasoning: extra?.reasoning ?? '', $attachments: JSON.stringify(extra?.attachments ?? []), $ta: textAttachments, $tc: toolCalls, $stats: JSON.stringify(extra?.stats ?? {}), $mk: modelKey, $now: now } as P)
    this.touchConversation(convId)
    return this.getMessage(id)!
  }

  /** The model_key a conversation is bound to (empty string → null). */
  private conversationModelKey(convId: string): string | null {
    const r = this.db.prepare(`SELECT model_key FROM conversations WHERE id = $id`).get({ $id: convId } as P) as { model_key?: string } | undefined
    return r?.model_key ? r.model_key : null
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = $id`).get({ $id: id } as P) as unknown as MsgRow | undefined
    return row ? rowToMsg(row) : null
  }

  updateMessage(id: string, patch: Partial<Pick<Message, 'content' | 'reasoning' | 'toolCalls' | 'stats' | 'researchMeta'>>): boolean {
    const sets: string[] = []
    const params: Record<string, SQLInputValue> = { $id: id }
    if (patch.content      !== undefined) { sets.push('content = $content');         params.$content      = patch.content }
    if (patch.reasoning    !== undefined) { sets.push('reasoning = $reasoning');     params.$reasoning    = patch.reasoning }
    if (patch.toolCalls    !== undefined) { sets.push('tool_calls = $tc');           params.$tc           = JSON.stringify(patch.toolCalls) }
    if (patch.stats        !== undefined) { sets.push('stats = $stats');             params.$stats        = JSON.stringify(patch.stats) }
    if (patch.researchMeta !== undefined) { sets.push('research_meta = $rm');        params.$rm           = JSON.stringify(patch.researchMeta) }
    if (!sets.length) return false
    return ((this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
  }

  deleteMessage(id: string): boolean {
    return ((this.db.prepare(`DELETE FROM messages WHERE id = $id`).run({ $id: id } as P) as unknown) as Changes).changes > 0
  }

  deleteMessagesAfterSeq(convId: string, seq: number): void {
    this.db.prepare(`DELETE FROM messages WHERE conv_id = $id AND seq > $seq`).run({ $id: convId, $seq: seq } as P)
  }

  /** Most-recent assistant gen t/s per model (spec 04 §5 `lastTps`). For each
   *  model_key, takes the newest assistant message that recorded a positive
   *  `stats.tps` and returns its value. Rows with NULL model_key (pre-v2) or no
   *  usable t/s are skipped. Returns an empty map when there's no chat history. */
  lastGenTpsByModel(): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT model_key, stats FROM messages
      WHERE role = 'assistant' AND model_key IS NOT NULL
      ORDER BY created_at DESC, seq DESC
    `).all() as unknown as { model_key: string; stats: string }[]
    const out = new Map<string, number>()
    for (const r of rows) {
      if (out.has(r.model_key)) continue // rows are newest-first → newest valid wins
      const tps = (safeJson(r.stats) as Partial<MessageStats>).tps
      if (typeof tps === 'number' && tps > 0) out.set(r.model_key, Math.round(tps * 10) / 10)
    }
    return out
  }

  getLastMessage(convId: string): Message | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE conv_id = $id ORDER BY seq DESC LIMIT 1`).get({ $id: convId } as P) as unknown as MsgRow | undefined
    return row ? rowToMsg(row) : null
  }

  close(): void { this.db.close() }
}
