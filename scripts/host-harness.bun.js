import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const configDirectory = process.env.OPENCODE_CONFIG_DIR?.trim()
  ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
  : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode");
const requireFromOpenCode = createRequire(path.join(configDirectory, "package.json"));
const solidTransformPath = Bun.resolveSync("@opentui/solid/bun-plugin", configDirectory);
const { ensureSolidTransformPlugin } = await import(pathToFileURL(solidTransformPath).href);
assert.equal(ensureSolidTransformPlugin(), true);

const hostSolidPath = Bun.resolveSync("@opentui/solid", configDirectory);
const hostSolidRuntimePath = Bun.resolveSync("solid-js", hostSolidPath);
const hostSolid = await import(pathToFileURL(hostSolidPath).href);
const runtimeSupportPath = Bun.resolveSync(
  "@opentui/solid/runtime-plugin-support/configure",
  configDirectory,
);
const { ensureRuntimePluginSupport } = await import(pathToFileURL(runtimeSupportPath).href);

assert.equal(path.basename(hostSolidPath), "index.bun.js");
assert.equal(path.basename(hostSolidRuntimePath), "server.js");
assert.notEqual(
  path.resolve(hostSolidRuntimePath),
  path.resolve(requireFromOpenCode.resolve("solid-js/dist/solid.js")),
);
assert.equal(ensureRuntimePluginSupport(), true);

const { default: plugin, getOpenCodeConfigDirectory, initializeQuotaPlugin } = await import("../src/tui.js");

const originalDataHome = process.env.XDG_DATA_HOME;
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT;
const syntheticDataHome = await mkdtemp(path.join(tmpdir(), "openai-quota-test-"));
const registrations = [];
const keymapLayers = [];
const disposers = [];
const visualRegistrations = [];
const visualKeymapLayers = [];
const visualDisposers = [];
const abortController = new AbortController();
const api = {
  slots: {
    register(pluginRegistration) {
      registrations.push(pluginRegistration);
      return "opencode-openai-quota";
    },
  },
  keymap: {
    registerLayer(layer) {
      keymapLayers.push(layer);
      return () => {};
    },
  },
  lifecycle: {
    signal: abortController.signal,
    onDispose(dispose) {
      disposers.push(dispose);
      return () => {};
    },
  },
};
let renderer;
let visualRenderer;

async function renderUntil(setup, predicate, message) {
  let frame = setup.captureCharFrame();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate(frame)) {
      return frame;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    frame = setup.captureCharFrame();
  }

  assert.fail(`${message}\nLast captured frame:\n${frame}`);
}

