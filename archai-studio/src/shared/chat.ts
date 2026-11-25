import { z } from 'zod'

export const ThreadSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  title: z.string(),
  model: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type Thread = z.infer<typeof ThreadSchema>

export interface MessageMeta {
  /** Skills injected into the system prompt for this reply (M6). */
  skills?: string[]
  model?: string
  /** Tokens generated and generation time, from Ollama. */
  evalCount?: number
  durationMs?: number
  /** True when the reply was stopped before it finished. */
  stopped?: boolean
}

export interface ChatMessage {
  id: number
  threadId: number
  role: 'user' | 'assistant'
  content: string
  thinking: string | null
  meta: MessageMeta | null
  createdAt: string
}

export interface ModelInfo {
  name: string
  sizeGb: number | null
  parameters: string | null
  quantization: string | null
}

export const ChatSendSchema = z
  .object({
    projectId: z.number().int().positive(),
    threadId: z.number().int().positive().nullable(),
    text: z.string().trim().min(1, 'Type a message first.').max(60_000, 'That message is too long. Paste a shorter extract.'),
    model: z.string().trim().min(1).max(200)
  })
  .strict()
export type ChatSend = z.input<typeof ChatSendSchema>

export interface ChatStarted {
  streamId: string
  threadId: number
  userMessage: ChatMessage
}

export interface ChatChunk {
  streamId: string
  content?: string
  thinking?: string
}
export interface ChatDone {
  streamId: string
  message: ChatMessage
}
export interface ChatError {
  streamId: string
  message: string
}
