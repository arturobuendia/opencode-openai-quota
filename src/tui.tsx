/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { readCodexRateLimits } from "./codex.js"
import { createQuotaRefresher } from "./refresh.js"
import { durationLabel, normalizeQuota, progress, remainingText, updatedText } from "./quota.js"

type QuotaWindowData = {
  usedPercent: number
  remainingPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}
type QuotaSnapshot = {
  updatedAt: number
  session: QuotaWindowData | null
  weekly: QuotaWindowData | null
  bankedAvailable: number | null
  nextExpiration: number | null
}

// The TUI plugin executes in the LOCAL terminal. It queries the user's Codex
// app-server, and never needs the OpenCode OAuth token or a backend RPC server.
export default Plugin.define({
  id: "openai-quota.tui",
  setup(context) {
    const theme = context.theme
    const [quota, setQuota] = createSignal<QuotaSnapshot | null>(null)
    const [error, setError] = createSignal("")
    const [busy, setBusy] = createSignal(false)
    const [clock, setClock] = createSignal(Date.now())
    let disposed = false
    let eventTimer: ReturnType<typeof setTimeout> | undefined

    async function readQuota() {
      if (disposed) return
      setBusy(true)
      try {
        const raw = await readCodexRateLimits()
        const snapshot = normalizeQuota(raw) as QuotaSnapshot
        if (!disposed) {
          setQuota(snapshot)
          setError("")
          setClock(Date.now())
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Codex quota unavailable")
      } finally {
        if (!disposed) setBusy(false)
      }
    }

    const refresher = createQuotaRefresher({
      read: readQuota,
      cooldownMs: 60_000,
    })

    function refresh(force = false) {
      return refresher.refresh({ force }).catch(() => false)
    }

    function QuotaWindow(props: { window: QuotaWindowData; name: string }) {
      const percent = () => Math.round(props.window.remainingPercent)
      const bar = () => progress(props.window.remainingPercent, 23)
      const fg = () => percent() <= 10 ? "#F87171" : percent() <= 25 ? "#FBBF24" : theme.text.base
      const resetLabel = () => {
        const value = remainingText(props.window.resetsAt, clock())
        return value === "unavailable" ? "Reset unavailable" : `Resets ${value}`
      }
      return (
        <box flexDirection="column" paddingTop={1}>
          <text fg={theme.text.base}><b>{durationLabel(props.window, props.name)}</b></text>
          <box flexDirection="row">
            <text fg={fg()}>{bar().filled}</text>
            <text fg={theme.text.muted}>{bar().empty}</text>
          </box>
          <text fg={fg()}>{percent()}% remaining</text>
          <text fg={theme.text.muted}>{resetLabel()}</text>
        </box>
      )
    }

    function QuotaPanel() {
      const snap = quota
      const label = () => {
        const data = snap()
        if (!data) return busy() ? "Reading Codex…" : "Unavailable"
        return `${busy() ? "Checking · " : ""}${updatedText(data.updatedAt, clock())}`
      }
      return (
        <box flexDirection="column" paddingTop={1} paddingBottom={1}>
          <text fg={theme.text.base}><b>OpenAI Quota</b></text>
          <text fg={theme.text.muted}>{label()}</text>
          <Show when={snap()}>
            {(snapshot) => (
              <>
                <Show when={snapshot().session}>
                  {(value) => <QuotaWindow window={value()} name="Session" />}
                </Show>
                <Show when={snapshot().weekly}>
                  {(value) => <QuotaWindow window={value()} name="Weekly" />}
                </Show>
                <box flexDirection="column" paddingTop={1}>
                  <text fg={theme.text.muted}>───────────────────────</text>
                  <text fg={theme.text.base}>
                    {snapshot().bankedAvailable === null
                      ? "Banked resets: unavailable"
                      : `${snapshot().bankedAvailable} available banked resets`}
                  </text>
                  <text fg={theme.text.muted}>
                    {snapshot().nextExpiration
                      ? `Next expires ${remainingText(snapshot().nextExpiration, clock())}`
                      : "Next expiration unavailable"}
                  </text>
                </box>
              </>
            )}
          </Show>
          <Show when={Boolean(error())}>
            <box flexDirection="column" paddingTop={1}>
              <text fg="#FBBF24">{snap() ? "Refresh failed · showing saved data" : "Cannot read Codex quota"}</text>
              <Show when={!snap()}>
                <text fg={theme.text.muted}>{error()}</text>
                <text fg={theme.text.muted}>Try /quota-refresh</text>
              </Show>
            </box>
          </Show>
        </box>
      )
    }

    const removeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => <QuotaPanel />,
    })

    // These commands belong only to this plugin; never shadow other statusline plugins.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "openai-quota.refresh",
        title: "Refresh OpenAI quota",
        group: "OpenAI quota",
        palette: true,
        slash: { name: "quota-refresh" },
        run: () => { void refresh(true) },
      }],
    }))

    // Refresh after a completed OpenCode execution. Let Codex publish the new
    // numbers for a few seconds first, then enforce a one-minute cooldown.
    const stopExecution = context.data.on("session.execution.succeeded", () => {
      if (eventTimer) clearTimeout(eventTimer)
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        if (!disposed) void refresh()
      }, 7_000)
    })

    // Existing safety net: periodic reads, live relative times, no per-render IO.
    void refresh()
    const polling = setInterval(() => { if (!disposed) void refresh() }, 120_000)
    const ticking = setInterval(() => {
      if (disposed) return
      const now = Date.now()
      setClock(now)
      const snapshot = quota()
      // Prevent showing a zero-quota window indefinitely after it resets.
      if (snapshot && [snapshot.session?.resetsAt, snapshot.weekly?.resetsAt]
        .some((when) => when !== null && when !== undefined && when <= now)) {
        void refresh()
      }
    }, 30_000)

    return () => {
      disposed = true
      clearInterval(polling)
      clearInterval(ticking)
      if (eventTimer) clearTimeout(eventTimer)
      stopExecution()
      removeSidebar?.()
    }
  },
})
