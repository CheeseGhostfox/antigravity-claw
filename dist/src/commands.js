import { AgyQuotaError, fetchAgyQuota } from "./agy-quota.js";
import { renderQuotaTelegram } from "./agy-quota.render.js";
import { ANTIGRAVITY_API_PROVIDER_ID, ANTIGRAVITY_CLI_PROVIDER_ID } from "../models.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };
function listApiKeyProfiles(config) {
    return Object.entries(config.auth?.profiles ?? {})
        .filter(([, profile]) => profile.provider === ANTIGRAVITY_API_PROVIDER_ID)
        .map(([id, profile]) => ({
        id,
        displayName: profile.displayName?.trim() || id,
        email: profile.email?.trim() || null,
        mode: profile.mode,
    }));
}
function apiCatalogModels(config) {
    const configured = config.models?.providers?.[ANTIGRAVITY_API_PROVIDER_ID]?.models;
    if (configured && configured.length > 0) {
        return configured;
    }
    return manifest.modelCatalog.providers[ANTIGRAVITY_API_PROVIDER_ID]?.models ?? [];
}
function apiDefaultModel(config) {
    const provider = manifest.modelCatalog.providers[ANTIGRAVITY_API_PROVIDER_ID];
    return provider?.defaultModel ?? apiCatalogModels(config)[0]?.id ?? "gpt-5.6-sol";
}
function cliQuickSwitchModels() {
    return (manifest.modelCatalog.providers[ANTIGRAVITY_CLI_PROVIDER_ID]?.models ?? []).slice(0, 3);
}
function commandButton(label, command) {
    return { label, action: { type: "command", command } };
}
function buttonsPresentation(title, buttons) {
    return { title, blocks: [{ type: "buttons", buttons }] };
}
// --- /quota ------------------------------------------------------------------
async function runQuotaCommand() {
    try {
        const snapshot = await fetchAgyQuota();
        return { text: renderQuotaTelegram(snapshot) };
    }
    catch (error) {
        if (error instanceof AgyQuotaError) {
            const text = error.kind === "no-credential"
                ? "⚠️ Cannot read the agy login.\n\nRun `agy` once on the gateway host to sign in, " +
                    "or set AGY_OAUTH_TOKEN_FILE to the token file path. Then try /quota again."
                : `⚠️ Failed to fetch Antigravity quota: ${error.message}`;
            return { text };
        }
        return { text: `⚠️ Failed to fetch Antigravity quota: ${String(error)}` };
    }
}
// --- /keys -------------------------------------------------------------------
function buildKeysHelpText(config) {
    const models = apiCatalogModels(config);
    const modelHint = models.length > 0
        ? `\n\nExample: /model ${ANTIGRAVITY_API_PROVIDER_ID}/${models[0]?.id ?? "gpt-5.6-sol"}@<profile>`
        : "";
    return ("Usage:\n" +
        "  /keys                     list API keys and quick-switch buttons\n" +
        "  /keys use <profile>       switch to one key and pick a model\n" +
        "  /keys help                this help\n" +
        modelHint);
}
function buildUseProfileReply(profile, config) {
    const models = apiCatalogModels(config);
    if (models.length === 0) {
        return {
            text: `Profile \`${profile.id}\` selected, but the antigravity-openai catalog has no models. ` +
                "Add models under config.models.providers[\"antigravity-openai\"].models.",
        };
    }
    const buttons = models.map((model) => commandButton(model.name ?? model.id, `/model ${ANTIGRAVITY_API_PROVIDER_ID}/${model.id}@${profile.id}`));
    const text = `Key \`${profile.id}\` ready. Pick a model — the switch applies to this session ` +
        "(add -g for global, -a for agent).\n\n" +
        `Or keep your current model and only swap the key:\n` +
        `/model <current>@${profile.id}`;
    return { text, presentation: buttonsPresentation("Switch API key", buttons) };
}
function buildKeysListReply(config, profiles) {
    const providerButtons = [];
    for (const model of cliQuickSwitchModels()) {
        providerButtons.push(commandButton(`CLI \u00B7 ${model.name ?? model.id}`, `/model ${ANTIGRAVITY_CLI_PROVIDER_ID}/${model.id}`));
    }
    const defaultApiModel = apiDefaultModel(config);
    providerButtons.push(commandButton(`API \u00B7 ${defaultApiModel}`, `/model ${ANTIGRAVITY_API_PROVIDER_ID}/${defaultApiModel}`));
    const keyButtons = profiles.map((profile) => {
        const label = profile.displayName !== profile.id ? `${profile.displayName} (${profile.id})` : profile.id;
        return commandButton(`Key \u00B7 ${label}`, `/keys use ${profile.id}`);
    });
    const lines = [
        "Current model: run `/model` to see it. Switch provider/model/key with the buttons.",
        "",
        "Providers:",
        ...providerButtons.map((button) => `\u2022 ${button.label} \u2192 \`${extractCommand(button)}\``),
    ];
    if (profiles.length > 0) {
        lines.push("", "API keys:", ...keyButtons.map((button) => `\u2022 ${button.label}`));
    }
    else {
        lines.push("", "No antigravity-openai API keys configured yet.", "Add one on the gateway host: `openclaw models auth login --provider antigravity-openai`");
    }
    lines.push("", "Tip: `/think low|medium|high` changes reasoning depth on either route.");
    const blocks = [];
    if (providerButtons.length > 0) {
        blocks.push({ type: "buttons", buttons: providerButtons });
    }
    if (keyButtons.length > 0) {
        blocks.push({ type: "buttons", buttons: keyButtons });
    }
    return {
        text: lines.join("\n"),
        presentation: { title: "Antigravity switch", blocks },
    };
}
function extractCommand(button) {
    if (button.action?.type === "command") {
        return button.action.command;
    }
    return "";
}
async function runKeysCommand(ctx) {
    const args = (ctx.args ?? "").trim();
    const [action, ...rest] = args.split(/\s+/);
    const profiles = listApiKeyProfiles(ctx.config);
    if (action === "help") {
        return { text: buildKeysHelpText(ctx.config) };
    }
    if (action === "use") {
        const profileId = rest.join(" ").trim();
        if (!profileId) {
            return { text: "Usage: /keys use <profile>\n\n" + buildKeysHelpText(ctx.config) };
        }
        const profile = profiles.find((candidate) => candidate.id === profileId);
        if (!profile) {
            const known = profiles.map((candidate) => `\u2022 ${candidate.id}`).join("\n");
            return {
                text: `Unknown API-key profile \`${profileId}\`.${known ? `\n\nConfigured keys:\n${known}` : ""}`,
            };
        }
        return buildUseProfileReply(profile, ctx.config);
    }
    if (action && action.length > 0) {
        return { text: `Unknown /keys action \`${action}\`.\n\n${buildKeysHelpText(ctx.config)}` };
    }
    return buildKeysListReply(ctx.config, profiles);
}
// --- registration ------------------------------------------------------------
export function buildPluginCommands() {
    return [
        {
            name: "quota",
            description: "Show the remaining Antigravity CLI quota pool with progress bars (weekly + 5-hour limits).",
            acceptsArgs: false,
            handler: runQuotaCommand,
        },
        {
            name: "keys",
            description: "List Antigravity API keys and switch provider/model/key with one tap; /keys use <profile>.",
            acceptsArgs: true,
            handler: runKeysCommand,
        },
    ];
}
