import { agentHarnessAttemptTerminal, emitAgentEvent, } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { ANTIGRAVITY_CLI_PROVIDER_ID, ANTIGRAVITY_HARNESS_RUNTIME_ID } from "./models.js";
import { buildAgyProjectId, getAgyAvailability, resolveAgyBinaryPath, runAgyPrint, } from "./src/agy-client.js";
/**
 * Canonical OpenClaw tool names whose exact denies the agy harness can also
 * enforce against its native equivalent. agy exposes no equivalent for these,
 * so denying them natively is trivially safe. Every other deny stays
 * fail-closed in core.
 */
const ANTIGRAVITY_TOOL_POLICY_SAFE_DENY_NAMES = [
    "web_fetch",
    "x_search",
    "memory_search",
    "memory_get",
    "dashboard",
    "canvas",
    "show_widget",
    "message",
    "heartbeat_respond",
    "automations",
    "gateway",
    "skill_workshop",
    "image_generate",
    "music_generate",
    "video_generate",
    "tts",
];
/**
 * Context-engine host capabilities the core can safely provide around this
 * harness. The harness is a black-box agent: core assembles the prompt before
 * runAttempt, persists the transcript after the turn, and maintains session
 * identity. `compact` and `runtime-llm-complete` are deliberately omitted: agy
 * cannot run native OpenClaw compaction or LLM callbacks.
 */
const ANTIGRAVITY_CONTEXT_ENGINE_HOST_CAPABILITIES = [
    "bootstrap",
    "assemble-before-prompt",
    "after-turn",
    "maintain",
];
function readPluginConfig(cfg) {
    const record = (typeof cfg === "object" && cfg !== null ? cfg : {});
    return {
        binaryPath: typeof record.binaryPath === "string" ? record.binaryPath : undefined,
        sandbox: record.sandbox === true,
        projectPrefix: typeof record.projectPrefix === "string" && record.projectPrefix.trim()
            ? record.projectPrefix.trim()
            : "openclaw",
    };
}
/**
 * Maps the OpenClaw think level onto agy's `--effort` surface. agy only
 * accepts low|medium|high; anything below medium is low, anything above is
 * high, and the caller's explicit "off" still runs at low (agy has no no-effort
 * mode). Omitted when the caller did not set a think level.
 */
function mapThinkLevelToAgyEffort(thinkLevel) {
    if (!thinkLevel) {
        return undefined;
    }
    const level = thinkLevel.trim().toLowerCase();
    if (level === "medium") {
        return "medium";
    }
    if (level === "high" ||
        level === "xhigh" ||
        level === "adaptive" ||
        level === "max" ||
        level === "ultra") {
        return "high";
    }
    return "low";
}
/** Sends an agent event to both the global listener and the attempt observer. */
async function emitAttemptEvent(params, event) {
    try {
        emitAgentEvent({
            runId: params.runId,
            stream: event.stream,
            data: event.data,
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        });
    }
    catch {
        // Observers are best-effort; never fail the attempt because a listener threw.
    }
    try {
        await params.onAgentEvent?.(event);
    }
    catch {
        // Same best-effort contract.
    }
}
/**
 * Creates the Antigravity CLI harness that executes `agy --print` turns.
 */
