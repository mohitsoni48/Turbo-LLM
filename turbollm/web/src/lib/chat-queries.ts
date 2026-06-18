import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createConversation, createExpertConversation, deleteConversation, deleteMessage, editMessage,
  getConversation, listConversations, regenerate, stopGeneration, updateConversation,
} from './chat-api'
import type { Conversation } from './chat-types'

export const chatKeys = {
  list: (q?: string) => ['conversations', q ?? ''] as const,
  detail: (id: string | null) => ['conversation', id] as const,
}

export function useConversations(q?: string) {
  return useQuery({
    queryKey: chatKeys.list(q),
    queryFn: () => listConversations(q),
    staleTime: 0,
    retry: false,
  })
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: chatKeys.detail(id),
    queryFn: () => getConversation(id!),
    enabled: !!id,
    retry: false,
  })
}

export function useConversationMutations() {
  const qc = useQueryClient()

  const invalidateList = () => void qc.invalidateQueries({ queryKey: ['conversations'] })
  const invalidateDetail = (id: string) => void qc.invalidateQueries({ queryKey: chatKeys.detail(id) })

  return {
    create: useMutation({
      mutationFn: (p?: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'modelKey' | 'toolPolicy'>>) => createConversation(p),
      onSuccess: invalidateList,
    }),
    createExpert: useMutation({
      mutationFn: () => createExpertConversation(),
      onSuccess: invalidateList,
    }),
    update: useMutation({
      mutationFn: (v: { id: string } & Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'sampling'>>) => updateConversation(v.id, v),
      onSuccess: (_d, v) => { invalidateList(); invalidateDetail(v.id) },
    }),
    remove: useMutation({
      mutationFn: (id: string) => deleteConversation(id),
      onSuccess: invalidateList,
    }),
    stop: useMutation({
      mutationFn: (convId: string) => stopGeneration(convId),
    }),
    editMsg: useMutation({
      mutationFn: (v: { convId: string; msgId: string; content: string }) => editMessage(v.convId, v.msgId, v.content),
      onSuccess: (_d, v) => invalidateDetail(v.convId),
    }),
    deleteMsg: useMutation({
      mutationFn: (v: { convId: string; msgId: string }) => deleteMessage(v.convId, v.msgId),
      onSuccess: (_d, v) => invalidateDetail(v.convId),
    }),
    regenerate: useMutation({
      mutationFn: (convId: string) => regenerate(convId),
      onSuccess: (_d, convId) => invalidateDetail(convId),
    }),
  }
}
