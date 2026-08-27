// Antigravity plugin exposes offline catalog metadata to core discovery.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildAntigravityProviders } from "./provider-catalog.js";

const antigravityProviderDiscovery: ProviderPlugin = {
  id: "antigravity",
  label: "Antigravity CLI + API",
  docsPath: "/providers/models",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      providers: buildAntigravityProviders(),
    }),
  },
};

export default antigravityProviderDiscovery;
