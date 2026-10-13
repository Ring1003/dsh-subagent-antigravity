---
description: "One-shot Antigravity CLI subagent provider for users and maintainers: install the Profile bundle, configure unattended Antigravity delegation, or troubleshoot headless child runs."
kind: "package-bundle"
---

# dsh-subagent-antigravity

English | [中文](README.zh.md)

## Overview

Install `dsh-subagent-antigravity` into a Profile when delegated work should run in a genuine, unattended Antigravity CLI session in the parent Session's workspace. Each delegation starts a fresh headless Antigravity process, executes exactly one turn for one self-contained text task, and returns only its final answer or a safe failure diagnostic. Native Antigravity configuration and authentication remain authoritative, while `permissionMode` selects the non-interactive approval posture. The Bundle adds its delegation tool as a global tool.

## Table of contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)
- [Model experience](#model-experience)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Enable **Antigravity subagent** on the plugins page, or install with `dsh plugin --profile <name> add dsh-subagent-antigravity`, when tasks should run in a fresh native Antigravity CLI session inside the parent workspace.

### Prerequisites

- The Antigravity CLI is installed and `agy` is on the `PATH` (official installer: <https://antigravity.google/docs/cli/install/>).
- An interactive `agy` session has completed login once — headless mode uses cached credentials only, and an unauthenticated run without a terminal exits with an `authentication required` error instead of hanging.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `antigravity` | Non-empty registry name on `ctx.subagents`; unique per mounted instance |
| `command` | `agy` | Headless CLI launcher: a PATH name or an absolute path |
| `model` | CLI native settings | Optional model slug fixed for this instance (list with `agy models`); omitted preserves CLI settings |
| `effort` | — | Reasoning effort: `low` / `medium` / `high` |
| `agent` | — | Fixed agent slug (list with `agy agents`) |
| `env` | `{}` | Explicit child environment layered over the scrubbed parent environment |
| `permissionMode` | `default` | Non-interactive approval posture: `default` (CLI policy; unapproved tools are soft-denied) or `dangerously-skip-permissions` (approve everything; must be chosen explicitly) |
| `sandbox` | `false` | Append `--sandbox` to enable terminal sandbox restrictions |
| `printTimeout` | — | `--print-timeout` passthrough (e.g. `15m`); omitted keeps the five-minute product default |
| `disposeGraceMs` | `3000` | Grace between managed-range termination tiers |

A configured `model` passes unchanged on every headless start; omission preserves native model selection. The provider does not discover models or rewrite aliases — headless mode exits non-zero on an unknown `--model`, so a bad pin fails loudly. Credential-shaped ambient variables are removed before the explicit `env` overlay, so a key intended for the child must be supplied there.

### Exposing the tool

The Bundle inserts `tool-subagent-antigravity` as a Host entry, so `subagent_antigravity` is a global tool visible to every preset. To mount the provider and tool without selecting the bundle layer, insert the same entries in `cordis.patch.yml`:

```yaml
- insert:
    - id: subagent-antigravity
      name: 'dsh-subagent-antigravity'
    - id: tool-subagent-antigravity
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: antigravity
        toolName: subagent_antigravity
        maxDepth: provider-managed
```

The tool returns a child id on acceptance; a completion notification follows. An external activation executes once — no follow-up input or resumption.

### What you get

The completion notification carries Antigravity's final answer, or a stop reason with an optional safe diagnostic. The parent Session separately persists the external task identity and full terminal result; no local child Session is created. Product reasoning, tool activity, raw stderr, and workspace diffs never enter the parent Session.

### Failure and recovery

A missing launcher, an uninstalled CLI, or an unauthenticated run fails on first delegation with a safe category: pre-publication failures (spawn, or before the `init` event) reject at the `initialize` stage; post-publication failures flatten into a fixed diagnostic (`Product subagent failure (product: Antigravity; stage: …; category: …)`). Cancelled runs settle as `aborted`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### Design concept

- **One fresh process, conversation, and turn per run.** Every run spawns a fresh `agy --input-format stream-json --output-format stream-json`, writes one `user` event, and executes exactly one turn; no continuation, resumption, or pooling.
- **Native configuration is authoritative.** Antigravity settings and authentication stay native via the parent cwd and the system keyring; the provider overrides only the optional model/effort/agent plus permission and timeout flags.
- **Deliberately unattended.** Headless mode has no interactive prompt: tool confirmations are handled by the CLI's own policy (soft-denied by default with an stderr notice), and the product has no server-initiated request surface to answer.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/run.ts`](src/run.ts) | Run lifecycle, publication gate, result selection, diagnostics |
| [`src/wire.ts`](src/wire.ts) | Minimal headless stream-json event-stream implementation |
| [`cordis.patch.yml`](cordis.patch.yml) | Profile layer registering the provider and its global delegation tool |

### Run flow

A start accepts only a non-empty sequence of text blocks and uses the child cwd selected by the subagent service. It spawns the fixed command through the subprocess seam, waits for the stream's opening `init` event (the publication gate), writes one `user` event, and awaits the authoritative `result` event. The answer prefers `result.response`; streamed `agent_response` deltas are the compatibility fallback; a SUCCESS with an empty answer is an `invalid-result` failure. Terminal mapping: `SUCCESS`→completed; `ERROR`→coarse category (invalid model→product-error, authentication→access-policy, quota→limit, timeout→service); `CANCELED`/`INTERRUPTED`→failure; `WAITING`/`INVALID`→product-error; `RUNNING` (process exited before a terminal) →transport. stderr is forwarded verbatim to the Host for observation only.

</details>

-----

<a id="further-exploration"></a>
## Further exploration

- [Official Antigravity CLI headless docs](https://antigravity.google/docs/cli/headless/) — the source of truth for the stream-json protocol, flags, and status values.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the subagent subsystem contract, provider conventions, and terminal-result semantics.
- [`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) — the sibling product backend this plugin mirrors, driving Codex over its official app-server protocol.

-----

<a id="model-experience"></a>
## Model experience

### Child request

The child receives the standalone text blocks as one turn in a fresh headless conversation. Its workspace is the selected child working directory; the provider instance fixes the configured model, effort, agent, environment, and non-interactive approval posture, while an omitted model and all remaining product settings come from the CLI's native configuration. Child tokens never enter the parent context; cache reuse depends only on Antigravity's own provider and request shape.

### Parent scheduling and results (indirect)

Through `dsh-tool-subagent`, the parent model first receives a child id, then Antigravity's final answer or a failure notification with a stop reason and safe diagnostic. Diagnostics contain only fixed stages, categories, and observed process facts. Product reasoning, intermediate messages, tool traffic, stderr, usage, and raw protocol payloads are never copied into the parent Session.

## Known limitations and deferred work

- **A fresh process and turn per run** — no continuation, resumption, pooling, progress streaming into the parent, or product-session persistence.
- **The payload comes from the host PATH** — unlike the Codex bundle's locked npm-package wrapper, the Antigravity CLI has no npm distribution; the deployment must guarantee `command` exists with a controlled version.
- **No protocol-level interrupt** — the headless stream has no `turn/interrupt` equivalent; cancellation is local settlement plus the managed-range termination ladder, and files or external systems changed before cancellation are not rolled back.
- **Approvals are owned by the CLI policy** — unapproved tools are soft-denied (exit 0 plus an stderr notice); `dangerously-skip-permissions` approves everything and must be chosen explicitly.
- **Statically selected instance** — the Profile fixes the provider name, optional model, and tool binding; callers cannot select or modify per call.
- **Authentication and account state stay native** — one interactive login is required; an unauthenticated run without a terminal fails outright.

### Dev note

- The protocol follows the official headless documentation as of 2026-10; the `result` envelope fields (`status`/`response`/`error`/`usage`) and the seven terminal statuses follow that document, and upstream changes require re-verification.
- The smoke test replays four scenarios against a mock `agy` (ok/error/empty/hang+cancel), covering the publication gate, result mapping, failure flattening, and cancel teardown.
