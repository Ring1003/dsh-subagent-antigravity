/**
 * Smoke test: drive the real startAntigravityRun lifecycle against a mock
 * `agy` speaking the official headless stream-json protocol, through a
 * minimal adapter of the shared subprocess seam contract.
 *
 * @module dsh-subagent-antigravity/test/smoke
 */
import { spawn } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { once } from 'node:events'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { startAntigravityRun, type AntigravityRunSpec } from '../src/run.ts'

const MOCK = resolve(import.meta.dirname, 'mock-agy.mjs')
chmodSync(MOCK, 0o755)

function seamSpawn(spec: SubprocessSpawnSpec): SubprocessHandle {
  const command = spec.argv[0]
  if (command === undefined) throw new Error('smoke: spawn argv must be non-empty')
  const cp = spawn(command, spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'] as const,
    env: { ...process.env, ...spec.env } as NodeJS.ProcessEnv,
  })
  let settled: (() => void) | undefined
  const exited = new Promise<void>((resolveExit) => { settled = resolveExit })
  const done = new Promise<SubprocessOutcome>((resolveDone, rejectDone) => {
    cp.once('error', (error: NodeJS.ErrnoException) => rejectDone(error))
    cp.once('close', (exitCode, signal) => {
      settled?.()
      resolveDone({ exitCode, signal: signal ?? null })
    })
  })
  void done.catch(() => {})
  return {
    stdin: cp.stdin,
    stdout: cp.stdout,
    stderr: cp.stderr,
    control: undefined,
    collected: {},
    done,
    terminate: () => { cp.kill('SIGTERM') },
    waitForExit: async (signal?: AbortSignal) => {
      await Promise.race([
        exited,
        ...(signal === undefined ? [] : [once(signal, 'abort').then(() => {})]),
      ])
      return cp.exitCode !== null || cp.signalCode !== null
    },
  }
}

interface Scenario {
  readonly mode: string
  readonly expect: string
  readonly diagnosticIncludes?: string
  readonly cancel?: boolean
}

const scenarios: readonly Scenario[] = [
  { mode: 'ok', expect: 'completed' },
  { mode: 'error', expect: 'error', diagnosticIncludes: 'category: product-error' },
  { mode: 'empty', expect: 'error', diagnosticIncludes: 'category: invalid-result' },
  { mode: 'hang', expect: 'aborted', cancel: true },
]

for (const scenario of scenarios) {
  const spec: AntigravityRunSpec = {
    cwd: process.cwd(),
    command: MOCK,
    permissionMode: 'default',
    sandbox: false,
    env: { MOCK_AGY_MODE: scenario.mode },
    disposeGraceMs: 1_500,
    spawn: seamSpawn,
  }
  const controller = new AbortController()
  const request = {
    cwd: process.cwd(),
    prompt: [{ type: 'text', text: 'ping' }],
    signal: controller.signal,
  } as unknown as SubagentStartRequest
  const run = await startAntigravityRun(request, spec)
  if (scenario.cancel) setTimeout(() => controller.abort(), 300)
  const result = await run.result
  await run.dispose()
  const text = result.output.map(block => block.type === 'text' ? block.text : '').join('')
  const pass = result.stopReason === scenario.expect
    && (scenario.diagnosticIncludes === undefined
      || (result.diagnostic ?? '').includes(scenario.diagnosticIncludes))
    && (scenario.expect !== 'completed' || text.includes('pong: ping'))
  console.log(
    `[${pass ? 'PASS' : 'FAIL'}] mode=${scenario.mode}`
    + ` stopReason=${result.stopReason}`
    + ` diagnostic=${JSON.stringify(result.diagnostic)}`
    + ` output=${JSON.stringify(text)}`,
  )
  if (!pass) process.exitCode = 1
}
