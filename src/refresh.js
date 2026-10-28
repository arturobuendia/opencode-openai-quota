/**
 * Coalesces concurrent quota reads and enforces a minimum time between
 * automatic attempts. A manual refresh bypasses the cooldown, but never
 * starts another Codex process while one is running.
 */
export function createQuotaRefresher({ read, now = () => Date.now(), cooldownMs = 60_000 }) {
  let lastAttempt = null
  let pending = null
  return {
    getLastAttempt: () => lastAttempt,
    refresh({ force = false } = {}) {
      if (pending) return pending
      if (!force && lastAttempt !== null && now() - lastAttempt < cooldownMs) {
        return Promise.resolve(false)
      }
      lastAttempt = now()
      pending = Promise.resolve().then(read).then(() => true).finally(() => { pending = null })
      return pending
    },
  }
}
