import assert from "node:assert/strict";
import test from "node:test";
import {
  findNextReset,
  FIVE_HOUR_WINDOW_SECONDS,
  formatCountdown,
  formatLocalResetDate,
  parseQuotaPayload,
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
