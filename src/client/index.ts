import type {
  ClientContext,
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
// Side-effect type import: pulls the settings.section SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Side-effect type import: pulls the host's ask event declarations into this program.
import type {} from '../events.ts'
import { AskNodeView } from './AskNode.tsx'
import { AskNotify } from './AskNotify.tsx'
import { AskPeerSettingsSection } from './AskPeerSettings.tsx'
import { FriendRecommendNodeView } from './FriendRecommendNode.tsx'

/** The view-model published for one ask node. */
export interface AskChatData {
  readonly askId: string
  readonly status: 'pending' | 'running' | 'answered' | 'declined'
  readonly caller: string
  readonly question: string
  readonly contextFiles?: string[]
  readonly answer?: string
  readonly truncated?: boolean
  readonly decisionUrl?: string
  readonly decisionToken?: string
}

/** The view-model published for one friend recommendation node. */
export interface FriendRecommendChatData {
  readonly recId: string
  readonly status: 'pending' | 'added' | 'declined'
  readonly from: string
  readonly peer: {
    readonly name: string
    readonly host: string
    readonly port: number
    readonly publicKey: string
    readonly description?: string
    readonly tags?: string[]
  }
  readonly reason?: string
  readonly decisionUrl?: string
  readonly decisionToken?: string
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'ask': AskChatData
    'friend-recommend': FriendRecommendChatData
  }
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

const askDefinition: ConversationNodeDefinition<AskChatData> = {
  kind: 'ask',
  target: 'chat',
  match: (event) => {
    if (event.type === 'ask/request') return { id: event.data.askId, role: 'start' }
    if (event.type === 'ask/decision' || event.type === 'ask/result') {
      return { id: event.data.askId, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'ask/request') throw new Error('ask node requires ask/request')
    return {
      askId: match.event.data.askId,
      status: 'pending',
      caller: match.event.data.caller,
      question: match.event.data.question,
      contextFiles: match.event.data.contextFiles,
      decisionUrl: match.event.data.decisionUrl,
      decisionToken: match.event.data.decisionToken,
    }
  },
  update: (context, match) => {
    if (match.event.type === 'ask/decision') {
      return { ...context.state, status: match.event.data.decision === 'approved' ? 'running' : 'declined' }
    }
    if (match.event.type === 'ask/result') {
      return {
        ...context.state,
        status: 'answered',
        answer: match.event.data.answer,
        truncated: match.event.data.truncated,
      }
    }
    return context.state
  },
  publication: () => 'immediate',
  buildLocationData: () => null,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'ask',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: context.state,
    }
  },
}

const friendRecommendDefinition: ConversationNodeDefinition<FriendRecommendChatData> = {
  kind: 'friend-recommend',
  target: 'chat',
  match: (event) => {
    if (event.type === 'friend/recommend') return { id: event.data.recId, role: 'start' }
    if (event.type === 'friend/decision') return { id: event.data.recId, role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'friend/recommend') throw new Error('friend-recommend node requires friend/recommend')
    return {
      recId: match.event.data.recId,
      status: 'pending',
      from: match.event.data.from,
      peer: match.event.data.peer,
      reason: match.event.data.reason,
      decisionUrl: match.event.data.decisionUrl,
      decisionToken: match.event.data.decisionToken,
    }
  },
  update: (context, match) => {
    if (match.event.type === 'friend/decision') {
      return { ...context.state, status: match.event.data.decision === 'added' ? 'added' : 'declined' }
    }
    return context.state
  },
  publication: () => 'immediate',
  buildLocationData: () => null,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'friend-recommend',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: context.state,
    }
  },
}

export const inject = ['conversationEvents', 'slots']

/** Browser half: register the ask conversation node and its chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(askDefinition)
  ctx.conversationEvents.register(friendRecommendDefinition)
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register({ name: 'conversation.chat.node', key: 'ask', locale: 'conversation' }, AskNodeView),
  )
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'friend-recommend', locale: 'conversation' },
      FriendRecommendNodeView,
    ),
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'ask-peer',
        order: 20,
        label: () => 'Ask Peer',
      },
      AskPeerSettingsSection,
    ),
  )

  // Session-independent ask notification (Answer/Decline toast over any page).
  const notifyContainer = document.createElement('div')
  document.body.appendChild(notifyContainer)
  const notifyRoot = createRoot(notifyContainer)
  notifyRoot.render(createElement(AskNotify))
  ctx.effect(() => () => {
    notifyRoot.unmount()
    notifyContainer.remove()
  })
}
