import { homedir } from "node:os";
import path from "node:path";
import { readOpenAICredential, requestOpenAIUsage } from "./auth.js";
import { createQuotaController, findNextReset, formatCountdown, formatLocalResetDate, formatLocalTime } from "./quota.js";

const SIDEBAR_ORDER = 600;
const FALLBACK_COLORS = {
  primary: "#38bdf8",
  success: "#34d399",
  warning: "#fbbf24",
  error: "#fb7185",
  info: "#60a5fa",
  text: "#e2e8f0",
  textMuted: "#94a3b8",
  borderSubtle: "#475569",
};

export function getOpenCodeConfigDirectory(env = process.env, home = homedir()) {
  const configuredDirectory = env.OPENCODE_CONFIG_DIR;

  if (typeof configuredDirectory === "string" && configuredDirectory.trim() !== "") {
    return path.resolve(configuredDirectory);
  }

  const configuredConfigHome = env.XDG_CONFIG_HOME;
  const configHome = typeof configuredConfigHome === "string" && configuredConfigHome.length > 0
    ? configuredConfigHome
    : path.join(home, ".config");

  return path.join(configHome, "opencode");
}

export function getOpenCodeConfigPackagePath(env = process.env, home = homedir()) {
  return path.join(path.resolve(getOpenCodeConfigDirectory(env, home)), "package.json");
}

async function loadTuiRuntime() {
  try {
    const [jsxRuntime, solidRuntime] = await Promise.all([
      import("@opentui/solid/jsx-runtime"),
      import("solid-js"),
    ]);

    return {
      jsx: jsxRuntime.jsx,
      createSignal: solidRuntime.createSignal,
      onCleanup: solidRuntime.onCleanup,
    };
  } catch {
    throw new Error("OpenCode TUI rendering dependencies could not be loaded.");
  }
}

function statusText(snapshot) {
  if (snapshot.refreshing) {
    return snapshot.windows ? "Refreshing quota…" : "Checking OpenAI…";
  }

  switch (snapshot.status) {
    case "loading":
      return "Waiting for quota…";
    case "ready":
      return "Quota up to date";
    case "stale":
      return "Connection issue · showing last good quota";
    case "expired":
      return "Session expired · reconnect in OpenCode";
    case "api-key":
      return "API key auth · subscription quota n/a";
    case "not-connected":
      return "Connect OpenAI OAuth";
    default:
      return "Quota unavailable · will retry";
  }
}

function statusColor(snapshot, palette) {
  if (snapshot.refreshing) {
    return palette.info;
  }

  switch (snapshot.status) {
    case "ready":
      return palette.success;
    case "stale":
    case "api-key":
    case "not-connected":
      return palette.warning;
    case "expired":
    case "unavailable":
      return palette.error;
    default:
      return palette.textMuted;
  }
}

function statusSymbol(snapshot) {
  if (snapshot.refreshing) {
    return "↻";
  }

  switch (snapshot.status) {
    case "ready":
      return "●";
    case "stale":
    case "api-key":
    case "expired":
    case "unavailable":
      return "!";
    default:
      return "○";
  }
}

function nextResetLine(snapshot) {
  const nextReset = findNextReset(snapshot.windows, snapshot.clockNow);

  if (!nextReset) {
    return "Next reset · unavailable";
  }

  return `Next reset · ${nextReset.label} · ${formatLocalResetDate(nextReset.window.resetAt)} · ${formatCountdown(nextReset.window.resetAt, snapshot.clockNow)}`;
}

function readPalette(theme) {
  const current = theme?.current;

  return Object.fromEntries(
    Object.entries(FALLBACK_COLORS).map(([name, fallback]) => [
      name,
      current?.[name] ?? fallback,
    ]),
  );
}

function quotaColor(remainingPercent, palette) {
  if (remainingPercent < 30) {
    return palette.error;
  }

  if (remainingPercent < 60) {
    return palette.warning;
  }

  return palette.success;
}

