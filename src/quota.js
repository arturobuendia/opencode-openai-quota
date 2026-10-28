/** Normalizes the official account/rateLimits/read response, never guessing missing figures. */
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null
const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : null
const clamp = (value) => Math.min(100, Math.max(0, value))

function asWindow(input) {
  const data = object(input)
  const used = num(data?.usedPercent)
  if (used === null || used < 0 || used > 100) return null
  const minutes = num(data?.windowDurationMins)
  const seconds = num(data?.resetsAt)
  return {
    usedPercent: used,
    remainingPercent: clamp(100 - used),
    windowDurationMins: minutes !== null && minutes > 0 ? minutes : null,
    resetsAt: seconds !== null && seconds > 0 ? seconds * 1000 : null,
  }
}

export function normalizeQuota(payload, now = Date.now()) {
  const result = object(payload)
  if (!result) throw new Error("Codex returned an invalid rate-limit payload")
  const byId = object(result.rateLimitsByLimitId)
  // Codex can return limits for multiple products. Only show Codex's bucket.
  const bucket = object(byId?.codex) ?? object(result.rateLimits)
  if (!bucket) throw new Error("Codex returned no rate limits for this ChatGPT account")

  const a = asWindow(bucket.primary)
  const b = asWindow(bucket.secondary)
  if (!a && !b) throw new Error("Codex returned no recognizable usage windows")
  const windows = [a, b].filter(Boolean)
  const knownWeekly = windows.find((w) => w.windowDurationMins === 10080) ?? null
  const session = windows.find((w) => w.windowDurationMins === 300)
    ?? windows.filter((w) => w !== knownWeekly).reduce((first, current) =>
      !first || (current.windowDurationMins ?? Infinity) < (first.windowDurationMins ?? Infinity) ? current : first, null)
  const weekly = knownWeekly ?? (windows.length > 1 ? windows.find((w) => w !== session) : null)
  // The caller displays the raw duration when it's not one of Codex's usual windows.
  const credits = object(result.rateLimitResetCredits)
  const count = num(credits?.availableCount)
  const bankedAvailable = count !== null && count >= 0 && Number.isInteger(count) ? count : null
  const detailList = Array.isArray(credits?.credits) ? credits.credits : null
  let nextExpiration = null
  if (bankedAvailable !== null && bankedAvailable > 0 && detailList?.length) {
    const dates = detailList
      .filter((c) => object(c)?.status === "available")
      .map((c) => num(c.expiresAt))
      .filter((v) => v !== null && v > 0)
    // Details can be capped or incomplete, so don't call this the earliest
    // expiration unless ALL available credits are described with valid times.
    if (dates.length === bankedAvailable) nextExpiration = Math.min(...dates) * 1000
  }
  return {
    status: "ok",
    updatedAt: now,
    session,
    weekly,
    bankedAvailable,
    nextExpiration,
  }
}

export function remainingText(epochMillis, now = Date.now()) {
  if (epochMillis === null || !Number.isFinite(epochMillis)) return "unavailable"
  const remaining = Math.max(0, Math.ceil((epochMillis - now) / 60_000))
  if (remaining === 0) return "now"
  const days = Math.floor(remaining / 1440)
  const hours = Math.floor((remaining % 1440) / 60)
  const minutes = remaining % 60
  return "in " + [days && `${days}d`, hours && `${hours}h`, (minutes || (!days && !hours)) && `${minutes}m`].filter(Boolean).join(" ")
}

export function progress(percent, width = 19) {
  if (!Number.isFinite(percent)) return { filled: "", empty: "─".repeat(width) }
  const n = Math.max(0, Math.min(width, Math.ceil((percent / 100) * width)))
  return { filled: "━".repeat(n), empty: "─".repeat(width - n) }
}

export function durationLabel(window, fallback) {
  if (!window) return fallback
  const duration = window.windowDurationMins
  if (duration === 300) return "Session (5h)"
  if (duration === 10080) return "Weekly"
  if (duration && duration % 1440 === 0) return `${fallback} (${duration / 1440}d)`
  if (duration && duration % 60 === 0) return `${fallback} (${duration / 60}h)`
  return fallback
}

/** Friendly UI status, without lying about freshness during a failed read. */
export function updatedText(updatedAt, now = Date.now()) {
  if (!Number.isFinite(updatedAt)) return "Never updated"
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000))
  if (minutes < 1) return "Updated just now"
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const duration = [days && `${days}d`, hours && `${hours}h`, mins && `${mins}m`].filter(Boolean).join(" ")
  return `Updated ${duration} ago`
}
