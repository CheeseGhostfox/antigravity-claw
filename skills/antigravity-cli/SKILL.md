---
name: antigravity-cli
description: Route the current agent turn to the Antigravity CLI (agy) harness. Use when the user asks to switch to / use the Antigravity CLI, Gemini CLI-style local coding agent, or the "antigravity" provider; when the CLI harness should take over from the API-key route; or when troubleshooting agy binary/login availability. The `antigravity` provider routes every model row through this plugin's agent harness via `agentRuntime.id = "antigravity"` and spawns `agy --print`.
user-invocable: false
---

# Antigravity CLI Harness

The `antigravity` provider runs the Antigravity CLI (`agy`) as a self-contained agent harness. Each turn spawns `agy --print "<prompt>" --model "<model>"` against the agy local login session; text deltas stream through the normal OpenClaw assistant pipeline, so replies and transcripts work on every channel without channel-specific hacks.

## When to route to the CLI provider

- The user explicitly asks for the Antigravity CLI / agy / "Antigravity" as the coding backend.
- The user wants the CLI harness to take over from the API-key route (hot switch).
- The CLI is available and logged in, and the API-key route hit quota or rate limits (core failover already prefers the CLI fallback when configured).

## Switch the agent to the CLI provider

Set the agent default model to an `antigravity/*` ref:

- Primary switch: `openclaw models --set-default antigravity/Gemini 3.7 Flash (High)` (or use the config editor on `agents.defaults.model`).
- Recommended fallback chain so API-key dispatch takes over when the CLI hits quota/rate/auth errors:

```jsonc
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "antigravity/Gemini 3.7 Flash (High)",
        "fallbacks": ["antigravity-openai/gpt-5.6-sol"],
      },
    },
  },
}
```

Optionally pin the CLI runtime per model row (same effect as the primary switch, survives future model-default changes):

```jsonc
{
  "models": {
    "providers": {
      "antigravity": {
        "models": {
          "Gemini 3.7 Flash (High)": { "agentRuntime": { "id": "antigravity" } },
        },
      },
    },
  },
}
```

Removing the pin (`"agentRuntime": { "id": "auto" }` or deleting the row) makes harness selection automatic again.

## Check remaining quota (chat)

Use `/quota` in chat to see the agy CLI quota pool (weekly + 5-hour limits) as
progress bars before or while routing to the CLI provider. It reads the agy
login token read-only from the OS keyring/token file; no API key is involved.

## Preflight the CLI

- Binary present: `agy --version`. The plugin also probes `agy --help` and falls back automatically when the binary is missing.
- Logged in: `agy login` (interactive) or check `agy auth status` / `agy whoami` if available. The harness cannot use an API key; it uses the agy local login session.
- List models: `agy models` (requires an active login; do not run it just to probe availability).

## Cancel the switch

Switch back to the native API-key route with `antigravity-api` (set the model to `antigravity-openai/gpt-5.6-sol`) or to any other provider's model ref. Remove any `models.providers.antigravity` pin rows you added.

## Failure behavior

When the CLI binary is missing, not logged in, or the attempt hits quota/rate limits, the harness returns a failed attempt terminal and core either falls back to the same attempt on the built-in OpenClaw runtime or advances the configured model fallback chain (above). The user always sees a visible outcome; nothing fails silently.

## Migration from the old Telegram hack

If the workspace previously forced agy through a Telegram adapter hack (spawn + `editMessageText`), remove that hack. Native channels now receive streamed replies through the harness's assistant events, and transcripts are persisted by core automatically.

