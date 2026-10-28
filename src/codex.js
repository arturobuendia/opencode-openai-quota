import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const quoteForShell = (value) => /[\s"]/u.test(value) ? `"${value.replace(/"/g, '""')}"` : value

/**
 * One short-lived local Codex app-server per refresh.
 * No credential files are read. No inference turn is created.
 * The protocol is JSON-lines with an initialize handshake before quota lookup.
 */
export async function readCodexRateLimits(options = {}) {
  const command = options.command ?? process.env.OPENCODE_QUOTA_CODEX ?? "codex"
  const args = options.args ?? ["app-server"]
  const timeoutMs = options.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    let done = false
    let initialized = false
    let child
    let timer
    let lines
    let killTimer
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      lines?.close()
      // End our owned child; it never outlives a refresh.
      // Closing stdin lets Codex exit gracefully; allow a brief grace period
      // before killing our owned process (important for Windows .cmd shims).
      try { child?.stdin?.end() } catch {}
      killTimer = setTimeout(() => { try { child?.kill() } catch {} }, 800)
      killTimer.unref?.()
      if (error) reject(error)
      else resolve(value)
    }
    try {
      // shell on Windows is needed for common npm/bun codex.cmd shims.
      // command and args are constant by default; do not set the custom
      // executable override to arbitrary/untrusted shell text.
      child = process.platform === "win32"
        // Windows shell concatenates tokens, so quote paths such as
        // "C:\Program Files\nodejs\node.exe" and pass no separate args.
        ? spawn([command, ...args].map(quoteForShell).join(" "), {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: true,
          env: process.env,
        })
        : spawn(command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: process.env,
        })
    } catch {
      finish(new Error("Could not start the Codex CLI. Install Codex and check your PATH."))
      return
    }
    timer = setTimeout(() => finish(new Error(`Codex did not answer in time (${Math.round(timeoutMs / 1000)} s).`)), timeoutMs)
    // Drain diagnostics but don't expose potentially private stderr content.
    child.stderr?.resume()
    child.on("error", () => finish(new Error("Codex CLI not found or not executable. Run: codex --version")))
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer)
      if (!done) finish(new Error(`Codex exited before returning quota (exit ${code ?? "unknown"}). Check: codex login status`))
    })
    const send = (value) => {
      if (done || !child.stdin?.writable) return
      child.stdin.write(`${JSON.stringify(value)}\n`)
    }
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on("line", (line) => {
      if (done || !line.trim()) return
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.id === 0) {
        if (msg.error) { finish(new Error("Codex rejected the initialization handshake.")); return }
        if (!msg.result) { finish(new Error("Codex did not confirm initialize.")); return }
        initialized = true
        send({ method: "initialized", params: {} })
        send({ id: 1, method: "account/rateLimits/read" })
      } else if (msg.id === 1 && initialized) {
        if (msg.error) {
          finish(new Error("Could not read quota. Check that Codex is logged in to a ChatGPT account."))
          return
        }
        finish(null, msg.result)
      }
    })
    send({
      id: 0,
      method: "initialize",
      params: {
        clientInfo: { name: "opencode_openai_quota", title: "OpenCode OpenAI Quota", version: "0.3.0" },
        // The rate-limit method is documented as stable; no experimental opt-in needed.
      },
    })
  })
}
