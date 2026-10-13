/**
 * Profile-named Antigravity CLI one-shot subagent provider. Every accepted
 * run starts a fresh headless `agy --input-format stream-json` conversation
 * process in the delegating Session's workspace and publishes only after the
 * opening `init` event.
 *
 * @module dsh-subagent-antigravity
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  assertUsableCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  ANTIGRAVITY_PERMISSION_MODES,
  DEFAULT_ANTIGRAVITY_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  antigravityStartupFailure,
  startAntigravityRun,
  type AntigravityPermissionMode,
  type AntigravityRunSpec,
} from './run.ts'

export const name = 'subagent-antigravity'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'antigravity'
const DEFAULT_COMMAND = 'agy'

/** Deployment-owned launcher, model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `antigravity`). */
  providerName?: string
  /**
   * Executable launching the headless CLI: a name resolved by the host
   * `PATH` or an absolute path (default `agy`). Unlike the Codex bundle
   * there is no npm-distributed payload to bind to.
   */
  command?: string
  /** Native model slug fixed for this instance; omitted to inherit CLI settings. */
  model?: string
  /** Reasoning effort fixed for this instance (`low`, `medium`, or `high`). */
  effort?: 'low' | 'medium' | 'high'
  /** Agent slug fixed for this instance (list them with `agy agents`). */
  agent?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Non-interactive permission posture fixed for this Provider instance. */
  permissionMode?: AntigravityPermissionMode
  /** Run with the CLI's terminal sandbox restrictions enabled. */
  sandbox?: boolean
  /**
   * `--print-timeout` passthrough for the CLI's response ceiling
   * (e.g. `15m`); omitted keeps the product default of five minutes.
   */
  printTimeout?: string
  /** Grace in milliseconds between headless managed-range termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  command: z.string().min(1).default(DEFAULT_COMMAND),
  model: z.string().min(1),
  effort: z.union(['low', 'medium', 'high'] as const),
  agent: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...ANTIGRAVITY_PERMISSION_MODES])
    .default(DEFAULT_ANTIGRAVITY_PERMISSION_MODE),
  sandbox: z.boolean().default(false),
  printTimeout: z.string().min(1),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Omit<Required<Config>, 'model' | 'effort' | 'agent' | 'printTimeout'>
  & Pick<Config, 'model' | 'effort' | 'agent' | 'printTimeout'>

class AntigravityProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-antigravity', 'child cwd', request.cwd)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-antigravity: request was aborted before headless startup',
        )
      }
      throw antigravityStartupFailure(error)
    }
    const spec: AntigravityRunSpec = {
      cwd,
      command: this.config.command,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      ...this.config.effort === undefined ? {} : { effort: this.config.effort },
      ...this.config.agent === undefined ? {} : { agent: this.config.agent },
      ...this.config.printTimeout === undefined
        ? {}
        : { printTimeout: this.config.printTimeout },
      permissionMode: this.config.permissionMode,
      sandbox: this.config.sandbox,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-antigravity "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startAntigravityRun(request, spec)
  }
}

/**
 * Register one Profile-named Antigravity CLI provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, launcher, model knobs, permission posture, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    command: config.command ?? DEFAULT_COMMAND,
    ...config.model === undefined ? {} : { model: config.model },
    ...config.effort === undefined ? {} : { effort: config.effort },
    ...config.agent === undefined ? {} : { agent: config.agent },
    ...config.printTimeout === undefined
      ? {}
      : { printTimeout: config.printTimeout },
    env: config.env as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_ANTIGRAVITY_PERMISSION_MODE,
    sandbox: config.sandbox ?? false,
    disposeGraceMs: config.disposeGraceMs as number,
  }
  assertPositiveFinite(
    'subagent-antigravity',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-antigravity: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new AntigravityProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
}
