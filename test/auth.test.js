import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import path from "node:path";
import {
  classifyOpenAICredential,
  getOpenCodeAuthPath,
  readOpenAICredential,
  requestOpenAIUsage,
  USAGE_ENDPOINT,
} from "../src/auth.js";
import {
  getOpenCodeConfigDirectory,
  getOpenCodeConfigPackagePath,
} from "../src/tui.js";

const now = 1_800_000_000_000;

test("OpenCode auth path follows XDG data home and its Windows default", () => {
  const xdgHome = path.resolve("test-data-home");
  const relativeDataHome = "relative-data-home";
  const home = path.resolve("home");

  assert.equal(
    getOpenCodeAuthPath({ env: { XDG_DATA_HOME: xdgHome }, home }),
    path.join(xdgHome, "opencode", "auth.json"),
  );
  assert.equal(
    getOpenCodeAuthPath({ env: { XDG_DATA_HOME: relativeDataHome }, home }),
    path.join(relativeDataHome, "opencode", "auth.json"),
  );
  assert.equal(
    getOpenCodeAuthPath({ env: { XDG_DATA_HOME: "" }, home }),
    path.join(home, ".local", "share", "opencode", "auth.json"),
  );
});

test("OpenCode config paths preserve relative XDG_CONFIG_HOME overrides", () => {
  const home = path.resolve("home");
  const relativeConfigHome = "relative-config-home";
  const relativeConfigDirectory = path.join(relativeConfigHome, "opencode");

  assert.equal(
    getOpenCodeConfigDirectory({ XDG_CONFIG_HOME: relativeConfigHome }, home),
    relativeConfigDirectory,
  );
  assert.equal(
    getOpenCodeConfigPackagePath({ XDG_CONFIG_HOME: relativeConfigHome }, home),
    path.join(path.resolve(relativeConfigDirectory), "package.json"),
  );
  assert.equal(
    getOpenCodeConfigDirectory({ XDG_CONFIG_HOME: "" }, home),
    path.join(home, ".config", "opencode"),
  );
});

test("credential classification distinguishes missing, API key, and expired OAuth", () => {
  assert.deepEqual(classifyOpenAICredential({}, now), { kind: "not-connected" });
  assert.deepEqual(
    classifyOpenAICredential({ openai: { type: "api", key: randomUUID() } }, now),
    { kind: "api-key" },
  );
  assert.deepEqual(
    classifyOpenAICredential({
      openai: { type: "oauth", access: randomUUID(), expires: now - 1 },
    }, now),
    { kind: "expired" },
  );
});

test("readOpenAICredential parses only synthetic data and never returns invalid JSON", async () => {
  const missing = await readOpenAICredential({
    env: {},
    authPath: "unused",
    readFileImpl: async () => {
      const error = new Error("synthetic missing file");
      error.code = "ENOENT";
      throw error;
    },
  });
  const invalid = await readOpenAICredential({
    env: {},
    authPath: "unused",
    readFileImpl: async () => "not-json",
  });

  assert.deepEqual(missing, { kind: "not-connected" });
  assert.deepEqual(invalid, { kind: "unavailable" });
});

test("non-empty valid OpenCode auth snapshot takes precedence over disk", async () => {
  let diskReads = 0;
  const result = await readOpenAICredential({
    env: {
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: "api" } }),
    },
    authPath: "unused",
    readFileImpl: async () => {
      diskReads += 1;
      return JSON.stringify({ openai: { type: "oauth" } });
    },
  });

  assert.deepEqual(result, { kind: "api-key" });
  assert.equal(diskReads, 0);
});

test("valid auth snapshots without OpenAI credentials do not fall back to disk", async () => {
  let diskReads = 0;
  const result = await readOpenAICredential({
    env: { OPENCODE_AUTH_CONTENT: "{}" },
    authPath: "unused",
    readFileImpl: async () => {
      diskReads += 1;
      return JSON.stringify({ openai: { type: "api" } });
    },
  });

  assert.deepEqual(result, { kind: "not-connected" });
  assert.equal(diskReads, 0);
});

test("empty auth snapshot falls back to disk like OpenCode 1.18.35", async () => {
  let diskReads = 0;
  const result = await readOpenAICredential({
    env: { OPENCODE_AUTH_CONTENT: "" },
    authPath: "unused",
    readFileImpl: async () => {
      diskReads += 1;
      return JSON.stringify({ openai: { type: "api" } });
    },
  });

  assert.deepEqual(result, { kind: "api-key" });
  assert.equal(diskReads, 1);
});

test("malformed auth snapshot falls back to disk without exposing parse errors", async () => {
  let diskReads = 0;
  const result = await readOpenAICredential({
    env: { OPENCODE_AUTH_CONTENT: "{synthetic-invalid-json" },
    authPath: "unused",
    readFileImpl: async () => {
      diskReads += 1;
      return JSON.stringify({ openai: { type: "api" } });
    },
  });

  assert.deepEqual(result, { kind: "api-key" });
  assert.equal(diskReads, 1);
});

test("OAuth access is returned only to the in-process request caller", () => {
  const access = randomUUID();
  const credential = classifyOpenAICredential({
    openai: {
      type: "oauth",
      access,
      expires: now + 60_000,
      accountId: "org_synthetic",
    },
  }, now);

  assert.equal(credential.kind, "oauth");
  assert.equal(credential.accessToken, access);
  assert.equal(credential.accountId, "org_synthetic");
});

test("usage request is pinned to OpenAI, forbids redirects, and omits cookies", async () => {
  const access = randomUUID();
  let request;
  const payload = { rate_limit: { primary_window: { used_percent: 20 } } };
  const response = new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });

  const received = await requestOpenAIUsage({
    accessToken: access,
    accountId: "org_synthetic",
  }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response;
    },
  });

  assert.equal(request.url, USAGE_ENDPOINT);
  assert.equal(new URL(request.url).protocol, "https:");
  assert.equal(new URL(request.url).hostname, "chatgpt.com");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.headers.authorization, `Bearer ${access}`);
  assert.equal(request.options.headers["ChatGPT-Account-Id"], "org_synthetic");
  assert.deepEqual(received, payload);
});

test("redirect responses and unauthorized OAuth responses are sanitized", async () => {
  await assert.rejects(
    requestOpenAIUsage({ accessToken: randomUUID() }, {
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.invalid/" },
      }),
    }),
    (error) => error.kind === "redirect" && error.message === "Quota request failed",
  );

  await assert.rejects(
    requestOpenAIUsage({ accessToken: randomUUID() }, {
      fetchImpl: async () => new Response(null, { status: 401 }),
    }),
    (error) => error.kind === "expired" && error.message === "Quota request failed",
  );
});

test("request timeout aborts and does not expose rejected request details", async () => {
  const syntheticValue = randomUUID();

  await assert.rejects(
    requestOpenAIUsage({ accessToken: randomUUID() }, {
      timeoutMs: 5,
      fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new Error(`synthetic failure ${syntheticValue}`));
        }, { once: true });
      }),
    }),
    (error) => error.kind === "timeout"
      && error.message === "Quota request failed"
      && !error.message.includes(syntheticValue),
  );
});

test("oversized responses are rejected before parsing", async () => {
  await assert.rejects(
    requestOpenAIUsage({ accessToken: randomUUID() }, {
      maxResponseBytes: 8,
      fetchImpl: async () => new Response("x".repeat(64)),
    }),
    (error) => error.kind === "payload-too-large"
      && error.message === "Quota request failed",
  );
});
