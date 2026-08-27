// Antigravity provider catalog facade used by the runtime entry and discovery.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildAntigravityApiProvider, buildAntigravityCliProvider } from "./models.js";

export type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export { buildAntigravityApiProvider, buildAntigravityCliProvider };

/** Builds both logical providers in one catalog result for discovery surfaces. */
export function buildAntigravityProviders(): Record<string, ModelProviderConfig> {
  return {
    antigravity: buildAntigravityCliProvider(),
    "antigravity-openai": buildAntigravityApiProvider(),
  };
}
