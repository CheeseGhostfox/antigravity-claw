---
name: antigravity-api
description: Route the current agent turn to the native OpenAI-compatible API-key route of the Antigravity plugin (provider `antigravity-openai`). Use when the user asks to switch to / use the API-key backend, stop using the Antigravity CLI harness, or when the CLI is unavailable, not logged in, or hitting quota/rate limits and should fall back to native OpenAI API dispatch.
user-invocable: false
---

# Antigravity API-Key Route

The `antigravity-openai` provider is the native OpenClaw API-key route of the Antigravity plugin. It uses the built-in OpenClaw agent runtime and the OpenAI-compatible transport with a standard API key. The plugin manifest ships OpenAI as the example catalog (`api: openai-responses`, `baseUrl: https://api.openai.com/v1`); the endpoint, protocol, models, and thinking-depth mapping are configurable via `models.providers["antigravity-openai"]` in `openclaw.json` (see the plugin README). No CLI binary, login session, or harness subprocess is involved.

## When to route to the API route

- The user explicitly asks for the API-key backend / "OpenAI API" / native dispatch.
- The user wants to take over from the Antigravity CLI harness (hot switch).
- The CLI binary is missing or not logged in, or the CLI route keeps hitting quota/rate limits.

## Configure the API key once

- Interactive: `openclaw onboard` and pick "Antigravity API (OpenAI-compatible)" / `antigravity-openai`, or `openclaw configure`.
- Non-interactive: `openclaw auth login antigravity-openai --openai-api-key <key>` or export `OPENAI_API_KEY=<key>`.

## Switch the agent to the API route

Set the agent default model to an `antigravity-openai/*` ref:

- Primary switch: `openclaw models --set-default antigravity-openai/gpt-5.6-sol` (or edit `agents.defaults.model`).
- Recommended fallback chain so the CLI harness takes over when the API route hits quota/rate limits:

```jsonc
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "antigravity-openai/gpt-5.6-sol",
        "fallbacks": ["antigravity/Gemini 3.7 Flash (High)"],
      },
    },
  },
}
```

Available API models: gpt-5.6-sol, gpt-5.6, gpt-5.2, o3, gpt-5-mini.

## Switch between multiple API keys (chat)

Each API key is an auth profile for provider ntigravity-openai. Use /keys
in chat to list them and tap a provider/model/key button, or:

- /keys use <profile> — pick a key, then tap the model to run
  /model antigravity-openai/<model>@<profile> for this session.
- Add keys on the host: openclaw models auth login --provider antigravity-openai --profile-id <name> --method api-key.
- Swap keys with the model ref suffix: /model antigravity-openai/gpt-5.6-sol@work.
## Point the route at a custom endpoint

`models.providers["antigravity-openai"]` in `openclaw.json` overrides `baseUrl`, `api` (`openai-responses` / `openai-completions`), the model list, `thinkingLevelMap`, and `compat.supportedReasoningEfforts` for the API-key route. The OpenAI models in the plugin manifest are the shipped example only; the plugin README's "Customize the API-key route" section has a copyable template. The API key stays bound to provider `antigravity-openai` regardless of the endpoint.


## Cancel the switch

Switch back to the CLI harness with `antigravity-cli` (set the model to `antigravity/Gemini 3.7 Flash (High)`), or to any other provider's model ref. Remove any `models.providers.antigravity` pin rows you added.

## Failure behavior

API-key auth failures, quota exhaustion, and rate limits surface as visible terminal errors, and core advances the configured model fallback chain (above). The API route has no dependency on the agy binary or login state, so it is the reliable backup when the CLI is unavailable.

## Migration from the old Telegram hack

If the workspace previously forced agy through a Telegram adapter hack, remove that hack. The API route needs no Telegram-specific code: replies and transcripts flow through the standard OpenClaw pipeline.

