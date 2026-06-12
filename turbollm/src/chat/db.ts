// Conversation + message persistence (spec 01 §4). Uses node:sqlite (Node 22+).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface Conversation {
  id: string
  title: string
  systemPrompt: string
  modelKey: string
  sampling: Record<string, number>
  createdAt: string
  updatedAt: string
  messages?: Message[]
}

export interface MessageStats {
  promptTokens: number
  promptMs: number
  promptTps: number
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

export interface Message {
  id: string
  convId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  attachments: string[]
  stats: Partial<MessageStats>
  createdAt: string
}

interface ConvRow { id: string; title: string; system_prompt: string; model_key: string; sampling: string; created_at: string; updated_at: string }
interface MsgRow  { id: string; conv_id: string; seq: number; role: 'user' | 'assistant'; content: string; reasoning: string; attachments: string; stats: string; created_at: string }

// node:sqlite named-param objects need an explicit cast to Record<string, SQLInputValue>
type P = Record<string, SQLInputValue>

function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return {} } }

function rowToConv(r: ConvRow): Conversation {
  return { id: r.id, title: r.title, systemPrompt: r.system_prompt, modelKey: r.model_key, sampling: safeJson(r.sampling) as Record<string, number>, createdAt: r.created_at, updatedAt: r.updated_at }
}

function rowToMsg(r: MsgRow): Message {
  return { id: r.id, convId: r.conv_id, seq: r.seq, role: r.role, content: r.content, reasoning: r.reasoning, attachments: safeJson(r.attachments) as string[], stats: safeJson(r.stats) as Partial<MessageStats>, createdAt: r.created_at }
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

  createConversation(partial?: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'modelKey' | 'sampling'>>): Conversation {
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db.prepare(`INSERT INTO conversations (id,title,system_prompt,model_key,sampling,created_at,updated_at) VALUES ($id,$title,$sp,$mk,$samp,$now,$now)`)
      .run({ $id: id, $title: partial?.title ?? 'New chat', $sp: partial?.systemPrompt ?? '', $mk: partial?.modelKey ?? '', $samp: JSON.stringify(partial?.sampling ?? {}), $now: now } as P)
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

  addMessage(convId: string, role: 'user' | 'assistant', content: string, extra?: Partial<Pick<Message, 'reasoning' | 'attachments' | 'stats'>>): Message {
    const id = randomUUID()
    const now = new Date().toISOString()
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS ms FROM messages WHERE conv_id = $id`).get({ $id: convId } as P) as unknown as { ms: number }
    this.db.prepare(`INSERT INTO messages (id,conv_id,seq,role,content,reasoning,attachments,stats,created_at) VALUES ($id,$cid,$seq,$role,$content,$reasoning,$attachments,$stats,$now)`)
      .run({ $id: id, $cid: convId, $seq: row.ms + 1, $role: role, $content: content, $reasoning: extra?.reasoning ?? '', $attachments: JSON.stringify(extra?.attachments ?? []), $stats: JSON.stringify(extra?.stats ?? {}), $now: now } as P)
    this.touchConversation(convId)
    return this.getMessage(id)!
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = $id`).get({ $id: id } as P) as unknown as MsgRow | undefined
    return row ? rowToMsg(row) : null
  }

  updateMessage(id: string, patch: Partial<Pick<Message, 'content' | 'reasoning' | 'stats'>>): boolean {
    const sets: string[] = []
    const params: Record<string, SQLInputValue> = { $id: id }
    if (patch.content   !== undefined) { sets.push('content = $content');     params.$content   = patch.content }
    if (patch.reasoning !== undefined) { sets.push('reasoning = $reasoning'); params.$reasoning = patch.reasoning }
    if (patch.stats     !== undefined) { sets.push('stats = $stats');         params.$stats     = JSON.stringify(patch.stats) }
    if (!sets.length) return false
    return ((this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
  }

  deleteMessage(id: string): boolean {
    return ((this.db.prepare(`DELETE FROM messages WHERE id = $id`).run({ $id: id } as P) as unknown) as Changes).changes > 0
  }

  deleteMessagesAfterSeq(convId: string, seq: number): void {
    this.db.prepare(`DELETE FROM messages WHERE conv_id = $id AND seq > $seq`).run({ $id: convId, $seq: seq } as P)
  }

  getLastMessage(convId: string): Message | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE conv_id = $id ORDER BY seq DESC LIMIT 1`).get({ $id: convId } as P) as unknown as MsgRow | undefined
    return row ? rowToMsg(row) : null
  }

  close(): void { this.db.close() }
}
