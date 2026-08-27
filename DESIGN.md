# Antigravity plugin design

## Goal

Give OpenClaw a first-class Antigravity integration with two hot-switchable
provider routes and automatic backup takeover, replacing ad-hoc CLI spawning
inside a channel adapter.

## Architecture

```
                  model selection (agents.defaults.model)
                                  |
              +-------------------+-------------------+
              |                                       |
     antigravity provider                  antigravity-openai provider
     agentRuntime.id = "antigravity"       (no runtime policy)
              |                                       |
      antigravity harness                    built-in OpenClaw runtime
      (AgentHarnessV2)                       (openai-responses transport,
              |                                API-key auth)
       agy --print stream-json
```

### 1. `antigravity` CLI harness

`harness.ts` registers an `AgentHarnessV2` (`id: "antigravity"`):

- `autoSelection.providerIds = ["antigravity"]` — core probes this harness for
  the CLI provider under `agentRuntime: "auto"`. Model rows also pin
  `agentRuntime.id = "antigravity"` so routing is deterministic.
- `supports(ctx)` returns `{ supported: true }` only when the provider is
  `antigravity`, no authored transport overrides or external credentials are
  involved, and the agy binary passes the availability gate. Any other case
  returns `{ supported: false, fallbackRuntime: "openclaw" }` so the core
  either re-runs on the built-in runtime or advances the model fallback chain —
  explicit, visible failover, never a silent downgrade.
- `runAttempt(params)` spawns:
  `agy --project <prefix>-<sha256(sessionKey)> --print <prompt> --add-dir <workspaceDir> --model <modelId> --output-format stream-json [--sandbox]`.
  `src/agy-client.ts` parses the NDJSON stream (`step_update.text_delta`,
  `result.status/error`), classifies failures (`billing`, `rate_limit`, `auth`,
  `server_error`), kills the process tree on timeout/abort, and never throws.
  The caller's `thinkLevel` maps onto agy `--effort` (low|medium|high) so
  reasoning effort survives the provider switch; a non-zero exit without a
  streamed result or classified stderr surfaces as a failed attempt, never a
  silent ok. Spawn errors, timeouts, and aborts resolve the run immediately
  with a bounded drain backstop, so no turn can hang on a stuck subprocess.
- Deltas stream as `stream: "assistant"` agent events plus
  `onPartialReply({ text, delta })`, so every channel gets native streaming
  replies and core persists the assistant transcript
  (`assistantTranscriptOwned: false`).
- Terminal mapping: ok / timeout (`normalize({ timedOut })`) / external abort
  (`normalize({ aborted, externalAbort })`) / failed prompt error. Quota and
  rate-limit text flows into the terminal error so core failover classification
  matches it and advances the configured fallback chain.

Capabilities are declared conservatively: `contextEngineHostCapabilities`
omits `compact` and `runtime-llm-complete` (agy cannot run native compaction or
LLM callbacks), and `deliveryDefaults.visibleReplies = "automatic"` because agy
is a self-contained replyer with no message-tool channel.

### 2. `antigravity-openai` API-key route

`index.ts` registers a second provider with `createProviderApiKeyAuthMethod`
(`OPENAI_API_KEY`) and a static OpenAI-compatible catalog (`openai-responses`,
`api.openai.com`). These models carry no runtime policy, so core uses the
built-in OpenClaw harness and the provider's native transport. No harness code
is needed for this route — it is native OpenClaw dispatch.

### 3. Hot switching and backup takeover

Two independent failover layers compose:

1. **Runtime fallback** — `supports()` returns `fallbackRuntime: "openclaw"`
   when the CLI is unavailable; the core re-runs the attempt on the built-in
   runtime (and the attempt fails visibly if that route cannot transport).
2. **Model fallback chain** — `agents.defaults.model.fallbacks` lets either
   route back up the other on terminal failures (quota/rate/auth). This is the
   primary hot-switch path: CLI hits quota → core moves to
   `antigravity-openai/gpt-5.6-sol`, and vice versa.

Switching providers is just changing the model selection; the skills
(`antigravity-cli`, `antigravity-api`) document both directions plus cancel and
migration from the old Telegram adapter hack.

## Files

- `index.ts` — plugin entry: harness + both provider registrations.
- `harness.ts` — `AgentHarnessV2` implementation.
- `models.ts` — static catalogs; CLI rows carry `agentRuntime.id`.
- `provider-catalog.ts` / `provider-discovery.ts` — offline catalog facade.
- `src/agy-client.ts` — binary resolution, availability probe, spawn, NDJSON parser, error classifier.
- `openclaw.plugin.json` — manifest: activation, providers, config schema, model catalogs, skills.
- `skills/` — hot-switch playbooks.
