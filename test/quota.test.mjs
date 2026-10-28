import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { readCodexRateLimits } from "../src/codex.js"
import { normalizeQuota, remainingText, progress, updatedText } from "../src/quota.js"
const fixture = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url))

test("app-server handshake followed by read returns valid snapshot", async () => {
  const raw = await readCodexRateLimits({command: process.execPath, args: [fixture], timeoutMs: 3000})
  const value = normalizeQuota(raw)
  assert.equal(value.session.remainingPercent, 37)
  assert.equal(value.weekly.remainingPercent, 60)
  assert.equal(value.bankedAvailable, 2)
  assert.equal(value.nextExpiration, 1800100000 * 1000)
})
test("missing data is unavailable, never synthesized", () => {
  const value = normalizeQuota({rateLimits: {primary: {usedPercent: 100, windowDurationMins: 300}}})
  assert.equal(value.session.remainingPercent, 0)
  assert.equal(value.weekly, null)
  assert.equal(value.bankedAvailable, null)
  assert.equal(value.nextExpiration, null)
})
test("incomplete banked reset details do not imply an expiry", () => {
  const value = normalizeQuota({
    rateLimits: {primary: {usedPercent: 10}},
    rateLimitResetCredits: {availableCount: 2, credits: [{status: "available", expiresAt: 1800100000}]},
  })
  assert.equal(value.bankedAvailable, 2)
  assert.equal(value.nextExpiration, null)
})
test("countdown and progress", () => {
  assert.equal(remainingText(1_800_000_000, 1_800_000_000), "now")
  assert.equal(remainingText(null), "unavailable")
  const result = progress(50, 10)
  assert.equal(result.filled.length, 5)
  assert.equal(result.empty.length, 5)
})

test("week-only response does not invent a session window", () => {
  const value = normalizeQuota({rateLimits: {primary: {usedPercent: 31, windowDurationMins: 10080}}})
  assert.equal(value.session, null)
  assert.equal(value.weekly.remainingPercent, 69)
})
test("progress visibly represents small nonzero remaining balance", () => {
  assert.equal(progress(1, 23).filled.length, 1)
  assert.equal(progress(0, 23).filled.length, 0)
})
test("relative times use consistent English copy", () => {
  assert.equal(remainingText(600000, 0), "in 10m")
  assert.equal(updatedText(0, 0), "Updated just now")
  assert.equal(updatedText(0, 61 * 60000), "Updated 1h 1m ago")
})
