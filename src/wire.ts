/**
 * Minimal Antigravity CLI headless `stream-json` adapter. This module owns
 * NDJSON framing over the child's stdio, the one-shot `init` handshake, the
 * single `user` event submission, streamed answer observation, and terminal
 * `result` selection. Permissions are owned by the CLI's own non-interactive
 * policy (notices stay on its stderr); there is no server-initiated request
 * surface to answer.
 *
 * @module dsh-subagent-antigravity/wire
 */

import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'

type JsonObject = Record<string, unknown>

/** Product facts owned by the Antigravity wire after publication. */
export interface AntigravityWireFailureFacts {
  readonly stage: 'prompt' | 'result'
  readonly category:
    | 'limit'
    | 'access-policy'
    | 'service'
    | 'transport'
    | 'product-error'
    | 'invalid-result'
    | 'unknown'
}

/** Terminal `status` values documented for the headless result event. */
const TERMINAL_STATUSES = [
  'SUCCESS',
  'ERROR',
  'CANCELED',
  'INTERRUPTED',
  'INVALID',
  'WAITING',
  'RUNNING',
] as const

type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`subagent-antigravity: headless stream returned invalid ${label}`)
  }
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`subagent-antigravity: headless stream returned invalid ${label}`)
  }
  return value
}

/**
 * Map the CLI's own error text to the shared coarse failure vocabulary.
 * The raw text never crosses the result boundary; only the fixed category
 * selected here is published, mirroring the Codex provider's posture.
 */
function errorCategory(error: string | undefined): AntigravityWireFailureFacts['category'] {
  if (error === undefined) return 'unknown'
  if (error.includes('authentication required') || error.includes('unauthorized')) {
    return 'access-policy'
  }
  if (error.includes('invalid model selection') || error.includes('is not recognized')) {
    return 'product-error'
  }
  if (error.includes('quota') || error.includes('usage limit') || error.includes('credits')) {
    return 'limit'
  }
  if (/timed? out|timeout/i.test(error)) return 'service'
  return 'unknown'
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`subagent-antigravity: headless request aborted: ${String(signal.reason)}`)
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One headless stream-json connection and its single one-shot turn.
 *
 * The class deliberately exposes no generic request surface; the headless
 * protocol is exactly `init`, one `user` submission, and its terminal
 * `result`.
 */
