// Static model catalogs for the Antigravity plugin.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };
/** Provider id for the agy (Antigravity CLI) harness route. */
export const ANTIGRAVITY_CLI_PROVIDER_ID = "antigravity";
/** Provider id for the OpenAI-compatible API-key route. */
export const ANTIGRAVITY_API_PROVIDER_ID = "antigravity-openai";
/** Harness runtime id owned by this plugin. */
export const ANTIGRAVITY_HARNESS_RUNTIME_ID = "antigravity";
/**
 * Builds the agy CLI provider catalog. Model ids are the exact names the
 * Antigravity CLI accepts for `--model`; they stay static because `agy models`
 * requires an interactive login and starts a language server.
 *
 * Every CLI row pins `agentRuntime.id = "antigravity"` so core routing
 * deterministically selects this plugin's harness for the CLI provider.
 */
export function buildAntigravityCliProvider() {
    const provider = buildManifestModelProviderConfig({
        providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
        catalog: manifest.modelCatalog.providers.antigravity,
    });
    return {
        ...provider,
        models: provider.models.map((model) => ({
            ...model,
            agentRuntime: { id: ANTIGRAVITY_HARNESS_RUNTIME_ID },
        })),
    };
}
/**
 * Builds the OpenAI-compatible API-key provider catalog. These rows carry no
 * agentRuntime policy, so core uses the built-in OpenClaw runtime and the
 * provider's native OpenAI-compatible transport with API-key auth.
 */
export function buildAntigravityApiProvider() {
    return buildManifestModelProviderConfig({
        providerId: ANTIGRAVITY_API_PROVIDER_ID,
        catalog: manifest.modelCatalog.providers["antigravity-openai"],
    });
}
