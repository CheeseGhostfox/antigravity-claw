// Pure-function unit tests for the agy quota client and Telegram renderer.
// SDK-free on purpose, matching the existing agy-client test style.
import { describe, expect, it } from "vitest";
import {
  AgyQuotaError,
  decodeAgyCredentialSecret,
  parseQuotaSummary,
} from "./agy-quota.js";
import {
  formatQuotaDuration,
  renderQuotaBar,
  renderQuotaTelegram,
} from "./agy-quota.render.js";

describe("decodeAgyCredentialSecret", () => {
  it("decodes a go-keyring-base64 wrapped token payload", () => {
    const payload = JSON.stringify({
      token: {
        access_token: "ya29.abc",
        refresh_token: "1//refresh",
        expiry: "2026-08-28T12:00:00.000Z",
      },
      auth_method: "consumer",
    });
    const raw = `go-keyring-base64:${Buffer.from(payload, "utf8").toString("base64")}`;
    const credential = decodeAgyCredentialSecret(raw);
    expect(credential.accessToken).toBe("ya29.abc");
    expect(credential.authMethod).toBe("consumer");
  });

  it("accepts a flat file payload without the keyring prefix", () => {
    const credential = decodeAgyCredentialSecret(
      JSON.stringify({ access_token: "flat-token" }),
    );
    expect(credential.accessToken).toBe("flat-token");
    expect(credential.authMethod).toBeNull();
  });

  it("throws a parse error for invalid JSON", () => {
    expect(() => decodeAgyCredentialSecret("not json")).toThrow(AgyQuotaError);
  });

  it("throws when no access_token is present", () => {
    expect(() => decodeAgyCredentialSecret('{"token":{}}')).toThrow(/no access_token/);
  });
});

describe("parseQuotaSummary", () => {
  const now = Date.parse("2026-08-28T00:00:00.000Z");

  it("normalizes groups and buckets with weekly/5h kinds", () => {
    const snapshot = parseQuotaSummary(
      {
        groups: [
          {
            displayName: "Gemini 3.7 Flash (High)",
            description: "Models within this group: Gemini 3.7 Flash (High)",
            buckets: [
              {
                bucketId: "weekly",
                displayName: "Weekly Limit",
                window: "weekly",
                resetTime: "2026-08-31T00:00:00.000Z",
                remainingFraction: 0.8,
              },
              {
                bucketId: "5h",
                displayName: "5-hour Limit",
                window: "5h",
                resetTime: "2026-08-28T05:00:00.000Z",
                remainingFraction: 0.6,
              },
            ],
          },
        ],
      },
      now,
    );
    expect(snapshot.groups).toHaveLength(1);
    const group = snapshot.groups[0];
    expect(group.name).toBe("Gemini 3.7 Flash (High)");
    expect(group.models).toBe("Gemini 3.7 Flash (High)");
    expect(group.buckets).toHaveLength(2);
    expect(group.buckets[0]).toMatchObject({
      kind: "weekly",
      remainingFraction: 0.8,
      resetsInSeconds: 3 * 24 * 3600,
    });
    expect(group.buckets[1]).toMatchObject({
      kind: "5h",
      remainingFraction: 0.6,
      resetsInSeconds: 5 * 3600,
    });
  });

  it("clamps out-of-range fractions and skips past reset times", () => {
    const snapshot = parseQuotaSummary(
      {
        groups: [
          {
            displayName: "G",
            buckets: [
              { displayName: "W", window: "weekly", remainingFraction: 2.5 },
              { displayName: "H", window: "5h", resetTime: "2026-08-27T00:00:00.000Z" },
            ],
          },
        ],
      },
      now,
    );
    expect(snapshot.groups[0].buckets[0].remainingFraction).toBe(1);
    expect(snapshot.groups[0].buckets[1].remainingFraction).toBeNull();
    expect(snapshot.groups[0].buckets[1].resetsInSeconds).toBe(0);
  });

  it("marks a bucket available when fully remaining", () => {
    const snapshot = parseQuotaSummary(
      {
        groups: [
          { displayName: "G", buckets: [{ displayName: "W", window: "weekly", remainingFraction: 1 }] },
        ],
      },
      now,
    );
    expect(snapshot.groups[0].buckets[0].available).toBe(true);
  });
});

describe("renderQuotaTelegram", () => {
  it("renders progress bars with percentages and reset counts", () => {
    const snapshot = {
      account: "user@example.com",
      tier: "consumer",
      fetchedAt: "2026-08-28T00:00:00.000Z",
      groups: [
        {
          name: "Gemini 3.7 Flash (High)",
          models: "",
          buckets: [
            {
              kind: "weekly",
              label: "Weekly Limit",
              remainingFraction: 0.75,
              resetTime: null,
              resetsInSeconds: 72 * 3600,
              available: false,
              description: null,
            },
            {
              kind: "5h",
              label: "5-hour Limit",
              remainingFraction: 0.1,
              resetTime: null,
              resetsInSeconds: 3600,
              available: false,
              description: null,
            },
          ],
        },
      ],
    };
    const text = renderQuotaTelegram(snapshot);
    expect(text).toContain("Antigravity CLI quota");
    expect(text).toContain("u***@example.com");
    expect(text).toContain("75% remaining");
    expect(text).toContain("resets in 72h 0m");
    expect(text).toContain("10% remaining");
    expect(text).toContain("resets in 1h 0m");
  });

  it("renders an available bucket as fully available", () => {
    const text = renderQuotaTelegram({
      account: null,
      tier: null,
      fetchedAt: "2026-08-28T00:00:00.000Z",
      groups: [
        {
          name: "G",
          models: "",
          buckets: [
            {
              kind: "weekly",
              label: "Weekly Limit",
              remainingFraction: 1,
              resetTime: null,
              resetsInSeconds: null,
              available: true,
              description: null,
            },
          ],
        },
      ],
    });
    expect(text).toContain("available");
  });

  it("handles an empty groups payload gracefully", () => {
    const text = renderQuotaTelegram({
      account: null,
      tier: null,
      fetchedAt: "2026-08-28T00:00:00.000Z",
      groups: [],
    });
    expect(text).toContain("No quota buckets");
  });
});

describe("renderQuotaBar and formatQuotaDuration", () => {
  it("draws a fixed-width bar", () => {
    expect(renderQuotaBar(0.5)).toHaveLength(16);
    expect(renderQuotaBar(1).replace(/\u2591/g, "")).toHaveLength(16);
    expect(renderQuotaBar(0)).toHaveLength(16);
  });

  it("formats durations like the agy panel", () => {
    expect(formatQuotaDuration(73 * 3600 + 5 * 60)).toBe("73h 5m");
    expect(formatQuotaDuration(3600)).toBe("1h 0m");
    expect(formatQuotaDuration(12 * 60)).toBe("12m");
    expect(formatQuotaDuration(45)).toBe("45s");
    expect(formatQuotaDuration(null)).toBeNull();
  });
});

