/**
 * One-shot Antigravity CLI child lifecycle: spawn the real headless
 * `agy --input-format stream-json` process through the subprocess seam,
 * publish only after the opening `init` event, flatten post-publication
 * failures, and dispose to whole-range quiescence.
 *
 * @module dsh-subagent-antigravity/run
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  AntigravityHeadlessWire,
  type AntigravityWireFailureFacts,
} from './wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Profile-selectable Antigravity permission posture. */
export type AntigravityPermissionMode =
  | 'default'
  | 'dangerously-skip-permissions'

/** Antigravity non-interactive permission postures mapped to headless flags. */
export const ANTIGRAVITY_PERMISSION_MODES = [
  'default',
  'dangerously-skip-permissions',
] as const satisfies readonly AntigravityPermissionMode[]

/** Safe default for unattended Antigravity runs: the CLI's own policy. */
export const DEFAULT_ANTIGRAVITY_PERMISSION_MODE: AntigravityPermissionMode =
  'default'

type AntigravityFailureStage =
  | 'initialize'
  | AntigravityWireFailureFacts['stage']
  | 'process'
  | 'teardown'

type AntigravityFailureCategory =
  | AntigravityWireFailureFacts['category']
  | 'process'

interface AntigravityFailureFacts {
  readonly stage: AntigravityFailureStage
  readonly category: AntigravityFailureCategory
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: AntigravityFailureFacts): string {
  const fields = [
    'product: Antigravity',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ] as const
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class AntigravityRunFailure extends Error {
  constructor(
    readonly facts: AntigravityFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-antigravity: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'AntigravityRunFailure'
  }
}

/**
 * Hide an unpublished Host failure behind fixed safe startup facts.
 * @param cause Original Host failure retained for internal diagnostics.
 * @returns A startup failure whose message contains only fixed safe facts.
 */
export function antigravityStartupFailure(cause: unknown): Error {
  return new AntigravityRunFailure({
    stage: 'initialize',
    category: 'unknown',
  }, cause)
}

/** Headless stream selection knobs passed through as CLI flags. */
export interface AntigravityRunFlags {
  /** Optional model slug pinned via `--model`; omitted keeps CLI settings. */
  readonly model?: string
  /** Optional reasoning effort pinned via `--effort`. */
  readonly effort?: 'low' | 'medium' | 'high'
  /** Optional agent selected via `--agent`. */
  readonly agent?: string
  /** Profile-selected permission posture. */
  readonly permissionMode: AntigravityPermissionMode
  /** Enable the CLI's terminal sandbox restrictions via `--sandbox`. */
  readonly sandbox: boolean
  /** Optional `--print-timeout` passthrough (e.g. `15m`); omitted keeps the 5m default. */
  readonly printTimeout?: string
}

/**
 * Fixed headless argv for one one-shot conversation process. Unlike the
 * Codex provider there is no npm-distributed payload, so `command` names the
 * product launcher resolved by the host `PATH` (or an absolute path).
 * @param command - executable to run.
 * @param flags - model, effort, agent, permission, sandbox, and timeout knobs.
 * @returns the executable and its fixed headless arguments.
 */
export function antigravityHeadlessArgv(
  command: string,
  flags: AntigravityRunFlags,
): string[] {
  return [
    command,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    ...flags.model === undefined ? [] : ['--model', flags.model],
    ...flags.effort === undefined ? [] : ['--effort', flags.effort],
    ...flags.agent === undefined ? [] : ['--agent', flags.agent],
    ...flags.permissionMode === 'dangerously-skip-permissions'
      ? ['--dangerously-skip-permissions']
      : [],
    ...flags.sandbox ? ['--sandbox'] : [],
    ...flags.printTimeout === undefined ? [] : ['--print-timeout', flags.printTimeout],
  ]
}

/** Fully resolved inputs for one Antigravity headless run. */
export interface AntigravityRunSpec extends AntigravityRunFlags {
  /** Selected child working directory, also the headless conversation cwd. */
  readonly cwd: string
  /** Executable launching the headless CLI (PATH name or absolute path). */
  readonly command: string
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared managed-range owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('subagent-antigravity: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-antigravity: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-antigravity: the one-shot task must not be empty')
  }
  return texts
}

/**
 * Close the private wire, terminate the managed range, and wait for the
 * subprocess owner to prove it is quiescent.
 * @param wire - private headless stream connection.
 * @param child - shared-service handle that owns the managed range.
 */
export async function disposeAntigravityChild(
  wire: AntigravityHeadlessWire,
  child: SubprocessHandle,
): Promise<void> {
  wire.close()

  let outcome: SubprocessOutcome | undefined
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )
  try {
    child.stdin?.end()
  } catch {
    // A concurrently closed stdin does not change range ownership below.
  }
  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    throw new AntigravityRunFailure({
      stage: 'teardown',
      category: 'unknown',
      outcome,
    }, thrown(error))
  }
  await child.done.catch(() => {})
}

