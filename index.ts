/**
 * Antigravity plugin entry: registers the agy CLI agent harness and two
 * hot-switchable providers.
 *
 * - `antigravity` (CLI): routes to this plugin's harness, which spawns
 *   `agy --print` and streams deltas through the OpenClaw agent pipeline.
 * - `antigravity-openai` (API key): delegates to the built-in OpenClaw
 *   runtime using the native OpenAI-compatible transport with API-key auth.
 *
 * The manifest ships OpenAI as the example catalog for the API-key route;
 * the endpoint, protocol, models, and thinking-depth mapping are all
 * overridable through `config.models.providers["antigravity-openai"]`.
 * Nothing here is a hard runtime dependency on api.openai.com.
 *
 * Switching the agent's model selection between the two providers is the
 * hot-switch: CLI availability is probed per attempt, and core model fallback
 * (quota/rate-limit/auth errors) can take over to the API route automatically.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { createAntigravityAgentHarness } from "./harness.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  ANTIGRAVITY_API_PROVIDER_ID,
  ANTIGRAVITY_CLI_PROVIDER_ID,
  ANTIGRAVITY_HARNESS_RUNTIME_ID,
  buildAntigravityApiProvider,
  buildAntigravityCliProvider,
} from "./models.js";

// Single source of truth for the onboarding-wizard default model: the
// manifest's example catalog. Users pointing the provider at a custom
// endpoint can pick any configured model as their agent default instead.
const ANTIGRAVITY_DEFAULT_API_MODEL =
  manifest.modelCatalog.providers["antigravity-openai"].defaultModel ?? "gpt-5.6-sol";

/** Builds the agy CLI provider: offline catalog only, no credentials. */
function buildAntigravityCliProviderPlugin(): ProviderPlugin {
  return {
    id: ANTIGRAVITY_CLI_PROVIDER_ID,
    label: "Antigravity CLI",
    docsPath: "/providers/models",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({ provider: buildAntigravityCliProvider() }),
    },
  };
}

/** Builds the OpenAI-compatible API-key provider for native OpenClaw dispatch. */
function buildAntigravityApiProviderPlugin(): ProviderPlugin {
  return {
    id: ANTIGRAVITY_API_PROVIDER_ID,
    label: "Antigravity API (OpenAI-compatible)",
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: ANTIGRAVITY_API_PROVIDER_ID,
        methodId: "api-key",
        label: "API key",
        hint: "API-key access for the antigravity-openai provider (any OpenAI-compatible endpoint; OPENAI_API_KEY is the shipped example)",
        optionKey: "openaiApiKey",
        flagName: "--openai-api-key",
        envVar: "OPENAI_API_KEY",
        promptMessage: "Enter the API key for the antigravity-openai endpoint",
        defaultModel: `${ANTIGRAVITY_API_PROVIDER_ID}/${ANTIGRAVITY_DEFAULT_API_MODEL}`,
        expectedProviders: [ANTIGRAVITY_API_PROVIDER_ID],
        wizard: {
          choiceId: "antigravity-openai-api-key",
          choiceLabel: "API key",
          groupId: ANTIGRAVITY_API_PROVIDER_ID,
          groupLabel: "Antigravity API",
          groupHint: "Native OpenAI-compatible API-key dispatch",
        },
      }),
    ],
    staticCatalog: {
      order: "simple",
      run: async () => ({ provider: buildAntigravityApiProvider() }),
    },
  };
}

export default definePluginEntry({
  id: "antigravity",
  name: "Antigravity CLI + API",
  description:
    "Dual-provider Antigravity integration: agy CLI agent harness and OpenAI-compatible API-key dispatch with hot-switchable backup takeover.",
  register(api) {
    const resolveCurrentConfig = () =>
      api.runtime.config?.current ? (api.runtime.config.current() as OpenClawConfig) : undefined;
    const resolveCurrentPluginConfig = () =>
      resolveLivePluginConfigObject(
        resolveCurrentConfig,
        "antigravity",
        api.pluginConfig as Record<string, unknown>,
      );

    api.registerAgentHarness(
      createAntigravityAgentHarness({
        id: ANTIGRAVITY_HARNESS_RUNTIME_ID,
        pluginConfig: api.pluginConfig,
        resolvePluginConfig: resolveCurrentPluginConfig,
      }),
    );

    api.registerProvider(buildAntigravityCliProviderPlugin());
    api.registerProvider(buildAntigravityApiProviderPlugin());
  },
});
