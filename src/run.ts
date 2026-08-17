import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
// Side-effect type import: declaration-merges the agentDefaultModel service.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
// Side-effect type import: declaration-merges the approval waterfall we answer.
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Config } from './config.ts'

export interface AskOutcome {
  answer: string
  truncated: boolean
}

const ANSWER_MODE_PREAMBLE =
  "You are answering a question from another engineer's agent. Investigate with " +
  'your tools and workspace, then answer concretely, step by step. Do not modify ' +
  'files, install software, or take other mutating actions: prefer reading and ' +
  'explaining over changing anything. Answer directly from your own workspace: ' +
  'do NOT call ask_peer, ask_peers, or peers_list, and never delegate the ' +
  'question to another agent. Do NOT output tool-call markup such as ' +
  '<tool_calls> in your answer text; if tools are unavailable, answer from ' +
  'the provided context only.'

const EXECUTE_MODE_PREAMBLE =
  "You are helping another engineer's agent from your own workspace. Read the " +
  'question carefully, investigate, and either answer concretely or, when the ' +
  'question asks you to carry out work, do so through the normal permission flow. ' +
  'Answer directly from your own workspace: do NOT call ask_peer, ask_peers, or ' +
  'peers_list, and never delegate the question to another agent.'

/** How many recent user/assistant messages are copied into the answer context. */
const MAX_CONTEXT_MESSAGES = 60

/**
 * Answer one question. The answer is session-level: when a target session
 * exists (explicit `sessionId` or the latest live session), the answering
 * agent receives a COPY of that session's recent conversation as context, so
 * it answers from the engineer's accumulated context. The live session is
 * never modified or interrupted; without any session the agent answers fresh.
 */
export async function runQuestion(
  ctx: Context,
  config: Config,
  question: string,
  contextFiles: readonly string[] | undefined,
  timeoutMs: number,
  sessionId?: string,
): Promise<AskOutcome> {
  const context = resolveSessionContext(ctx, sessionId)
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  const handle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
    // Transient answering sessions: marked as subagent children so they stay
    // out of the main history/sidebar (they are short-lived and must not be
    // reopened from a possibly torn persisted log).
    meta: { cwd: config.workspace, origin: 'subagent' },
    agentOptions: {
      provider: config.provider ?? selection?.provider,
      model: config.model ?? selection?.model,
    },
    // Answering agents never ask other agents: their ask tools are removed
    // from the scoped world, which prevents recursive ask loops.
    setup: (agentCtx) => {
      agentCtx.tools.restrict({
        deny: ['ask_peer', 'ask_peers', 'ask_peer_async', 'ask_result', 'peers_list'],
      })
    },
  })
  // Hard guarantee: the answering agent's sandbox denies every file
  // modification (bash and fs alike), so an ask can never change the host
  // workspace. The approval gate below is a second, independent layer.
  setSandboxMode(handle.agent.session, 'read-only')
  return runAgentTurn(ctx, config, handle, question, contextFiles, timeoutMs, context)
}

/** Copy the recent conversation of the target (or latest) session as context. */
function resolveSessionContext(ctx: Context, sessionId: string | undefined): string | undefined {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return undefined
  let target: Session | undefined
  if (sessionId !== undefined) {
    try {
      target = sessions.get(SessionId(sessionId))
    } catch {
      target = undefined
    }
  }
  target ??= sessions.list().at(-1)
  if (target === undefined) return undefined

  const parts: string[] = []
  for (const event of target.events) {
    if (event.type === 'user/message') {
      const text = textOf(event.data.content)
      if (text.length > 0) parts.push(`[user] ${text}`)
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data.message.content)
      if (text.length > 0) parts.push(`[assistant] ${text}`)
    }
  }
  const recent = stripToolCallMarkup(parts.slice(-MAX_CONTEXT_MESSAGES).join('\n'))
  return recent.length > 0 ? recent : undefined
}

function textOf(blocks: readonly { type?: string; text?: string }[]): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
}

/** Remove tool-call markup that a model wrote as literal text. */
function stripToolCallMarkup(text: string): string {
  const withoutBlocks = text.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '').trim()
  return withoutBlocks
    .split('\n')
    .filter((line) => !/^\s*<invoke[\s\S]*$/.test(line) && !/^\s*<\/invoke>\s*$/.test(line) && !/^\s*<parameter/.test(line))
    .join('\n')
    .trim()
}

/** Drive one answering agent to quiescence and collect its committed text. */
async function runAgentTurn(
  ctx: Context,
  config: Config,
  handle: AgentHandle,
  question: string,
  contextFiles: readonly string[] | undefined,
  timeoutMs: number,
  context: string | undefined,
): Promise<AskOutcome> {
  let answer = ''
  let truncated = false
  let turnError: Error | undefined
  const sessionId = handle.agent.session.id
  const owned = new Set<SessionId>([sessionId])

  const offEvents = ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.header.id !== sessionId || truncated) return
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      turnError = new Error(event.data.reason.error.message)
      return
    }
    if (event.type !== 'assistant/message') return
    for (const block of event.data.message.content) {
      if (block.type !== 'text') continue
      const remaining = config.maxAnswerChars - answer.length
      if (remaining <= 0) {
        truncated = true
        handle.agent.cancel({ kind: 'user' })
        return
      }
      if (block.text.length > remaining) {
        answer += block.text.slice(0, remaining)
        truncated = true
        handle.agent.cancel({ kind: 'user' })
        return
      }
      answer += block.text
    }
  })

  const offApproval = ctx.on('approval/request', async (request, next) => {
    if (!owned.has(request.agent.session.id)) return next()
    if (config.allowExecution) return next()
    return 'rejected'
  })

  try {
    const preamble = config.allowExecution ? EXECUTE_MODE_PREAMBLE : ANSWER_MODE_PREAMBLE
    const contextBlock =
      context !== undefined
        ? `\n\nCopied context from the target session (the live session is untouched; answer using this context):\n${context}`
        : ''
    const files =
      contextFiles && contextFiles.length > 0
        ? `\n\nRelevant files in the colleague's workspace to read first:\n${contextFiles
            .map((file) => `- ${file}`)
            .join('\n')}`
        : ''
    handle.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: `${preamble}${contextBlock}\n\nQuestion:\n${question}${files}` }],
        source: { kind: 'user' },
      }),
    )

    const timer = setTimeout(() => {
      truncated = true
      handle.agent.cancel({ kind: 'user' })
    }, timeoutMs)

    try {
      await handle.agent.whenIdle()
    } finally {
      clearTimeout(timer)
    }
  } finally {
    offEvents()
    offApproval()
    await handle.dispose()
  }

  if (turnError) throw turnError
  const clean = stripToolCallMarkup(answer)
  if (clean.length === 0) {
    throw new Error('the answering agent produced no committed text answer (retry or ask a simpler question)')
  }
  return { answer: clean, truncated }
}
