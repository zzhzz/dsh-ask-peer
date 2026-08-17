#!/usr/bin/env node
/**
 * Minimal DeepSeek-compatible streaming chat-completions mock for keyless
 * dsh-ask-peer smoke tests. Not a general-purpose test server.
 *
 * Roles (MOCK_ROLE):
 *   answerer (default) — answers with MOCK_ANSWER text. With
 *                        MOCK_ATTEMPT_WRITE=1, the first real turn per session
 *                        emits a `bash` call that tries to write a file, so
 *                        the test can verify the answering agent's read-only
 *                        sandbox denies it. With MOCK_ASK_LOOP=1 it also emits
 *                        an `ask_peer` call, so the test can verify answering
 *                        agents are denied ask tools (no recursive asks).
 *   asker             — drives a full model round trip: peers_list, then
 *                        ask_peers (peers from MOCK_ASK_PEERS), then a final
 *                        text summarizing both tool results.
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 9001)
const ROLE = process.env.MOCK_ROLE ?? 'answerer'
const ANSWER =
  process.env.MOCK_ANSWER ??
  'Answer: run `make dev` with NODE_ENV=development to stand up the environment.'
const ASK_PEERS = (process.env.MOCK_ASK_PEERS ?? 'bob,carol').split(',').map((s) => s.trim())
const DEFAULT_QUESTION = process.env.MOCK_ASK_QUESTION ?? 'How do I stand up the dev environment?'
const ATTEMPT_WRITE = process.env.MOCK_ATTEMPT_WRITE === '1'
const ASK_LOOP = process.env.MOCK_ASK_LOOP === '1'
const MAX_BODY = 4 * 1024 * 1024

const attemptedWrites = new Set()
const askerSteps = new Map()

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('mock: request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function ssePayload(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`)
}

function usageChunk() {
  return {
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 12,
    },
  }
}

function finish(res) {
  res.write('data: [DONE]\n\n')
  res.end()
}

function respondText(res, text, thinking) {
  ssePayload(res, {
    choices: [{
      delta: { role: 'assistant', content: '', ...(thinking ? { reasoning_content: '' } : {}) },
    }],
  })
  if (thinking) {
    ssePayload(res, { choices: [{ delta: { reasoning_content: 'I will answer this question directly. ' } }] })
  }
  ssePayload(res, { choices: [{ delta: { content: text } }] })
  ssePayload(res, { choices: [{ delta: {}, finish_reason: 'stop' }] })
  ssePayload(res, usageChunk())
  finish(res)
}

function respondToolCall(res, toolName, args, thinking) {
  respondToolCalls(res, [{ name: toolName, args }], thinking)
}

function respondToolCalls(res, calls, thinking) {
  ssePayload(res, {
    choices: [{
      delta: { role: 'assistant', content: '', ...(thinking ? { reasoning_content: '' } : {}) },
    }],
  })
  if (thinking) {
    ssePayload(res, {
      choices: [{ delta: { reasoning_content: 'I should use tools for this. ' } }],
    })
  }
  const firsts = calls.map((call, index) => {
    const mid = Math.floor(call.args.length / 2)
    return {
      index,
      id: `call_mock_${index}`,
      type: 'function',
      function: { name: call.name, arguments: call.args.slice(0, mid) },
    }
  })
  const seconds = calls.map((call, index) => {
    const mid = Math.floor(call.args.length / 2)
    return { index, function: { arguments: call.args.slice(mid) } }
  })
  ssePayload(res, {
    choices: [{
      delta: { content: '', tool_calls: firsts },
    }],
  })
  ssePayload(res, { choices: [{ delta: { tool_calls: seconds } }] })
  ssePayload(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  ssePayload(res, usageChunk())
  finish(res)
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock: unknown path ${url.pathname}` } }))
      return
    }

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock: bad request: ${String(error)}` } }))
      return
    }

    const session = req.headers['x-deepseek-harness-session-id'] ?? 'anon'
    const thinking = body.thinking?.type === 'enabled'
    const messages = Array.isArray(body.messages) ? body.messages : []
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    const hasAskTools =
      hasTools &&
      body.tools.some(
        (tool) =>
          tool.function?.name === 'ask_peer' ||
          tool.function?.name === 'ask_peers' ||
          tool.function?.name === 'peers_list',
      )

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    // Asker role: peers_list -> ask_peers -> summarize.
    if (ROLE === 'asker' && hasAskTools) {
      const step = askerSteps.get(session) ?? 0
      askerSteps.set(session, step + 1)
      const lastUser = [...messages].reverse().find((message) => message.role === 'user')
      const question =
        typeof lastUser?.content === 'string' && lastUser.content.trim().length > 0
          ? lastUser.content.trim()
          : DEFAULT_QUESTION
      if (step === 0) {
        respondToolCall(res, 'peers_list', '{}', thinking)
        return
      }
      if (step === 1) {
        respondToolCall(res, 'ask_peers', JSON.stringify({ peers: ASK_PEERS, question }), thinking)
        return
      }
      const toolResults = messages.filter((message) => message.role === 'tool').map((message) => message.content)
      respondText(
        res,
        `Roster from peers_list:\n${toolResults[0] ?? '(no roster)'}\n\nAnswers from ask_peers:\n${
          toolResults[1] ?? toolResults[0] ?? '(no answers)'
        }`,
        thinking,
      )
      return
    }

    // Answerer role: the first real turn may attempt a workspace write (proves
    // the read-only sandbox) and/or a recursive ask_peer (proves ask tools are
    // denied on answering agents).
    if (ROLE === 'answerer' && hasTools && !attemptedWrites.has(session)) {
      attemptedWrites.add(session)
      const calls = []
      if (ATTEMPT_WRITE) {
        calls.push({ name: 'bash', args: JSON.stringify({ command: 'echo pwned > pwned.txt' }) })
      }
      if (ASK_LOOP) {
        calls.push({ name: 'ask_peer', args: JSON.stringify({ peer: 'ada', question: 'recursion probe' }) })
        calls.push({ name: 'ask_peer_async', args: JSON.stringify({ peer: 'ada', question: 'recursion probe async' }) })
      }
      if (calls.length > 0) {
        respondToolCalls(res, calls, thinking)
        return
      }
    }

    const question = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
    respondText(res, `Answer to "${question}": ${ANSWER}`, thinking)
  })().catch((error) => {
    console.error('[mock-llm]', error)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    if (!res.writableEnded) res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] role=${ROLE} listening on 127.0.0.1:${PORT}`)
})
