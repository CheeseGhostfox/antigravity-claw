# Antigravity Claw

Dual-provider [Antigravity](https://antigravity.ai) integration for
[OpenClaw](https://github.com/openclaw/openclaw): a first-class `agy` CLI agent
harness **and** a native OpenAI-compatible API-key route, hot-switchable with
automatic backup takeover.

| Provider             | Backend               | Runtime                                         | Auth                       |
| -------------------- | --------------------- | ----------------------------------------------- | -------------------------- |
| `antigravity`        | Antigravity CLI (`agy`) | Plugin agent harness (`agentRuntime.id = "antigravity"`) | `agy` local login   |
| `antigravity-openai` | OpenAI-compatible API | Built-in OpenClaw runtime                       | API key (`OPENAI_API_KEY`) |

Switching the agent's model selection between the two providers is the hot
switch. Core model fallback (`agents.defaults.model.fallbacks`) takes over
automatically on quota, rate-limit, and auth failures, so the CLI and API
routes back each other up without any channel-specific code.

## Features

- **Native agent harness** — `agy --print` runs as a real OpenClaw
  `AgentHarnessV2`: per-attempt availability probing, NDJSON delta streaming
  into the normal assistant pipeline, persisted transcripts, timeout/abort
  process-tree cleanup, and classified terminal failures (billing, rate limit,
  auth, server error) that feed core failover.
- **Native API-key route** — `antigravity-openai` uses the built-in OpenClaw
  runtime and OpenAI-compatible transport. No CLI binary or login required.
- **Hot switch + backup takeover** — change one model selection to move between
  providers; runtime fallback (`fallbackRuntime: "openclaw"`) and the model
  fallback chain cover missing binaries, missing keys, quota, and rate limits.
- **Skills** — `antigravity-cli` and `antigravity-api` playbooks for routing,
  preflight, cancel, and migration.
- **No channel hacks** — replies and transcripts flow through the standard
  OpenClaw pipeline, so every channel works uniformly.

## Architecture

```
            model selection (agents.defaults.model)
                            |
        +-------------------+-------------------+
        |                                       |
 antigravity provider               antigravity-openai provider
 agentRuntime.id = "antigravity"     (no runtime policy)
        |                                       |
 antigravity harness                  built-in OpenClaw runtime
 (AgentHarnessV2)                      (openai-responses transport,
        |                                API-key auth)
 agy --print stream-json
```

- `harness.ts` — `AgentHarnessV2` implementation (spawn, stream, terminate, failover).
- `src/agy-client.ts` — binary resolution, availability probe, NDJSON parser, error classifier.
- `models.ts`, `provider-catalog.ts`, `provider-discovery.ts` — static offline catalogs.
- `openclaw.plugin.json` — manifest: activation, providers, config schema, model catalogs, skills.
- `skills/` — hot-switch playbooks.

See `DESIGN.md` for the full design rationale.

## Install

Requires OpenClaw `>= 2026.8.1` (currently on the OpenClaw beta channel on npm: `2026.8.1-beta.x`).

```bash
openclaw plugins install git:https://github.com/CheeseGhostfox/antigravity-claw
```

The plugin registers two providers:

- `antigravity` — CLI harness (requires the `agy` binary, see below).
- `antigravity-openai` — API-key route.

### Install the Antigravity CLI (for the `antigravity` provider)

```bash
agy login        # interactive login once
agy --version    # verify
```

If `agy` is not on `PATH`, set an explicit path in the plugin config (below).

## Configuration

Optional `plugins.entries.antigravity.config` block in `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "antigravity": {
        "config": {
          "binaryPath": "C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe",
          "sandbox": true,
          "projectPrefix": "openclaw"
        }
      }
    }
  }
}
```

- `binaryPath` (string) — explicit `agy` executable. Defaults to `agy` on `PATH`, then the Windows AppData install location.
- `sandbox` (boolean, default `true`) — pass `--sandbox` to `agy`.
- `projectPrefix` (string, default `"openclaw"`) — stable prefix for `agy --project <prefix>-<hash>`.

## Usage

### CLI harness (`antigravity`)

```bash
# switch the agent default model to the CLI provider
openclaw models --set-default "antigravity/Gemini 3.7 Flash (High)"
```

CLI models: `Gemini 3.7 Flash (High|Medium|Low)`, `Gemini 3.1 Pro (High|Low)`,
`Gemini 3.6 Flash (High)`.

### API-key route (`antigravity-openai`)

```bash
openclaw onboard   # pick "Antigravity API (OpenAI-compatible)"
# or
export OPENAI_API_KEY=sk-...
openclaw models --set-default antigravity-openai/gpt-5.6-sol
```

API models: `gpt-5.6-sol`, `gpt-5.6`, `gpt-5.2`, `o3`, `gpt-5-mini`.
### Customize the API-key route (models, endpoint, thinking depth)

The OpenAI entries in `openclaw.plugin.json` are the shipped **example**
catalog only. Every request-time detail of the API-key route is configurable in
`openclaw.json` under `models.providers["antigravity-openai"]`; OpenClaw
merges these rows over the plugin's static catalog:

- `baseUrl` — any OpenAI-compatible endpoint (provider-level, or per model).
- `api` — `openai-responses` (default) or `openai-completions`.
- `models[]` — add or replace models: `id`, `name`, `reasoning`, `input`,
  `params`, `contextWindow`, `contextTokens`, `maxTokens`, `compat`.
- `thinkingLevelMap` — map OpenClaw thinking levels (`off|low|medium|high|xhigh|max`)
  to the endpoint's reasoning-effort strings (e.g. `none`, `minimal`, `low`).
- `compat.supportedReasoningEfforts` — which thinking levels OpenClaw offers.
- `compat.supportsReasoningEffort` — whether the endpoint accepts an effort.

```jsonc
{
  "models": {
    "providers": {
      "antigravity-openai": {
        "baseUrl": "https://gateway.example.com/v1",
        "api": "openai-completions",
        "models": [
          {
            "id": "my-reasoning-model",
            "name": "My Reasoning Model",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 128000,
            "contextTokens": 32000,
            "maxTokens": 16000,
            "thinkingLevelMap": {
              "off": "none",
              "low": "minimal",
              "medium": "low",
              "high": "medium",
              "xhigh": "high",
              "max": "high"
            },
            "compat": {
              "supportsReasoningEffort": true,
              "supportedReasoningEfforts": ["none", "minimal", "low", "medium", "high"]
            }
          }
        ]
      }
    }
  }
}
```

The API key stays bound to the provider id (`OPENAI_API_KEY` or
`openclaw auth login antigravity-openai --openai-api-key <key>`), regardless
of which endpoint `baseUrl` points at. Point the agent at the new model:

```bash
openclaw models --set-default antigravity-openai/my-reasoning-model
```

A copyable template lives in `examples/api-key-custom-endpoint.jsonc`.
### Hot switch with backup takeover

Keep one route as primary and the other as automatic fallback:

```jsonc
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "antigravity/Gemini 3.7 Flash (High)",
        "fallbacks": ["antigravity-openai/gpt-5.6-sol"]
      }
    }
  }
}
```

- CLI up → attempts run through `agy --print`, streaming deltas over the normal assistant pipeline.
- CLI binary missing / not logged in / quota hit → the harness returns a failed
  attempt terminal; core advances the fallback chain to the API route (or
  re-runs the attempt on the built-in OpenClaw runtime for the same route).
- API key missing / quota hit → core advances to the CLI fallback.

## Skills

- `antigravity-cli` — route to the CLI harness; availability checks; cancel; migration notes.
- `antigravity-api` — route to the API-key backend; key setup; cancel; migration notes.

## Development

### Build from source

The repo ships committed `dist/` output, so the installed plugin never needs a
build step. To rebuild locally:

```bash
npm install        # installs the openclaw peer (dev dependency) + toolchain
npm run build      # tsc -p tsconfig.build.json -> dist/
npm test           # vitest run src/agy-client.test.ts
npm run typecheck  # tsc -p tsconfig.json
```

Loader-level contract tests (registration, harness gating, failover
classification) live in the OpenClaw monorepo because they use the internal
`plugin-test-runtime` module that is not exported by the published `openclaw`
package; the pure-function suites in `src/` run standalone.

### How packaging works

OpenClaw requires compiled runtime output for externally installed plugin
packages (TypeScript source fallback is only enabled for local `--link` dev
paths). This repo therefore commits `dist/` and declares it explicitly:

```json
{
  "openclaw": {
    "extensions": ["./index.ts"],
    "runtimeExtensions": ["./dist/index.js"]
  },
  "peerDependencies": {
    "openclaw": ">=2026.8.1-0"
  }
}
```

- `openclaw.runtimeExtensions` points the installer at the compiled entry that
  already exists in the repo.
- The `openclaw` peer dependency makes OpenClaw link its host SDK package into
  the plugin's `node_modules`, so `openclaw/plugin-sdk/*` imports resolve at
  runtime.
- Keep `dist/` in sync whenever you change source: `npm run build`, then commit.
- `types/openclaw-sdk-shared.d.ts` supplies local type declarations for SDK subpaths whose `.d.ts` files are not shipped in the published `openclaw` npm package; runtime resolution is unaffected.

## Troubleshooting

- `agy --version` fails → install `agy` or set `binaryPath`. The harness probes
  `agy --help` and falls back automatically.
- "not logged into Antigravity" errors → run `agy login`.
- `agy models` hangs without a login → the plugin never runs it at probe time;
  model ids are static.

## License

MIT — derivative work of [OpenClaw](https://github.com/openclaw/openclaw)
(MIT, Copyright (c) 2026 OpenClaw Foundation). See `LICENSE`.






