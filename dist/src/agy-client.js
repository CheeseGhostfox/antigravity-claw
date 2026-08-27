// agy (Antigravity CLI) subprocess client: binary resolution, availability
// probe, spawn, and stream-json NDJSON parsing.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const AGY_WINDOWS_DEFAULT_PATHS = [
    path.join(process.env.LOCALAPPDATA ?? "", "agy", "bin", "agy.exe"),
    path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe"),
];
const AGY_UNIX_DEFAULT_PATHS = [
    path.join(os.homedir(), ".local", "bin", "agy"),
    path.join(os.homedir(), ".agy", "bin", "agy"),
];
/** Resolves the agy executable path from config, PATH, or default install locations. */
export function resolveAgyBinaryPath(configuredPath) {
    const explicit = configuredPath?.trim();
    if (explicit) {
        return fs.existsSync(explicit) ? explicit : undefined;
    }
    const onPath = findOnPath("agy");
    if (onPath) {
        return onPath;
    }
    const candidates = process.platform === "win32" ? AGY_WINDOWS_DEFAULT_PATHS : AGY_UNIX_DEFAULT_PATHS;
    return candidates.find((candidate) => fs.existsSync(candidate));
}
function findOnPath(command) {
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const dir of pathEntries) {
        const candidate = path.join(dir, process.platform === "win32" ? `${command}.exe` : command);
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        catch {
            // Unreadable PATH entries are common on Windows; keep scanning.
        }
    }
    return undefined;
}
/** Derives a stable agy project id for one OpenClaw session/agent identity. */
export function buildAgyProjectId(params) {
    const identity = params.sessionKey?.trim() ||
        params.agentId?.trim() ||
        params.sessionId?.trim() ||
        params.runId?.trim() ||
        "default";
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
    return `${params.prefix.trim() || "openclaw"}-${hash}`;
}
// Availability is probed asynchronously (spawn --help) but supports() is
// synchronous, so the probe result is cached and converges within one TTL.
const AVAILABILITY_PROBE_TTL_MS = 30_000;
let cachedAvailability;
let cachedAvailabilityFor;
let cachedAvailabilityAt = 0;
let availabilityProbeInFlight;
function markAvailability(binaryPath, value) {
    cachedAvailability = value;
    cachedAvailabilityFor = binaryPath;
    cachedAvailabilityAt = Date.now();
}
/** Synchronous availability gate: binary presence first, cached probe second. */
export function getAgyAvailability(binaryPath, now = Date.now()) {
    if (!binaryPath) {
        return {
            ok: false,
            reason: "agy (Antigravity CLI) binary was not found on PATH or in default install locations",
        };
    }
    if (!fs.existsSync(binaryPath)) {
        return { ok: false, reason: `agy binary not found at ${binaryPath}` };
    }
    if (cachedAvailabilityFor === binaryPath &&
        now - cachedAvailabilityAt < AVAILABILITY_PROBE_TTL_MS) {
        return cachedAvailability ?? { ok: true };
    }
    // Unknown: optimistically accept and refresh the probe in the background.
    void refreshAgyAvailabilityProbe(binaryPath);
    return { ok: true };
}
/** Runs a bounded `--help` probe so a broken/non-executable binary falls back. */
export function refreshAgyAvailabilityProbe(binaryPath) {
    if (availabilityProbeInFlight) {
        return availabilityProbeInFlight;
    }
    availabilityProbeInFlight = (async () => {
        try {
            const probe = await new Promise((resolve) => {
                try {
                    const child = spawn(binaryPath, ["--help"], {
                        stdio: ["ignore", "pipe", "pipe"],
                        windowsHide: true,
                    });
                    let settled = false;
                    const timer = setTimeout(() => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        child.kill();
                        resolve({ ok: true, reason: "agy --help probe timed out; assuming available" });
                    }, 3_000);
                    child.on("error", (error) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        clearTimeout(timer);
                        resolve({
                            ok: false,
                            reason: `agy failed to start: ${String(error.message ?? error)}`,
                        });
                    });
                    child.on("close", (code) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        clearTimeout(timer);
                        resolve(code === 0
                            ? { ok: true }
                            : { ok: false, reason: `agy exited with code ${code} during availability probe` });
                    });
                }
                catch (error) {
                    resolve({ ok: false, reason: `agy availability probe failed: ${String(error)}` });
                }
            });
            markAvailability(binaryPath, probe.ok ? { ok: true } : { ok: false, reason: probe.reason ?? "agy probe failed" });
        }
        finally {
            availabilityProbeInFlight = undefined;
        }
    })();
    return availabilityProbeInFlight;
}
const RATE_LIMIT_PATTERN = /quota|rate\s*limit|\b429\b|too\s*many\s*requests/i;
const AUTH_PATTERN = /not\s+logged\s+into\s+antigravity|invalid\s+token|unauthori[sz]ed|\b401\b/i;
const SERVER_ERROR_PATTERN = /internal\s+server\s+error|\b50[0-9]\b|service\s+unavailable/i;
/** Classifies agy error text into OpenClaw model-fallback failure kinds. */
export function classifyAgyError(text) {
    if (!text.trim()) {
        return undefined;
    }
    if (RATE_LIMIT_PATTERN.test(text)) {
        return /quota/i.test(text) ? "billing" : "rate_limit";
    }
    if (AUTH_PATTERN.test(text)) {
        return "auth";
    }
    if (SERVER_ERROR_PATTERN.test(text)) {
        return "server_error";
    }
    return undefined;
}
const AGY_EVENT_FIELD_NAMES = new Set([
    "event",
    "step_update",
    "result",
    "reasoning",
    "usage",
    "tool_use",
    "tool_call",
    "message",
]);
/** Parses one NDJSON line from the agy stream. Tolerant of log noise. */
export function parseAgyStreamLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed.startsWith("{")) {
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            return undefined;
        }
        if (!parsed || typeof parsed !== "object") {
            return undefined;
        }
        const record = parsed;
        const stepUpdate = record.step_update;
        if (stepUpdate && typeof stepUpdate === "object") {
            const delta = stepUpdate.text_delta;
            if (typeof delta === "string" && delta.length > 0) {
                return { kind: "text-delta", delta };
            }
        }
        const reasoning = record.reasoning;
        if (reasoning && typeof reasoning === "object") {
            const delta = reasoning.text_delta;
            if (typeof delta === "string" && delta.length > 0) {
                return { kind: "reasoning-delta", delta };
            }
        }
        const usage = record.usage;
        if (usage && typeof usage === "object") {
            return { kind: "usage", usage: usage };
        }
        const result = record.result;
        if (result && typeof result === "object") {
            const resultRecord = result;
            const status = typeof resultRecord.status === "string" ? resultRecord.status : "";
            const error = typeof resultRecord.error === "string"
                ? resultRecord.error
                : typeof resultRecord.message === "string"
                    ? resultRecord.message
                    : undefined;
            return { kind: "result", status, ...(error ? { error } : {}) };
        }
        if (record.event !== undefined) {
            return { kind: "unknown", raw: record };
        }
        return undefined;
    }
    // Non-JSON lines are agy log output; ignore them.
    if (AGY_EVENT_FIELD_NAMES.has(trimmed)) {
        return { kind: "unknown", raw: trimmed };
    }
    return undefined;
}
/** Kills the agy process and its child tree (best effort on Windows). */
export function killAgyProcess(child) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    try {
        child.kill();
    }
    catch {
        // Fall through to taskkill below.
    }
    if (process.platform === "win32" && child.pid !== undefined) {
        try {
            spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
        }
        catch {
            // Best-effort tree cleanup only.
        }
    }
    else if (child.pid !== undefined) {
        // POSIX SIGTERM can be ignored by a hung process; escalate so the
        // timeout/abort backstop below never waits on a process that will not exit.
        try {
            child.kill("SIGKILL");
        }
        catch {
            // Best-effort escalation only.
        }
    }
}
/**
 * Runs one agy `--print` turn and resolves with the accumulated text and
 * terminal facts. Never throws for stream/protocol failures; terminal state is
 * returned in the result so the harness can map it to attempt terminals.
 */
