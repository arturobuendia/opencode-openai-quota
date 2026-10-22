import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { QuotaRequestError } from "../src/auth.js";
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
        return quotaPayload();
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

test("expired OAuth clears previously displayed quota", async () => {
  let credentialKind = "oauth";
  const controller = createQuotaController({
    readCredential: async () => credentialKind === "oauth"
      ? { kind: "oauth", accessToken: randomUUID() }
      : { kind: "expired" },
    fetchQuota: async () => quotaPayload(),
    now: () => now,
  });

  assert.equal(await controller.refresh(), true);
  credentialKind = "expired";
  assert.equal(await controller.refresh(), false);
  assert.equal(controller.getSnapshot().status, "expired");
  assert.equal(controller.getSnapshot().windows, null);

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
