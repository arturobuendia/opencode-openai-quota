import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  QuotaRequestError,
  requestOpenAIUsage,
  RESET_CREDITS_ENDPOINT,
  USAGE_ENDPOINT,
} from "../src/auth.js";
import { createQuotaController, FIVE_HOUR_WINDOW_SECONDS } from "../src/quota.js";

const now = 1_800_000_000_000;

function quotaPayload() {
  return {
    rate_limit: {
      primary_window: {
        used_percent: 25,
        limit_window_seconds: FIVE_HOUR_WINDOW_SECONDS,
        reset_at: now / 1_000 + 3_600,
      },
    },
  };
}

function resetCreditsPayload(count = 2, expiration = now + 86_400_000) {
  return {
    ...quotaPayload(),
    rate_limit_reset_credits: { available_count: count },
    reset_credit_details: {
      available_count: count,
      credits: Array.from({ length: count }, (_, index) => ({
        reset_type: "codex_rate_limits",
        status: "available",
        expires_at: new Date(expiration + index * 86_400_000).toISOString(),
      })),
    },
  };
}

function fakeTimers() {
  const scheduled = [];
  const cleared = [];

  return {
    scheduled,
    cleared,
    setIntervalImpl(callback, milliseconds) {
      const handle = { callback, milliseconds };
      scheduled.push(handle);
      return handle;
    },
    clearIntervalImpl(handle) {
      cleared.push(handle);
    },
  };
}

test("controller schedules one network refresh and one countdown clock, then clears both", async () => {
  const timers = fakeTimers();
  const controller = createQuotaController({
    readCredential: async () => ({ kind: "not-connected" }),
    fetchQuota: async () => {
      assert.fail("a missing OAuth login must not make a request");
    },
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
  });

  controller.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(timers.scheduled.map(({ milliseconds }) => milliseconds), [120_000, 30_000]);
  assert.equal(controller.getSnapshot().status, "not-connected");

  controller.dispose();

  assert.equal(timers.cleared.length, 2);
});

test("manual refreshes do not overlap", async () => {
  let finishRead;
  let readCalls = 0;
  const controller = createQuotaController({
    readCredential: () => {
      readCalls += 1;
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    },
    fetchQuota: async () => quotaPayload(),
    now: () => now,
  });

  const first = controller.refresh();
  const second = await controller.refresh();

  assert.equal(second, false);
  assert.equal(readCalls, 1);

  finishRead({ kind: "oauth", accessToken: randomUUID() });
  assert.equal(await first, true);
  assert.equal(controller.getSnapshot().status, "ready");

  controller.dispose();
});

test("refreshing is observable while unchanged quota data is being fetched", async () => {
  let currentTime = now;
  let attempts = 0;
  let finishRefresh;
  const controller = createQuotaController({
    readCredential: async () => ({ kind: "oauth", accessToken: randomUUID() }),
    fetchQuota: async () => {
      attempts += 1;

      if (attempts === 1) {
        return quotaPayload();
      }

      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    },
    now: () => currentTime,
  });

  assert.equal(await controller.refresh(), true);
  const lastGoodWindows = controller.getSnapshot().windows;
  const lastGoodFetchedAt = controller.getSnapshot().fetchedAt;
  const pendingRefresh = controller.refresh();

  assert.equal(controller.getSnapshot().refreshing, true);
  assert.equal(controller.getSnapshot().windows, lastGoodWindows);
  assert.equal(controller.getSnapshot().fetchedAt, lastGoodFetchedAt);

  await new Promise((resolve) => setImmediate(resolve));
  currentTime += 5_000;
  finishRefresh(quotaPayload());

  assert.equal(await pendingRefresh, true);
  assert.equal(controller.getSnapshot().refreshing, false);
  assert.equal(controller.getSnapshot().windows.fiveHour.remainingPercent, 75);
  assert.equal(controller.getSnapshot().fetchedAt, currentTime);

  controller.dispose();
});

test("network failure preserves the last good quota only with an explicit stale status", async () => {
  const access = randomUUID();
  let attempts = 0;
  const controller = createQuotaController({
    readCredential: async () => ({ kind: "oauth", accessToken: access }),
    fetchQuota: async () => {
      attempts += 1;

      if (attempts === 1) {
        return resetCreditsPayload();
      }

      throw new Error(`synthetic failure ${access}`);
    },
    now: () => now,
  });

  assert.equal(await controller.refresh(), true);
  assert.equal(await controller.refresh(), false);

  const snapshot = controller.getSnapshot();

  assert.equal(snapshot.status, "stale");
  assert.equal(snapshot.windows.fiveHour.remainingPercent, 75);
  assert.deepEqual(snapshot.resetCredits, {
    availableCount: 2,
    nextExpirationAt: now + 86_400_000,
    expirationStale: false,
  });
  assert.equal(JSON.stringify(snapshot).includes(access), false);

  controller.dispose();
});

