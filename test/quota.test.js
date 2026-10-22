import assert from "node:assert/strict";
import test from "node:test";
import {
  findNextReset,
  FIVE_HOUR_WINDOW_SECONDS,
  formatCountdown,
  formatLocalResetDate,
  parseQuotaPayload,
  parseResetCredits,
  WEEKLY_WINDOW_SECONDS,
} from "../src/quota.js";

const now = 1_800_000_000_000;

function window(usedPercent, limitWindowSeconds, resetAt) {
  return {
    used_percent: usedPercent,
    limit_window_seconds: limitWindowSeconds,
    reset_at: resetAt,
  };
}

test("quota percentages are displayed as remaining, not used", () => {
  const result = parseQuotaPayload({
    rate_limit: {
      primary_window: window(20, FIVE_HOUR_WINDOW_SECONDS, now / 1_000 + 3_600),
      secondary_window: window(75, WEEKLY_WINDOW_SECONDS, now / 1_000 + 86_400),
    },
  }, now);

  assert.equal(result.fiveHour.remainingPercent, 80);
  assert.equal(result.weekly.remainingPercent, 25);
});

test("window durations identify 5-hour and weekly quotas even when swapped", () => {
  const result = parseQuotaPayload({
    rate_limit: {
      primary_window: window(30, WEEKLY_WINDOW_SECONDS, now / 1_000 + 86_400),
      secondary_window: window(60, FIVE_HOUR_WINDOW_SECONDS, now / 1_000 + 3_600),
    },
  }, now);

  assert.equal(result.fiveHour.remainingPercent, 40);
  assert.equal(result.weekly.remainingPercent, 70);
  assert.equal(findNextReset(result, now).key, "fiveHour");
});

test("zero and full usage remain distinct from missing data", () => {
  const result = parseQuotaPayload({
    rate_limit: {
      primary_window: window(0, FIVE_HOUR_WINDOW_SECONDS, now / 1_000 + 3_600),
      secondary_window: window(100, WEEKLY_WINDOW_SECONDS, now / 1_000 + 86_400),
    },
  }, now);

  assert.equal(result.fiveHour.remainingPercent, 100);
  assert.equal(result.weekly.remainingPercent, 0);
  assert.equal(parseQuotaPayload({ rate_limit: {} }, now), undefined);
  assert.equal(parseQuotaPayload({ rate_limit: { primary_window: { used_percent: null } } }, now), undefined);
});

test("banked reset count and earliest complete expiration are parsed independently of quota windows", () => {
  const payload = {
    rate_limit_reset_credits: { available_count: 2 },
    reset_credit_details: {
      available_count: 2,
      credits: [
        {
          reset_type: "codex_rate_limits",
          status: "available",
          expires_at: new Date(now + 5 * 86_400_000).toISOString(),
        },
        {
          reset_type: "codex_rate_limits",
          status: "available",
          expires_at: new Date(now + 86_400_000).toISOString(),
        },
      ],
    },
  };

  assert.deepEqual(parseResetCredits(payload, now), {
    availableCount: 2,
    nextExpirationAt: now + 86_400_000,
    expirationStale: false,
  });
  assert.deepEqual(parseResetCredits({
    rate_limit_reset_credits: { available_count: 0 },
  }, now), {
    availableCount: 0,
    nextExpirationAt: null,
    expirationStale: false,
  });
});

test("missing, malformed, partial, and null-expiry reset details stay unavailable", () => {
  const expiry = new Date(now + 86_400_000).toISOString();
  const fullDetails = {
    available_count: 2,
    credits: [
      { reset_type: "codex_rate_limits", status: "available", expires_at: expiry },
      { reset_type: "codex_rate_limits", status: "available", expires_at: expiry },
    ],
  };
  const usageCount = { rate_limit_reset_credits: { available_count: 2 } };
  const incompletePayloads = [
    usageCount,
    { ...usageCount, reset_credit_details: { ...fullDetails, credits: fullDetails.credits.slice(0, 1) } },
    { ...usageCount, reset_credit_details: { ...fullDetails, credits: [null, fullDetails.credits[1]] } },
    {
      ...usageCount,
      reset_credit_details: {
        ...fullDetails,
        credits: [{ ...fullDetails.credits[0], expires_at: null }, fullDetails.credits[1]],
      },
    },
    { ...usageCount, reset_credit_details: { ...fullDetails, credits: [{}, fullDetails.credits[1]] } },
    {
      ...usageCount,
      reset_credit_details: {
        ...fullDetails,
        credits: [
          { ...fullDetails.credits[0], reset_type: "unknown_reset_type" },
          fullDetails.credits[1],
        ],
      },
    },
    {
      ...usageCount,
      reset_credit_details: {
        ...fullDetails,
        credits: [
          { ...fullDetails.credits[0], expires_at: "2028-02-30T00:00:00Z" },
          fullDetails.credits[1],
        ],
      },
    },
  ];

  for (const payload of incompletePayloads) {
    assert.deepEqual(parseResetCredits(payload, now), {
      availableCount: 2,
      nextExpirationAt: null,
      expirationStale: false,
    });
  }

  assert.equal(parseResetCredits({}, now), null);
  assert.equal(parseResetCredits({
    rate_limit_reset_credits: { available_count: "0" },
  }, now), null);
  assert.deepEqual(parseResetCredits({
    ...usageCount,
    reset_credit_details: { ...fullDetails, available_count: 1 },
  }, now), {
    availableCount: 1,
    nextExpirationAt: null,
    expirationStale: false,
  });
});

test("unknown explicit windows are not guessed into a quota", () => {
  const result = parseQuotaPayload({
    rate_limit: {
      primary_window: window(25, 3_600, now / 1_000 + 3_600),
      secondary_window: null,
    },
  }, now);

  assert.equal(result, undefined);
});

test("next reset selects the earliest future window and ignores past or missing timestamps", () => {
  const windows = {
    fiveHour: { remainingPercent: 80, resetAt: now + 3_600_000 },
    weekly: { remainingPercent: 60, resetAt: now + 86_400_000 },
  };

  assert.equal(findNextReset(windows, now).key, "fiveHour");
  assert.equal(findNextReset({
    fiveHour: { remainingPercent: 80, resetAt: now - 1 },
    weekly: { remainingPercent: 60, resetAt: null },
  }, now), undefined);
});

test("reset-after fallback is used when an absolute reset is missing or past", () => {
  const result = parseQuotaPayload({
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: FIVE_HOUR_WINDOW_SECONDS,
        reset_at: now / 1_000 - 10,
        reset_after_seconds: 900,
      },
    },
  }, now);

  assert.equal(result.fiveHour.resetAt, now + 900_000);
});

test("reset time formats in the process local timezone and countdown stays non-negative", () => {
  const timestamp = now + 2 * 86_400_000 + 3_660_000;
  const expected = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));

  assert.equal(formatLocalResetDate(timestamp), expected);
  assert.equal(formatCountdown(timestamp, now), "2d 1h");
  assert.equal(formatCountdown(now + 60_000, now), "1m");
  assert.equal(formatCountdown(now + 500, now), "<1m");
  assert.equal(formatCountdown(now - 1, now), "now");
});
