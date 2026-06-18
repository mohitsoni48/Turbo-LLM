export type PersonaId = 'default' | 'blank' | 'blunt' | 'concise' | 'detailed' | 'formal' | 'tutor' | 'creative' | 'research'

export interface Persona {
  id: PersonaId
  name: string
  description: string
  systemPrompt: string
}

export const PERSONAS: readonly Persona[] = [
  {
    id: 'default',
    name: 'Default',
    description: "Balanced and helpful with chart capability and your personalization settings",
    systemPrompt: '',
  },
  {
    id: 'blank',
    name: 'Blank',
    description: 'Zero system prompt — raw model output, no instructions injected',
    systemPrompt: '',
  },
  {
    id: 'concise',
    name: 'Concise',
    description: 'Shortest possible answers, bullet points over paragraphs',
    systemPrompt:
      'Keep answers as short as possible. Use bullet points over paragraphs when listing multiple items. No preamble, no trailing summary. Answer the question and stop.',
  },
  {
    id: 'detailed',
    name: 'Detailed',
    description: 'Thorough explanations with context, examples, and reasoning',
    systemPrompt:
      'Give thorough, educational explanations. Include relevant context, examples, and reasoning. Do not truncate or summarize — explain fully.',
  },
  {
    id: 'blunt',
    name: 'Blunt',
    description: 'Direct with no filler words or pleasantries',
    systemPrompt:
      'Be direct and blunt. Skip preambles and pleasantries — no "Certainly!", "Of course!", "Great question!". Get to the point immediately. If something is wrong, say so plainly.',
  },
  {
    id: 'formal',
    name: 'Formal',
    description: 'Professional, polished prose suitable for documents',
    systemPrompt:
      'Write in a professional, polished tone. Avoid casual language, contractions, emojis, and conversational filler. Suit your response for a professional document or communication.',
  },
  {
    id: 'tutor',
    name: 'Tutor',
    description: 'Asks a clarifying question first, then teaches step by step',
    systemPrompt:
      'You are a patient teacher. If the question is ambiguous, ask one focused clarifying question before answering. Otherwise, explain step by step as if teaching someone encountering this topic for the first time.',
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Multi-search deep research — runs 3–5 targeted queries before answering, cites all sources',
    systemPrompt:
      'You are a deep research assistant. Every response requires multiple web searches — do NOT compose your answer until you have run at least 3 searches.\n\n' +
      'Required search strategy (follow this every time):\n' +
      '1. Start with a broad query to get an overview and identify key facts\n' +
      '2. Run a second targeted query focusing on the most important specific aspect (version, date, number, name, etc.)\n' +
      '3. Run a third query from a different angle — e.g. "site:reddit.com", comparisons, recent news, or expert opinions\n' +
      '4. If results are thin or contradict each other, run 1–2 more refined searches to resolve the gaps\n' +
      '5. Only compose your answer after all searches are done\n\n' +
      'Query craft rules:\n' +
      '- Use precise terms: model names, version numbers, dates, company names — never vague phrases\n' +
      '- Vary your query angles across searches: overview → specific fact → alternative perspective\n' +
      '- If a search returns stale or irrelevant results, rephrase and search again immediately\n\n' +
      'In your answer:\n' +
      '- Cite every factual claim inline as [source title](url)\n' +
      '- Note conflicts between sources and which you find more credible and why\n' +
      '- Clearly separate what search results say from what you already knew\n' +
      '- If searches failed to answer something, say so explicitly instead of guessing',
  },
  {
    id: 'creative',
    name: 'Creative',
    description: 'Imaginative, vivid language with unexpected angles',
    systemPrompt:
      'Prioritize imagination and novelty. Use vivid language, explore unexpected angles, and bring a distinct voice. Favor interesting over safe.',
  },
]

export interface Personalization {
  assistantName: string
  userName: string
  customInstructions: string
}

const LS_DEFAULT_PERSONA = 'tllm.persona.default'
const LS_CONV_PERSONA = (id: string) => `tllm.persona.conv.${id}`
const LS_ASSISTANT_NAME = 'tllm.personal.assistantName'
const LS_USER_NAME = 'tllm.personal.userName'
const LS_CUSTOM_INSTRUCTIONS = 'tllm.personal.customInstructions'

