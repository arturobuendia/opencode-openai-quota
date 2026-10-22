import { QuotaRequestError } from "./auth.js";

export const FIVE_HOUR_WINDOW_SECONDS = 18_000;
export const WEEKLY_WINDOW_SECONDS = 604_800;

const MAX_RESET_AFTER_SECONDS = WEEKLY_WINDOW_SECONDS * 2;
const MAX_DATE_MS = 8_640_000_000_000_000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericValue(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }

  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : undefined;
}

function toTimestampMilliseconds(value) {
  const timestamp = numericValue(value);

  if (timestamp === undefined || timestamp <= 0) {
    return undefined;
  }

  const milliseconds = timestamp >= 1_000_000_000_000
    ? timestamp
    : timestamp * 1_000;

  return milliseconds <= MAX_DATE_MS ? milliseconds : undefined;
}

function resetTimestamp(window, now) {
  const absolute = toTimestampMilliseconds(window.reset_at);

  if (absolute !== undefined && absolute > now) {
    return absolute;
  }

  const resetAfterSeconds = numericValue(window.reset_after_seconds);

  if (
    resetAfterSeconds === undefined
    || resetAfterSeconds <= 0
    || resetAfterSeconds > MAX_RESET_AFTER_SECONDS
  ) {
    return undefined;
  }

  const relative = now + resetAfterSeconds * 1_000;

  return relative <= MAX_DATE_MS ? relative : undefined;
}

function classifyWindow(window, source, now) {
  if (!isRecord(window)) {
    return undefined;
  }

  const duration = numericValue(window.limit_window_seconds);
  let kind;

  if (duration === FIVE_HOUR_WINDOW_SECONDS) {
    kind = "fiveHour";
  } else if (duration === WEEKLY_WINDOW_SECONDS) {
    kind = "weekly";
  } else if (duration === undefined) {
    kind = source === "primary_window" ? "fiveHour" : "weekly";
  } else {
    return undefined;
  }

  const usedPercent = numericValue(window.used_percent);

  if (usedPercent === undefined || usedPercent < 0 || usedPercent > 101) {
    return undefined;
  }

  return {
    kind,
    remainingPercent: Math.max(0, Math.round(100 - usedPercent)),
    resetAt: resetTimestamp(window, now),
  };
}

function parseResetExpiration(value, now) {
  if (typeof value !== "string") {
    return undefined;
  }

  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);

  if (!parts) {
    return undefined;
  }

  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);

  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return undefined;
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp) || timestamp <= now || timestamp > MAX_DATE_MS) {
    return undefined;
  }

  return timestamp;
}

function resetCreditCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function findNextResetCreditExpiration(details, availableCount, now) {
  const detailCount = resetCreditCount(details?.available_count);
  const credits = details?.credits;

  if (
    detailCount !== availableCount
    || !Array.isArray(credits)
    || credits.length !== availableCount
    || availableCount === 0
  ) {
    return undefined;
  }

  let nextExpirationAt = Infinity;

  for (const credit of credits) {
    if (
      !isRecord(credit)
      || credit.reset_type !== "codex_rate_limits"
      || credit.status !== "available"
    ) {
      return undefined;
    }

    const expiration = parseResetExpiration(credit.expires_at, now);

    if (expiration === undefined) {
      return undefined;
    }

    nextExpirationAt = Math.min(nextExpirationAt, expiration);
  }

  return Number.isFinite(nextExpirationAt) ? nextExpirationAt : undefined;
}

export function parseResetCredits(payload, now = Date.now()) {
  const usageCount = resetCreditCount(payload?.rate_limit_reset_credits?.available_count);
  const detailsCount = resetCreditCount(payload?.reset_credit_details?.available_count);
  const availableCount = detailsCount ?? usageCount;

  if (availableCount === undefined) {
    return null;
  }

  if (availableCount === 0) {
    return {
      availableCount,
      nextExpirationAt: null,
      expirationStale: false,
    };
  }

  return {
    availableCount,
    nextExpirationAt: findNextResetCreditExpiration(
      payload?.reset_credit_details,
      availableCount,
      now,
    ) ?? null,
    expirationStale: false,
  };
}

export function parseQuotaPayload(payload, now = Date.now()) {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) {
    return undefined;
  }

  const result = {
    fiveHour: null,
    weekly: null,
  };
  const ambiguous = new Set();

  for (const source of ["primary_window", "secondary_window"]) {
    const classified = classifyWindow(payload.rate_limit[source], source, now);

    if (!classified || ambiguous.has(classified.kind)) {
      continue;
    }

    if (result[classified.kind] !== null) {
      result[classified.kind] = null;
      ambiguous.add(classified.kind);
      continue;
    }

    result[classified.kind] = {
      remainingPercent: classified.remainingPercent,
      resetAt: classified.resetAt,
    };
  }

  return result.fiveHour || result.weekly ? result : undefined;
}