export class AntigravityHeadlessWire {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private readonly fatal = Promise.withResolvers<never>()
  private readonly initialized = Promise.withResolvers<void>()
  private resultPayload: PromiseWithResolvers<JsonObject> | undefined
  private lastResponse: string | undefined
  private accumulatedAnswer = ''
  private failure: AntigravityWireFailureFacts | undefined
  private inputEnded = false
  private terminalObserved = false
  private started = false
  private closed = false

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    // Fatal stream state can arrive after the current guarded operation has
    // already settled. Keep the shared rejection observed without inserting
    // another promise-adoption hop into active races.
    void this.fatal.promise.catch(() => {})
    // Pipe errors can race protocol closure and process teardown. Retain the
    // error listener for the lifetime of this per-run stream so no late EPIPE
    // becomes an unhandled EventEmitter error.
    this.output.on('error', this.onOutputError)
  }

  /** Attach stream listeners and begin reading headless events. */
  start(): void {
    if (this.started) return
    this.started = true
    this.input.on('data', this.onData)
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
  }

  /**
   * Whether the headless stream ended before a terminal result event.
   * @returns `true` only for an early stream close without a result.
   */
  endedBeforeTerminal(): boolean {
    return this.inputEnded && !this.terminalObserved
  }

  /**
   * Wait for the stream's opening `init` event — the headless analog of a
   * protocol handshake. Publication happens only after it.
   * @param signal - unpublished-start cancellation.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    await this.guarded(this.initialized.promise, signal)
  }

  /**
   * Submit the one text-only task as a `user` event and wait for this turn's
   * authoritative terminal `result` event.
   * @param texts - already validated task text blocks.
   * @param signal - local cancellation for the published run.
   * @returns the shared subagent result.
   */
  async runTurn(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    const completion = Promise.withResolvers<JsonObject>()
    this.resultPayload = completion
    let payload: JsonObject
    try {
      const message = JSON.stringify({
        event: 'user',
        message: { content: texts.map(text => ({ type: 'text', text })) },
      })
      const flushed = new Promise<void>((resolve, reject) => {
        this.output.write(`${message}\n`, error =>
          error === undefined || error === null ? resolve() : reject(thrown(error)))
      })
      await this.guarded(flushed, signal)
    } catch (error: unknown) {
      this.recordFailure({ stage: 'prompt', category: 'transport' })
      throw error
    }
    try {
      payload = await this.guarded(completion.promise, signal)
    } catch (error: unknown) {
      this.recordFailure({ stage: 'result', category: 'unknown' })
      throw error
    }

    const rawStatus = string(payload.status, 'result status')
    if (!(TERMINAL_STATUSES as readonly string[]).includes(rawStatus)) {
      this.recordFailure({ stage: 'result', category: 'invalid-result' })
      throw new Error(
        `subagent-antigravity: headless stream returned invalid terminal status ${rawStatus}`,
      )
    }
    const status = rawStatus as TerminalStatus
    if (status === 'SUCCESS') {
      this.lastResponse = typeof payload.response === 'string' ? payload.response : undefined
      const output = this.collectOutput()
      if (output.length === 0) {
        this.recordFailure({ stage: 'result', category: 'invalid-result' })
        throw new Error('subagent-antigravity: Antigravity completed without a final answer')
      }
      return { output, stopReason: 'completed' }
    }
    const category = status === 'RUNNING'
      ? 'transport'
      : status === 'WAITING' || status === 'INVALID'
        ? 'product-error'
        : errorCategory(typeof payload.error === 'string' ? payload.error : undefined)
    this.recordFailure({ stage: 'result', category })
    throw new Error(
      `subagent-antigravity: Antigravity run ended with status ${status}`
      + (status === 'ERROR' ? `: ${category}` : ''),
    )
  }

  /**
   * Best-effort remote cancellation. The headless stream has no interrupt
   * request; local settlement and process teardown remain authoritative.
   */
  interrupt(): void {
    // No protocol-level interrupt exists; intentionally a no-op.
  }

  /**
   * The best answer observed for this turn, preserving exact bytes. The
   * terminal `result.response` is authoritative; streamed `agent_response`
   * deltas are the compatibility fallback.
   * @returns the selected final text block, if any.
   */
  collectOutput(): ContentBlock[] {
    const selected = this.lastResponse !== undefined
      ? this.lastResponse
      : this.accumulatedAnswer
    return selected !== undefined && selected.trim().length > 0
      ? [{ type: 'text', text: selected }]
      : []
  }

  /**
   * The structured failure fact observed for this published turn.
   * Call only after a non-completed return or rejection from {@link runTurn}.
   * @returns the fixed stage/category pair.
   */
  collectFailure(): AntigravityWireFailureFacts {
    return this.failure as AntigravityWireFailureFacts
  }

  /** Detach stream listeners. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.started) {
      this.input.off('data', this.onData)
      this.input.off('error', this.onInputError)
      this.input.off('end', this.onInputEnd)
    }
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    const withFatal = Promise.race([this.fatal.promise, pending])
    return raceAbort(withFatal, signal)
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string'
      ? this.decoder.write(Buffer.from(chunk))
      : this.decoder.write(chunk)
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      this.consumeLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    // Surface any final unterminated line before declaring early closure.
    this.buffer += this.decoder.end()
    if (this.buffer.trim().length > 0) this.consumeLine(this.buffer)
    this.buffer = ''
    this.inputEnded = true
    this.fail(new Error('subagent-antigravity: headless stream closed'))
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let event: JsonObject
    try {
      event = object(JSON.parse(trimmed), 'event object')
    } catch (error: unknown) {
      this.fail(thrown(error))
      return
    }
    try {
      this.handleEvent(event)
    } catch (error: unknown) {
      this.fail(thrown(error))
    }
  }

  private handleEvent(event: JsonObject): void {
    const kind = string(event.event, 'event name')
    if (kind === 'init') {
      object(event.init, 'init payload')
      this.initialized.resolve()
      return
    }
    if (kind === 'step_update') {
      const update = object(event.step_update, 'step_update payload')
      if (update.step_type === 'agent_response' && typeof update.text_delta === 'string') {
        this.accumulatedAnswer += update.text_delta
      }
      return
    }
    if (kind === 'result') {
      const payload = object(event.result, 'result payload')
      const completion = this.resultPayload
      if (completion === undefined) return
      this.resultPayload = undefined
      this.terminalObserved = true
      completion.resolve(payload)
      return
    }
    // Unknown events are ignored: the headless stream may grow new
    // observation kinds without breaking older providers.
  }

  private recordFailure(facts: AntigravityWireFailureFacts): void {
    this.failure = facts
  }
}
