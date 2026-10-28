import { createInterface } from "node:readline"
const messages = []
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", line => {
  const msg = JSON.parse(line)
  messages.push(msg)
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({id: msg.id, result: {userAgent: "mock"}}) + "\n")
  }
  if (msg.method === "account/rateLimits/read") {
    const initialized = messages.findIndex(m => m.method === "initialized")
    if (initialized < 0) throw new Error("Missing initialized notification")
    process.stdout.write(JSON.stringify({id: msg.id, result: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 63, windowDurationMins: 300, resetsAt: 1800000000 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1800500000 }
      },
      rateLimitResetCredits: { availableCount: 2, credits: [
        { status: "available", expiresAt: 1800100000 },
        { status: "available", expiresAt: 1800200000 }
      ] }
    }}) + "\n")
  }
})