function isPersonaId(v: unknown): v is PersonaId {
  return PERSONAS.some((p) => p.id === v)
}

export function getDefaultPersonaId(): PersonaId {
  const v = localStorage.getItem(LS_DEFAULT_PERSONA)
  return isPersonaId(v) ? v : 'default'
}

export function setDefaultPersonaId(id: PersonaId): void {
  localStorage.setItem(LS_DEFAULT_PERSONA, id)
}

export function getConvPersonaId(convId: string): PersonaId {
  const v = localStorage.getItem(LS_CONV_PERSONA(convId))
  return isPersonaId(v) ? v : getDefaultPersonaId()
}

export function setConvPersonaId(convId: string, id: PersonaId): void {
  localStorage.setItem(LS_CONV_PERSONA(convId), id)
}

export function getPersonalization(): Personalization {
  return {
    assistantName: localStorage.getItem(LS_ASSISTANT_NAME) ?? '',
    userName: localStorage.getItem(LS_USER_NAME) ?? '',
    customInstructions: localStorage.getItem(LS_CUSTOM_INSTRUCTIONS) ?? '',
  }
}

export function savePersonalization(p: Personalization): void {
  const set = (key: string, val: string) => {
    if (val.trim()) localStorage.setItem(key, val.trim())
    else localStorage.removeItem(key)
  }
  set(LS_ASSISTANT_NAME, p.assistantName)
  set(LS_USER_NAME, p.userName)
  set(LS_CUSTOM_INSTRUCTIONS, p.customInstructions)
}

/** Always-on capability injected into every TurboLLM conversation. Instructs the
 *  model to use text-based charts and graphics when visual output would help — no
 *  external tools or code execution required, pure Unicode/ASCII output. */
const TURBOLLM_BASE_CAPABILITY = `You are running inside TurboLLM, a local-first AI chat app. You can render text-based charts and graphics using Unicode characters. Use them when a visual would genuinely make the response clearer — not by default.

A chart is appropriate when:
- Comparing 3+ items by a numeric metric (rankings, benchmarks, budgets)
- Showing a trend, distribution, or progression over time or stages
- Presenting a hierarchy or dependency tree
- The user asks about data that has a clear pattern hard to read in prose

A chart is NOT appropriate for:
- Conversational replies, opinions, or explanations
- Data with only 1–2 values (just state the numbers inline)
- Lists that are purely qualitative (no meaningful numeric comparison)

When a chart is warranted:
- Bar / column charts: use block fill characters █ ▓ ▒ ░ with a numeric scale and axis labels
- Tables: use box-drawing characters ┌ ─ ┐ │ └ ┘ ├ ┤ ┬ ┴ ┼ for clean borders; align columns
- Line / trend: sketch with · ╌ ╍ ╱ ╲ characters; mark key points with ●
- Tree / hierarchy: use └─ ├─ │ connectors
- Progress / gauge: [████████░░] style with a percentage

Always include a title, axis/column labels, and the underlying numbers. Keep charts compact — no wider than ~60 characters. Wrap chart output in a plain code block (\`\`\`) so spacing is preserved.`

/** Build the hidden system prompt for a new conversation from a persona + personalization. */
export function buildSystemPrompt(personaId: PersonaId, p: Personalization): string {
  if (personaId === 'blank') return ''
  const persona = PERSONAS.find((px) => px.id === personaId)
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const parts: string[] = [TURBOLLM_BASE_CAPABILITY, `Today's date is ${today}.`]
  if (persona?.systemPrompt) parts.push(persona.systemPrompt)
  if (p.assistantName.trim()) parts.push(`Your name is ${p.assistantName.trim()}.`)
  if (p.userName.trim()) parts.push(`The user's name is ${p.userName.trim()}.`)
  if (p.customInstructions.trim()) parts.push(p.customInstructions.trim())
  return parts.join('\n\n')
}