test("disposed controller aborts work and ignores late credential results", async () => {
  let finishRead;
  let requestSignal;
  let fetchCalls = 0;
  const controller = createQuotaController({
    readCredential: ({ signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    },
    fetchQuota: async () => {
      fetchCalls += 1;
      return quotaPayload();
    },
  });

  const pending = controller.refresh();
  controller.dispose();
  finishRead({ kind: "oauth", accessToken: randomUUID() });

  assert.equal(requestSignal.aborted, true);
  assert.equal(await pending, false);
  assert.equal(fetchCalls, 0);
  assert.equal(controller.getSnapshot().status, "loading");
});

test("disposed controller ignores late quota and reset metadata", async () => {
  let finishFetch;
  const controller = createQuotaController({
    readCredential: async () => ({ kind: "oauth", accessToken: randomUUID() }),
    fetchQuota: () => new Promise((resolve) => {
      finishFetch = resolve;
    }),
    now: () => now,
  });

  const pending = controller.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  controller.dispose();
  finishFetch(resetCreditsPayload());

  assert.equal(await pending, false);
  assert.equal(controller.getSnapshot().windows, null);
  assert.equal(controller.getSnapshot().resetCredits, null);
});

test("expired OAuth clears previously displayed quota", async () => {
  let credentialKind = "oauth";
  const controller = createQuotaController({
    readCredential: async () => credentialKind === "oauth"
      ? { kind: "oauth", accessToken: randomUUID() }
      : { kind: "expired" },
    fetchQuota: async () => resetCreditsPayload(),
    now: () => now,
  });

  assert.equal(await controller.refresh(), true);
  assert.equal(controller.getSnapshot().resetCredits.availableCount, 2);
  credentialKind = "expired";
  assert.equal(await controller.refresh(), false);
  assert.equal(controller.getSnapshot().status, "expired");
  assert.equal(controller.getSnapshot().windows, null);
  assert.equal(controller.getSnapshot().resetCredits, null);

  controller.dispose();
});

test("transient reset-detail failure keeps the last expiration explicitly stale", async () => {
  let attempts = 0;
  const controller = createQuotaController({
    readCredential: async () => ({ kind: "oauth", accessToken: randomUUID() }),
    fetchQuota: async () => {
      attempts += 1;

      if (attempts === 1) {
        return resetCreditsPayload();
      }

      return {
        ...quotaPayload(),
        rate_limit_reset_credits: { available_count: 3 },
        reset_credit_details: null,
        reset_credit_details_stale: true,
      };
    },
    now: () => now,
  });

  assert.equal(await controller.refresh(), true);
  assert.equal(await controller.refresh(), true);
  assert.equal(controller.getSnapshot().status, "ready");
  assert.deepEqual(controller.getSnapshot().resetCredits, {
    availableCount: 3,
    nextExpirationAt: now + 86_400_000,
    expirationStale: true,
  });

  controller.dispose();
});

test("detail timeout publishes fresh quota and count while retaining only the old expiry as stale", async () => {
  const oldExpiration = now + 86_400_000;
  let usageReads = 0;
  let detailReads = 0;
  let detailSignal;
  let detailReaderCancelCalls = 0;
  let detailReaderReleaseCalls = 0;
  const accessToken = randomUUID();

  const controller = createQuotaController({
    readCredential: async () => ({ kind: "oauth", accessToken }),
    fetchQuota: (credentials, { signal }) => requestOpenAIUsage(credentials, {
      signal,
      timeoutMs: 100,
      fetchImpl: async (url, options) => {
        if (url === USAGE_ENDPOINT) {
          usageReads += 1;
          return new Response(JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: usageReads === 1 ? 20 : 40,
                limit_window_seconds: FIVE_HOUR_WINDOW_SECONDS,
                reset_at: now / 1_000 + 3_600,
              },
            },
            rate_limit_reset_credits: { available_count: usageReads === 1 ? 2 : 3 },
          }));
        }

        assert.equal(url, RESET_CREDITS_ENDPOINT);
        detailReads += 1;

        if (detailReads === 1) {
          return new Response(JSON.stringify({
            available_count: 2,
            credits: [
              {
                reset_type: "codex_rate_limits",
                status: "available",
                expires_at: new Date(oldExpiration).toISOString(),
              },
              {
                reset_type: "codex_rate_limits",
                status: "available",
                expires_at: new Date(oldExpiration + 86_400_000).toISOString(),
              },
            ],
          }));
        }

        detailSignal = options.signal;
        return {
          status: 200,
          ok: true,
          redirected: false,
          headers: { get: () => null },
          body: {
            getReader() {
              let finishRead;

              return {
                read() {
                  return new Promise((resolve) => {
                    finishRead = resolve;
                  });
                },
                cancel() {
                  detailReaderCancelCalls += 1;
                  finishRead?.({ done: true });
                  return Promise.resolve();
                },
                releaseLock() {
                  detailReaderReleaseCalls += 1;
                },
              };
            },
          },
        };
      },
    }),
    now: () => now,
  });

  assert.equal(await controller.refresh(), true);
  assert.equal(controller.getSnapshot().windows.fiveHour.remainingPercent, 80);
  assert.equal(controller.getSnapshot().resetCredits.availableCount, 2);
  assert.equal(controller.getSnapshot().resetCredits.nextExpirationAt, oldExpiration);

  assert.equal(await controller.refresh(), true);
  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.refreshing, false);
  assert.equal(snapshot.windows.fiveHour.remainingPercent, 60);
  assert.deepEqual(snapshot.resetCredits, {
    availableCount: 3,
    nextExpirationAt: oldExpiration,
    expirationStale: true,
  });
  assert.equal(usageReads, 2);
  assert.equal(detailReads, 2);
  assert.equal(detailSignal.aborted, true);
  assert.equal(detailReaderCancelCalls, 1);
  assert.equal(detailReaderReleaseCalls, 1);

  controller.dispose();
});

test("unauthorized usage response reports reconnect without leaking errors", async () => {
  const controller = createQuotaController({
    readCredential: async () => ({ kind: "oauth", accessToken: randomUUID() }),
    fetchQuota: async () => {
      throw new QuotaRequestError("expired");
    },
  });

  await controller.refresh();

  assert.equal(controller.getSnapshot().status, "expired");
  assert.equal(JSON.stringify(controller.getSnapshot()).includes("Quota request failed"), false);

  controller.dispose();
});