export function findNextReset(windows, now = Date.now()) {
  if (!windows) {
    return undefined;
  }

  const candidates = [
    { key: "fiveHour", label: "5h", window: windows.fiveHour },
    { key: "weekly", label: "Weekly", window: windows.weekly },
  ].filter(({ window }) => Number.isFinite(window?.resetAt) && window.resetAt > now);

  candidates.sort((left, right) => left.window.resetAt - right.window.resetAt);

  return candidates[0];
}

export function formatLocalResetDate(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function formatLocalTime(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

export function formatCountdown(timestamp, now = Date.now()) {
  const milliseconds = timestamp - now;

  if (milliseconds <= 0) {
    return "now";
  }

  if (milliseconds < 60_000) {
    return "<1m";
  }

  const totalMinutes = Math.ceil(milliseconds / 60_000);

  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return `${minutes}m`;
}

export function createQuotaController({
  readCredential,
  fetchQuota,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  refreshIntervalMs = 120_000,
  clockIntervalMs = 30_000,
}) {
  let snapshot = {
    status: "loading",
    refreshing: false,
    windows: null,
    resetCredits: null,
    fetchedAt: null,
    clockNow: now(),
  };
  let started = false;
  let disposed = false;
  let inFlight = false;
  let activeRequest;
  let refreshTimer;
  let clockTimer;
  const listeners = new Set();

  function publish(update) {
    if (disposed) {
      return;
    }

    snapshot = {
      ...snapshot,
      ...update,
      clockNow: now(),
    };

    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function clearQuota(status) {
    publish({ status, windows: null, resetCredits: null, fetchedAt: null });
  }

  async function refresh() {
    if (disposed || inFlight) {
      return false;
    }

    inFlight = true;
    const request = new AbortController();
    activeRequest = request;

    try {
      publish({ refreshing: true });
      const credential = await readCredential({ signal: request.signal });

      if (disposed || request.signal.aborted) {
        return false;
      }

      if (credential?.kind === "aborted") {
        return false;
      }

      if (credential?.kind !== "oauth") {
        const status = ["api-key", "expired", "not-connected"].includes(credential?.kind)
          ? credential.kind
          : "unavailable";

        clearQuota(status);
        return false;
      }

      const payload = await fetchQuota(credential, { signal: request.signal });

      if (disposed || request.signal.aborted) {
        return false;
      }

      const fetchedAt = now();
      const windows = parseQuotaPayload(payload, fetchedAt);
      let resetCredits = parseResetCredits(payload, fetchedAt);

      if (!windows) {
        throw new QuotaRequestError("invalid-response");
      }

      if (
        payload?.reset_credit_details_stale === true
        && resetCredits?.availableCount > 0
        && snapshot.resetCredits?.nextExpirationAt
      ) {
        resetCredits = {
          ...resetCredits,
          nextExpirationAt: snapshot.resetCredits.nextExpirationAt,
          expirationStale: true,
        };
      }

      publish({ status: "ready", windows, resetCredits, fetchedAt });
      return true;
    } catch (error) {
      if (disposed || request.signal.aborted || error?.kind === "aborted") {
        return false;
      }

      if (error instanceof QuotaRequestError && error.kind === "expired") {
        clearQuota("expired");
        return false;
      }

      if (snapshot.windows && snapshot.fetchedAt !== null) {
        publish({ status: "stale" });
      } else {
        clearQuota("unavailable");
      }

      return false;
    } finally {
      if (activeRequest === request) {
        activeRequest = undefined;
        inFlight = false;
        publish({ refreshing: false });
      }
    }
  }

  function start() {
    if (started || disposed) {
      return;
    }

    started = true;
    refreshTimer = setIntervalImpl(() => {
      void refresh();
    }, refreshIntervalMs);
    clockTimer = setIntervalImpl(() => {
      publish({});
    }, clockIntervalMs);
    void refresh();
  }

  function subscribe(listener) {
    if (disposed) {
      return () => {};
    }

    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  function dispose() {
    if (disposed) {
      return;
    }

    disposed = true;

    if (refreshTimer !== undefined) {
      clearIntervalImpl(refreshTimer);
    }

    if (clockTimer !== undefined) {
      clearIntervalImpl(clockTimer);
    }

    activeRequest?.abort();
    activeRequest = undefined;
    listeners.clear();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe,
    refresh,
    start,
    dispose,
  };
}