function createQuotaCard(label, windowKey, snapshot, runtime, palette) {
  return runtime.jsx("box", {
    flexDirection: "column",
    children: [
      runtime.jsx("box", {
        flexDirection: "row",
        justifyContent: "space-between",
        children: [
          runtime.jsx("text", {
            fg: palette.textMuted,
            children: label,
          }),
          runtime.jsx("text", {
            fg: palette.text,
            children: () => {
              const window = snapshot().windows?.[windowKey];
              return window ? `${window.remainingPercent}% left` : "Unavailable";
            },
          }),
        ],
      }),
      runtime.jsx("box", {
        flexDirection: "row",
        children: () => {
          const window = snapshot().windows?.[windowKey];

          if (!window) {
            return runtime.jsx("text", {
              fg: palette.textMuted,
              children: "──────────",
            });
          }

          const filled = Math.round(window.remainingPercent / 10);
          const color = quotaColor(window.remainingPercent, palette);

          return [
            runtime.jsx("text", {
              fg: color,
              children: "━━━━━━━━━━".slice(0, filled),
            }),
            runtime.jsx("text", {
              fg: palette.borderSubtle,
              children: "──────────".slice(0, 10 - filled),
            }),
          ];
        },
      }),
    ],
  });
}

function createSidebarComponent(controller, runtime) {
  return function OpenAIQuotaSidebar({ theme }) {
    const [snapshot, setSnapshot] = runtime.createSignal(controller.getSnapshot());
    const unsubscribe = controller.subscribe(setSnapshot);
    runtime.onCleanup(unsubscribe);
    const palette = readPalette(theme);

    return runtime.jsx("box", {
      flexDirection: "column",
      width: "100%",
      border: true,
      borderStyle: "single",
      borderColor: palette.borderSubtle,
      paddingX: 1,
      paddingY: 1,
      children: [
        runtime.jsx("text", {
          fg: palette.primary,
          children: "OpenAI quota",
        }),
        runtime.jsx("box", {
          flexDirection: "row",
          children: () => runtime.jsx("box", {
            flexDirection: "row",
            gap: 1,
            children: [
              runtime.jsx("text", {
                fg: statusColor(snapshot(), palette),
                children: statusSymbol(snapshot()),
              }),
              runtime.jsx("text", {
                fg: statusColor(snapshot(), palette),
                wrapMode: "word",
                children: statusText(snapshot()),
              }),
            ],
          }),
        }),
        createQuotaCard("5-hour", "fiveHour", snapshot, runtime, palette),
        createQuotaCard("Weekly", "weekly", snapshot, runtime, palette),
        runtime.jsx("text", {
          fg: palette.textMuted,
          wrapMode: "word",
          children: () => nextResetLine(snapshot()),
        }),
        runtime.jsx("text", {
          fg: palette.textMuted,
          children: () => snapshot().fetchedAt === null
            ? "No successful refresh yet"
            : `${snapshot().status === "stale" ? "Last good" : "Updated"} ${formatLocalTime(snapshot().fetchedAt)}`,
        }),
        runtime.jsx("text", {
          fg: palette.textMuted,
          children: "Manual refresh: command palette",
        }),
      ],
    });
  };
}

export async function initializeQuotaPlugin(api, dependencies = {}) {
  const runtime = await (dependencies.loadTuiRuntime ?? loadTuiRuntime)();
  const controller = createQuotaController({
    readCredential: dependencies.readCredential ?? readOpenAICredential,
    fetchQuota: dependencies.fetchQuota ?? requestOpenAIUsage,
    now: dependencies.now,
    setIntervalImpl: dependencies.setIntervalImpl,
    clearIntervalImpl: dependencies.clearIntervalImpl,
  });
  const Sidebar = createSidebarComponent(controller, runtime);

  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content: (context) => runtime.jsx(Sidebar, { theme: context?.theme }),
    },
  });

  api.keymap.registerLayer({
    commands: [
      {
        name: "openai-quota.refresh",
        title: "Refresh OpenAI quota",
        category: "OpenAI quota",
        namespace: "palette",
        run() {
          void controller.refresh();
        },
      },
    ],
  });

  api.lifecycle.onDispose(() => {
    controller.dispose();
  });

  controller.start();
}

async function tui(api) {
  await initializeQuotaPlugin(api);
}

const plugin = {
  id: "opencode-openai-quota",
  tui,
};

export default plugin;
