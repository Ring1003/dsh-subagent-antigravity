#!/usr/bin/env node
// Mock Antigravity CLI for provider smoke tests. Speaks the official headless
// stream-json protocol documented at antigravity.google/docs/cli/headless/:
//   stdout: {"event":"init",...} → step_update(s) → {"event":"result",...}
//   stdin:  one {"event":"user","message":{"content":[...]}} per turn
// Mode is selected with MOCK_AGY_MODE: ok | error | hang | empty

import { createInterface } from 'node:readline'

const mode = process.env.MOCK_AGY_MODE ?? 'ok'
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

out({
  event: 'init',
  conversation_id: '00000000-mock-0000-0000-000000000000',
  init: { cwd: process.cwd(), tools: ['ask_permission', 'run_command'], permission_mode: 'request-review' },
})

if (mode === 'hang') {
  // Never answer; stay alive (a ref'd interval keeps the loop alive without
  // top-level await, which Node force-exits with code 13 when unsettled).
  const keepAlive = setInterval(() => {}, 60_000)
  process.stdin.on('end', () => { clearInterval(keepAlive); process.exit(0) })
  process.stdin.resume()
}

let input = ''
if (mode !== 'hang') {
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  const message = JSON.parse(trimmed)
  if (message.event !== 'user') return
  const content = message.message.content
  input = (Array.isArray(content)
    ? content.filter(b => b.type === 'text').map(b => b.text).join('')
    : String(content)).trim()

  out({
    event: 'step_update',
    step_update: {
      conversation_id: '00000000-mock-0000-0000-000000000000',
      step_index: 2, state: 'ACTIVE', step_type: 'agent_response',
      text_delta: `pong: ${input}`,
    },
  })
  out({
    event: 'step_update',
    step_update: {
      conversation_id: '00000000-mock-0000-0000-000000000000',
      step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '\n',
    },
  })
  if (mode === 'error') {
    out({
      event: 'result',
      result: {
        conversation_id: '00000000-mock-0000-0000-000000000000',
        status: 'ERROR', response: '', error: 'invalid model selection (--model "x"): model x is not recognized',
        duration_seconds: 0.1, num_turns: 1,
      },
    })
  } else if (mode === 'empty') {
    out({
      event: 'result',
      result: {
        conversation_id: '00000000-mock-0000-0000-000000000000',
        status: 'SUCCESS', response: '   ',
        duration_seconds: 0.1, num_turns: 1,
      },
    })
  } else {
    out({
      event: 'result',
      result: {
        conversation_id: '00000000-mock-0000-0000-000000000000',
        status: 'SUCCESS', response: `pong: ${input}\n`,
        duration_seconds: 0.2, num_turns: 1,
      },
    })
  }
  })
  rl.on('close', () => process.exit(0))
}
