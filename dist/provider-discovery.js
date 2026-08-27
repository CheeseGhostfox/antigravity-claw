import { buildAntigravityProviders } from "./provider-catalog.js";
const antigravityProviderDiscovery = {
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
