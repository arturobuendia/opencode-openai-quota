import { readCodexRateLimits } from "../src/codex.js"
import { normalizeQuota, remainingText } from "../src/quota.js"
try {
  const snapshot = normalizeQuota(await readCodexRateLimits())
  for (const name of ["session", "weekly"]) {
    const w = snapshot[name]
    console.log(`${name}:`, w ? `${Math.round(w.remainingPercent)}% remaining; reset in ${remainingText(w.resetsAt)}` : "unavailable")
  }
  console.log(`Banked resets: ${snapshot.bankedAvailable ?? "unavailable"}`)
  console.log(`Next expiration: ${snapshot.nextExpiration ? remainingText(snapshot.nextExpiration) : "unavailable"}`)
} catch (error) {
  console.error("Quota probe failed:", error.message)
  process.exitCode = 1
}