try {
  process.env.XDG_DATA_HOME = syntheticDataHome;
  process.env.OPENCODE_AUTH_CONTENT = "";

  assert.equal(plugin.id, "opencode-openai-quota");
  assert.equal(typeof plugin.tui, "function");
  await plugin.tui(api);

  assert.equal(registrations.length, 1);
  assert.equal(typeof registrations[0].slots.sidebar_content, "function");
  assert.equal("id" in registrations[0], false);
  assert.equal(keymapLayers[0].commands[0].name, "openai-quota.refresh");
  assert.equal(keymapLayers[0].commands[0].namespace, "palette");
  assert.equal(disposers.length, 1);

  assert.equal(getOpenCodeConfigDirectory(), configDirectory);

  const { testRender } = hostSolid;
  const setup = await testRender(
    () => registrations[0].slots.sidebar_content(
      { theme: {} },
      { session_id: "synthetic-session" },
    ),
    { width: 72, height: 16 },
  );
  renderer = setup.renderer;
  await setup.renderOnce();

  const frame = setup.captureCharFrame();

  assert.match(frame, /OpenAI quota/);
  assert.match(frame, /Checking OpenAI|Connect OpenAI OAuth/);
  const visualApi = {
    slots: {
      register(pluginRegistration) {
        visualRegistrations.push(pluginRegistration);
      },
    },
    keymap: {
      registerLayer(layer) {
        visualKeymapLayers.push(layer);
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(dispose) {
        visualDisposers.push(dispose);
        return () => {};
      },
    },
  };
  const visualTimers = { scheduled: [], cleared: [] };
  let visualNow = Date.UTC(2026, 9, 21, 14, 30, 0);
  let fetchCalls = 0;
  let credentialReads = 0;
  let finishInitialCredential;
  let finishManualRefresh;
  const syntheticToken = "synthetic-visual-token";
  const visualPayload = {
    rate_limit: {
      primary_window: {
        used_percent: 25,
        limit_window_seconds: 18_000,
        reset_at: visualNow / 1_000 + 95,
      },
      secondary_window: {
        used_percent: 40,
        limit_window_seconds: 604_800,
        reset_at: visualNow / 1_000 + 172_800,
      },
    },
    rate_limit_reset_credits: { available_count: 2 },
    reset_credit_details: {
      available_count: 2,
      credits: [
        {
          reset_type: "codex_rate_limits",
          status: "available",
          expires_at: "2026-10-21T14:31:30Z",
        },
        {
          reset_type: "codex_rate_limits",
          status: "available",
          expires_at: "2026-11-30T14:30:00Z",
        },
      ],
    },
  };
  const changedVisualPayload = {
    rate_limit: {
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 18_000,
        reset_at: visualNow / 1_000 + 125,
      },
      secondary_window: {
        used_percent: 55,
        limit_window_seconds: 604_800,
        reset_at: visualNow / 1_000 + 172_800,
      },
    },
    rate_limit_reset_credits: { available_count: 1 },
    reset_credit_details: {
      available_count: 1,
      credits: [
        {
          reset_type: "codex_rate_limits",
          status: "available",
          expires_at: "2026-10-24T14:30:00Z",
        },
      ],
    },
  };
  const changedAgainVisualPayload = {
    rate_limit: {
      primary_window: {
        used_percent: 66,
        limit_window_seconds: 18_000,
        reset_at: visualNow / 1_000 + 125,
      },
      secondary_window: {
        used_percent: 80,
        limit_window_seconds: 604_800,
        reset_at: visualNow / 1_000 + 172_800,
      },
    },
    rate_limit_reset_credits: { available_count: 0 },
  };
  const incompleteVisualPayload = {
    ...changedAgainVisualPayload,
    rate_limit_reset_credits: { available_count: 1 },
    reset_credit_details: {
      available_count: 1,
      credits: [{
        reset_type: "codex_rate_limits",
        status: "available",
        expires_at: null,
      }],
    },
  };
  const unavailableVisualPayload = {
    ...changedAgainVisualPayload,
    rate_limit_reset_credits: { available_count: "unknown" },
  };
  const staleDetailsVisualPayload = {
    ...changedAgainVisualPayload,
    rate_limit_reset_credits: { available_count: 3 },
    reset_credit_details: null,
    reset_credit_details_stale: true,
  };

  await initializeQuotaPlugin(visualApi, {
    now: () => visualNow,
    readCredential: () => {
      credentialReads += 1;

      if (credentialReads === 1) {
        return new Promise((resolve) => {
          finishInitialCredential = resolve;
        });
      }

      return Promise.resolve({ kind: "oauth", accessToken: syntheticToken });
    },
    fetchQuota: async () => {
      fetchCalls += 1;

      if (fetchCalls === 1) {
        return visualPayload;
      }

      if (fetchCalls === 2) {
        return new Promise((resolve) => {
          finishManualRefresh = resolve;
        });
      }

      if (fetchCalls === 3) {
        return changedVisualPayload;
      }

      if (fetchCalls === 4) {
        return changedAgainVisualPayload;
      }

      if (fetchCalls === 5) {
        return unavailableVisualPayload;
      }

      if (fetchCalls === 6) {
        return incompleteVisualPayload;
      }

      if (fetchCalls === 7) {
        return changedVisualPayload;
      }

      if (fetchCalls === 8) {
        return staleDetailsVisualPayload;
      }

      throw new Error(`synthetic network error: ${syntheticToken}`);
    },
    setIntervalImpl(callback, milliseconds) {
      const handle = { callback, milliseconds };
      visualTimers.scheduled.push(handle);
      return handle;
    },
    clearIntervalImpl(handle) {
      visualTimers.cleared.push(handle);
    },
  });

  assert.equal(visualRegistrations.length, 1);
  assert.equal(visualKeymapLayers[0].commands[0].name, "openai-quota.refresh");
  assert.deepEqual(visualTimers.scheduled.map(({ milliseconds }) => milliseconds), [120_000, 30_000]);

  const themeColors = {
    primary: "#123456",
    success: "#23ab67",
    warning: "#d8a500",
    error: "#e84a5f",
    info: "#2b7fd2",
    text: "#edf2f4",
    textMuted: "#8492a6",
    borderSubtle: "#5a6372",
  };
  let visualSlotInvocations = 0;
  const visualSetup = await testRender(() => {
    visualSlotInvocations += 1;
    return visualRegistrations[0].slots.sidebar_content(
      { theme: { current: themeColors } },
      { session_id: "synthetic-session" },
    );
  }, { width: 72, height: 16 });
  visualRenderer = visualSetup.renderer;
  await visualSetup.renderOnce();
  const loadingFrame = visualSetup.captureCharFrame();
  assert.match(loadingFrame, /Checking OpenAI/);
  finishInitialCredential({ kind: "oauth", accessToken: syntheticToken });

  const readyFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.includes("Quota up to date"),
    "Quota panel did not render the ready state.",
  );
  assert.match(readyFrame, /75% left/);
  assert.match(readyFrame, /60% left/);
  assert.match(readyFrame, /Banked resets · 2 available/);
  assert.match(readyFrame, /Next expiry · .* · 2m/);
  assert.equal(readyFrame.includes("Manual refresh: command palette"), false);
  assert.match(readyFrame, /Updated \d{1,2}:\d{2}:\d{2}/);
  assert.equal(fetchCalls, 1);
  assert.equal(visualRegistrations.length, 1);
  assert.equal(visualSlotInvocations, 1);

  const spans = visualSetup.captureSpans().lines.flatMap(({ spans: lineSpans }) => lineSpans);
  assert.ok(spans.some(({ text, fg }) =>
    text.includes("OpenAI quota")
      && fg.toInts()[0] === 0x12
      && fg.toInts()[1] === 0x34
      && fg.toInts()[2] === 0x56,
  ));
  assert.ok(spans.some(({ text, fg }) =>
    text.includes("━")
      && fg.toInts()[0] === 0x23
      && fg.toInts()[1] === 0xab
      && fg.toInts()[2] === 0x67,
  ));

  const initialUpdatedLine = readyFrame.match(/Updated[^\r\n]*/)?.[0];
  visualTimers.scheduled[0].callback();

  const refreshingFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.includes("Refreshing quota"),
    "Manual refresh state was not visible in the rendered panel.",
  );
  assert.match(refreshingFrame, /75% left/);
  assert.equal(typeof finishManualRefresh, "function");
  visualNow += 5_000;
  finishManualRefresh(visualPayload);

  const refreshedFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.includes("Quota up to date")
      && currentFrame.match(/Updated[^\r\n]*/)?.[0] !== initialUpdatedLine,
    "Successful refresh did not update the displayed freshness timestamp.",
  );
  assert.match(refreshedFrame, /75% left/);
  assert.equal(fetchCalls, 2);

  const initialResetLine = refreshedFrame.match(/Next reset[^\r\n]*/)?.[0];
  const initialExpiryLine = refreshedFrame.match(/Next expiry[^\r\n]*/)?.[0];
  visualNow += 30_000;
  visualTimers.scheduled[1].callback();

  const clockFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.match(/Next reset[^\r\n]*/)?.[0] !== initialResetLine,
    "A countdown clock tick did not update the mounted panel.",
  );
  assert.match(clockFrame, /Next reset · 5h · .* · 1m/);
  assert.notEqual(clockFrame.match(/Next expiry[^\r\n]*/)?.[0], initialExpiryLine);
  assert.match(clockFrame, /Next expiry · .* · <1m/);
  assert.equal(visualRegistrations.length, 1);
  assert.equal(visualSlotInvocations, 1);

  const beforeChangedUpdatedLine = clockFrame.match(/Updated[^\r\n]*/)?.[0];
  visualNow += 5_000;
  visualKeymapLayers[0].commands[0].run();

  const changedFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.includes("Quota up to date")
      && currentFrame.includes("58% left")
      && currentFrame.includes("45% left")
      && currentFrame.includes("Banked resets · 1 available"),
    "A refreshed quota percentage change did not reach the mounted panel.",
  );
  assert.match(changedFrame, /Next expiry · .* · 3d/);
  assert.notEqual(changedFrame.match(/Updated[^\r\n]*/)?.[0], beforeChangedUpdatedLine);
  assert.equal(fetchCalls, 3);
  assert.equal(visualRegistrations.length, 1);
  assert.equal(visualSlotInvocations, 1);

  visualNow += 5_000;
  visualTimers.scheduled[0].callback();

  const changedAgainFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.includes("Quota up to date")
      && currentFrame.includes("34% left")
      && currentFrame.includes("20% left")
      && currentFrame.includes("Banked resets · 0 available")
      && currentFrame.includes("Next expiry · none"),
    "A second polling quota percentage change did not reach the mounted panel.",
  );
  assert.equal(fetchCalls, 4);
  assert.equal(visualRegistrations.length, 1);
  assert.equal(visualSlotInvocations, 1);

  visualNow += 5_000;
  visualKeymapLayers[0].commands[0].run();
  const unavailableFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.includes("Banked resets · unavailable")
      && currentFrame.includes("Next expiry · unavailable"),
    "Missing or malformed reset count did not render as unavailable.",
  );
  assert.match(unavailableFrame, /20% left/);
  assert.equal(fetchCalls, 5);

  visualNow += 5_000;
  visualKeymapLayers[0].commands[0].run();
  const incompleteFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.includes("Banked resets · 1 available")
      && currentFrame.includes("Next expiry · unavailable"),
    "An incomplete reset detail list did not render an unavailable expiration.",
  );
  assert.match(incompleteFrame, /34% left/);
  assert.equal(fetchCalls, 6);

  visualNow += 5_000;
  visualKeymapLayers[0].commands[0].run();
  const recoveredFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.includes("Quota up to date")
      && currentFrame.includes("Banked resets · 1 available")
      && /Next expiry · .* · 2d 23h/.test(currentFrame),
    "A valid detail refresh did not restore its current expiration.",
  );
  assert.match(recoveredFrame, /58% left/);
  assert.equal(fetchCalls, 7);

  visualNow += 5_000;
  visualKeymapLayers[0].commands[0].run();
  const freshCountStaleExpiryFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.includes("Quota up to date")
      && currentFrame.includes("Banked resets · 3 available")
      && currentFrame.includes("Last known expiry"),
    "A detail-only timeout mislabeled its fresh count as stale.",
  );
  assert.match(freshCountStaleExpiryFrame, /34% left/);
  assert.equal(freshCountStaleExpiryFrame.includes("Last known banked resets"), false);
  assert.equal(fetchCalls, 8);

  visualNow += 5_000;
  visualKeymapLayers[0].commands[0].run();
  const staleFrame = await renderUntil(
    visualSetup,
    (currentFrame) => currentFrame.includes("Connection issue"),
    "Transient refresh failure did not render the stale-data state.",
  );
  assert.match(staleFrame, /34% left/);
  assert.match(staleFrame, /20% left/);
  assert.match(staleFrame, /Last known banked resets · 3 available/);
  assert.match(staleFrame, /Last known expiry/);
  assert.equal(staleFrame.includes(syntheticToken), false);
  assert.equal(fetchCalls, 9);
  assert.equal(visualRegistrations.length, 1);
  assert.equal(visualSlotInvocations, 1);
  const staleSpans = visualSetup.captureSpans().lines.flatMap(({ spans: lineSpans }) => lineSpans);
  assert.ok(staleSpans.some(({ text, fg }) =>
    text.includes("Connection issue")
      && fg.toInts()[0] === 0xd8
      && fg.toInts()[1] === 0xa5
      && fg.toInts()[2] === 0x00,
  ));

  visualSetup.resize(28, 16);
  await visualSetup.renderOnce();
  const narrowFrame = visualSetup.captureCharFrame();
  assert.match(narrowFrame, /OpenAI quota/);
  assert.match(narrowFrame, /34% left/);
  assert.equal(await visualDisposers[0](), undefined);
  assert.equal(visualTimers.cleared.length, 2);

  const readsBeforeDisposedTimerCallbacks = credentialReads;
  visualNow += 30_000;
  visualTimers.scheduled[0].callback();
  visualTimers.scheduled[1].callback();
  await visualSetup.renderOnce();
  assert.equal(visualSetup.captureCharFrame(), narrowFrame);
  assert.equal(credentialReads, readsBeforeDisposedTimerCallbacks);
  assert.equal(fetchCalls, 9);
  assert.equal(visualSlotInvocations, 1);
} finally {
  renderer?.destroy();
  visualRenderer?.destroy();

  for (const dispose of disposers.reverse()) {
    await dispose();
  }

  for (const dispose of visualDisposers.reverse()) {
    await dispose();
  }

  if (originalDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalDataHome;
  }

  if (originalAuthContent === undefined) {
    delete process.env.OPENCODE_AUTH_CONTENT;
  } else {
    process.env.OPENCODE_AUTH_CONTENT = originalAuthContent;
  }

  await rm(syntheticDataHome, { recursive: true, force: true });
}

console.log("OpenCode TUI entrypoint harness passed.");
