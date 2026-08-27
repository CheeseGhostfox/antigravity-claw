/**
 * agy (Antigravity CLI) quota client: credential read and the
 * Cloud Code quota RPC that powers agy's `/usage` panel.
 *
 * The RPC is private/undocumented; the two calls below are reproduced from
 * live agy traffic and match multiple independent OSS implementations
 * (abruption/agy-cli-usage, wakamex/agy-usage, clankercode/quotas):
 *
 *   1. POST /v1internal:loadCodeAssist  {"metadata":{"ideType":"ANTIGRAVITY"}}
 *        -> { cloudaicompanionProject, currentTier }
 *   2. POST /v1internal:retrieveUserQuotaSummary  {"project":<project>}
 *        -> { groups:[{displayName,description,buckets:[...]}], description }
 *
 * agy persists its OAuth token in the OS keyring using the zalando/go-keyring
 * convention (service "gemini", account "antigravity"); long values are stored
 * as `go-keyring-base64:` + base64(JSON). Headless Linux (no Secret Service)
 * falls back to a plain-JSON file at
 * ~/.gemini/antigravity-cli/antigravity-oauth-token.
 *
 * The token is used read-only for the one request and never written back.
 * Account login and token refresh stay with agy itself (running `agy` refreshes
 * the stored token), so this module takes over quota *usage* without touching
 * agy account state or embedding OAuth client credentials.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const KEYRING_SERVICE = "gemini";
const KEYRING_ACCOUNT = "antigravity";
const GO_KEYRING_B64_PREFIX = "go-keyring-base64:";
/** Cloud Code hosts, daily first (matches the current agy channel). */
const QUOTA_HOSTS = ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"];
/** Bounded network budget so a dead endpoint cannot hang a bot reply. */
const FETCH_TIMEOUT_MS = 12_000;
export class AgyQuotaError extends Error {
    kind;
    constructor(message, kind) {
        super(message);
        this.kind = kind;
        this.name = "AgyQuotaError";
    }
}
// --- credential reading ------------------------------------------------------
function defaultTokenFileCandidates() {
    const candidates = [
        path.join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    ];
    const envPath = process.env.AGY_OAUTH_TOKEN_FILE?.trim();
    if (envPath) {
        candidates.unshift(envPath);
    }
    return candidates;
}
function readTokenFile() {
    for (const file of defaultTokenFileCandidates()) {
        try {
            if (existsSync(file)) {
                const content = readFileSync(file, "utf8").trim();
                if (content) {
                    return content;
                }
            }
        }
        catch {
            // Unreadable (permissions) — try the next candidate.
        }
    }
    return null;
}
/** Reads the go-keyring credential blob via the Win32 CredRead API (PowerShell). */
function readWindowsCredentialManager() {
    const target = `${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`;
    const script = `
$ErrorActionPreference='Stop'
$sig = 'using System;
using System.Runtime.InteropServices;
public class CredApi {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  public static string Read(string target){
    IntPtr p; if(!CredRead(target,1,0,out p)) return null;
    try {
      var c=(CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL));
      var b=new byte[c.CredentialBlobSize];
      if(c.CredentialBlobSize>0) Marshal.Copy(c.CredentialBlob,b,0,c.CredentialBlobSize);
      return Convert.ToBase64String(b);
    } finally { CredFree(p); }
  }
}'
Add-Type -TypeDefinition $sig
[CredApi]::Read('${target}')
`;
    return new Promise((resolve) => {
        execFile("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
        ], { encoding: "utf8", windowsHide: true, timeout: 10_000 }, (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            const b64 = stdout.trim();
            if (!b64) {
                resolve(null);
                return;
            }
            let raw;
            try {
                raw = Buffer.from(b64, "base64").toString("utf8");
            }
            catch {
                resolve(null);
                return;
            }
            const utf16 = Buffer.from(b64, "base64").toString("utf16le");
            const looksValid = (s) => s.startsWith(GO_KEYRING_B64_PREFIX) || s.trimStart().startsWith("{");
            resolve(looksValid(raw) ? raw : looksValid(utf16) ? utf16 : raw);
        });
    });
}
/** Reads the credential via platform keyring CLIs (macOS/Linux). */
function readViaKeyringCli() {
    if (process.platform === "darwin") {
        return runKeyringCli("security", [
            "find-generic-password",
            "-s",
            KEYRING_SERVICE,
            "-a",
            KEYRING_ACCOUNT,
            "-w",
        ]);
    }
    if (process.platform === "linux") {
        return runKeyringCli("secret-tool", [
            "lookup",
            "service",
            KEYRING_SERVICE,
            "account",
            KEYRING_ACCOUNT,
        ]);
    }
    return Promise.resolve(null);
}
function runKeyringCli(command, args) {
    return new Promise((resolve) => {
        execFile(command, [...args], { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
            resolve(error ? null : stdout.trim() || null);
        });
    });
}
/** Decodes the raw keyring/file payload into a typed credential. */
export function decodeAgyCredentialSecret(raw) {
    const payload = raw.startsWith(GO_KEYRING_B64_PREFIX)
        ? Buffer.from(raw.slice(GO_KEYRING_B64_PREFIX.length), "base64").toString("utf8")
        : raw;
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch {
        throw new AgyQuotaError("Stored agy credential is not valid JSON", "parse");
    }
    const record = (parsed ?? {});
    const token = record.token ?? record;
    const accessToken = typeof token.access_token === "string" ? token.access_token : undefined;
    if (!accessToken) {
        throw new AgyQuotaError("Stored agy credential has no access_token", "parse");
    }
    return {
        accessToken,
        authMethod: typeof record.auth_method === "string" ? record.auth_method : null,
    };
}
async function readAgyCredentialRaw() {
    if (process.platform === "win32") {
        const fromCredMan = await readWindowsCredentialManager();
        if (fromCredMan) {
            return fromCredMan;
        }
    }
    const fromCli = await readViaKeyringCli();
    if (fromCli) {
        return fromCli;
    }
    return readTokenFile();
}
/** Returns the stored agy access token, read-only. */
export async function resolveAgyAccessToken() {
    const raw = await readAgyCredentialRaw();
    if (!raw) {
        throw new AgyQuotaError("No agy OAuth credential found. Sign in once with the Antigravity CLI (`agy`), " +
            "or set AGY_OAUTH_TOKEN_FILE to the token file path.", "no-credential");
    }
    return decodeAgyCredentialSecret(raw);
}
// --- quota RPC ---------------------------------------------------------------
async function fetchWithTimeout(url, init) {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}
async function postCloudCode(host, accessToken, method, body) {
    const response = await fetchWithTimeout(`https://${host}/v1internal:${method}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity-claw/0.1 (openclaw plugin)",
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new AgyQuotaError(`${method} -> HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`, "api");
    }
    return (await response.json());
}
function extractAccountEmail(uri) {
    const match = uri?.match(/[?&]Email=([^&]+)/);
    if (!match) {
        return null;
    }
    try {
        return decodeURIComponent(match[1]);
    }
    catch {
        return match[1];
    }
}
function bucketKind(window, label) {
    if (window === "weekly" || /week/i.test(label)) {
        return "weekly";
    }
    if (window === "5h" || /5.?hour|five.?hour/i.test(label)) {
        return "5h";
    }
    return window || label;
}
/** Normalizes the raw retrieveUserQuotaSummary payload into a renderable snapshot. */
export function parseQuotaSummary(raw, nowMs = Date.now()) {
    const groups = (raw.groups ?? [])
        .filter((group) => Array.isArray(group.buckets))
        .map((group) => ({
        name: group.displayName?.trim() || "Models",
        models: (group.description ?? "").replace(/^Models within this group:\s*/i, "").trim(),
        buckets: (group.buckets ?? []).map((bucket) => {
            const remaining = bucket.remainingFraction;
            const hasFraction = typeof remaining === "number" && Number.isFinite(remaining);
            const clamped = hasFraction ? Math.max(0, Math.min(1, remaining)) : null;
            const resetMs = bucket.resetTime ? new Date(bucket.resetTime).getTime() : null;
            const resetsInSeconds = resetMs !== null && Number.isFinite(resetMs)
                ? Math.max(0, Math.round((resetMs - nowMs) / 1000))
                : null;
            return {
                kind: bucketKind(bucket.window, bucket.displayName ?? ""),
                label: bucket.displayName?.trim() || bucket.window?.trim() || "Quota",
                remainingFraction: clamped,
                resetTime: bucket.resetTime ?? null,
                resetsInSeconds,
                available: clamped === 1,
                description: bucket.description ?? null,
            };
        }),
    }));
    return {
        account: null,
        tier: null,
        fetchedAt: new Date(nowMs).toISOString(),
        groups,
    };
}
/** Fetches the quota summary from the Cloud Code API, trying each host in order. */
export async function fetchQuotaSummary(accessToken, hosts = QUOTA_HOSTS) {
    let lastError;
    for (const host of hosts) {
        try {
            const load = await postCloudCode(host, accessToken, "loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } });
            const project = load.cloudaicompanionProject;
            if (!project) {
                throw new AgyQuotaError("loadCodeAssist returned no cloudaicompanionProject", "api");
            }
            const raw = await postCloudCode(host, accessToken, "retrieveUserQuotaSummary", { project });
            const snapshot = parseQuotaSummary(raw);
            snapshot.account = extractAccountEmail(load.currentTier?.upgradeSubscriptionUri);
            snapshot.tier =
                load.currentTier?.name?.trim() ||
                    load.currentTier?.id?.trim() ||
                    load.paidTier?.name?.trim() ||
                    load.paidTier?.id?.trim() ||
                    null;
            return snapshot;
        }
        catch (error) {
            // Wrong host -> try the next candidate; auth errors stop early.
            if (error instanceof AgyQuotaError &&
                (error.message.includes("HTTP 401") || error.message.includes("HTTP 403"))) {
                throw error;
            }
            lastError = error;
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new AgyQuotaError("No Cloud Code host responded", "network");
}
/** Convenience: resolve the token then fetch quota. */
export async function fetchAgyQuota() {
    const credential = await resolveAgyAccessToken();
    return await fetchQuotaSummary(credential.accessToken);
}