/**
 * Start the real headless Antigravity CLI child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, launcher, environment, process service, and diagnostic policy.
 * @returns the published run after the opening `init` event.
 */
export async function startAntigravityRun(
  request: SubagentStartRequest,
  spec: AntigravityRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-antigravity: request was aborted before headless startup')
  }

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: antigravityHeadlessArgv(spec.command, spec),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw new AntigravityRunFailure({
      stage: 'initialize',
      category: 'unknown',
    }, thrown(error))
  }

  const wire = new AntigravityHeadlessWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
  )
  const onStderr = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    try {
      // Synchronous fd forwarding preserves byte order without owning a
      // backpressure queue. A slow host sink can block this event-loop turn.
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // Host stderr is an observation sink, not a child-run failure authority.
    }
  }
  const onStderrError = (): void => {
    // Stderr observation is auxiliary. The event stream and child.done remain
    // the only terminal authorities if the diagnostic stream itself fails.
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  const disposeProcess = async (): Promise<void> => {
    try {
      await disposeAntigravityChild(wire, child)
      // Let stderr already queued by the process close reach the Host before
      // its forwarding listeners are detached.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    } finally {
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
    }
  }

  let processFailureFacts: AntigravityFailureFacts | undefined
  const processFailure: Promise<never> = child.done.then<never>(
    (outcome) => {
      processFailureFacts = {
        stage: 'process',
        category: 'process',
        outcome,
      }
      throw new AntigravityRunFailure(processFailureFacts)
    },
    (error: unknown) => {
      processFailureFacts = {
        stage: 'process',
        category: 'unknown',
      }
      throw new AntigravityRunFailure(processFailureFacts, thrown(error))
    },
  )
  // A normal post-result dispose also closes the process. Keep its expected
  // late rejection observed when the terminal result settles first.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-antigravity: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  try {
    wire.start()
    await Promise.race([wire.initialize(request.signal), processFailure])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = runAbort.signal.aborted
    if (!(error instanceof AntigravityRunFailure) && !cancelledBeforeCleanup) {
      // Node reports stdout EOF before the child close that owns its outcome.
      // Let an already-exiting process publish those facts before rollback.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
    const failure = new AntigravityRunFailure({
      stage: 'initialize',
      category: 'unknown',
      outcome: error instanceof AntigravityRunFailure
        ? error.facts.outcome
        : processFailureFacts?.outcome,
    }, thrown(error))
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      const cleanupFailure = thrown(disposeError)
      throw new AggregateError(
        [failure, cleanupFailure],
        `${failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (cancelledBeforeCleanup) {
      throw new Error('subagent-antigravity: request was aborted before run publication')
    }
    try {
      request.signal.throwIfAborted()
    } catch {
      throw new Error('subagent-antigravity: request was aborted before run publication')
    }
    throw failure
  }

  const collectOutput = (): ContentBlock[] => wire.collectOutput()
  let diagnostic: string | undefined
  const recordFailureDiagnostic = (facts: AntigravityFailureFacts): string => {
    diagnostic = failureDiagnostic(facts)
    return diagnostic
  }
  const withProcessOutcome = (facts: AntigravityFailureFacts): AntigravityFailureFacts => {
    const outcome = processFailureFacts?.outcome
    return outcome === undefined
      ? facts
      : { ...facts, outcome }
  }
  const publishedProcessFailure = processFailure.catch(
    async (error: unknown): Promise<never> => {
      // Frames already queued by the exiting CLI remain authoritative.
      // One I/O turn lets them settle before process exit ends the run.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      throw error
    },
  )
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        const terminal = await Promise.race([
          wire.runTurn(texts, runAbort.signal),
          publishedProcessFailure,
        ])
        return terminal
      } catch (error: unknown) {
        // Give stderr data already queued in Node one turn to reach the Host
        // before error settlement.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const endedBeforeTerminal = wire.endedBeforeTerminal()
        if (
          endedBeforeTerminal
          && processFailureFacts === undefined
          && !runAbort.signal.aborted
        ) {
          try {
            const exited = await child.waitForExit(
              AbortSignal.timeout(Math.ceil(spec.disposeGraceMs)),
            )
            if (exited) await child.done
          } catch {
            // The wire failure remains authoritative when exit observation fails.
          }
        }
        const facts = error instanceof AntigravityRunFailure
          ? error.facts
          : endedBeforeTerminal && processFailureFacts !== undefined
            ? processFailureFacts
            : withProcessOutcome(wire.collectFailure())
        recordFailureDiagnostic(facts)
        throw error instanceof AntigravityRunFailure
          ? error
          : new AntigravityRunFailure(facts, thrown(error))
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
