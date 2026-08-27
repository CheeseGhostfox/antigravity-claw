// agy-client pure-function unit tests: stream parsing, error classification,
// project id derivation, and availability gating. These stay SDK-free so the
// tests do not pull core modules into the plugin package.
import { describe, expect, it } from "vitest";
import {
  buildAgyProjectId,
  classifyAgyError,
  getAgyAvailability,
  parseAgyStreamLine,
  runAgyPrint,
} from "./agy-client.js";

describe("parseAgyStreamLine", () => {
  it("parses step_update text deltas", () => {
    const event = parseAgyStreamLine(
      '{"event":"step_update","step_update":{"text_delta":"hi","id":"step-1"}}',
    );
    expect(event).toEqual({ kind: "text-delta", delta: "hi" });
  });

  it("parses reasoning text deltas", () => {
    const event = parseAgyStreamLine(
      '{"event":"step_update","reasoning":{"text_delta":"thinking..."}}',
    );
    expect(event).toEqual({ kind: "reasoning-delta", delta: "thinking..." });
  });

  it("parses result events with error text", () => {
    const event = parseAgyStreamLine(
      '{"event":"result","result":{"status":"error","error":"Quota exceeded"}}',
    );
    expect(event).toEqual({ kind: "result", status: "error", error: "Quota exceeded" });
  });

  it("parses usage events", () => {
    const event = parseAgyStreamLine('{"event":"usage","usage":{"inputTokens":10}}');
    expect(event).toEqual({ kind: "usage", usage: { inputTokens: 10 } });
  });

  it("ignores empty lines and non-JSON log noise", () => {
    expect(parseAgyStreamLine("")).toBeUndefined();
    expect(parseAgyStreamLine("   ")).toBeUndefined();
    expect(parseAgyStreamLine("some plain log line")).toBeUndefined();
    expect(parseAgyStreamLine("{broken json")).toBeUndefined();
  });
});

describe("classifyAgyError", () => {
  it("classifies quota as billing", () => {
    expect(classifyAgyError("Quota exceeded for the Antigravity plan")).toBe("billing");
    expect(classifyAgyError("monthly quota exhausted")).toBe("billing");
  });

  it("classifies rate limits", () => {
    expect(classifyAgyError("Rate Limit: too many requests")).toBe("rate_limit");
    expect(classifyAgyError("HTTP 429 Too Many Requests")).toBe("rate_limit");
  });

  it("classifies auth failures", () => {
    expect(classifyAgyError("You are not logged into Antigravity")).toBe("auth");
    expect(classifyAgyError("invalid token: unauthorized")).toBe("auth");
  });

  it("classifies server errors", () => {
    expect(classifyAgyError("internal server error")).toBe("server_error");
    expect(classifyAgyError("HTTP 503 service unavailable")).toBe("server_error");
  });

  it("returns undefined for unknown text", () => {
    expect(classifyAgyError("some other failure")).toBeUndefined();
    expect(classifyAgyError("")).toBeUndefined();
  });
});

describe("buildAgyProjectId", () => {
  it("derives a stable hash from session identity", () => {
    const first = buildAgyProjectId({
      prefix: "openclaw",
      sessionKey: "chat-123",
      agentId: "agent-a",
      sessionId: "session-1",
    });
    const second = buildAgyProjectId({
      prefix: "openclaw",
      sessionKey: "chat-123",
      agentId: "agent-a",
      sessionId: "session-1",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^openclaw-[0-9a-f]{16}$/);
  });

  it("changes when the session identity changes", () => {
    const a = buildAgyProjectId({ prefix: "openclaw", sessionKey: "chat-1" });
    const b = buildAgyProjectId({ prefix: "openclaw", sessionKey: "chat-2" });
    expect(a).not.toBe(b);
  });

  it("falls back to a default identity", () => {
    expect(buildAgyProjectId({ prefix: "openclaw" })).toMatch(/^openclaw-[0-9a-f]{16}$/);
  });
});

describe("getAgyAvailability", () => {
  it("rejects missing binary paths", () => {
    const availability = getAgyAvailability(undefined);
    expect(availability.ok).toBe(false);
  });

  it("rejects nonexistent binaries", () => {
    const availability = getAgyAvailability("C:/definitely/not/here/agy.exe");
    expect(availability.ok).toBe(false);
  });
});

// Spawn-level integration tests use node itself as the "agy" binary so they
// stay portable across CI platforms without an agy install.
const NODE_BINARY = process.execPath;
const RUN_ARGS = {
  cwd: process.cwd(),
  timeoutMs: 5_000,
};

describe("runAgyPrint", () => {
  it("streams text deltas and returns a clean success", async () => {
    const script = [
      "process.stdout.write(JSON.stringify({event:'step_update',step_update:{text_delta:'hi'}})+'\\n');",
      "process.stdout.write(JSON.stringify({event:'result',result:{status:'success'}})+'\\n');",
    ].join("");
    const result = await runAgyPrint({
      binaryPath: NODE_BINARY,
      args: ["-e", script],
      ...RUN_ARGS,
    });
    expect(result.text).toBe("hi");
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.exitedNonZero).toBe(false);
  });

  it("reports a non-zero exit without a streamed result as a failure", async () => {
    const result = await runAgyPrint({
      binaryPath: NODE_BINARY,
      args: ["-e", "process.stderr.write('boom'); process.exit(3);"],
      ...RUN_ARGS,
    });
    expect(result.exitedNonZero).toBe(true);
    expect(result.exitCode).toBe(3);
    expect(result.error).toMatch(/boom/);
  });

  it("resolves with an error when the binary cannot be spawned", async () => {
    const result = await runAgyPrint({
      binaryPath: "C:/definitely/not/here/agy.exe",
      args: ["--print", "hi"],
      ...RUN_ARGS,
    });
    expect(result.error).toBeTruthy();
    expect(result.timedOut).toBe(false);
  });

  it("resolves timed-out turns without hanging", async () => {
    const result = await runAgyPrint({
      binaryPath: NODE_BINARY,
      args: ["-e", "setInterval(() => {}, 1000);"],
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("resolves aborted turns without hanging", async () => {
    const controller = new AbortController();
    const run = runAgyPrint({
      binaryPath: NODE_BINARY,
      args: ["-e", "setInterval(() => {}, 1000);"],
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await run;
    expect(result.aborted).toBe(true);
  });
});
