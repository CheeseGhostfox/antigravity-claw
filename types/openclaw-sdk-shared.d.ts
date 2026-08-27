/**
 * Local type declarations for OpenClaw SDK subpaths whose `.d.ts` files are
 * not shipped in the published `openclaw` npm package (upstream gap: the
 * runtime JS is exported, but the `types` condition is missing).
 *
 * The shapes mirror the real SDK types in openclaw/openclaw
 * (`src/config/types.models.ts`, `src/plugin-sdk/provider-catalog-shared.ts`)
 * for the exact surface this plugin uses. Runtime resolution still goes to the
 * real `openclaw` package; this file only exists so `tsc` can typecheck the
 * plugin against a published host.
 */

declare module "openclaw/plugin-sdk/provider-model-shared" {
  /** Normalized model row exposed by a provider catalog (subset of ModelDefinitionConfig). */
  export type ModelDefinitionConfig = {
    id: string;
    name: string;
    reasoning: boolean;
    input: Array<"text" | "image" | "video" | "audio">;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    maxTokens: number;
    agentRuntime?: { id?: string };
  };

  /** Runtime provider config with model rows (subset of ModelProviderConfig). */
  export type ModelProviderConfig = {
    baseUrl: string;
    models: ModelDefinitionConfig[];
  };
}

declare module "openclaw/plugin-sdk/provider-catalog-shared" {
  import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

  /** Normalizes a plugin manifest modelCatalog provider block into runtime config. */
  export function buildManifestModelProviderConfig(params: {
    providerId: string;
    catalog: unknown;
  }): ModelProviderConfig;
}