export function createAntigravityAgentHarness(options = {}) {
    const harnessRuntimeId = options.id?.trim().toLowerCase() || ANTIGRAVITY_HARNESS_RUNTIME_ID;
    const resolveAttemptConfig = (config) => resolvePluginConfigObject(config, "antigravity") ??
        (typeof options.resolvePluginConfig === "function"
            ? options.resolvePluginConfig()
            : undefined) ??
        options.pluginConfig;
    /**
     * Builds the canonical attempt result for one agy turn.
     */
    const buildAntigravityAttemptResult = (params, terminal, patch) => ({
        terminal,
        sessionIdUsed: params.sessionId,
        sessionFileUsed: params.sessionFile,
        agentHarnessId: harnessRuntimeId,
        assistantTranscriptOwned: false,
        messagesSnapshot: [],
        assistantTexts: patch?.assistantTexts ?? [],
        toolMetas: [],
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        messagingToolSourceReplyPayloads: [],
        cloudCodeAssistFormatError: false,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    });
    const harness = {
        id: harnessRuntimeId,
        label: options.label ?? "Antigravity CLI agent harness",
        autoSelection: { providerIds: [ANTIGRAVITY_CLI_PROVIDER_ID] },
        authBootstrap: "harness",
        contextEngineHostCapabilities: ANTIGRAVITY_CONTEXT_ENGINE_HOST_CAPABILITIES,
        conversationToolPolicySupport: "exact",
        conversationToolPolicySafeDenyTools: ANTIGRAVITY_TOOL_POLICY_SAFE_DENY_NAMES,
        // agy is a self-contained replyer: it streams its final reply directly and
        // has no message-tool channel, so visible replies must be automatic.
        deliveryDefaults: { visibleReplies: "automatic" },
        supports: (ctx) => {
            const provider = ctx.provider.trim().toLowerCase();
            if (provider !== ANTIGRAVITY_CLI_PROVIDER_ID) {
                return {
                    supported: false,
                    reason: "provider is not the Antigravity CLI provider",
                    fallbackRuntime: "openclaw",
                };
            }
            // agy uses its own local login session, not a prepared API key. Any
            // authored transport override or external credential cannot be
            // reproduced by the CLI.
            if (ctx.modelProvider?.requestTransportOverrides === "present") {
                return {
                    supported: false,
                    reason: "Antigravity CLI cannot reproduce authored request transport overrides",
                    fallbackRuntime: "openclaw",
                };
            }
            const preparedAuth = ctx.modelProvider?.preparedAuth;
            if (preparedAuth &&
                preparedAuth.source !== "none" &&
                preparedAuth.source !== "harness" &&
                preparedAuth.source !== undefined) {
                return {
                    supported: false,
                    reason: "Antigravity CLI uses its own local login, not prepared provider auth",
                    fallbackRuntime: "openclaw",
                };
            }
            const cfg = readPluginConfig(resolveAttemptConfig(undefined));
            const binaryPath = resolveAgyBinaryPath(cfg.binaryPath);
            const availability = getAgyAvailability(binaryPath);
            if (!availability.ok) {
                return {
                    supported: false,
                    reason: availability.reason,
                    fallbackRuntime: "openclaw",
                };
            }
            return { supported: true, priority: 100 };
        },
        runAttempt: async (params) => {
            const startedAt = Date.now();
            const cfg = readPluginConfig(resolveAttemptConfig(params.config));
            const binaryPath = resolveAgyBinaryPath(cfg.binaryPath);
            await emitAttemptEvent(params, {
                stream: "lifecycle",
                data: { phase: "start", startedAt },
            });
            if (!binaryPath) {
                const error = new Error("agy (Antigravity CLI) binary was not found on PATH or in default install locations. " +
                    "Install agy or set plugins.entries.antigravity.config.binaryPath.");
                await emitAttemptEvent(params, {
                    stream: "lifecycle",
                    data: { phase: "error", startedAt, endedAt: Date.now(), error: error.message },
                });
                return buildAntigravityAttemptResult(params, agentHarnessAttemptTerminal.normalize({
                    promptError: error,
                    promptErrorSource: "prompt",
                }));
            }
            const modelId = params.modelId?.trim() || "Gemini 3.7 Flash (High)";
            const workspaceDir = params.workspaceDir?.trim() || params.cwd?.trim() || process.cwd();
            const effort = mapThinkLevelToAgyEffort(params.thinkLevel);
            const args = [
                "--project",
                buildAgyProjectId({
                    prefix: cfg.projectPrefix,
                    sessionKey: params.sessionKey,
                    agentId: params.agentId,
                    sessionId: params.sessionId,
                    runId: params.runId,
                }),
                "--print",
                params.prompt,
                "--add-dir",
                workspaceDir,
                "--model",
                modelId,
                "--output-format",
                "stream-json",
                ...(effort ? ["--effort", effort] : []),
                ...(cfg.sandbox ? ["--sandbox"] : []),
            ];
            let accumulated = "";
            const result = await runAgyPrint({
                binaryPath,
                args,
                cwd: workspaceDir,
                timeoutMs: params.timeoutMs,
                signal: params.abortSignal,
                onEvent: (event) => {
                    if (event.kind === "text-delta") {
                        accumulated += event.delta;
                        void emitAttemptEvent(params, {
                            stream: "assistant",
                            data: { text: accumulated, delta: event.delta },
                        });
                        try {
                            void params.onPartialReply?.({ text: accumulated, delta: event.delta });
                        }
                        catch {
                            // Best-effort stream preview; the transcript still settles below.
                        }
                    }
                },
            });
            let terminal;
            if (result.timedOut) {
                terminal = agentHarnessAttemptTerminal.normalize({
                    timedOut: true,
                    ...(result.error ? { promptError: new Error(result.error) } : {}),
                });
            }
            else if (result.aborted) {
                terminal = agentHarnessAttemptTerminal.normalize({
                    aborted: true,
                    externalAbort: true,
                });
            }
            else if (result.error) {
                terminal = agentHarnessAttemptTerminal.normalize({
                    promptError: new Error(result.error),
                    promptErrorSource: "prompt",
                });
            }
            else if (result.exitedNonZero) {
                // Non-zero exit with no streamed result or classified stderr is still
                // a failed turn: surface it as a prompt error instead of a silent ok.
                terminal = agentHarnessAttemptTerminal.normalize({
                    promptError: new Error(`agy exited with code ${result.exitCode ?? "unknown"} without a streamed result`),
                    promptErrorSource: "prompt",
                });
            }
            else {
                terminal = { kind: "ok" };
            }
            await emitAttemptEvent(params, {
                stream: "lifecycle",
                data: {
                    phase: result.error ? "error" : "end",
                    startedAt,
                    endedAt: Date.now(),
                    ...(result.error ? { error: result.error } : {}),
                },
            });
            return buildAntigravityAttemptResult(params, terminal, {
                assistantTexts: accumulated ? [accumulated] : [],
            });
        },
    };
    return harness;
}