const DRAIN_GRACE_MS = 2_000;
export async function runAgyPrint(options) {
    const { binaryPath, args, cwd, timeoutMs, signal } = options;
    const timeout = Math.max(1, timeoutMs);
    const collected = [];
    const stderrLines = [];
    let terminalError;
    let terminalErrorKind;
    let sawResultEvent = false;
    let timedOut = false;
    let aborted = false;
    let resolved = false;
    const resultState = {
        text: "",
        timedOut: false,
        aborted: false,
        exitedNonZero: false,
        exitCode: null,
    };
    const settle = (patch) => {
        if (resolved) {
            return;
        }
        resolved = true;
        Object.assign(resultState, patch, {
            text: collected.join(""),
            ...(terminalError !== undefined ? { error: terminalError } : {}),
            ...(terminalErrorKind !== undefined ? { errorKind: terminalErrorKind } : {}),
        });
    };
    await new Promise((resolvePromise, rejectPromise) => {
        const handleEvent = async (event) => {
            // Accumulate text synchronously before any observer await so a close
            // racing a slow listener cannot drop the final delta from the result.
            if (event.kind === "text-delta") {
                collected.push(event.delta);
            }
            // Record result terminal facts before the observer await so a slow
            // listener can never delay the error/status freeze past `close`.
            if (event.kind === "result") {
                sawResultEvent = true;
                if (event.status.toUpperCase() === "ERROR" || event.error) {
                    terminalError = event.error?.trim() || `agy returned ${event.status}`;
                    terminalErrorKind = classifyAgyError(terminalError) ?? "unknown";
                }
            }
            try {
                await options.onEvent?.(event);
            }
            catch {
                // Observers are best-effort; never fail the run because a listener threw.
            }
            if (event.kind === "text-delta") {
                return;
            }
        };
        let child;
        let timeoutHandle;
        let drainHandle;
        let stdoutBuffer = "";
        // Backstop so a process that never emits `close` (spawn error, hung
        // process after kill) cannot leave the turn pending forever.
        const scheduleDrainFinish = () => {
            if (drainHandle || resolved) {
                return;
            }
            drainHandle = setTimeout(() => {
                drainHandle = undefined;
                finish();
            }, DRAIN_GRACE_MS);
        };
        const finish = () => {
            clearTimeout(timeoutHandle);
            if (drainHandle) {
                clearTimeout(drainHandle);
                drainHandle = undefined;
            }
            settle({
                timedOut,
                aborted,
                exitedNonZero: child?.exitCode !== 0 && child?.exitCode !== null,
                exitCode: child?.exitCode ?? null,
            });
            resolvePromise();
        };
        try {
            child = spawn(binaryPath, args, {
                cwd,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                shell: false,
            });
        }
        catch (error) {
            terminalError = `failed to spawn agy: ${String(error)}`;
            terminalErrorKind = "unknown";
            finish();
            return;
        }
        child.on("error", (error) => {
            if (!terminalError) {
                terminalError = `agy process error: ${String(error.message ?? error)}`;
                terminalErrorKind = classifyAgyError(terminalError) ?? "unknown";
            }
            // A failed spawn may never emit `close`; resolve the run from `error`.
            finish();
        });
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (!stdout || !stderr) {
            terminalError = "agy subprocess stdio streams were not available";
            terminalErrorKind = "unknown";
            finish();
            return;
        }
        stdout.setEncoding("utf8");
        stdout.on("data", (chunk) => {
            stdoutBuffer += chunk;
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) {
                const event = parseAgyStreamLine(line);
                if (event) {
                    void handleEvent(event);
                }
            }
        });
        stderr.setEncoding("utf8");
        stderr.on("data", (chunk) => {
            const line = chunk.toString();
            if (line.trim()) {
                stderrLines.push(line.trim());
                options.onStderr?.(line);
                const classified = classifyAgyError(line);
                if (classified && !terminalError) {
                    terminalError = line.trim();
                    terminalErrorKind = classified;
                }
            }
        });
        const abortHandler = () => {
            aborted = true;
            if (child) {
                killAgyProcess(child);
            }
            scheduleDrainFinish();
        };
        if (signal?.aborted) {
            abortHandler();
        }
        else {
            signal?.addEventListener("abort", abortHandler, { once: true });
        }
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child) {
                killAgyProcess(child);
            }
            scheduleDrainFinish();
        }, timeout);
        child.on("close", (code) => {
            if (signal) {
                signal.removeEventListener("abort", abortHandler);
            }
            finish();
        });
    });
    if (!terminalError && stderrLines.length > 0 && !sawResultEvent) {
        const last = stderrLines[stderrLines.length - 1];
        if (last === undefined) {
            return resultState;
        }
        terminalError = last;
        terminalErrorKind = classifyAgyError(last) ?? "unknown";
        resultState.error = terminalError;
        resultState.errorKind = terminalErrorKind;
    }
    return resultState;
}
