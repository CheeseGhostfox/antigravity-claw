import { buildAntigravityApiProvider, buildAntigravityCliProvider } from "./models.js";
export { buildAntigravityApiProvider, buildAntigravityCliProvider };
/** Builds both logical providers in one catalog result for discovery surfaces. */
export function buildAntigravityProviders() {
    return {
        antigravity: buildAntigravityCliProvider(),
        "antigravity-openai": buildAntigravityApiProvider(),
    };
}
