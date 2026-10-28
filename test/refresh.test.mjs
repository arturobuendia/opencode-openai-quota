import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQuotaRefresher } from '../src/refresh.js'

test('cooldown prevents redundant reads, manual refresh overrides it', async () => {
  let clock = 1_000_000
  let reads = 0
  const refresher = createQuotaRefresher({
    now: () => clock,
    cooldownMs: 60_000,
    read: async () => { reads++ },
  })
  assert.equal(await refresher.refresh(), true)
  assert.equal(await refresher.refresh(), false)
  assert.equal(reads, 1)
  assert.equal(await refresher.refresh({force:true}), true)
  assert.equal(reads, 2)
  clock += 61_000
  assert.equal(await refresher.refresh(), true)
  assert.equal(reads, 3)
})

test('concurrent refreshes share the same pending read', async () => {
  let finish
  let reads = 0
  const refresher = createQuotaRefresher({
    read: () => { reads++; return new Promise(resolve => { finish = resolve }) },
  })
  const a = refresher.refresh()
  const b = refresher.refresh({force:true})
  assert.equal(a, b)
  await Promise.resolve()
  finish()
  assert.equal(await a, true)
  assert.equal(await b, true)
  assert.equal(reads, 1)
})

test('failed refresh is eligible for later retry without an overlapping process', async () => {
  let clock = 1_000
  let reads = 0
  const refresher = createQuotaRefresher({
    now: () => clock,
    cooldownMs: 60_000,
    read: () => { reads++; if (reads === 1) throw new Error('Codex unavailable') },
  })
  await assert.rejects(refresher.refresh(), /Codex unavailable/)
  assert.equal(await refresher.refresh(), false)
  clock += 60_000
  assert.equal(await refresher.refresh(), true)
  assert.equal(reads, 2)
})
